// Helm PWA Service Worker — push notifications only, no caching

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  self.clients.claim();
});

// No caching — always fetch from network
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));

// Push notification handler
self.addEventListener('push', (e) => {
  let data = { title: 'Helm', body: 'Agente aguardando resposta' };
  try {
    data = e.data.json();
  } catch {}
  
  e.waitUntil(
    self.registration.showNotification(data.title || 'Helm', {
      body: data.body || 'Agente aguardando',
      icon: '/icon-192.png',
      badge: '/icon-badge-96.png',
      tag: data.tag || 'helm-waiting',
      renotify: true,
      data: data
    })
  );
});

// Click notification → open/focus app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          return c.focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});
