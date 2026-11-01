// Robot « chaque nom d'arrêt » : tape le nom de CHAQUE station d'une ville et vérifie que l'appli retrouve la même station.
// Usage : node tests/robot_noms.js VILLE [VILLE…]   (serveur local http://localhost:8765/ avec horaires/ générés)
// Affiche les noms mal retrouvés (tapé -> trouvé) et les noms présents à plusieurs endroits (homonymes).
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:8765/";
(async () => {
  const nav = await chromium.launch();
  const page = await nav.newPage({ timezoneId: "Europe/Paris" });
  for (const ville of process.argv.slice(2)) {
    await page.goto(BASE);
    await page.evaluate(v => localStorage.setItem("ville", v), ville);
    await page.goto(BASE);
    const res = await page.evaluate(async v => {
      VILLE = v;
      const conf = villeActuelle();
      const index = (await (await fetch(`horaires/${conf.gtfs}/stations.json`)).json()).stations;
      const arrets = await (await fetch(`horaires/${conf.gtfs}/arrets.json`)).json();
      const pos = Object.fromEntries(arrets.map(a => [a[0], a]));
      const noms = Object.keys(index), rates = [], homonymes = [];
      for (const n of noms) {
        const tape = titre(n);
        const { arret } = analyser(tape);
        NOMS_ECARTES = new Set();
        const trouve = arret.length ? meilleurNom(noms, arret) : null;
        if (trouve !== n && normaliser(trouve || "") !== normaliser(n)) rates.push(`${tape} -> ${trouve ? titre(trouve) : "RIEN"}`);
        const pts = index[n].map(i => pos[i]).filter(Boolean);
        const loin = pts.some(p => pts.some(q => distance(p[3], p[4], q[3], q[4]) > 1000));
        if (loin) homonymes.push(`${tape} (${[...new Set(pts.map(p => p[2]).filter(Boolean))].join(", ") || index[n].length + " quais"})`);
      }
      return { total: noms.length, rates, homonymes };
    }, ville);
    console.log(`\n=== ${ville} : ${res.total} noms · ${res.rates.length} mal retrouvés · ${res.homonymes.length} homonymes`);
    res.rates.forEach(x => console.log("  ✗ " + x));
    console.log("  homonymes : " + res.homonymes.join(" ; "));
  }
  await nav.close();
})();
