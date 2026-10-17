"""Mode secours de Flouter : floute une vidéo avec deface quand le téléphone n'y arrive pas.

Utilisé seulement avec l'accord explicite de la personne. Les fichiers restent en mémoire vive
(tmpfs), sont effacés dès que le résultat est téléchargé (ou au bout de 15 min), et rien n'est journalisé.

API (toutes les réponses sont en JSON, sauf le résultat) :
  POST /api/uploads?size=…&mode=…&thresh=…&audio=…   réserve un envoi            -> {id}
  POST /api/uploads/<id>?offset=…                    envoie un morceau (≤ 64 Mo)  -> {received}
  GET  /api/jobs/<id>                                état du traitement           -> {state, progress, position, error}
  GET  /api/jobs/<id>/result                         vidéo floutée (puis effacée)
  POST /api/jobs/<id>/cancel                         abandon
  POST /api/report                                   signalement d'un problème (diagnostic technique)
"""
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

import imageio_ffmpeg

WORK = '/work'  # tmpfs (mémoire vive)
MB = 1024 * 1024
# Réglables dans docker-compose.yml (section environment du service api)
MAX_BYTES = int(os.environ.get('MAX_MB', 600)) * MB            # taille max d'une vidéo
MAX_SECONDS = int(os.environ.get('MAX_MINUTES', 10)) * 60      # durée max traitée
MAX_QUEUE = int(os.environ.get('MAX_QUEUE', 8))                # vidéos en attente au maximum
WORK_BYTES = int(os.environ.get('WORK_MB', 2800)) * MB         # place réservable dans /work (taille du tmpfs moins une marge)
CHUNK_MAX = 64 * MB
TTL = 15 * 60       # résultat non récupéré : effacé au bout de 15 min
IDLE_UPLOAD = 600   # envoi abandonné : effacé après 10 min sans nouveau morceau (laisse le temps aux nouveaux essais)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

REPORTS = '/reports/reports.jsonl'  # signalements de problèmes (aucun fichier, aucune IP)
REPORT_FIELDS = {'os', 'browser', 'inapp', 'features', 'kind', 'container', 'codec', 'size', 'duration', 'step', 'error', 'local', 'comment', 'version'}
REPORTS_MAX = 5 * MB
report_times = deque(maxlen=60)  # au plus 60 signalements par heure

jobs = {}        # id -> dict
queue = deque()  # ids en attente
lock = threading.Lock()
wake = threading.Event()


def job_dir(jid):
    return os.path.join(WORK, jid)


def drop(jid):
    with lock:
        job = jobs.pop(jid, None)
        if jid in queue:
            queue.remove(jid)
    if job and job.get('proc'):
        try:
            job['proc'].kill()
        except OSError:
            pass
    shutil.rmtree(job_dir(jid), ignore_errors=True)


def reserved():
    """Place promise aux tâches en cours : un envoi n'est accepté que si sa taille tient dans /work."""
    return sum(j['size'] for j in jobs.values() if j['state'] in ('uploading', 'queued', 'running'))


