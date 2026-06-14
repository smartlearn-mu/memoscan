const CACHE_NAME = 'memoscan-v1';
const ASSETS = [
  '/memoscan/',
  '/memoscan/index.html'
];

// Installation : mise en cache des assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Interception des requêtes : stratégie "cache d'abord, puis réseau"
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) {
        return response;
      }
      return fetch(event.request).then(fetchResponse => {
        // Mise en cache des nouvelles requêtes (sauf les appels API)
        if (!event.request.url.includes('/exec') && !event.request.url.includes('googleapis')) {
          const responseClone = fetchResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return fetchResponse;
      });
    }).catch(() => {
      // Hors-ligne : page par défaut (optionnel)
      return caches.match('/memoscan/index.html');
    })
  );
});