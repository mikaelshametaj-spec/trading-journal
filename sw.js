// Service worker di Trading Journal Pro: rende l'app utilizzabile offline.
// Non tocca i dati (IndexedDB): memorizza solo i file dell'app. Le richieste ad altri domini (sincronizzazione) passano direttamente.
var CACHE = 'tjp-macro-3';
var FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('tjp-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // pagina: prima la rete (così gli aggiornamenti arrivano), se offline la copia salvata
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (r) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put('./index.html', cp); }); return r; }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req).then(function (r) { if (r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); } return r; }); }));
});

// Avvisi notizie: notifiche push inviate dalla funzione Supabase "macro-analisi", anche ad app chiusa.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Avviso mercato', {
    body: d.body || '', tag: d.tag || 'tj-avviso', renotify: true,
    icon: './icon-192.png', badge: './icon-192.png', vibrate: [200, 100, 200],
    data: { url: d.url || './#/macro' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = new URL((e.notification.data && e.notification.data.url) || './#/macro', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) { return c.focus().then(function (w) { return w && 'navigate' in w ? w.navigate(target) : w; }); }
    }
    return self.clients.openWindow ? self.clients.openWindow(target) : null;
  }));
});