def run(job, cmd, start, span):
    """Lance une commande et convertit sa progression (%) en avancement global."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
    job['proc'] = proc
    buf = ''
    while True:
        ch = proc.stderr.read(1)
        if not ch:
            break
        buf = (buf + ch)[-200:]
        if ch not in '\r\n':
            continue
        dur = re.search(r'Duration: (\d+):(\d+):(\d+)', buf)
        if dur:
            h, mi, sec = map(int, dur.groups())
            job['duration'] = min(MAX_SECONDS, h * 3600 + mi * 60 + sec) or 1
        percent = re.findall(r'(\d+)%\|', buf)          # barre de progression de deface
        clock = re.findall(r'time=(\d+):(\d+):(\d+)', buf)  # progression de ffmpeg
        if percent:
            job['progress'] = start + span * int(percent[-1]) / 100
        elif clock:
            h, mi, s = map(int, clock[-1])
            job['progress'] = start + span * min(1, (h * 3600 + mi * 60 + s) / job['duration'])
        buf = ''
    proc.wait()
    job['proc'] = None
    if proc.returncode != 0:
        raise RuntimeError('traitement impossible')


def container_format(path):
    """Reconnaît une vraie vidéo à sa signature ; tout le reste est refusé."""
    with open(path, 'rb') as f:
        head = f.read(64)
    if head[4:8] in (b'ftyp', b'moov', b'mdat', b'wide', b'free', b'skip'):
        return 'mov'        # MP4 / MOV / 3GP
    if head[:4] == b'\x1a\x45\xdf\xa3':
        return 'matroska'   # WebM / MKV
    return None


def process(jid):
    job = jobs[jid]
    d = job_dir(jid)
    src, norm, out = f'{d}/in', f'{d}/norm.mp4', f'{d}/out.mp4'
    try:
        fmt = container_format(src)
        if not fmt:
            raise RuntimeError("ce fichier n'est pas une vidéo reconnue (MP4, MOV ou WebM)")
        # 1. Normalisation : 720p max, durée limitée, métadonnées supprimées (GPS, appareil, date).
        #    Format d'entrée imposé et accès limité au seul fichier reçu (ni autres fichiers, ni réseau).
        scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'"
        audio = ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k'] if job['audio'] else ['-an']
        run(job, [FFMPEG, '-hide_banner', '-y', '-protocol_whitelist', 'file', '-f', fmt, '-i', src,
                  '-t', str(MAX_SECONDS), '-map', '0:v:0', *audio, '-vf', scale,
                  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
                  '-map_metadata', '-1', norm], 0, 0.2)
        os.remove(src)
        # 2. Floutage des visages (deface), détection sur une image réduite (côté max 640 px, comme sur téléphone)
        gen = imageio_ffmpeg.read_frames(norm)
        w, h = next(gen)['size']
        gen.close()
        r = 640 / max(w, h)
        det = f'{max(32, round(w * r))}x{max(32, round(h * r))}'
        cfg = {'codec': 'libx264', 'pixelformat': 'yuv420p', 'output_params': ['-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart']}
        cmd = ['deface', norm, '-o', out, '--scale', det, '--thresh', str(job['thresh']), '--mask-scale', '1.3',
               '--replacewith', job['mode'], '--ffmpeg-config', json.dumps(cfg)]
        if job['audio']:
            cmd.append('--keep-audio')
        run(job, cmd, 0.2, 0.8)
        os.remove(norm)
        job['state'], job['progress'] = 'done', 1
    except Exception as e:
        job['state'] = 'error'
        job['error'] = str(e) if isinstance(e, RuntimeError) else 'traitement impossible'
        for f in (src, norm, out):
            if os.path.exists(f):
                os.remove(f)
    job['touched'] = time.time()


def worker():
    while True:
        wake.wait(5)
        wake.clear()
        with lock:
            jid = queue.popleft() if queue else None
            if jid in jobs:
                jobs[jid]['state'] = 'running'
        if jid in jobs:
            process(jid)
        # Nettoyage : résultats jamais récupérés et envois abandonnés en cours de route
        now = time.time()
        for jid, job in list(jobs.items()):
            idle = now - job['touched']
            if (job['state'] in ('done', 'error') and idle > TTL) or (job['state'] == 'uploading' and idle > IDLE_UPLOAD):
                drop(jid)


def clean_text(v):
    """Texte de signalement sur une ligne, sans caractères de contrôle (affiché ensuite dans un terminal)."""
    return re.sub(r'[\x00-\x1f\x7f-\x9f]+', ' ', str(v))[:500]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # aucun journal
        pass

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def length(self):
        value = self.headers.get('Content-Length') or '0'
        return int(value) if value.isdigit() else -1

    def read_into(self, f, length):
        left = length
        while left:
            chunk = self.rfile.read(min(MB, left))
            if not chunk:
                raise IOError('envoi interrompu')
            f.write(chunk)
            left -= len(chunk)

    def do_POST(self):
        url = urlsplit(self.path)
        q = dict(parse_qsl(url.query))
        if url.path == '/api/report':
            return self.report()
        if url.path == '/api/uploads':
            return self.new_upload(q)
        m = re.fullmatch(r'/api/uploads/([0-9a-f]{32})', url.path)
        if m:
            return self.upload(m.group(1), q)
        m = re.fullmatch(r'/api/jobs/([0-9a-f]{32})/cancel', url.path)
        if m:
            drop(m.group(1))
            return self.reply(200, {'ok': True})
        self.reply(404, {'error': 'inconnu'})

    def new_upload(self, q):
        size = int(q['size']) if q.get('size', '').isdigit() else 0
        if not 0 < size <= MAX_BYTES:
            return self.reply(413, {'error': f'fichier trop gros pour le serveur ({MAX_BYTES // MB} Mo maximum)'})
        now = time.time()
        with lock:
            if len(queue) >= MAX_QUEUE or reserved() + size > WORK_BYTES:
                return self.reply(503, {'error': 'le serveur est occupé, réessaie dans quelques minutes'})
            jid = secrets.token_hex(16)
            os.makedirs(job_dir(jid), mode=0o700)
            jobs[jid] = {
                'state': 'uploading', 'progress': 0, 'touched': now, 'duration': 1, 'proc': None,
                'size': size, 'received': 0,
                'mode': q.get('mode') if q.get('mode') in ('blur', 'solid', 'mosaic') else 'blur',
                'thresh': 0.1 if q.get('thresh') == 'high' else 0.2,
                'audio': q.get('audio') == '1',
            }
        self.reply(201, {'id': jid})

    def upload(self, jid, q):
        """Envoi en morceaux : passe les limites de taille des intermédiaires."""
        job = jobs.get(jid)
        length = self.length()
        if not job:
            return self.reply(404, {'error': 'envoi introuvable ou expiré'})
        if 0 < length <= CHUNK_MAX and q.get('offset') == str(job['received'] - length):
            # Morceau déjà reçu dont la réponse s'est perdue : le téléphone le renvoie, on l'ignore
            try:
                self.read_into(io.BytesIO(), length)
            except OSError:
                return self.reply(503, {'error': 'envoi interrompu'})
            job['touched'] = time.time()
            return self.reply(200, {'received': job['received']})
        if job['state'] != 'uploading':
            return self.reply(404, {'error': 'envoi introuvable ou expiré'})
        if not 0 < length <= CHUNK_MAX or q.get('offset') != str(job['received']) or job['received'] + length > job['size']:
            return self.reply(400, {'error': 'morceau invalide'})
        with lock:
            if job.get('busy'):  # ancien essai encore en cours de lecture : le téléphone réessaiera
                return self.reply(503, {'error': 'envoi déjà en cours'})
            job['busy'] = True
        try:
            self.write_chunk(jid, job, length)
        finally:
            job['busy'] = False

    def write_chunk(self, jid, job, length):
        try:
            with open(f'{job_dir(jid)}/in', 'ab') as f:
                try:
                    self.read_into(f, length)
                except OSError:
                    # Coupure réseau : on revient à ce qui était complet, le téléphone renverra ce morceau
                    f.truncate(job['received'])
                    raise
        except OSError:
            job['touched'] = time.time()
            return self.reply(503, {'error': 'envoi interrompu'})
        job['received'] += length
        job['touched'] = time.time()
        if job['received'] == job['size']:
            with lock:
                job['state'] = 'queued'
                queue.append(jid)
            wake.set()
        self.reply(200, {'received': job['received']})

    def report(self):
        length = self.length()
        if not 0 < length <= 4096:
            return self.reply(413, {'error': 'signalement trop long'})
        now = time.time()
        if len(report_times) == report_times.maxlen and now - report_times[0] < 3600:
            return self.reply(503, {'error': 'trop de signalements en ce moment, réessaie plus tard'})
        try:
            data = json.loads(self.rfile.read(length))
            row = {k: clean_text(v) for k, v in data.items() if k in REPORT_FIELDS}
        except (ValueError, AttributeError):
            return self.reply(400, {'error': 'signalement illisible'})
        row['date'] = time.strftime('%Y-%m-%d')  # le jour seulement
        try:
            if os.path.exists(REPORTS) and os.path.getsize(REPORTS) > REPORTS_MAX:
                return self.reply(507, {'error': 'boîte de signalements pleine'})
            with open(REPORTS, 'a') as f:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
        except OSError:
            return self.reply(500, {'error': 'enregistrement impossible'})
        report_times.append(now)
        self.reply(200, {'ok': True})

    def do_GET(self):
        m = re.fullmatch(r'/api/jobs/([0-9a-f]{32})(/result)?', urlsplit(self.path).path)
        job = jobs.get(m.group(1)) if m else None
        if not job:
            return self.reply(404, {'error': 'tâche introuvable ou expirée'})
        jid = m.group(1)
        if not m.group(2):
            pos = list(queue).index(jid) + 1 if jid in queue else 0
            return self.reply(200, {'state': job['state'], 'progress': round(job['progress'], 3), 'position': pos, 'error': job.get('error')})
        if job['state'] != 'done':
            return self.reply(409, {'error': 'pas encore prête'})
        path = f'{job_dir(jid)}/out.mp4'
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Content-Length', str(os.path.getsize(path)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with open(path, 'rb') as f:
                shutil.copyfileobj(f, self.wfile, MB)
        finally:
            drop(jid)  # effacée dès qu'elle est récupérée


def summary():
    """docker exec flou-api python /app/server.py resume  — synthèse des signalements."""
    from collections import Counter
    rows = []
    if os.path.exists(REPORTS):
        with open(REPORTS) as f:
            rows = [json.loads(line) for line in f if line.strip()]
    print(f'{len(rows)} signalement(s)')
    for key in ('os', 'browser', 'inapp', 'step', 'error', 'codec'):
        print(f'\n— {key}')
        for value, n in Counter(r.get(key, '?') for r in rows).most_common(10):
            print(f'  {n:4d}  {clean_text(value)}')
    comments = [r for r in rows if r.get('comment')]
    if comments:
        print('\n— derniers commentaires')
        for r in comments[-10:]:
            print(f"  [{r['date']}] {clean_text(r.get('os'))} / {clean_text(r.get('browser'))} : {clean_text(r['comment'])}")


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['resume']:
        summary()
        raise SystemExit
    threading.Thread(target=worker, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
