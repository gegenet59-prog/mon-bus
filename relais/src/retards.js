// Relevé des retards (Lille) : toutes les 5 minutes, le relais lit le temps réel d'Ilevia et, pour chaque bus qui passe
// dans les 5 minutes, compare l'heure annoncée à l'heure prévue la plus proche (horaires/lille/prevu_quais.json).
// On ne garde que des totaux, par ligne + quai + type de jour + heure : nombre de bus, somme des retards, somme des carrés,
// nombre de retards de 5 min ou plus. De quoi calculer plus tard des moyennes et le « mauvais jour » (1 fois sur 5).
// Stockage : Durable Object « Retards » (SQLite), quelques Mo au plus même après des mois.

import { heureParis } from "./pannes.js";

const SITE = "https://gegenet59-prog.github.io/mon-bus";
const typeJour = d => [6, 0].includes(d.getUTCDay()) ? (d.getUTCDay() === 6 ? "sam" : "dim") : "sem";

export class Retards {
  constructor(ctx, env) {
    this.ctx = ctx; this.sql = ctx.storage.sql; this.prevu = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS retards (cle TEXT PRIMARY KEY, ligne TEXT, quai TEXT, jour TEXT, heure INTEGER,
                   n INTEGER, somme REAL, carres REAL, gros INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS vus (cle TEXT PRIMARY KEY, t INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS journal (jour TEXT PRIMARY KEY, releves INTEGER, bus INTEGER)`);
  }

  async horairesPrevus(jour) {
    if (this.prevu?.jour === jour) return this.prevu;
    const r = await fetch(`${SITE}/horaires/lille/prevu_quais.json`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.jour !== jour) return null;          // fichier de la veille (avant la mise à jour de la nuit) : on attend
    return (this.prevu = d);
  }

  async relever() {
    const ici = new Date(heureParis());                       // heure de Paris écrite en UTC (convention Ilevia)
    const jour = ici.toISOString().slice(0, 10).replace(/-/g, "");
    const maintenant = ici.getTime();
    const prevu = await this.horairesPrevus(jour);
    if (!prevu) return { attente: "horaires du jour pas encore publiés" };
    const p = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "dsp_ilevia:prochains_passages",
      outputFormat: "application/json", propertyName: "code_ligne,code_arret_physique,heure_estimee_depart" });
    const r = await fetch(`https://data.lillemetropole.fr/geoserver/wfs?${p}`);
    if (!r.ok) return { erreur: r.status };
    const minuit = Date.UTC(ici.getUTCFullYear(), ici.getUTCMonth(), ici.getUTCDate());
    let bus = 0;
    for (const f of (await r.json()).features || []) {
      const { code_ligne: ligne, code_arret_physique: quai, heure_estimee_depart: h } = f.properties;
      const t = Date.parse(h || "");
      if (!ligne || !quai || !t || t < maintenant || t >= maintenant + 5 * 60000) continue;   // seulement les bus sur le point de passer
      const liste = prevu.q[quai]?.[ligne];
      if (!liste) continue;
      const annonce = (t - minuit) / 60000;
      // heure prévue la plus proche (dans ±30 min)
      let a = 0, b = liste.length;
      while (a < b) { const m = (a + b) >> 1; if (liste[m] < annonce) a = m + 1; else b = m; }
      const proches = [liste[a - 1], liste[a]].filter(x => x !== undefined && Math.abs(x - annonce) <= 30);
      if (!proches.length) continue;
      const sched = proches.sort((x, y) => Math.abs(x - annonce) - Math.abs(y - annonce))[0];
      const vu = `${jour}|${ligne}|${quai}|${sched}`;
      if (this.sql.exec("SELECT 1 FROM vus WHERE cle = ?", vu).toArray().length) continue;   // ce bus est déjà compté
      this.sql.exec("INSERT INTO vus (cle, t) VALUES (?, ?)", vu, maintenant);
      const retard = Math.round((annonce - sched) * 10) / 10;
      const tj = typeJour(ici), heure = Math.floor(sched / 60) % 24;
      const cle = `${ligne}|${quai}|${tj}|${heure}`;
      this.sql.exec(`INSERT INTO retards (cle, ligne, quai, jour, heure, n, somme, carres, gros) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
                     ON CONFLICT(cle) DO UPDATE SET n = n + 1, somme = somme + excluded.somme, carres = carres + excluded.carres, gros = gros + excluded.gros`,
                     cle, ligne, quai, tj, heure, retard, retard * retard, retard >= 5 ? 1 : 0);
      bus++;
    }
    this.sql.exec(`INSERT INTO journal (jour, releves, bus) VALUES (?, 1, ?) ON CONFLICT(jour) DO UPDATE SET releves = releves + 1, bus = bus + excluded.bus`, jour, bus);
    this.sql.exec("DELETE FROM vus WHERE t < ?", maintenant - 2 * 86400000);   // la mémoire des bus vus ne sert que 2 jours
    return { bus };
  }

  async fetch(requete) {
    const action = new URL(requete.url).pathname.slice(1);
    const ok = d => new Response(JSON.stringify(d, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (action === "relever") return ok(await this.relever());
    if (action === "bilan") {    // contrôle : jours enregistrés, nombre de bus, lignes les plus en retard
      const journal = this.sql.exec("SELECT * FROM journal ORDER BY jour DESC LIMIT 14").toArray();
      const total = this.sql.exec("SELECT COUNT(*) AS cles, SUM(n) AS bus FROM retards").toArray()[0];
      const lignes = this.sql.exec(`SELECT ligne, SUM(n) AS bus, ROUND(SUM(somme) / SUM(n), 1) AS retard_moyen,
                                   ROUND(100.0 * SUM(gros) / SUM(n)) AS pct_5min_ou_plus FROM retards GROUP BY ligne HAVING bus >= 20
                                   ORDER BY retard_moyen DESC LIMIT 15`).toArray();
      return ok({ total, journal, lignes_les_plus_en_retard: lignes });
    }
    return new Response("?", { status: 404 });
  }
}
