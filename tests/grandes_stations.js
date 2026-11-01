// Test réel des grandes stations : les N stations les plus desservies de chaque ville, avec le temps réel.
// Usage : node tests/grandes_stations.js VILLE [VILLE…]   (N=30 par défaut, variable N=…)
// Pour chaque station : arrêt affiché, nombre de lignes/directions, part en temps réel (📡), et alertes :
//   DOUBLON (même ligne + même direction deux fois), TERMINUS (direction = l'arrêt lui-même), RT KO (flux en panne).
const { chromium } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "http://localhost:8765/";
const N = +(process.env.N || 30);
const normaliser = t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
(async () => {
  const nav = await chromium.launch();
  const page = await nav.newPage({ timezoneId: "Europe/Paris" });
  for (const ville of process.argv.slice(2)) {
    await page.goto(BASE);
    await page.evaluate(v => localStorage.setItem("ville", v), ville);
    await page.goto(BASE);
    // stations classées par taille de leurs fichiers d'horaires (= nombre de passages)
    const dossier = `horaires/${ville.toLowerCase()}`;
    const index = JSON.parse(fs.readFileSync(`${dossier}/stations.json`)).stations;
    const taille = n => index[n].reduce((t, id) => t + (fs.existsSync(`${dossier}/${id}.json`) ? fs.statSync(`${dossier}/${id}.json`).size : 0), 0);
    const noms = await page.evaluate(l => l.map(titre), Object.keys(index).sort((a, b) => taille(b) - taille(a)).slice(0, N));
    console.log(`\n=== ${ville}`);
    let alertes = 0;
    for (const q of noms) {
      await page.evaluate(q => chercher(q), q);
      await page.waitForFunction(() => !/Recherche/.test(document.getElementById("statut").innerText), null, { timeout: 30000 }).catch(() => {});
      const info = await page.evaluate(() => {
        const t = document.querySelector("#resultats h2")?.innerText || "-";
        const lignes = [...document.querySelectorAll("#resultats .ligne")].map(l => ({
          num: l.querySelector(".num").innerText.replace(/\n/g, " "), sens: l.querySelector(".sens").innerText.replace("→ ", ""),
          rt: l.querySelector(".min").innerText.includes("📡") }));
        return { t, lignes, statut: document.getElementById("statut").innerText, choix: document.querySelectorAll("#proches button").length };
      });
      const cles = info.lignes.map(l => l.num + " → " + l.sens);
      const doublons = cles.filter((c, i) => cles.indexOf(c) !== i);
      const terminus = info.lignes.filter(l => normaliser(l.sens) === normaliser(info.t)).map(l => l.num);
      const rt = info.lignes.filter(l => l.rt).length;
      const pb = [doublons.length && `DOUBLON ${doublons.join(", ")}`, terminus.length && `TERMINUS ${terminus.join(", ")}`,
                  /indisponible/.test(info.statut) && "RT KO", !info.lignes.length && info.statut].filter(Boolean);
      alertes += pb.length;
      console.log(`${q.padEnd(32)} | ${info.t.slice(0, 30).padEnd(30)} | ${String(info.lignes.length).padStart(2)} dir. | 📡 ${rt}`
        + (info.choix ? ` | ${info.choix} homonymes` : "") + (pb.length ? " | ⚠️ " + pb.join(" | ") : ""));
    }
    console.log(`→ ${ville} : ${alertes} alerte(s)`);
  }
  await nav.close();
})();
