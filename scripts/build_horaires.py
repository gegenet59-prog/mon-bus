#!/usr/bin/env python3
"""Fabrique les horaires théoriques Ilevia pour l'appli « Mon bus ».

Télécharge le GTFS officiel d'Ilevia et écrit :
  - horaires/stations.json : nom d'arrêt normalisé -> liste de préfixes de quais (ex. REP)
  - horaires/arrets.json : nom d'arrêt normalisé -> [latitude, longitude] (pour « Autour de moi »)
  - horaires/<PREFIXE>.json : passages théoriques de tous les quais de cet arrêt,
    pour aujourd'hui et demain (+ la nuit d'hier après minuit), heure de Paris

Usage : python3 scripts/build_horaires.py [chemin_ou_url_du_gtfs.zip] [dossier_sortie]
Lancé chaque nuit par GitHub Actions (.github/workflows/horaires.yml).
"""
import csv
import io
import json
import os
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

URL_GTFS = "https://media.ilevia.fr/opendata/gtfs.zip"
PARIS = ZoneInfo("Europe/Paris")


def normaliser(texte):
    """Même règle que dans l'appli : sans accents, majuscules, sans tirets ni apostrophes."""
    t = unicodedata.normalize("NFD", texte)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").upper()
    for c in "-'’.,?!":
        t = t.replace(c, " ")
    return " ".join(t.split())


def lire(z, nom):
    with z.open(nom) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else URL_GTFS
    sortie = sys.argv[2] if len(sys.argv) > 2 else "horaires"

    if source.startswith("http"):
        with urllib.request.urlopen(source, timeout=300) as r:
            donnees = r.read()
    else:
        with open(source, "rb") as f:
            donnees = f.read()
    z = zipfile.ZipFile(io.BytesIO(donnees))

    # Jours utiles : hier (seulement les bus après minuit), aujourd'hui, demain
    aujourd_hui = datetime.now(PARIS).date()
    hier = (aujourd_hui - timedelta(days=1)).strftime("%Y%m%d")
    jours = {(aujourd_hui + timedelta(days=d)).strftime("%Y%m%d") for d in (-1, 0, 1)}

    # Services actifs par jour (Ilevia n'utilise que calendar_dates)
    services = defaultdict(set)
    for l in lire(z, "calendar_dates.txt"):
        if l["date"] in jours and l["exception_type"] == "1":
            services[l["service_id"]].add(l["date"])

    lignes = {l["route_id"]: l["route_short_name"] for l in lire(z, "routes.txt")}
    trajets = {}
    for l in lire(z, "trips.txt"):
        if l["service_id"] in services:
            trajets[l["trip_id"]] = (lignes.get(l["route_id"], l["route_id"]),
                                     l["trip_headsign"], services[l["service_id"]])

    # Quais (location_type 0) : code -> préfixe de 3 lettres, et nom d'arrêt
    stations = defaultdict(set)
    positions = defaultdict(list)
    for l in lire(z, "stops.txt"):
        if l["location_type"] == "0" and len(l["stop_id"]) >= 4:
            nom = normaliser(l["stop_name"])
            stations[nom].add(l["stop_id"][:3])
            try:
                positions[nom].append((float(l["stop_lat"]), float(l["stop_lon"])))
            except ValueError:
                pass

    # On ne garde que les départs (pas le terminus d'arrivée) : dernier arrêt exclu
    dernier = {}
    for l in lire(z, "stop_times.txt"):
        t = l["trip_id"]
        if t in trajets:
            s = int(l["stop_sequence"])
            if s > dernier.get(t, -1):
                dernier[t] = s

    passages = defaultdict(list)
    for l in lire(z, "stop_times.txt"):
        t = l["trip_id"]
        if t not in trajets or int(l["stop_sequence"]) == dernier[t]:
            continue
        ligne, direction, dates = trajets[t]
        quai = l["stop_id"]
        heure = l["departure_time"][:5]  # peut dépasser 24:00 (bus après minuit)
        for d in dates:
            if d == hier and heure < "24:00":
                continue  # d'hier, on ne garde que la nuit (24:xx, 25:xx...)
            passages[quai[:3]].append([d, heure, ligne, direction, quai])

    os.makedirs(sortie, exist_ok=True)
    genere = datetime.now(PARIS).isoformat(timespec="minutes")
    for prefixe, liste in passages.items():
        liste.sort()
        with open(os.path.join(sortie, f"{prefixe}.json"), "w", encoding="utf-8") as f:
            json.dump({"genere": genere, "passages": liste}, f, ensure_ascii=False, separators=(",", ":"))
    index = {nom: sorted(p) for nom, p in stations.items()}
    with open(os.path.join(sortie, "stations.json"), "w", encoding="utf-8") as f:
        json.dump({"genere": genere, "stations": index}, f, ensure_ascii=False, separators=(",", ":"))
    # Position moyenne des quais de chaque arrêt
    arrets = {nom: [round(sum(p[0] for p in pts) / len(pts), 5), round(sum(p[1] for p in pts) / len(pts), 5)]
              for nom, pts in positions.items() if pts}
    with open(os.path.join(sortie, "arrets.json"), "w", encoding="utf-8") as f:
        json.dump(arrets, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(passages)} arrêts, {sum(len(v) for v in passages.values())} passages, {len(index)} noms")


if __name__ == "__main__":
    main()
