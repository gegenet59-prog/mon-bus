// Test de la croix ✕ et de la prédiction d'arrêts (téléphone simulé). Usage : node tests/tester_prediction.js [adresse]
// Note : en local, seuls Lille et Paris ont leurs horaires complets ; ailleurs « aucun résultat » est normal (même sans prédiction).
// Pour chaque ville : on tape le début d'un arrêt, on lit les propositions, on clique la première, on vérifie le résultat, puis la croix.
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:8765/";
const CAS = [
  ["LILLE", "repub", "République"], ["LILLE", "14 c1 rep", "République"], ["LILLE", "wagn", "Wagner"], ["LILLE", "gare lille fl", "Flandres"],
  ["PARIS", "chatel", "Châtelet"], ["PARIS", "métro 4 gare du n", "Gare du Nord"],
  ["BORDEAUX", "quinc", "Quinconces"], ["RENNES", "repu", "République"], ["MONTPELLIER", "come", "Comédie"], ["NICE", "mass", "Masséna"],
];
(async () => {
  const nav = await chromium.launch();
  const ctx = await nav.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, timezoneId: "Europe/Paris" });
  const page = await ctx.newPage();
  const erreurs = []; page.on("pageerror", e => erreurs.push(String(e)));
  let ko = 0;
  for (const [ville, tape, attendu] of CAS) {
    await page.goto(BASE); await page.evaluate(v => localStorage.setItem("ville", v), ville); await page.reload();
    await page.waitForTimeout(600);
    await page.fill("#question", ""); await page.type("#question", tape, { delay: 30 });
    await page.waitForTimeout(900);
    const props = await page.$$eval("#suggQ button", b => b.map(x => x.textContent));
    const croix = await page.$eval("#effacerQ", e => !e.hidden);
    let titre = "", valeur = "";
    if (props.length) {
      await page.click("#suggQ button");
      await page.waitForTimeout(3500);
      titre = await page.$eval("#resultats .arret h2, #resultats h2", e => e.textContent).catch(() => "(aucun résultat)");
      valeur = await page.inputValue("#question");
    }
    const sans = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const bon = props.length && props.some(p => sans(p).includes(sans(attendu))) && croix;
    if (!bon) ko++;
    console.log(`${bon ? "✅" : "❌"} ${ville} « ${tape} » → ${props.slice(0, 4).join(" | ")}  ⇒ barre « ${valeur} » · résultat « ${titre.trim().slice(0, 50)} » · croix ${croix}`);
    await page.click("#effacerQ");
    const vide = await page.inputValue("#question"), cache = await page.$eval("#effacerQ", e => e.hidden);
    if (vide !== "" || !cache) { ko++; console.log("   ❌ la croix n'a pas vidé la barre"); }
  }
  if (erreurs.length) { ko++; console.log("Erreurs JS :", erreurs); }
  await page.screenshot({ path: "/tmp/pred.png" });
  console.log(ko ? `\n${ko} problème(s)` : "\nTout est bon"); await nav.close();
})();
