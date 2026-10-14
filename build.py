#!/usr/bin/env python3
"""Construit le site publié à partir des sources (site/).

Le code est regroupé et compacté par esbuild, les gros fichiers reçoivent des noms courts, et les
licences des composants libres sont réunies dans licences.txt, comme l'exigent leurs licences.

Usage : python3 build.py [dossier]     (dist/ par défaut ; nécessite Docker pour esbuild)

La construction se fait dans un dossier à part, puis chaque fichier remplace l'ancien par un
renommage atomique : le site reste servi sans coupure pendant une publication.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = f'{ROOT}/site'
TMP = f'{ROOT}/.dist-new'

# Nom dans les sources -> nom publié
RENAME = {
    './detector.js': './w.js',
    './vendor/ort-wasm-1g.mjs': './e.mjs',
    './vendor/ort-wasm-simd-threaded.wasm': './e.wasm',
    './vendor/centerface.onnx': './m.bin',
}
COPY = {'vendor/ort-wasm-1g.mjs': 'e.mjs', 'vendor/ort-wasm-simd-threaded.wasm': 'e.wasm',
        'vendor/centerface.onnx': 'm.bin', 'icon.svg': 'icon.svg', 'manifest.webmanifest': 'manifest.webmanifest',
        'theme.js': 't.js', 'fonts/sg5.woff2': 'sg5.woff2', 'fonts/sg7.woff2': 'sg7.woff2', 'fonts/bg8.woff2': 'bg8.woff2'}
PAGES = ('index.html', 'confidentialite.html')
# Fichiers mis en cache dès la première visite pour fonctionner hors connexion
OFFLINE = ['./', 'index.html', 's.css', 'a.js', 'w.js', 'e.mjs', 'e.wasm', 'm.bin', 'icon.svg',
           'manifest.webmanifest', 'confidentialite.html', 't.js', 'sg5.woff2', 'sg7.woff2', 'bg8.woff2']
LICENSES = [('Modèle de détection (CenterFace)', 'centerface.txt'), ('Modèle (via deface)', 'deface.txt'),
            ("Moteur d'inférence (ONNX Runtime Web)", 'onnxruntime.txt'), ('Lecture vidéo (mp4box.js)', 'mp4box.txt'),
            ('Écriture vidéo (mp4-muxer)', 'mp4-muxer.txt'), ('Polices (Space Grotesk, Bricolage Grotesque)', 'fonts-ofl.txt')]


def esbuild(entry, out, *args):
    cmd = f'npx -y esbuild@0.28 /w/site/{entry} --minify --legal-comments=none --log-level=warning ' \
          f'--outfile=/w/.dist-new/{out} {" ".join(args)}'
    subprocess.run(['docker', 'run', '--rm', '-v', f'{ROOT}:/w', '-w', '/w', 'node:24-alpine', 'sh', '-c', cmd], check=True)


def edit(path, fn):
    with open(path) as f:
        s = f.read()
    with open(path, 'w') as f:
        f.write(fn(s))


def digest(name):
    with open(f'{TMP}/{name}', 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def rename_refs(s):
    for a, b in RENAME.items():
        s = s.replace(a, b)
    return re.sub(r'//# sourceMappingURL=\S+', '', s)


def build():
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)
    version = time.strftime('%Y-%m-%d.%H%M')
    esbuild('app.js', 'a.js', '--bundle', '--format=esm', f'--define:__VERSION__=\'"{version}"\'')
    esbuild('detector.js', 'w.js', '--bundle', '--format=esm')
    esbuild('style.css', 's.css', '--loader:.css=css')
    for src, dst in COPY.items():
        shutil.copy(f'{SRC}/{src}', f'{TMP}/{dst}')
    for page in PAGES:
        with open(f'{SRC}/{page}') as f:
            html = re.sub(r'<!--.*?-->\s*', '', f.read(), flags=re.S)
        with open(f'{TMP}/{page}', 'w') as f:
            f.write(html.replace('href="style.css"', 'href="s.css"').replace('src="app.js"', 'src="a.js"')
                    .replace('src="theme.js"', 'src="t.js"'))
    edit(f'{TMP}/a.js', rename_refs)
    edit(f'{TMP}/w.js', rename_refs)
    edit(f'{TMP}/e.mjs', rename_refs)
    edit(f'{TMP}/s.css', lambda s: s.replace('fonts/', ''))  # polices publiées à la racine
    # Adresses liées au contenu (?v=…) : Cloudflare fait garder 4 h le code aux navigateurs,
    # une nouvelle version doit donc changer d'adresse pour être chargée tout de suite.
    edit(f'{TMP}/a.js', lambda s: s.replace('./w.js', f'./w.js?v={digest("w.js")}'))
    for page in PAGES:
        edit(f'{TMP}/{page}', lambda s: s.replace('href="s.css"', f'href="s.css?v={digest("s.css")}"')
             .replace('src="a.js"', f'src="a.js?v={digest("a.js")}"').replace('src="t.js"', f'src="t.js?v={digest("t.js")}"'))

    with open(f'{TMP}/licences.txt', 'w') as out:
        out.write('Ce site utilise les composants libres suivants. Leurs licences sont reproduites ci-dessous.\n')
        for title, name in LICENSES:
            with open(f'{ROOT}/licenses/{name}') as f:
                out.write(f'\n\n==== {title} ====\n\n{f.read().strip()}\n')

    # Nom du cache lié au contenu publié : chaque publication réinstalle le cache hors connexion
    h = hashlib.sha256()
    for name in sorted(os.listdir(TMP)):
        with open(f'{TMP}/{name}', 'rb') as f:
            h.update(name.encode() + f.read())
    with open(f'{SRC}/sw.js') as f:
        sw = f.read()
    sw = re.sub(r"const CACHE = '[^']*';", f"const CACHE = 'flouter-{h.hexdigest()[:10]}';", sw, count=1)
    sw = re.sub(r'const CORE = \[[^\]]*\];', f'const CORE = {OFFLINE!r};'.replace('"', "'"), sw, count=1)
    with open(f'{TMP}/sw.js', 'w') as f:
        f.write(sw)


def publish(live):
    os.makedirs(live, exist_ok=True)
    names = sorted(os.listdir(TMP), key=lambda n: n.endswith('.html'))  # pages en dernier
    for name in names:
        shutil.copy(f'{TMP}/{name}', f'{live}/.{name}.tmp')
        os.replace(f'{live}/.{name}.tmp', f'{live}/{name}')
    for name in os.listdir(live):
        if name not in names:
            path = f'{live}/{name}'
            shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
    shutil.rmtree(TMP)
    print(f'{live} prêt :', ', '.join(sorted(names)))


if __name__ == '__main__':
    build()
    publish(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else f'{ROOT}/dist')
