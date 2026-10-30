#!/usr/bin/env python3
"""Horaires des TER dans les gares de la métropole lilloise, pour l'appli « Mon bus ».

Télécharge le GTFS national SNCF et écrit :
  - horaires/ter/gares.json : [[code UIC, nom, latitude, longitude], ...]
  - horaires/ter/<UIC>.json : passages prévus (aujourd'hui, demain, + la nuit d'hier)
      [date, heure, ligne, destination, n° de train, couleur, couleur du texte]
Le temps réel (retards, suppressions) est lu par l'appli dans le flux GTFS-RT SNCF,
en reliant chaque train par son numéro et sa date.

Usage : python3 scripts/build_ter.py [chemin_ou_url_du_gtfs.zip] [dossier_sortie]
"""
import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

URL = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip"
PARIS = ZoneInfo("Europe/Paris")
# Rectangle autour de la Métropole Européenne de Lille
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = 50.52, 50.80, 2.78, 3.30


def lire(z, nom):
    with z.open(nom) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else URL
    sortie = os.path.join(sys.argv[2] if len(sys.argv) > 2 else "horaires", "ter")
    if source.startswith("http"):
        with urllib.request.urlopen(source, timeout=600) as r:
            donnees = r.read()
    else:
        with open(source, "rb") as f:
            donnees = f.read()
    z = zipfile.ZipFile(io.BytesIO(donnees))

    aujourd_hui = datetime.now(PARIS).date()
    hier = (aujourd_hui - timedelta(days=1)).strftime("%Y%m%d")
    jours = {(aujourd_hui + timedelta(days=d)).strftime("%Y%m%d") for d in (-1, 0, 1)}

    services = defaultdict(set)
    for l in lire(z, "calendar_dates.txt"):
        if l["date"] in jours and l["exception_type"] == "1":
            services[l["service_id"]].add(l["date"])

    # Gares de la métropole (StopArea) et leurs quais TER (« StopPoint:OCETrain TER-<UIC> »)
    noms, gares, quai_gare = {}, {}, {}
    for l in lire(z, "stops.txt"):
        noms[l["stop_id"]] = l["stop_name"]
        if l["location_type"] == "1":
            lat, lon = float(l["stop_lat"]), float(l["stop_lon"])
            if LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX:
                gares[l["stop_id"]] = [l["stop_id"].split("OCE")[-1], l["stop_name"], round(lat, 5), round(lon, 5)]
    for l in lire(z, "stops.txt"):
        if l["location_type"] == "0" and l["parent_station"] in gares and "Train TER" in l["stop_id"]:
            quai_gare[l["stop_id"]] = l["parent_station"]

    routes = {l["route_id"]: (l["route_short_name"], l["route_color"], l["route_text_color"]) for l in lire(z, "routes.txt")}
    trajets = {}
    for l in lire(z, "trips.txt"):
        if l["service_id"] in services and ":TER:" in l["trip_id"]:
            trajets[l["trip_id"]] = (routes.get(l["route_id"], ("TER", "", "")), l["trip_headsign"], services[l["service_id"]])

    # Un seul passage de stop_times : on garde les arrêts en gare de la métropole et le terminus de chaque train
    arrets, terminus = defaultdict(list), {}
    for l in lire(z, "stop_times.txt"):
        t = l["trip_id"]
        if t not in trajets:
            continue
        s = int(l["stop_sequence"])
        if s >= terminus.get(t, (-1, ""))[0]:
            terminus[t] = (s, l["stop_id"])
        if l["stop_id"] in quai_gare and l["pickup_type"] != "1":
            arrets[t].append((s, l["departure_time"][:5], quai_gare[l["stop_id"]]))

    passages = defaultdict(list)
    for t, liste in arrets.items():
        (ligne, couleur, texte), numero, dates = trajets[t]
        fin_seq, fin_quai = terminus[t]
        destination = noms.get(fin_quai, "")
        for s, heure, gare in liste:
            if s == fin_seq:
                continue  # le train finit ici : pas un départ
            for d in dates:
                if d == hier and heure < "24:00":
                    continue
                passages[gares[gare][0]].append([d, heure, ligne or "TER", destination, numero, couleur, texte])

    os.makedirs(sortie, exist_ok=True)
    for uic, liste in passages.items():
        liste.sort()
        with open(os.path.join(sortie, f"{uic}.json"), "w", encoding="utf-8") as f:
            json.dump(liste, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(sortie, "gares.json"), "w", encoding="utf-8") as f:
        json.dump([g for sa, g in gares.items() if g[0] in passages], f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(passages)} gares TER, {sum(len(v) for v in passages.values())} passages")


if __name__ == "__main__":
    main()
