// Robot Paris : tape le nom de chacune des stations ferrées d'Île-de-France (métro, RER, Transilien, tram,
// téléphérique…) et vérifie que l'appli retrouve la bonne station. Vérifie aussi le type et le badge des lignes.
// Ne consomme AUCUN appel PRIM : tout se fait avec horaires/arrets_paris.json et horaires/lignes_paris.json.
// Usage : générer ces fichiers (python3 scripts/build_arrets_paris.py), lancer  python3 -m http.server 8765,
//         puis  node tests/verifier_stations_paris.js [adresse]
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:8765/";

(async () => {
  const navigateur = await chromium.launch();
  const page = await navigateur.newPage();
  await page.goto(BASE);
  await page.evaluate(() => localStorage.setItem("ville", "PARIS"));
  await page.goto(BASE);

  // 1. Chaque station ferrée, tapée par son nom, doit être retrouvée
  const stations = await page.evaluate(async () => {
    const liste = await (await fetch("horaires/arrets_paris.json")).json();
    const ferres = liste.filter(a => a[4]);
    const erreurs = [];
    for (const [num, label] of ferres) {
      const nom = sansCommune(label);
      const { arret, lignes } = analyser(nom);
      const top = (await trouverZonesParis(arret, lignes))[0];
      if (!top || top.id.split(":").pop() !== num)
        erreurs.push({ label, trouve: top ? top.label : "RIEN", homonyme: !!top && normaliser(sansCommune(top.label)) === normaliser(nom) });
    }
    return { total: ferres.length, erreurs };
  });
  const vraies = stations.erreurs.filter(e => !e.homonyme);
  console.log(`Stations ferrées : ${stations.total} — erreurs : ${vraies.length} — homonymes : ${stations.erreurs.length - vraies.length}`);
  for (const e of vraies) console.log(`  ⚠️ ${e.label}  →  ${e.trouve}`);
  for (const e of stations.erreurs.filter(e => e.homonyme)) console.log(`  (même nom) ${e.label}  →  ${e.trouve}`);

  // 2. Type et badge de chaque ligne
  const lignes = await page.evaluate(async () => {
    const toutes = await (await fetch("horaires/lignes_paris.json")).json();
    const types = {}, bizarres = [];
    for (const [id, [code, couleur, , nomMode, nom]] of Object.entries(toutes)) {
      const it = habillerParis({ code, ligne: code }, nomMode, nom);
      const cle = `${it.nomMode} (rang ${rangMode(it)}) ← ${nomMode}`;
      types[cle] = (types[cle] || 0) + 1;
      if (!couleur) bizarres.push(`${id} ${code} sans couleur`);
      if (it.mode !== "BUS" && it.mode !== "TRAIN" && (!it.code || it.code.length > 7)) bizarres.push(`${id} ${code} ${nomMode} : badge « ${it.code} »`);
    }
    return { types, bizarres };
  });
  console.log(`\nLignes par type :`);
  for (const [k, v] of Object.entries(lignes.types).sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log(`Lignes à regarder : ${lignes.bizarres.length}`);
  for (const b of lignes.bizarres) console.log(`  ⚠️ ${b}`);
  await navigateur.close();
})();
