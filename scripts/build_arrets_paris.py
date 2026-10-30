#!/usr/bin/env python3
"""Liste des arrêts d'Île-de-France avec leur position, pour « Autour de moi » (mode PARIS).

Écrit horaires/arrets_paris.json : [[numéro IDFM, libellé, latitude, longitude], ...]
L'appli calcule elle-même les arrêts les plus proches (pas d'appel à l'API depuis le téléphone).

Usage : python3 scripts/build_arrets_paris.py [dossier_sortie]
Clé PRIM : variable d'environnement CLE_PRIM, sinon la clé de l'appli.
"""
import json
import os
import sys
import time
import urllib.request

PRIM = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/stop_areas"
CLE = os.environ.get("CLE_PRIM") or "4nXb9R6YGCqMyntuh0GmKY3U8xtlSk27"


def page(n):
    req = urllib.request.Request(f"{PRIM}?count=1000&depth=0&start_page={n}", headers={"apikey": CLE})
    for essai in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception:
            if essai == 2:
                raise
            time.sleep(5)


def main():
    sortie = sys.argv[1] if len(sys.argv) > 1 else "horaires"
    arrets, n = [], 0
    while True:
        d = page(n)
        for s in d.get("stop_areas", []):
            c = s.get("coord") or {}
            try:
                arrets.append([s["id"].split(":")[-1], s.get("label") or s["name"],
                               round(float(c["lat"]), 5), round(float(c["lon"]), 5)])
            except (KeyError, ValueError):
                pass
        pg = d["pagination"]
        n += 1
        if n * pg["items_per_page"] >= pg["total_result"]:
            break
    os.makedirs(sortie, exist_ok=True)
    with open(os.path.join(sortie, "arrets_paris.json"), "w", encoding="utf-8") as f:
        json.dump(arrets, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(arrets)} arrêts d'Île-de-France")


if __name__ == "__main__":
    main()
