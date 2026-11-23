// Test de la pastille orange « +N » des bus en direct (Lille) avec un FAUX temps réel construit à partir des horaires prévus de Porte d'Arras :
//  - un bus 14 annoncé 5 min après l'horaire prévu  → pastille « +5 »
//  - un bus 14 annoncé 2 min après (sous le seuil)   → pas de pastille
//  - un bus 14 annoncé 2 min avant (en avance)       → pas de pastille
// Usage : node tests/tester_pastille_retard.js [adresse]   (par défaut http://localhost:8765/)
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:8765/";
(async () => {
  const nav = await chromium.launch();
  const page = await (await nav.newContext({ viewport: { width: 390, height: 780 }, timezoneId: "Europe/Paris" })).newPage();
  const erreurs = []; page.on("pageerror", e => erreurs.push(String(e)));
  // Horloge fixée au lundi 9 nov. 2026, 21h : c'est un jour couvert par les horaires de la copie locale (la nuit, GitHub régénère horaires/)
  await page.clock.install({ time: new Date("2026-11-09T21:00:00+01:00") });
  await page.goto(BASE); await page.evaluate(() => localStorage.setItem("ville", "LILLE")); await page.reload();
  const prevus = await page.evaluate(async () => {
    const f = await chargerCompact("lille", "866"), n = new Date();
    const d = `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
    const nowMin = n.getHours() * 60 + n.getMinutes();
    return (f.j[d] || []).map(([min, li, si, qi]) => ({ min, ligne: f.l[li][0], sens: f.s[si], quai: f.q[qi] })).filter(x => x.ligne === "14" && x.min >= nowMin + 12 && x.min <= nowMin + 120);
  });
  if (prevus.length < 3) { console.log("⚠️ pas assez de passages prévus de la 14 dans les 2 prochaines heures pour tester", prevus.length); await nav.close(); process.exit(2); }
  const [a, b, c] = prevus;
  const heure = (min, decalage) => new Date(Date.UTC(2026, 10, 9, 0, min + decalage)).toISOString().slice(0, 19) + "Z";   // lundi 9 nov. 2026
  const feat = (x, dec) => ({ type: "Feature", properties: { nom_station: "LILLE PORTE D'ARRAS", code_ligne: x.ligne, sens_ligne: x.sens.toUpperCase(), code_arret_physique: x.quai, heure_estimee_depart: heure(x.min, dec) } });
  await page.route(/geoserver\/wfs.*prochains_passages/, r => r.fulfill({ contentType: "application/json", body: JSON.stringify({ type: "FeatureCollection", features: [feat(a, 5), feat(b, 2), feat(c, -2)] }) }));
  await page.fill("#question", "14 Porte d'Arras"); await page.press("#question", "Enter"); await page.waitForTimeout(3500);
  const lignes = await page.$$eval("#resultats .ligne", l => l.map(x => ({ sens: x.querySelector(".sens")?.textContent, min: x.querySelector(".min")?.textContent.replace(/\s+/g, " ").trim(), retards: [...x.querySelectorAll(".retard")].map(e => e.textContent) })));
  console.log(JSON.stringify(lignes, null, 1));
  const tous = lignes.flatMap(l => l.retards);
  const bon = tous.includes("+5") && tous.length === 1;
  console.log(`${bon ? "✅" : "❌"} pastilles affichées : ${JSON.stringify(tous)} (attendu : seulement +5)`);
  await page.screenshot({ path: "/tmp/pastille.png" });
  if (erreurs.length) console.log("Erreurs JS :", erreurs);
  await nav.close(); process.exit(bon && !erreurs.length ? 0 : 1);
})();
