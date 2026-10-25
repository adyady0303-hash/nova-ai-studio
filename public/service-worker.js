const CACHE = "nova-mobile-shell-v1";
const SHELL = ["/offline.html", "/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/p/")) return;
  if (request.mode === "navigate") event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
  else if (SHELL.includes(url.pathname)) event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
