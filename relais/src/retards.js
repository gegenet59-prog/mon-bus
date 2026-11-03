// Relevé des retards (Lille) : toutes les 5 minutes, le relais lit le temps réel d'Ilevia et, pour chaque bus qui passe
// dans les 5 minutes, compare l'heure annoncée à l'heure prévue la plus proche (horaires/lille/prevu_quais.json).
// On ne garde que des totaux, par ligne + quai + type de jour + heure : nombre de bus, somme des retards, somme des carrés,
// nombre de retards de 5 min ou plus. De quoi calculer plus tard des moyennes et le « mauvais jour » (1 fois sur 5).
// Stockage : Durable Object « Retards », quelques centaines de Ko même après des mois.

import { heureParis } from "./pannes.js";

const SITE = "https://gegenet59-prog.github.io/mon-bus";
const typeJour = d => [6, 0].includes(d.getUTCDay()) ? (d.getUTCDay() === 6 ? "sam" : "dim") : "sem";

// Offre gratuite Cloudflare : 100 000 lignes écrites et 5 millions de lignes lues par jour (pour tous les Durable Objects
// du compte). Une première version écrivait une ligne par bus et les a dépassés en une matinée, ce qui a bloqué aussi les alertes.
// Désormais : quelques « paquets » seulement par relevé (un par type de jour + heure, et la liste courte des bus déjà comptés),
// soit environ 3 écritures toutes les 5 minutes (~900 par jour).
export class Retards {
  constructor(ctx, env) { this.st = ctx.storage; this.prevu = null; }

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
    const tj = typeJour(ici);
    const vus = (await this.st.get("vus")) || {};             // bus déjà comptés (on oublie au bout d'une heure)
    for (const [k, t] of Object.entries(vus)) if (t < maintenant - 3600000) delete vus[k];
    const paquets = {};                                       // "a:sem:17" -> { "ligne|quai": [n, somme, carrés, gros] }
    let bus = 0;
    for (const f of (await r.json()).features || []) {
      const { code_ligne: ligne, code_arret_physique: quai, heure_estimee_depart: h } = f.properties;
      const t = Date.parse(h || "");
      if (!ligne || !quai || !t || t < maintenant || t >= maintenant + 5 * 60000) continue;   // seulement les bus sur le point de passer
      const liste = prevu.q[quai]?.[ligne];
      if (!liste) continue;
      const annonce = (t - minuit) / 60000;
      let a = 0, b = liste.length;
      while (a < b) { const m = (a + b) >> 1; if (liste[m] < annonce) a = m + 1; else b = m; }
      const proches = [liste[a - 1], liste[a]].filter(x => x !== undefined && Math.abs(x - annonce) <= 30);
      if (!proches.length) continue;
      const sched = proches.sort((x, y) => Math.abs(x - annonce) - Math.abs(y - annonce))[0];
      const vu = `${jour}|${ligne}|${quai}|${sched}`;
      if (vus[vu]) continue;
      vus[vu] = maintenant;
      const retard = Math.round((annonce - sched) * 10) / 10;
      const cle = `a:${tj}:${Math.floor(sched / 60) % 24}`;
      paquets[cle] ??= (await this.st.get(cle)) || {};
      const x = (paquets[cle][`${ligne}|${quai}`] ??= [0, 0, 0, 0]);
      x[0]++; x[1] = Math.round((x[1] + retard) * 10) / 10; x[2] = Math.round(x[2] + retard * retard); x[3] += retard >= 5 ? 1 : 0;
      bus++;
    }
    const journal = (await this.st.get("journal")) || {};
    journal[jour] = [(journal[jour]?.[0] || 0) + 1, (journal[jour]?.[1] || 0) + bus];
    await this.st.put({ ...paquets, vus, journal });          // une seule écriture groupée
    return { bus };
  }

  async fetch(requete) {
    const action = new URL(requete.url).pathname.slice(1);
    const ok = d => new Response(JSON.stringify(d, null, 1), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    if (action === "relever") return ok(await this.relever());
    if (action === "bilan") {    // contrôle : jours enregistrés (relevés, bus), lignes les plus en retard
      const journal = Object.entries((await this.st.get("journal")) || {}).slice(-14).map(([j, [releves, bus]]) => ({ jour: j, releves, bus }));
      const parLigne = {};
      for (const paquet of (await this.st.list({ prefix: "a:" })).values())
        for (const [k, [n, somme, , gros]] of Object.entries(paquet)) {
          const l = (parLigne[k.split("|")[0]] ??= [0, 0, 0]); l[0] += n; l[1] += somme; l[2] += gros;
        }
      const lignes = Object.entries(parLigne).filter(([, v]) => v[0] >= 20)
        .map(([ligne, [bus, somme, gros]]) => ({ ligne, bus, retard_moyen: Math.round(somme / bus * 10) / 10, pct_5min_ou_plus: Math.round(100 * gros / bus) }))
        .sort((a, b) => b.retard_moyen - a.retard_moyen).slice(0, 15);
      return ok({ bus: Object.values(parLigne).reduce((t, v) => t + v[0], 0), journal, lignes_les_plus_en_retard: lignes });
    }
    return new Response("?", { status: 404 });
  }
}
