// Relais temps réel de « Mon bus » (Cloudflare Workers).
// Certains réseaux publient leur temps réel sans autoriser les pages web à le lire (en-tête CORS absent).
// Ce relais le lit à la place du téléphone et le renvoie avec l'autorisation. Il ne stocke rien,
// garde seulement la réponse 20 secondes (tous les utilisateurs partagent le même appel au réseau).
//
// Usage : https://<relais>/?flux=nice   (seuls les flux de la liste ci-dessous sont acceptés)

const FLUX = {
  // GTFS-RT « trip updates » (protobuf)
  nice: "https://ara-api.enroute.mobi/rla/gtfs/trip-updates",
  montpellier: "https://gtfsproxy.e-tam.fr/COMMON/TripUpdate.pb",
};

const DUREE_CACHE = 20; // secondes

const ENTETES_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(requete, env, ctx) {
    if (requete.method === "OPTIONS") return new Response(null, { headers: ENTETES_CORS });
    const url = new URL(requete.url);
    const nom = url.searchParams.get("flux");
    if (!nom) {
      return new Response(JSON.stringify({ relais: "Mon bus", flux: Object.keys(FLUX) }), {
        headers: { ...ENTETES_CORS, "Content-Type": "application/json; charset=utf-8" },
      });
    }
    // Lyon (TCL) : prochains passages du Grand Lyon, accès avec le compte data.grandlyon.com
    // (identifiants rangés dans les secrets Cloudflare GRANDLYON_USER / GRANDLYON_MDP, jamais dans le code)
    // ?flux=lyon&arret=1234  -> passages de cet arrêt physique (plusieurs : arret=1,2,3)
    if (nom === "lyon" || nom === "lyon-test") {
      if (!env.GRANDLYON_USER || !env.GRANDLYON_MDP) return new Response("Identifiants Grand Lyon absents", { status: 500, headers: ENTETES_CORS });
      const auth = "Basic " + btoa(`${env.GRANDLYON_USER}:${env.GRANDLYON_MDP}`);
      const base = "https://data.grandlyon.com/fr/datapusher/ws/rdata/tcl_sytral.tclpassagearret/all.json";
      const arrets = (url.searchParams.get("arret") || "").split(",").filter(a => /^\d{1,6}$/.test(a)).slice(0, 12);
      if (nom === "lyon-test") {
        const r = await fetch(`${base}?maxfeatures=3`, { headers: { Authorization: auth } });
        return new Response(`HTTP ${r.status}\n\n${(await r.text()).slice(0, 3000)}`, { headers: { ...ENTETES_CORS, "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (!arrets.length) return new Response("Paramètre arret manquant", { status: 400, headers: ENTETES_CORS });
      const cache = caches.default;
      const resultats = await Promise.all(arrets.map(async a => {
        const cle = new Request(`https://relais.mon-bus/lyon/${a}`);
        const enCache = await cache.match(cle);
        if (enCache) return enCache.json();
        const r = await fetch(`${base}?field=id&value=${a}&maxfeatures=200`, { headers: { Authorization: auth } });
        if (!r.ok) return [];
        const d = await r.json();
        const lignes = (d.values || []).map(v => ({ id: v.id, ligne: v.ligne, direction: v.direction, heure: v.heurepassage,
                                                    type: v.type, course: v.coursetheorique, dest: v.idtarretdestination }));
        ctx.waitUntil(cache.put(cle, new Response(JSON.stringify(lignes), { headers: { "Cache-Control": `public, max-age=${DUREE_CACHE}` } })));
        return lignes;
      }));
      return new Response(JSON.stringify(resultats.flat()), {
        headers: { ...ENTETES_CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${DUREE_CACHE}` },
      });
    }
    const source = FLUX[nom];
    if (!source) return new Response("Flux inconnu", { status: 404, headers: ENTETES_CORS });

    // Réponse déjà en cache (moins de 20 s) ?
    const cache = caches.default;
    const cle = new Request(`https://relais.mon-bus/${nom}`);
    const enCache = await cache.match(cle);
    if (enCache) return enCache;

    let reponse;
    try {
      reponse = await fetch(source, { headers: { "User-Agent": "MonBus-relais/1.0" }, cf: { cacheTtl: DUREE_CACHE } });
    } catch (e) {
      return new Response("Réseau injoignable", { status: 502, headers: ENTETES_CORS });
    }
    if (!reponse.ok) return new Response(`Réseau : erreur ${reponse.status}`, { status: 502, headers: ENTETES_CORS });

    const corps = await reponse.arrayBuffer();
    const finale = new Response(corps, {
      headers: {
        ...ENTETES_CORS,
        "Content-Type": reponse.headers.get("Content-Type") || "application/octet-stream",
        "Cache-Control": `public, max-age=${DUREE_CACHE}`,
      },
    });
    ctx.waitUntil(cache.put(cle, finale.clone()));
    return finale;
  },
};
