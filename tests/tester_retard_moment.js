// Test du « retard du moment » dans l'itinéraire : avec un faux retard de 8 min sur la 14, ses départs des 90 prochaines minutes
// doivent être décalés de 8 min ; une autre ligne, et un départ lointain (dans 3 h), ne doivent pas bouger.
// Usage : node tests/tester_retard_moment.js [adresse]   (par défaut http://localhost:8765/)
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:8765/";
(async () => {
  const nav = await chromium.launch();
  const page = await (await nav.newContext({ timezoneId: "Europe/Paris" })).newPage();
  const erreurs = []; page.on("pageerror", e => erreurs.push(String(e)));
  await page.goto(BASE); await page.evaluate(() => localStorage.setItem("ville", "LILLE")); await page.reload();
  const res = await page.evaluate(async () => {
    await chargerReseau();
    const R = ITI.reseau, code = pi => R.l[R.p[pi][0]][0];
    const pi14 = R.p.findIndex((p, i) => code(i) === "14"), piL1 = R.p.findIndex((p, i) => code(i) === "L1");
    const maintenant = new Date(), lointain = new Date(Date.now() + 3 * 3600000);
    const retards = { "14": { r: 8, n: 5 } };
    const h0 = preparerHoraires(maintenant, {}), h1 = preparerHoraires(maintenant, retards), h2 = preparerHoraires(lointain, retards);
    const nowMin = maintenant.getHours() * 60 + maintenant.getMinutes();
    const fenetre = l => l.filter(x => x[0] >= nowMin - 5 && x[0] <= nowMin + 90).map(x => x[0]);   // la zone qui doit être décalée
    const lointainMin = (lointain.getHours() * 60 + lointain.getMinutes());
    return {
      pi14, piL1, nowMin,
      avant14: fenetre(h0(pi14)), apres14: h1(pi14).map(x => x[0]).filter(v => v >= nowMin + 3 && v <= nowMin + 98),
      avantL1: fenetre(h0(piL1)), apresL1: fenetre(h1(piL1)),
      lointain: JSON.stringify(h2(pi14).filter(x => x[0] >= lointainMin && x[0] <= lointainMin + 60).map(x => x[0]).slice(0, 4))
               === JSON.stringify(preparerHoraires(lointain, {})(pi14).filter(x => x[0] >= lointainMin && x[0] <= lointainMin + 60).map(x => x[0]).slice(0, 4)),
    };
  });
  const decale = res.avant14.length > 0 && res.avant14.every(v => res.apres14.includes(v + 8));
  const intact = JSON.stringify(res.avantL1) === JSON.stringify(res.apresL1);
  console.log(res);
  console.log(`${decale ? "✅" : "❌"} la 14 est décalée de +8 min · ${intact ? "✅" : "❌"} la L1 ne bouge pas · ${res.lointain ? "✅" : "❌"} départ dans 3 h : rien ne bouge`);
  if (erreurs.length) console.log("Erreurs JS :", erreurs);
  await nav.close();
  process.exit(decale && intact && res.lointain && !erreurs.length ? 0 : 1);
})();
