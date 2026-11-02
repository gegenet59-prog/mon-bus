#!/usr/bin/env python3
"""Vérifie le plan du réseau (reseau.json) utilisé par l'itinéraire : pour chaque ligne et chaque trajet d'aujourd'hui,
l'heure calculée à chaque arrêt (départ + profil de temps) doit exister dans le fichier d'horaires de l'arrêt (issu du GTFS).
Usage : python3 tests/verifier_itineraire.py lille [AAAAMMJJ] [dossier]"""
import json, sys, os
from collections import defaultdict
ville = sys.argv[1]; d = sys.argv[3] if len(sys.argv) > 3 else f"horaires/{ville}"
r = json.load(open(f"{d}/reseau.json"))
jour = sys.argv[2] if len(sys.argv) > 2 else sorted(r["jours"])[1]
groupes = set(r["jours"].get(jour, []))
cache = {}
def passages(arret):   # (code ligne, minute) présents dans le fichier de l'arrêt pour ce jour
    if arret not in cache:
        f = f"{d}/{arret}.json"
        s = set()
        if os.path.exists(f):
            x = json.load(open(f))
            for m, li, *_ in x["j"].get(jour, []): s.add((x["l"][li][0], m))
        cache[arret] = s
    return cache[arret]
ok = ecart = absent = 0; pires = defaultdict(int); exemples = []
for p in r["p"]:
    code = r["l"][p[0]][0]
    for g, deps in p[4].items():
        if int(g) not in groupes: continue
        for v in deps:
            dep, prof = divmod(v, 1024)
            for k, arret in enumerate(p[2][:-1]):          # le terminus n'est pas un départ
                m = dep + p[3][prof][k]
                s = passages(arret)
                if (code, m) in s: ok += 1
                elif any((code, m + e) in s for e in (-2, -1, 1, 2)):
                    ecart += 1; pires[code] += 1
                else:
                    absent += 1; pires[code] += 1
                    if len(exemples) < 8: exemples.append(f"{code} {p[1][:25]} arrêt {arret} {m // 60:02d}:{m % 60:02d}")
total = ok + ecart + absent
print(f"{ville} {jour} : {total} passages vérifiés · exacts {ok} ({100 * ok / max(total, 1):.2f} %) · écart 1-2 min {ecart} · introuvables {absent}")
if pires: print("  lignes concernées :", sorted(pires.items(), key=lambda x: -x[1])[:10])
for e in exemples: print("  ex.", e)
