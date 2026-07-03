// Service worker para Velázquez Barométrica.
// Solo funciona cuando este archivo está alojado en un servidor real (https:// o localhost),
// junto a index.html, manifest.json, icon-192.png e icon-512.png en la misma carpeta.
//
// Estrategia: "red primero". Si hay internet, siempre trae la versión más
// nueva del servidor (y la va guardando en caché). Si no hay internet,
// usa la última copia guardada. Así, cada vez que subís cambios a GitHub
// Pages, se ven de inmediato en la próxima carga — no quedan pegados.
//
// IMPORTANTE: cada vez que subas una actualización importante, subí
// también este archivo cambiando el número de CACHE_NAME (v2, v3, ...).
// Eso obliga a los celulares que ya tenían la app instalada a limpiar
// la caché vieja.

const CACHE_NAME = "velazquez-puntos-v2"
const APP_SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});