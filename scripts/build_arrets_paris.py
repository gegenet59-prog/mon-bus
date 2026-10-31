#!/usr/bin/env python3
"""Données d'Île-de-France préparées chaque nuit, pour économiser le quota PRIM (1 000 appels/jour).

Écrit :
  horaires/arrets_paris.json : [[numéro IDFM, libellé, latitude, longitude, ferré], ...]
      ferré = 1 si la station est desservie par métro, RER, Transilien, train, tram, Orlyval/CDG VAL,
      funiculaire ou téléphérique (sert à préférer « Châtelet » station à un arrêt de bus homonyme)
  horaires/lignes_paris.json : {numéro de ligne IDFM: [code, couleur, couleur du texte, mode commercial, nom]}

L'appli cherche les arrêts et habille les lignes avec ces fichiers, sans appel à l'API.
Coût : environ 30 appels par nuit.

Usage : python3 scripts/build_arrets_paris.py [dossier_sortie]
Clé PRIM : variable d'environnement CLE_PRIM, sinon la clé de l'appli.
"""
import json
import os
import sys
import time
import urllib.request

NAVITIA = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia"
CLE = os.environ.get("CLE_PRIM") or "4nXb9R6YGCqMyntuh0GmKY3U8xtlSk27"
MODES_FERRES = ["Metro", "RapidTransit", "LocalTrain", "Train", "Tramway", "RailShuttle", "Funicular", "SuspendedCableCar"]


def appel(chemin):
    req = urllib.request.Request(f"{NAVITIA}/{chemin}", headers={"apikey": CLE})
    for essai in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception:
            if essai == 2:
                raise
            time.sleep(5)


def toutes_les_pages(chemin, cle):
    """Parcourt les pages Navitia (1 000 éléments par page)."""
    n, res = 0, []
    while True:
        sep = "&" if "?" in chemin else "?"
        d = appel(f"{chemin}{sep}count=1000&depth=0&start_page={n}")
        res += d.get(cle, [])
        pg = d.get("pagination") or {}
        n += 1
        if not pg or n * pg["items_per_page"] >= pg["total_result"]:
            return res


def main():
    sortie = sys.argv[1] if len(sys.argv) > 1 else "horaires"
    os.makedirs(sortie, exist_ok=True)

    # Stations desservies par un mode ferré (ou tram, téléphérique…)
    ferres = set()
    for mode in MODES_FERRES:
        try:
            for s in toutes_les_pages(f"physical_modes/physical_mode:{mode}/stop_areas", "stop_areas"):
                ferres.add(s["id"].split(":")[-1])
        except Exception as e:
            print(f"mode {mode} ignoré : {e}")

    arrets = []
    for s in toutes_les_pages("stop_areas", "stop_areas"):
        c = s.get("coord") or {}
        try:
            num = s["id"].split(":")[-1]
            arrets.append([num, s.get("label") or s["name"], round(float(c["lat"]), 5), round(float(c["lon"]), 5),
                           1 if num in ferres else 0])
        except (KeyError, ValueError):
            pass
    with open(os.path.join(sortie, "arrets_paris.json"), "w", encoding="utf-8") as f:
        json.dump(arrets, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(arrets)} arrêts d'Île-de-France, dont {len(ferres)} stations ferrées ou tram")

    lignes = {}
    for l in toutes_les_pages("lines", "lines"):
        lignes[l["id"].split(":")[-1]] = [l.get("code") or "", l.get("color") or "", l.get("text_color") or "",
                                          (l.get("commercial_mode") or {}).get("name", ""), l.get("name") or ""]
    with open(os.path.join(sortie, "lignes_paris.json"), "w", encoding="utf-8") as f:
        json.dump(lignes, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(lignes)} lignes d'Île-de-France")


if __name__ == "__main__":
    main()
