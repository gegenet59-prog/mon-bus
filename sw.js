// Service worker de « Mon bus » : sert uniquement aux alertes de panne (notifications).
// Il ne met rien en cache : l'appli fonctionne exactement comme avant.
// Le relais envoie un simple « réveil » ; on va lire le message à afficher chez lui.
const RELAIS = "https://mon-bus.gegenet59.workers.dev/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});   // présent pour que Chrome propose « Installer l'application » (ne touche à aucune requête)

self.addEventListener("push", e => e.waitUntil((async () => {
  let m = { titre: "Mon bus", texte: "Info trafic : ouvre l'appli pour voir le détail." };
  try {
    const abo = await self.registration.pushManager.getSubscription();
    if (abo) m = await (await fetch(`${RELAIS}?flux=alerte&endpoint=${encodeURIComponent(abo.endpoint)}`)).json();
  } catch {}
  await self.registration.showNotification(m.titre, {
    body: m.texte, icon: "icone-192.png", badge: "icone-192.png",
    tag: `panne-${m.ville || ""}`, renotify: true, data: { ville: m.ville || "" },
  });
})()));

// Toucher la notification ouvre l'appli sur la bonne ville
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const ville = e.notification.data?.ville;
  e.waitUntil(self.clients.openWindow(`./${ville ? `?ville=${ville}` : ""}`));
});
