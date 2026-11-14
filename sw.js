// Minimal service worker so the site can be installed as an app.
// It never caches: alert data must always be fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
