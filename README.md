# Mon bus Ilevia

Mini-appli web : prochains passages Ilevia (Lille) par arrêt, au clavier ou à la voix.

- **Temps réel** : flux open data de la Métropole (`data.lillemetropole.fr`), 1 à 2 bus par ligne.
- **Horaires prévus** : GTFS officiel Ilevia, transformé chaque nuit par `scripts/build_horaires.py`
  (GitHub Actions, `.github/workflows/horaires.yml`) en petits fichiers `horaires/<ARRÊT>.json`.
- **C1A / C1B** : distinguées par le quai (code d'arrêt physique), voir `BOUCLES` dans `index.html`.

Réglage GitHub Pages requis : *Settings → Pages → Source : GitHub Actions*.

## Sources et licences des données

- Ilevia / Métropole Européenne de Lille : data.lillemetropole.fr (licence du flux temps réel à confirmer auprès de la MEL)
- SNCF Voyageurs (TER) : GTFS et GTFS-RT, licence ODbL
- Île-de-France Mobilités (PRIM) : licences ODbL / Licence Mobilités / Etalab selon les jeux
Les fichiers générés dans `horaires/` sont des bases dérivées de ces données.
