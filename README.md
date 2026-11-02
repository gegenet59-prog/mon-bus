# Mon bus Ilevia

Mini-appli web : prochains passages Ilevia (Lille) par arrêt, au clavier ou à la voix.

- **Temps réel** : flux open data de la Métropole (`data.lillemetropole.fr`), 1 à 2 bus par ligne.
- **Horaires prévus** : GTFS officiel Ilevia, transformé chaque nuit par `scripts/build_ville.py`
  (GitHub Actions, `.github/workflows/horaires.yml`) en petits fichiers `horaires/<ARRÊT>.json`.
- **C1A / C1B** : distinguées par le quai (code d'arrêt physique), voir `BOUCLES` dans `index.html`.

Réglage GitHub Pages requis : *Settings → Pages → Source : GitHub Actions*.

## Moteur commun (autres villes)

`scripts/build_ville.py <VILLE> <url_gtfs>` fabrique `horaires/<ville>/` au format compacté
(chaque nom écrit une seule fois puis remplacé par son numéro). Vérifié sur Lille : 0 différence
sur 299 849 horaires par rapport à l'ancien format. Temps réel : flux GTFS-RT déclaré dans `VILLES` (index.html).

## Sources et licences des données

- Ilevia / Métropole Européenne de Lille : data.lillemetropole.fr (licence du flux temps réel à confirmer auprès de la MEL)
- SNCF Voyageurs (TER) : GTFS et GTFS-RT, licence ODbL
- Bordeaux Métropole (TBM) et Rennes (STAR) : GTFS / GTFS-RT, via transport.data.gouv.fr
- Montpellier Méditerranée Métropole (TaM) et Nice (Lignes d'Azur) : temps réel via le relais Cloudflare (dossier relais/)
- Île-de-France Mobilités (PRIM) : licences ODbL / Licence Mobilités / Etalab selon les jeux
Les fichiers générés dans `horaires/` sont des bases dérivées de ces données.

## Tests

`node tests/tester_villes.js [adresse]` : pose une série de questions à chaque ville (arrêt trouvé, directions, doublons, homonymes). En local, générer `horaires/` puis lancer `python3 -m http.server 8765`. La nuit, beaucoup de lignes ne roulent pas.
`node tests/robot_noms.js BORDEAUX NICE …` : tape le nom de **chaque** arrêt de la ville et vérifie que l'appli retrouve le bon (liste aussi les homonymes).
`node tests/grandes_stations.js BORDEAUX NICE …` : les 30 stations les plus desservies avec le temps réel (doublons, direction = l'arrêt lui-même, flux en panne).

`python3 tests/verifier_itineraire.py lille [AAAAMMJJ]` : vérifie que l'heure calculée par l'itinéraire est exacte pour tous les trajets de toutes les lignes, à chaque arrêt.

`node tests/verifier_stations_paris.js` : vérifie les 996 stations ferrées d'Île-de-France et le badge des 2 029 lignes, sans consommer de quota PRIM.

## Pannes métro / tram et alertes

- Bandeau rouge à l'accueil quand une ligne de métro / tram / RER de la ville est en panne (info trafic officielle, lue par le relais : `?flux=pannes&ville=LILLE`).
- 🔔 en haut : on coche ses lignes, le téléphone reçoit une notification en cas de panne puis quand le trafic reprend.
  Le relais (Durable Object `Alertes`, `relais/src/alertes.js`) vérifie toutes les 5 min (Paris tous les quarts d'heure, quota PRIM).
  Sur iPhone, il faut d'abord ajouter l'appli à l'écran d'accueil.
- Villes : Lille, Paris, Bordeaux, Montpellier (Rennes : le STAR ne publie que les alertes des bus pour l'instant).

## Itinéraire

Bandeau « 🧭 Itinéraire » à l'accueil → écran séparé (départ, arrivée : arrêt, favori, adresse ou ma position).
`build_ville.py` écrit chaque nuit `reseau.json` (suite des arrêts de chaque ligne, temps entre arrêts, nombre de trajets par heure).
Toute la saison : départs de chaque trajet par « groupe de jours ». Calcul horaire sur le téléphone (Dijkstra), 4 critères + trajet habituel avec l'état de chaque ligne ; partir maintenant ou à une date et heure.
les lignes qui ne roulent pas à l'heure demandée sont écartées. Paris : lien Google Maps.
