#!/usr/bin/env python3
"""Moteur commun : horaires prévus d'un réseau (GTFS) au format compacté, pour l'appli « Mon bus ».

Usage : python3 scripts/build_ville.py <ville> <chemin_ou_url_du_gtfs.zip> [dossier_sortie]
Écrit dans <dossier_sortie>/<ville>/ (par défaut horaires/<ville>/) :
  - stations.json : {"stations": {NOM: [identifiants d'arrêts]}}
  - arrets.json   : [[identifiant, NOM, commune, latitude, longitude], ...]   (pour « Autour de moi »)
  - <id>.json     : passages prévus de l'arrêt (aujourd'hui, demain, + la nuit d'hier), compactés :
        {"l": [[ligne, type, couleur, couleur texte, route_id], ...],   lignes (type GTFS : 0 tram, 1 métro, 3 bus…)
         "s": [direction, ...],                              directions
         "q": [quai, ...],                                   codes de quais (stop_id)
         "t": [trajet, ...],                                 identifiants de trajets (pour le temps réel)
         "j": {"AAAAMMJJ": [[minutes, n° ligne, n° direction, n° quai, n° trajet, n° d'ordre, n° arrêt suivant], ...]}}
     L'arrêt suivant (rangé dans la table « s ») sert à distinguer deux sens qui affichent la même direction (boucles).
     « minutes » = minutes depuis minuit du jour de service (peut dépasser 1440 : bus après minuit).
Compacter = écrire chaque nom une seule fois et le remplacer ensuite par son numéro : aucune information perdue.
"""
import csv
import io
import json
import math
import os
import re
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")


def normaliser(texte):
    """Même règle que dans l'appli : sans accents, majuscules, sans tirets ni apostrophes."""
    t = unicodedata.normalize("NFD", texte)
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").upper()
    for c in "-'’.,?!":
        t = t.replace(c, " ")
    return " ".join(t.split())


def lire(z, nom):
    if nom not in z.namelist():
        return
    with z.open(nom) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def metres(a, b, c, d):
    r = math.radians
    h = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def services_actifs(z, jours):
    """service_id -> dates actives parmi « jours » (calendar.txt + calendar_dates.txt)."""
    actifs = defaultdict(set)
    noms_jours = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for l in lire(z, "calendar.txt"):
        for j in jours:
            d = datetime.strptime(j, "%Y%m%d")
            if l["start_date"] <= j <= l["end_date"] and l[noms_jours[d.weekday()]] == "1":
                actifs[l["service_id"]].add(j)
    for l in lire(z, "calendar_dates.txt"):
        if l["date"] in jours:
            if l["exception_type"] == "1":
                actifs[l["service_id"]].add(l["date"])
            elif l["exception_type"] == "2":
                actifs[l["service_id"]].discard(l["date"])
    return actifs


SORTIE = ""


def construire_reseau(ordre, tous, svc_types, jours_type, parent_de, sur, lignes, stops):
    """Plan du réseau pour les itinéraires, valable toute la saison :
    {"l": [[code, type, couleur, couleur texte], ...],
     "jours": {"AAAAMMJJ": [n° des groupes qui roulent ce jour-là]},
     "p": [[n° ligne, direction, [arrêts], [[profil de temps : minutes depuis le 1er arrêt, pour chaque arrêt], ...],
            {"n° groupe": [départ du 1er arrêt × 1024 + n° de profil, ...]}], ...]}
    Profils de temps : un trajet de midi met plus longtemps qu'un trajet de 6 h ; chaque trajet garde le sien
    (au plus 1024 par parcours, sinon le plus proche), pour que l'heure à chaque arrêt soit celle de l'horaire.
    Groupe = services qui roulent les mêmes jours. Chaque trajet n'est écrit qu'une fois : petit fichier pour toute la saison.
    Un « parcours » = une ligne + une suite d'arrêts ; l'heure de passage à un arrêt = départ + somme des temps."""
    tables_l, idx_l, parcours = [], {}, {}
    for t, liste in ordre.items():
        route, direction, service = tous[t]
        suite, cumul, depart = [], [], None
        for _, sid, mn in liste:
            pid = parent_de.get(sid)
            if pid is None or (suite and suite[-1] == sur[pid]):
                continue
            if not suite:
                depart = mn
            if depart is None:
                break
            suite.append(sur[pid])
            cumul.append(max(cumul[-1] if cumul else 0, (mn - depart) if mn is not None else (cumul[-1] + 2 if cumul else 0)))
        if len(suite) < 2 or depart is None:
            continue
        if route not in idx_l:
            l = lignes.get(route, [route, 3, "", "", route])
            idx_l[route] = len(tables_l)
            tables_l.append(l[:4])
        direction = normaliser(direction or stops.get(liste[-1][1], {}).get("stop_name", ""))
        cle = (route, tuple(suite))
        p = parcours.get(cle)
        if p is None:
            p = parcours[cle] = [idx_l[route], direction, suite, [], defaultdict(list)]
        profil = tuple(cumul)
        if profil in p[3]:
            n = p[3].index(profil)
        elif len(p[3]) < 1024:
            p[3].append(profil); n = len(p[3]) - 1
        else:   # trop de profils : le plus proche
            n = min(range(1024), key=lambda i: sum(abs(a - b) for a, b in zip(p[3][i], profil)))
        p[4][svc_types[service]].append(depart * 1024 + n)
    for p in parcours.values():
        p[3] = [list(x) for x in p[3]]
        p[4] = {str(k): sorted(v) for k, v in p[4].items()}
    return {"l": tables_l, "jours": jours_type, "p": list(parcours.values())}



