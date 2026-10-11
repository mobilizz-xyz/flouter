#!/usr/bin/env python3
"""Reconstruit site/vendor/ à partir des paquets publiés (npm, PyPI), pour vérifier leur provenance.

  python3 tools/vendor.py          (nécessite Docker ; téléchargements dans build/, ignoré par git)

Deux fichiers sont modifiés par rapport aux originaux :
  - ort-wasm-1g.mjs : le moteur ONNX Runtime réserve au plus 1 Go de mémoire au lieu de 4 Go
    (Safari sur iPhone refuse la réservation d'origine) ;
  - centerface.onnx : le modèle de deface, avec des dimensions d'entrée libres (comme le fait
    deface au chargement) et sans les poids listés parmi les entrées (refusé par ONNX Runtime Web).
"""
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DL = f'{ROOT}/build/vendor-src'
OUT = f'{ROOT}/site/vendor'
NPM = ['onnxruntime-web@1.30.0', 'mp4box@2.4.1', 'mp4-muxer@5.2.2']
DEFACE = 'deface==1.5.0'


def docker(image, script):
    subprocess.run(['docker', 'run', '--rm', '-v', f'{DL}:/dl', '-w', '/dl', image, 'sh', '-c', script], check=True)


def fetch():
    shutil.rmtree(DL, ignore_errors=True)
    os.makedirs(DL)
    docker('node:24-alpine', f'npm pack --silent {" ".join(NPM)} && for f in *.tgz; do mkdir -p "${{f%.tgz}}" && tar -xzf "$f" -C "${{f%.tgz}}"; done')
    # Modèle : extrait du paquet deface, puis adapté pour le navigateur
    docker('python:3.12-slim', f"""pip install -q onnx==1.17.0 && pip download -q --no-deps {DEFACE} -d . && python - <<'EOF'
import glob, zipfile, onnx
from onnx.tools.update_model_dims import update_inputs_outputs_dims
with zipfile.ZipFile(glob.glob('deface-*.whl')[0]) as z:
    open('centerface-orig.onnx', 'wb').write(z.read('deface/centerface.onnx'))
m = onnx.load('centerface-orig.onnx')
dims = lambda nodes: {{n.name: [d.dim_value for d in n.type.tensor_type.shape.dim] for n in nodes}}
ins, outs = dims(m.graph.input), dims(m.graph.output)
ins['input.1'] = ['B', 3, 'H', 'W']
outs.update({{'537': ['B', 1, 'h', 'w'], '538': ['B', 2, 'h', 'w'], '539': ['B', 2, 'h', 'w'], '540': ['B', 10, 'h', 'w']}})
m = update_inputs_outputs_dims(m, ins, outs)
weights = {{i.name for i in m.graph.initializer}}
keep = [i for i in m.graph.input if i.name not in weights]
del m.graph.input[:]
m.graph.input.extend(keep)
onnx.save(m, 'centerface.onnx')
EOF""")


def install():
    ort = f'{DL}/onnxruntime-web-1.30.0/package/dist'
    os.makedirs(f'{OUT}/mp4box', exist_ok=True)
    shutil.copy(f'{ort}/ort.wasm.min.mjs', f'{OUT}/ort.wasm.min.mjs')
    shutil.copy(f'{ort}/ort-wasm-simd-threaded.wasm', f'{OUT}/ort-wasm-simd-threaded.wasm')
    with open(f'{ort}/ort-wasm-simd-threaded.mjs') as f:
        engine = f.read()
    old, new = 'maximum:65536,shared:!0', 'maximum:16384,shared:!0'  # pages de 64 Ko : 4 Go -> 1 Go
    assert engine.count(old) == 1, 'réservation mémoire introuvable : version du moteur changée ?'
    with open(f'{OUT}/ort-wasm-1g.mjs', 'w') as f:
        f.write(engine.replace(old, new))

    mp4box = f'{DL}/mp4box-2.4.1/package'
    for name in os.listdir(f'{mp4box}/dist'):
        # mp4box.all.mjs et les morceaux qu'il importe
        if name == 'mp4box.all.mjs' or (name.endswith('.mjs') and not name.startswith('mp4box.')):
            shutil.copy(f'{mp4box}/dist/{name}', f'{OUT}/mp4box/{name}')
    shutil.copy(f'{mp4box}/LICENSE', f'{OUT}/mp4box/LICENSE')

    muxer = f'{DL}/mp4-muxer-5.2.2/package'
    shutil.copy(f'{muxer}/build/mp4-muxer.mjs', f'{OUT}/mp4-muxer.mjs')
    shutil.copy(f'{muxer}/LICENSE', f'{OUT}/LICENSE-mp4-muxer')
    shutil.copy(f'{DL}/centerface.onnx', f'{OUT}/centerface.onnx')


if __name__ == '__main__':
    fetch()
    install()
    print('site/vendor/ reconstruit à partir de :', ', '.join(NPM + [DEFACE]))
