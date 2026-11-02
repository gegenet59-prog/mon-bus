// Pannes de métro / tram / RER par ville, au même format pour toutes les villes :
// { id, ville, mode: "METRO" | "TRAM" | "RER" | "TRAIN", lignes: ["1"], grave: true/false, titre, texte, fin }
// grave = interruption, service réduit ou gros retards (ce qui déclenche une alerte) ; sinon simple info (travaux…)

const CLE_PRIM = "4nXb9R6YGCqMyntuh0GmKY3U8xtlSk27"; // clé gratuite de Nice, déjà visible dans l'appli
const SITE = "https://gegenet59-prog.github.io/mon-bus";

// Réseaux qui publient leurs alertes au format GTFS-RT (protobuf)
const ALERTES_GTFS = {
  BORDEAUX: "https://bdx.mecatran.com/utw/ws/gtfsfeed/alerts/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt",
  MONTPELLIER: "https://gtfsproxy.e-tam.fr/COMMON/Alert.pb",
  RENNES: "https://proxy.transport.data.gouv.fr/resource/star-rennes-integration-gtfs-rt-alerts",   // bus seulement pour l'instant
};
export const VILLES_PANNES = ["LILLE", "PARIS", ...Object.keys(ALERTES_GTFS)];

const sansBalises = t => (t || "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// ---------- Lecture protobuf minimale (comme dans l'appli) ----------
function lireProto(buf, debut = 0, fin = buf.length) {
  const champs = [];
  let i = debut;
  const varint = () => { let r = 0, m = 1, o; do { o = buf[i++]; r += (o & 127) * m; m *= 128; } while (o & 128); return r; };
  while (i < fin) {
    const cle = varint(), num = Math.floor(cle / 8), type = cle & 7;
    if (type === 0) champs.push([num, varint()]);
    else if (type === 2) { const n = varint(); champs.push([num, [i, i + n]]); i += n; }
    else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else break;
  }
  return champs;
}
const decodeur = new TextDecoder();
const texte = (buf, [a, b]) => decodeur.decode(buf.subarray(a, b));
function traduction(buf, plage) {           // TranslatedString -> texte en français de préférence
  let t = "", fr = "";
  for (const [n, v] of lireProto(buf, ...plage)) if (n === 1) {
    let s = "", lang = "";
    for (const [k, w] of lireProto(buf, ...v)) { if (k === 1) s = texte(buf, w); if (k === 2) lang = texte(buf, w); }
    if (!t) t = s;
    if (lang.startsWith("fr")) fr = s;
  }
  return fr || t;
}

// Type de chaque ligne (route_id -> [code, type GTFS]), écrit chaque nuit par scripts/build_ville.py
async function lignesDe(ville) {
  const cache = caches.default, cle = new Request(`https://relais.mon-bus/lignes/v2/${ville}`);
  const enCache = await cache.match(cle);
  if (enCache) return enCache.json();
  const r = await fetch(`${SITE}/horaires/${ville.toLowerCase()}/lignes.json`);
  const d = r.ok ? await r.json() : {};
  if (r.ok) await cache.put(cle, new Response(JSON.stringify(d), { headers: { "Cache-Control": "public, max-age=21600" } }));
  return d;
}
const MODE_GTFS = { 0: "TRAM", 1: "METRO", 2: "TRAIN", 5: "TRAM", 7: "TRAM" };

async function pannesGtfs(ville) {
  const r = await fetch(ALERTES_GTFS[ville], { headers: { "User-Agent": "MonBus-relais/1.0" } });
  if (!r.ok) throw new Error(`${ville} ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const lignes = await lignesDe(ville), maintenant = Date.now() / 1000, res = [];
  for (const [n, ent] of lireProto(buf)) {
    if (n !== 2) continue;
    let id = "", alerte = null;
    for (const [m, v] of lireProto(buf, ...ent)) { if (m === 1) id = texte(buf, v); if (m === 5) alerte = v; }
    if (!alerte) continue;
    const routes = new Set(), types = new Set(), periodes = [];
    let effet = 0, titre = "", desc = "";
    for (const [k, v] of lireProto(buf, ...alerte)) {
      if (k === 1) { const p = { debut: 0, fin: 0 }; for (const [a, b] of lireProto(buf, ...v)) { if (a === 1) p.debut = b; if (a === 2) p.fin = b; } periodes.push(p); }
      if (k === 5) for (const [a, b] of lireProto(buf, ...v)) { if (a === 2) routes.add(texte(buf, b)); if (a === 3) types.add(b); }
      if (k === 7) effet = v;
      if (k === 10) titre = traduction(buf, v);
      if (k === 11) desc = traduction(buf, v);
    }
    // seulement les alertes en cours
    if (periodes.length && !periodes.some(p => (!p.debut || p.debut <= maintenant) && (!p.fin || p.fin >= maintenant))) continue;
    const parMode = {};
    for (const route of routes) {
      const [code, type] = lignes[route] || [];
      const mode = MODE_GTFS[type];
      if (mode) (parMode[mode] ??= new Set()).add(code);
    }
    for (const t of types) if (MODE_GTFS[t] && !routes.size) parMode[MODE_GTFS[t]] ??= new Set();
    const fin = Math.max(0, ...periodes.map(p => p.fin || 0));
    for (const [mode, codes] of Object.entries(parMode))
      res.push({ id: `${ville}:${id}:${mode}`, ville, mode, lignes: [...codes].sort(), grave: [1, 2, 3].includes(effet),
                 titre: sansBalises(titre), texte: sansBalises(desc || titre), fin: fin ? new Date(fin * 1000).toISOString() : null });
  }
  return res;
}

// Ilevia laisse ses messages d'incident 24 h (heure_fin_prevue = +24 h) alors que la panne dure souvent 10 minutes.
// Ses heures finissent par « Z » mais sont à l'heure de Paris. Fin réelle : l'heure écrite dans le message
// (« interrompue jusque 15h 50 ») + 30 min de marge ; sans heure, un incident est oublié au bout de 3 h.
export const heureParis = () => { // l'heure de Paris, écrite comme si c'était de l'UTC (même convention qu'Ilevia)
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
};
export function perimeIlevia(x, maintenant = heureParis()) {
  if (x.heure_fin_prevue && Date.parse(x.heure_fin_prevue) < maintenant) return true;
  const modif = Date.parse(x.date_modification || "");
  if (!modif || x.type_perturbation !== "Perturbation") return false;
  const h = sansBalises(x.message).match(/jusqu(?:e|'?\s?(?:à|a|’à))\s*(\d{1,2})\s*h\s*(\d{2})?/i);
  if (h) {
    let fin = Math.floor(modif / 86400000) * 86400000 + (+h[1] * 60 + +(h[2] || 0)) * 60000;
    if (fin < modif - 3600000) fin += 86400000;      // « jusque 0h30 » écrit à 23h50 : le lendemain
    return maintenant > fin + 30 * 60000;
  }
  return maintenant > modif + 3 * 3600000;
}

async function tramsEnTempsReel() {
  const p = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "dsp_ilevia:prochains_passages",
                                  outputFormat: "application/json", CQL_FILTER: "code_ligne='TRAM'" });
  const r = await fetch(`https://data.lillemetropole.fr/geoserver/wfs?${p}`);
  return r.ok ? ((await r.json()).features || []).map(f => f.properties) : [];
}
const sansAccents = t => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
export function tramRepart(x, trams) {
  const modif = Date.parse(x.date_modification || "");
  // passages mis à jour au moins 10 min après le message (le flux d'Ilevia est à l'heure de Paris, comme les messages)
  const frais = trams.filter(t => Date.parse(t.date_modification || "") > modif + 10 * 60000);
  if (!frais.length) return false;
  const m = sansBalises(x.message).match(/entre (?:les stations |la station |l'arr[êe]t )?(.+?) et (?:la station |l'arr[êe]t )?(.+?)(?= jusqu| à partir|[.,;(]|$)/i);
  if (!m) return true;
  const voulues = [m[1], m[2]].map(sansAccents);
  return voulues.every(v => frais.some(t => { const n = sansAccents(t.nom_station); return n.includes(v) || v.includes(n); }));
}

async function pannesLille() {
  const p = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "dsp_ilevia:perturbations", outputFormat: "application/json" });
  const r = await fetch(`https://data.lillemetropole.fr/geoserver/wfs?${p}`);
  if (!r.ok) throw new Error(`LILLE ${r.status}`);
  const res = [];
  // Ilevia publie un nouveau message à chaque mise à jour d'un incident (« jusque 19h55 » puis « jusque 20h00 ») sans
  // retirer l'ancien : pour chaque ligne, on ne garde que l'incident le plus récent
  const plusRecents = {};
  for (const f of (await r.json()).features || []) {
    const x = f.properties, cle = `${x.cible}|${x.type_perturbation}`;
    if (x.type_perturbation !== "Perturbation" || !plusRecents[cle] || (x.date_modification || "") > (plusRecents[cle].date_modification || ""))
      plusRecents[x.type_perturbation === "Perturbation" ? cle : x.identifiant_message] = x;
  }
  let trams = null;   // passages du tram en temps réel (lus seulement s'il y a une panne de tram)
  for (const x of Object.values(plusRecents)) {
    const code = (x.cible || "").split("::")[1]?.split(":")[0] || "";
    const mode = /^ME\d$/.test(code) ? "METRO" : /^(TRAM|TR|T|R)$/.test(code) ? "TRAM" : null;
    if (!mode) continue;
    if (perimeIlevia(x)) continue;   // message périmé
    // Tram : il est dans le temps réel d'Ilevia (pas le métro). Si des trams sont de nouveau annoncés
    // aux stations citées dans le message (ou n'importe où si aucune), la panne est finie, même si le message traîne
    if (mode === "TRAM" && x.type_perturbation === "Perturbation") {
      trams ??= await tramsEnTempsReel().catch(() => []);
      if (tramRepart(x, trams)) continue;
    }
    const t = sansBalises(x.message);
    res.push({ id: x.type_perturbation === "Perturbation" ? `LILLE:${code}` : `LILLE:${x.identifiant_message}`, ville: "LILLE", mode,
               lignes: mode === "METRO" ? [code.replace("ME", "")] : [], grave: x.type_perturbation === "Perturbation",
               titre: t.split(/[.:]\s/)[0].slice(0, 120), texte: t, fin: x.heure_fin_prevue || null });
  }
  return res;
}

// Paris : rapports de ligne Navitia (métro, RER, tram), un appel par mode
const MODES_PARIS = { METRO: "physical_mode:Metro", RER: "physical_mode:RapidTransit", TRAM: "physical_mode:Tramway" };
async function pannesParis() {
  const res = [];
  for (const [mode, pm] of Object.entries(MODES_PARIS)) {
    const r = await fetch(`https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/physical_modes/${pm}/line_reports?count=100&disable_geojson=true`,
                          { headers: { apikey: CLE_PRIM } });
    if (!r.ok) throw new Error(`PARIS ${r.status}`);
    const d = await r.json();
    const touchees = {};   // perturbation -> codes des lignes touchées (liens de la ligne et de ses arrêts)
    for (const lr of d.line_reports || []) {
      const code = lr.line?.code;
      const liens = [...(lr.line?.links || []), ...(lr.pt_objects || []).flatMap(o => o.links || o[o.embedded_type]?.links || [])];
      for (const link of liens) if (link.type === "disruption") (touchees[link.id] ??= new Set()).add(code);
    }
    for (const di of d.disruptions || []) {
      if (di.status !== "active" || !touchees[di.id]) continue;
      const m = (di.messages || []).find(x => (x.channel?.types || []).includes("web")) || (di.messages || [])[0];
      const titreMsg = (di.messages || []).find(x => (x.channel?.types || []).includes("title"));
      const t = sansBalises(m?.text);
      const effet = di.severity?.effect || "";
      // Une panne de ligne touche la ligne (ou un tronçon) ; un ascenseur ou un escalier en panne n'est qu'une info de station
      const surLaLigne = (di.impacted_objects || []).some(o => ["line", "line_section"].includes(o.pt_object?.embedded_type) || o.impacted_section);
      const tout = `${titreMsg?.text || ""} ${m?.text || ""}`;
      // ascenseur, escalier… en panne : info de station, pas une panne de ligne (et il y en a des centaines) -> ignorées
      if (/ascenseur|escalier|escalator|trottoir roulant|guichet|distributeur/i.test(tout)) continue;
      // travaux, horaires modifiés, offre allégée : prévus à l'avance, ce n'est pas une panne
      const prevu = /travaux|modification des horaires|horaires modifi|all[eè]gement|offre (de transport )?(est )?r[ée]duite|bus de (nuit|remplacement)/i.test(tout)
                    || /travaux/i.test(di.cause || "");
      res.push({ id: `PARIS:${di.id}`, ville: "PARIS", mode, lignes: [...touchees[di.id]].sort(),
                 grave: surLaLigne && !prevu && ["NO_SERVICE", "REDUCED_SERVICE", "SIGNIFICANT_DELAYS"].includes(effet),
                 titre: sansBalises(titreMsg?.text) || t.split(/[.:]\s/)[0].slice(0, 120), texte: t,
                 fin: (di.application_periods?.at(-1)?.end || "").replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6") || null });
    }
  }
  return res;
}

// Pannes d'une ville (gardées en cache : Paris 15 min pour le quota PRIM, les autres 2 min)
export async function pannes(ville) {
  const cache = caches.default, cle = new Request(`https://relais.mon-bus/pannes/v7/${ville}`);
  const enCache = await cache.match(cle);
  if (enCache) return enCache.json();
  const liste = ville === "LILLE" ? await pannesLille() : ville === "PARIS" ? await pannesParis()
              : ALERTES_GTFS[ville] ? await pannesGtfs(ville) : [];
  await cache.put(cle, new Response(JSON.stringify(liste), { headers: { "Cache-Control": `public, max-age=${ville === "PARIS" ? 900 : 120}` } }));
  return liste;
}
