// Batterie de tests « façon Lille » pour toutes les villes de Mon bus.
// Usage : node tests/tester_villes.js [adresse]   (par défaut http://localhost:8765/)
// Pour tester en local : générer horaires/ (commandes du workflow), puis  python3 -m http.server 8765
// Pour chaque question : arrêt trouvé, lignes/directions affichées, et alerte DOUBLONS ou CHOIX d'homonymes.
// ⚠️ La nuit, beaucoup de lignes ne roulent pas : « Aucun passage » n'est pas forcément une erreur.
const { chromium } = require("playwright");
const BASE = process.argv[2] || "http://localhost:8765/";

const QUESTIONS = {
  LILLE: ["14 République Beaux-Arts direction Marais", "C1 Wagner", "CO1 République Beaux-Arts", "métro 1 Gare Lille Flandres",
          "Gare Lille Flandre", "tram Gare Lille Europe", "tram R Gare Lille Europe", "tram T Gare Lille Europe", "métro 2 Gare Lille Europe"],
  PARIS: ["RER A Châtelet", "RER B Gare du Nord", "métro 4 Gare du Nord", "métro 14 Gare de Lyon", "tram T3a Porte de Vincennes"],
  BORDEAUX: ["tram C Quinconces", "tram B Hôtel de Ville direction Pessac"],
  RENNES: ["métro a République", "bus C1 République"],
  AMIENS: ["Gare"],
  MARSEILLE: ["métro 1 Castellane", "tram 2 Castellane", "Castellane"],
  NICE: ["tram 1 Masséna", "tram Masséna", "Garibaldi"],
  GRENOBLE: ["tram A Gares", "tram B Gares", "Victor Hugo"],
  MONTPELLIER: ["comedie", "tram 2 Comédie", "tram 1 Comédie direction Odysseum", "Comédie direction Sabines",
                "Gare St Roch", "Place de l'Europe", "bus 6 Euromédecine", "Odysseum direction Gare Sud France"],
};

(async () => {
  const navigateur = await chromium.launch();
  const page = await navigateur.newPage();
  for (const [ville, questions] of Object.entries(QUESTIONS)) {
    await page.goto(BASE);
    await page.evaluate(v => localStorage.setItem("ville", v), ville);
    for (const q of questions) {
      await page.goto(BASE);
      await page.fill("input", q);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(ville === "PARIS" ? 8000 : 3500);
      const lignes = (await page.innerText("#resultats")).split("\n");
      const groupes = [];
      for (let i = 0; i < lignes.length; i++)
        if (lignes[i].startsWith("→")) groupes.push(`${lignes[i - 2]} ${lignes[i - 1]} ${lignes[i]}`);
      const doublons = groupes.filter((g, i) => groupes.indexOf(g) !== i);
      const choix = await page.$$eval("#proches button", bs => bs.map(b => b.innerText));
      const statut = await page.innerText("#statut");
      console.log(`${ville} | ${q} | arrêt : ${lignes[0] || "-"} | ${groupes.length} groupes`
        + (doublons.length ? ` | ⚠️ DOUBLONS : ${doublons.join(" ; ")}` : "")
        + (choix.length ? ` | CHOIX : ${choix.join(" / ")}` : ""));
      console.log("    " + (groupes.slice(0, 4).join(" ; ") || statut));
    }
  }
  await navigateur.close();
})();