def completer_communes(arrets):
    """Arrêts du même nom à plus d'1 km l'un de l'autre (Wagner à Lille ET à Wattrelos) sans commune dans les données :
    on demande la commune à l'API officielle geo.api.gouv.fr (par position). En cas d'échec, l'appli dit « près de … »."""
    import urllib.request
    par_nom = defaultdict(list)
    for a in arrets:
        par_nom[a[1]].append(a)
    a_faire = [a for liste in par_nom.values() if len(liste) > 1
               and any(metres(x[3], x[4], y[3], y[4]) > 1000 for x in liste for y in liste)
               for a in liste if not a[2]]
    # Hors de la nuit (publication après une modification) : on reprend les communes déjà publiées, sans appeler l'API
    if os.environ.get("GITHUB_EVENT_NAME") == "push" and a_faire:
        try:
            url = f"https://gegenet59-prog.github.io/mon-bus/horaires/{os.path.basename(SORTIE)}/arrets.json"
            with urllib.request.urlopen(url, timeout=20) as r:
                connues = {x[0]: x[2] for x in json.load(r) if x[2]}
            for a in a_faire:
                a[2] = connues.get(a[0], "")
            print(f"  communes reprises du site publié : {sum(1 for a in a_faire if a[2])}/{len(a_faire)}")
            return
        except Exception:
            pass   # site injoignable : on fait comme la nuit
    trouves = echecs = 0
    for a in a_faire:
        if echecs >= 5:      # API injoignable : on n'insiste pas
            break
        try:
            url = f"https://geo.api.gouv.fr/communes?lat={a[3]}&lon={a[4]}&fields=nom&format=json"
            with urllib.request.urlopen(url, timeout=10) as r:
                rep = json.load(r)
            if rep:
                a[2] = rep[0]["nom"]
                trouves += 1
            echecs = 0
        except Exception:
            echecs += 1
    if a_faire:
        print(f"  communes des arrêts homonymes : {trouves}/{len(a_faire)} trouvées (geo.api.gouv.fr)")


