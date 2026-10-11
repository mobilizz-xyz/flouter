# Flouter

Floute les visages des photos et vidéos avant de les publier, **entièrement dans le navigateur** :
les fichiers ne quittent pas l'appareil. Pensé pour les photos et vidéos de manifestation,
sur téléphone, sans compte ni installation.

Site : https://flouter.mobilizz.xyz

## Fonctionnement

- **Détection** : modèle [CenterFace](https://github.com/Star-Clouds/CenterFace) (celui de
  [deface](https://github.com/ORB-HD/deface)), exécuté par [ONNX Runtime Web](https://onnxruntime.ai/)
  dans un worker. En détection « Maximale », les images très sombres sont analysées une seconde fois,
  éclaircies, et les visages des deux passes sont réunis.
- **Masquage destructif**, en rectangle : aplat noir (par défaut), émoji posé sur l'aplat noir, pixels
  ou flou. Pixels et flou réduisent le visage à quelques pixels puis l'agrandissent : ce n'est pas un
  flou réversible.
- **Photos** : ré-encodées depuis un canvas, donc sans métadonnées (GPS, appareil, date). On peut
  ajouter ou retirer un flou en touchant l'image.
- **Vidéos** : lues avec [mp4box.js](https://github.com/gpac/mp4box.js) et WebCodecs (décodage et
  encodage matériels), réécrites avec [mp4-muxer](https://github.com/Vanilagy/mp4-muxer). La détection
  tourne une image sur trois ; chaque image reçoit les zones détectées juste avant et juste après elle.
  Le son est conservé (copié s'il est en AAC, compressé sur l'appareil s'il est en PCM). Des zones
  manuelles peuvent suivre un élément que la détection ne voit pas (tatouage, banderole).
- **Hors connexion** : un service worker met le site en cache dès la première visite.
- **Mode secours** (`api/`) : si le téléphone n'arrive pas à traiter une vidéo, la personne peut choisir
  de l'envoyer au serveur, qui la floute avec deface. Rien n'est envoyé sans son accord ; la vidéo
  reste en mémoire vive et est effacée dès que le résultat est récupéré (au plus tard 15 min).

## Organisation

```
site/                 sources du site (modules JavaScript, sans étape de compilation)
  app.js              entrée : ajout des fichiers, service worker
  settings.js         réglages (masquage, émojis, détection, son)
  theme.js            thème Auto / Sombre / Clair (chargé dans <head>, sans module)
  fonts/              polices Space Grotesk et Bricolage Grotesque (OFL)
  engine.js           chargement du moteur, détection (detector.js tourne dans un worker)
  anonymize.js        masquage d'une zone
  photo.js            photos et retouche
  video.js            vidéos (lecture, détection, encodage)
  pcm-audio.js        son PCM des fichiers .mov
  mp4-output.js       écriture du MP4
  zones.js            éditeur de zones manuelles (zone-path.js : leur trajectoire)
  fallback.js         mode secours (envoi au serveur)
  report.js           signalement d'un problème (diagnostic technique, jamais le fichier)
  list.js, viewer.js, save.js, zip.js   interface, enregistrement, archive .zip
  vendor/             composants libres (voir tools/vendor.py)
api/server.py         serveur du mode secours (Python, sans dépendance web)
build.py              construction du site publié (dist/)
tools/vendor.py       reconstruction de site/vendor/ depuis npm et PyPI
tests/                tests (node --test)
```

## Développement

Le site fonctionne directement depuis les sources :

```sh
python3 -m http.server -d site 8000     # puis http://localhost:8000
```

Tests et vérification du code (Node 20 ou plus) :

```sh
npm install
npm test
npm run lint
```

## Mise en ligne

```sh
python3 build.py              # construit dist/ (nécessite Docker pour esbuild)
docker compose up -d          # site sur http://127.0.0.1:8088, mode secours sur le réseau interne
```

Placer un proxy HTTPS devant. Les en-têtes de sécurité (politique de contenu, isolation entre
origines nécessaire aux threads du moteur) sont définis dans le `Caddyfile`. Les réglages propres à
un serveur vont dans `docker-compose.override.yml` (ignoré par git).

## Composants libres

`site/vendor/` contient des fichiers publiés tels quels, sauf deux, modifiés pour le navigateur :
le moteur ONNX Runtime limité à 1 Go de mémoire (Safari sur iPhone refuse les 4 Go d'origine) et le
modèle de deface, dont les dimensions d'entrée sont rendues libres. `python3 tools/vendor.py`
reconstruit le dossier à l'identique à partir des paquets officiels.

Leurs licences sont dans `licenses/` et réunies dans `licences.txt` sur le site publié.

## Licence

[MIT](LICENSE)
