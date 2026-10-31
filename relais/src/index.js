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
    // RTM Marseille (SIRI, requêtes SOAP) : test d'accès
    if (nom === "rtm-test") {
      const type = url.searchParams.get("req") === "lignes" ? "LinesDiscovery" : "CheckStatus";
      const maintenant = new Date().toISOString();
      const corps = `<?xml version="1.0" encoding="UTF-8"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sw="http://wsdl.siri.org.uk" xmlns:siri="http://www.siri.org.uk/siri"><S:Body><sw:${type}><Request><siri:RequestTimestamp>${maintenant}</siri:RequestTimestamp><siri:RequestorRef>open-data</siri:RequestorRef><siri:MessageIdentifier>monbus-${Date.now()}</siri:MessageIdentifier></Request><RequestExtension/></sw:${type}></S:Body></S:Envelope>`;
      try {
        const r = await fetch("https://siri.lametropolemobilite.fr/RTM", { method: "POST", body: corps, headers: { "Content-Type": "text/xml; charset=utf-8" } });
        const texte = await r.text();
        return new Response(`HTTP ${r.status}\n\n${texte.slice(0, 20000)}`, { headers: { ...ENTETES_CORS, "Content-Type": "text/plain; charset=utf-8" } });
      } catch (e) {
        return new Response("Erreur : " + e.message, { status: 502, headers: ENTETES_CORS });
      }
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