def main():
    ville, source = sys.argv[1], sys.argv[2]
    global SORTIE
    sortie = SORTIE = os.path.join(sys.argv[3] if len(sys.argv) > 3 else "horaires", ville.lower())
    if source.startswith("http"):
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0 (mon-bus)"})
        with urllib.request.urlopen(req, timeout=600) as r:
            donnees = r.read()
    else:
        with open(source, "rb") as f:
            donnees = f.read()
    z = zipfile.ZipFile(io.BytesIO(donnees))

    aujourd_hui = datetime.now(PARIS).date()
    hier = (aujourd_hui - timedelta(days=1)).strftime("%Y%m%d")
    jours = {(aujourd_hui + timedelta(days=d)).strftime("%Y%m%d") for d in (-1, 0, 1)}
    actifs = services_actifs(z, jours)
    # Saison complète (pour les itinéraires) : chaque date reçoit un « type de jour » (même ensemble de services)
    fins = [l["end_date"] for l in lire(z, "calendar.txt")] + [l["date"] for l in lire(z, "calendar_dates.txt")]
    derniere = min(max(fins) if fins else aujourd_hui.strftime("%Y%m%d"), (aujourd_hui + timedelta(days=400)).strftime("%Y%m%d"))
    saison, d = [], aujourd_hui - timedelta(days=1)
    while d.strftime("%Y%m%d") <= derniere:
        saison.append(d.strftime("%Y%m%d")); d += timedelta(days=1)
    par_date = defaultdict(set)
    for svc, ds in services_actifs(z, set(saison)).items():
        for x in ds:
            par_date[x].add(svc)
    # services qui roulent exactement les mêmes jours = un seul « groupe » (Ilevia : des milliers de services, quelques dizaines de groupes)
    dates_de = defaultdict(set)
    for x in saison:
        for svc in par_date[x]:
            dates_de[svc].add(x)
    groupes, svc_types = {}, {}
    for svc, ds in dates_de.items():
        svc_types[svc] = groupes.setdefault(frozenset(ds), len(groupes))
    jours_type = {x: sorted({svc_types[v] for v in par_date[x]}) for x in saison}
    print(f"  saison jusqu'au {derniere} : {len(svc_types)} services, {len(groupes)} groupes de jours")

    # ---------- Arrêts : regroupement des quais par arrêt ----------
    # Avec parent_station quand le réseau le fournit, sinon par nom identique à moins de 400 m
    stops = {l["stop_id"]: l for l in lire(z, "stops.txt")}
    parent_de, infos, positions = {}, {}, defaultdict(list)
    groupes = defaultdict(list)  # nom -> [(id groupe, lat, lon)]
    compteur = 0
    for sid, l in stops.items():
        if l.get("location_type", "0") not in ("", "0"):
            continue
        try:
            lat, lon = float(l["stop_lat"]), float(l["stop_lon"])
        except (ValueError, KeyError):
            continue
        # « Laennec Quai B » et « Laennec Quai A » sont le même arrêt : on retire le nom du quai
        nom = re.sub(r"\s+(QUAI|QUAIS|QUAY|POTEAU)\s+\w+$", "", normaliser(l["stop_name"]))
        pid = l.get("parent_station") or ""
        if not pid or pid not in stops:
            pid = None
            for gid, glat, glon in groupes[nom]:
                if metres(lat, lon, glat, glon) < 400:
                    pid = gid
                    break
            if pid is None:
                compteur += 1
                pid = f"g{compteur}"
                groupes[nom].append((pid, lat, lon))
            commune = l.get("stop_desc", "")
        else:
            commune = stops[pid].get("stop_desc", "")
        # stop_desc n'est gardé comme commune que s'il ressemble à un nom de ville
        commune = commune.strip() if commune and len(commune) < 40 and not re.search(r"\d", commune) else ""
        parent_de[sid] = pid
        infos.setdefault(pid, (nom, commune.title() if commune.isupper() else commune))
        positions[pid].append((lat, lon))
    # identifiants de fichiers sûrs
    sur = {pid: re.sub(r"[^A-Za-z0-9_-]", "_", pid) for pid in infos}

    # ---------- Lignes et trajets du jour ----------
    lignes = {l["route_id"]: [l.get("route_short_name") or l.get("route_long_name") or l["route_id"],
                              int(l.get("route_type") or 3) % 100 if (l.get("route_type") or "3").isdigit() else 3,
                              l.get("route_color", ""), l.get("route_text_color", ""), l["route_id"]]
              for l in lire(z, "routes.txt")}
    tous = {l["trip_id"]: (l["route_id"], l.get("trip_headsign", ""), l["service_id"])
            for l in lire(z, "trips.txt") if l["service_id"] in svc_types}
    trajets = {t: (r, h, actifs[svc]) for t, (r, h, svc) in tous.items() if actifs.get(svc)}

    # Ordre des arrêts de chaque trajet : terminus (pas un départ), direction par défaut et arrêt suivant
    ordre = defaultdict(list)
    for l in lire(z, "stop_times.txt"):
        if l["trip_id"] in tous:
            hh = (l.get("departure_time") or l.get("arrival_time") or "").split(":")
            mn = int(hh[0]) * 60 + int(hh[1]) if len(hh) >= 2 and hh[0].isdigit() else None
            ordre[l["trip_id"]].append((int(l["stop_sequence"]), l["stop_id"], mn))
    fin, suivant = {}, {}
    for t, liste in ordre.items():
        liste.sort()
        fin[t] = liste[-1][:2]
        for (s1, a, _), (s2, b, _) in zip(liste, liste[1:]):
            suivant[(t, s1)] = normaliser(stops.get(b, {}).get("stop_name", ""))
    reseau = construire_reseau(ordre, tous, svc_types, jours_type, parent_de, sur, lignes, stops)
    del ordre

    par_arret = defaultdict(list)
    for l in lire(z, "stop_times.txt"):
        t = l["trip_id"]
        if t not in trajets or l["stop_id"] not in parent_de:
            continue
        s = int(l["stop_sequence"])
        if s == fin[t][0] or l.get("pickup_type") == "1":
            continue
        heure = l["departure_time"] or l["arrival_time"]
        if not heure:
            continue
        h, m = heure.split(":")[:2]
        minutes = int(h) * 60 + int(m)
        route, direction, dates = trajets[t]
        direction = direction or stops.get(fin[t][1], {}).get("stop_name", "")
        for d in dates:
            if d == hier and minutes < 1440:
                continue
            par_arret[parent_de[l["stop_id"]]].append((d, minutes, route, direction, l["stop_id"], t, s, suivant.get((t, s), "")))

    # ---------- Écriture compactée ----------
    os.makedirs(sortie, exist_ok=True)
    total = 0
    for pid, liste in par_arret.items():
        liste.sort()
        idx = {"l": {}, "s": {}, "q": {}, "t": {}}
        tables = {"l": [], "s": [], "q": [], "t": []}

        def num(cle, valeur, contenu=None):
            if valeur not in idx[cle]:
                idx[cle][valeur] = len(tables[cle])
                tables[cle].append(contenu if contenu is not None else valeur)
            return idx[cle][valeur]

        j = defaultdict(list)
        for d, minutes, route, direction, quai, t, s, via in liste:
            j[d].append([minutes, num("l", route, lignes.get(route, [route, 3, "", "", route])), num("s", direction),
                         num("q", quai), num("t", t), s, num("s", via)])
            total += 1
        with open(os.path.join(sortie, f"{sur[pid]}.json"), "w", encoding="utf-8") as f:
            json.dump({**tables, "j": j}, f, ensure_ascii=False, separators=(",", ":"))

    stations = defaultdict(list)
    for pid in par_arret:
        stations[infos[pid][0]].append(sur[pid])
    arrets = [[sur[pid], infos[pid][0], infos[pid][1],
               round(sum(p[0] for p in positions[pid]) / len(positions[pid]), 5),
               round(sum(p[1] for p in positions[pid]) / len(positions[pid]), 5)] for pid in par_arret]
    completer_communes(arrets)
    with open(os.path.join(sortie, "stations.json"), "w", encoding="utf-8") as f:
        json.dump({"genere": datetime.now(PARIS).isoformat(timespec="minutes"), "stations": stations},
                  f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(sortie, "arrets.json"), "w", encoding="utf-8") as f:
        json.dump(arrets, f, ensure_ascii=False, separators=(",", ":"))
    # Horaires prévus d'aujourd'hui par quai (code d'arrêt physique) et par ligne : sert au relais pour mesurer les retards
    # (il compare l'heure annoncée en temps réel à l'heure prévue la plus proche)
    jour = aujourd_hui.strftime("%Y%m%d")
    par_quai = defaultdict(lambda: defaultdict(list))
    for liste in par_arret.values():
        for d, minutes, route, direction, quai, t, s, via in liste:
            if d == jour:
                code = lignes.get(route, [route])[0]
                par_quai[stops.get(quai, {}).get("stop_code") or quai][code].append(minutes)
    with open(os.path.join(sortie, "prevu_quais.json"), "w", encoding="utf-8") as f:
        json.dump({"jour": jour, "q": {q: {l: sorted(set(m)) for l, m in d.items()} for q, d in par_quai.items()}},
                  f, ensure_ascii=False, separators=(",", ":"))
    # Plan du réseau pour les itinéraires : suite des arrêts de chaque ligne, temps entre arrêts, trajets par heure
    with open(os.path.join(sortie, "reseau.json"), "w", encoding="utf-8") as f:
        json.dump(reseau, f, ensure_ascii=False, separators=(",", ":"))
    # Type de chaque ligne (route_id -> [code, type GTFS]) : sert au relais pour trier les alertes (métro, tram…)
    with open(os.path.join(sortie, "lignes.json"), "w", encoding="utf-8") as f:
        json.dump({rid: [l[0], l[1]] for rid, l in lignes.items()}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{ville} : {len(par_arret)} arrêts, {total} passages")


if __name__ == "__main__":
    main()
