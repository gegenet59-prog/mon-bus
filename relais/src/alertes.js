// Alertes « panne de métro / tram » envoyées sur le téléphone (Web Push), gérées par un Durable Object.
// Il garde : la clé VAPID du relais (créée une fois, jamais publiée sauf sa moitié publique), les abonnés
// (adresse de notification du navigateur + villes/lignes choisies) et les pannes déjà signalées.
// Aucune donnée personnelle : juste l'adresse anonyme fournie par le navigateur et les lignes choisies.
//
// Notification sans contenu chiffré : le téléphone reçoit un « réveil », puis va lire son message ici (?flux=alerte).

import { pannes, VILLES_PANNES } from "./pannes.js";

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const texteB64url = s => b64url(new TextEncoder().encode(s));
async function hacher(s) { return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 22); }

// Une ligne choisie (« METRO:1 », « TRAM:* ») est-elle touchée par cette panne ?
const concerne = (choix, p) => choix.some(c => {
  const [mode, code] = c.split(":");
  return mode === p.mode && (code === "*" || !p.lignes.length || p.lignes.includes(code));
});
const nomLignes = p => {
  const m = { METRO: "Métro", TRAM: "Tram", RER: "RER", TRAIN: "Train" }[p.mode] || p.mode;
  return p.lignes.length ? p.lignes.map(l => `${m} ${l}`).join(", ") : m;
};

export class Alertes {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.st = ctx.storage; }

  async vapid() {
    let v = await this.st.get("vapid");
    if (!v) {
      const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      v = { prive: await crypto.subtle.exportKey("jwk", k.privateKey), public: b64url(await crypto.subtle.exportKey("raw", k.publicKey)) };
      await this.st.put("vapid", v);
    }
    return v;
  }

  // Envoie un « réveil » au téléphone ; renvoie le code HTTP du service de notification
  async reveiller(endpoint) {
    const v = await this.vapid();
    const cle = await crypto.subtle.importKey("jwk", v.prive, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const entete = texteB64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const corps = texteB64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
                                               sub: "https://gegenet59-prog.github.io/mon-bus/" }));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cle, new TextEncoder().encode(`${entete}.${corps}`));
    const r = await fetch(endpoint, { method: "POST", headers: { TTL: "3600", Urgency: "high",
      Authorization: `vapid t=${entete}.${corps}.${b64url(sig)}, k=${v.public}` } });
    return r.status;
  }

  async fetch(requete) {
    const url = new URL(requete.url);
    const action = url.pathname.slice(1);
    const ok = d => new Response(JSON.stringify(d), { headers: { "Content-Type": "application/json" } });

    if (action === "vapid") return ok({ cle: (await this.vapid()).public });

    if (action === "abonner") {          // { endpoint, choix: { LILLE: ["METRO:1", "TRAM:*"] } }
      const d = await requete.json();
      // adresse fournie par le navigateur (https) ; 127.0.0.1 seulement pour les tests locaux
      if (!d.endpoint || !/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(d.endpoint)) return ok({ erreur: "adresse invalide" });
      const choix = {};
      for (const [ville, l] of Object.entries(d.choix || {}))
        if (VILLES_PANNES.includes(ville) && Array.isArray(l)) choix[ville] = l.filter(x => /^[A-Z]+:[\w*]{1,6}$/.test(x)).slice(0, 60);
      const id = await hacher(d.endpoint);
      if (!Object.values(choix).some(l => l.length)) { await this.st.delete(`abo:${id}`); return ok({ abonne: false }); }
      const ancien = await this.st.get(`abo:${id}`);
      await this.st.put(`abo:${id}`, { endpoint: d.endpoint, choix, message: ancien?.message || null });
      return ok({ abonne: true });
    }

    if (action === "message") {          // le téléphone vient lire le message qui l'a réveillé
      const id = await hacher(url.searchParams.get("endpoint") || "");
      const a = await this.st.get(`abo:${id}`);
      return ok(a?.message || { titre: "Mon bus", texte: "Info trafic : ouvre l'appli pour voir le détail." });
    }

    if (action === "test") {             // notification d'essai juste après l'abonnement
      const endpoint = url.searchParams.get("endpoint") || "";
      const id = await hacher(endpoint);
      const a = await this.st.get(`abo:${id}`);
      if (!a) return ok({ envoye: false });
      a.message = { titre: "🔔 Alertes activées", texte: "Tu seras prévenu ici en cas de panne sur tes lignes.", ville: Object.keys(a.choix)[0] };
      await this.st.put(`abo:${id}`, a);
      return ok({ envoye: await this.reveiller(endpoint) });
    }

    if (action === "verifier") return ok(await this.verifier(url.searchParams.get("paris") === "1"));
    return new Response("?", { status: 404 });
  }

  // Appelé toutes les 5 minutes : nouvelles pannes graves -> alerte ; panne terminée -> « trafic rétabli »
  async verifier(avecParis) {
    const abonnes = await this.st.list({ prefix: "abo:" });
    const villes = new Set();
    for (const a of abonnes.values()) for (const [v, l] of Object.entries(a.choix)) if (l.length) villes.add(v);
    const bilan = {};
    for (const ville of villes) {
      if (ville === "PARIS" && !avecParis) continue;     // Paris : tous les quarts d'heure seulement (quota PRIM)
      let liste;
      try { liste = (await pannes(ville)).filter(p => p.grave); } catch { continue; }
      const vus = (await this.st.get(`vus:${ville}`)) || {};
      const actuels = Object.fromEntries(liste.map(p => [p.id, p]));
      const nouvelles = liste.filter(p => !vus[p.id]);
      const finies = Object.values(vus).filter(p => !actuels[p.id]);
      let envois = 0;
      for (const [cle, a] of abonnes) {
        const choix = a.choix[ville] || [];
        const etat = p => /interromp|coupé|aucun(e)? (train|métro|rame|circulation)/i.test(`${p.titre} ${p.texte}`) ? "interrompu" : "perturbé";
        const pour = [...nouvelles.filter(p => concerne(choix, p)).map(p => ({ titre: `⚠️ ${nomLignes(p)} : ${etat(p)}`, texte: p.texte.slice(0, 400) })),
                      ...finies.filter(p => concerne(choix, p)).map(p => ({ titre: `✅ ${nomLignes(p)} : trafic rétabli`, texte: "La perturbation signalée est terminée." }))];
        if (!pour.length) continue;
        // une seule notification (le téléphone lit le dernier message) : plusieurs pannes à la fois sont regroupées
        a.message = pour.length === 1 ? { ...pour[0], ville }
          : { titre: `${pour[0].titre.slice(0, 80)} (+${pour.length - 1})`, texte: pour.map(m => m.titre).join("\n").slice(0, 400), ville };
        await this.st.put(cle, a);
        const code = await this.reveiller(a.endpoint).catch(() => 0);
        if (code === 404 || code === 410) await this.st.delete(cle);   // abonnement supprimé par le téléphone
        else envois++;
      }
      await this.st.put(`vus:${ville}`, Object.fromEntries(liste.map(p => [p.id, { id: p.id, mode: p.mode, lignes: p.lignes, titre: p.titre, texte: "" }])));
      bilan[ville] = { pannes: liste.length, nouvelles: nouvelles.length, finies: finies.length, envois };
    }
    return bilan;
  }
}
