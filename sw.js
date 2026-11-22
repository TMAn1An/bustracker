// Service worker: makes the student app installable and quick to open.
// - /vendor/* (versioned libraries that never change): cache first.
// - Pages and app files: network first, so an update is live at once; the cached copy is used only when offline.
// - /api/*, map tiles and anything else from other sites: never cached here (always live).
// - Push: the server sends an empty push; we fetch the messages for this subscription and show them.
const VERSION = 'v6';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/feed.js', '/js/map.js', '/js/bus3d.js', '/js/share.js', '/js/social.js', '/js/app.js',
  '/vendor/maplibre-gl.js', '/vendor/maplibre-gl.css', '/vendor/three.min.js', '/assets/logo.png', '/assets/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(x => x.put(e.request, copy)); return r; })));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))));
});

/* ---------- push notifications ---------- */
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msgs = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'inbox', endpoint: sub.endpoint }) });
        msgs = (await r.json()).messages || [];
      }
    } catch (err) { /* offline: fall back to a generic message below */ }
    // A push must always show something (browsers require it).
    if (!msgs.length) msgs = [{ title: 'IUBAT Bus Tracker', body: 'Tap to see where your bus is.', url: '/', tag: 'generic' }];
    await Promise.all(msgs.map(m => self.registration.showNotification(m.title, {
      body: m.body, tag: m.tag || undefined, renotify: !!m.tag, icon: '/assets/icons/icon-192.png', badge: '/assets/icons/favicon-48.png', data: { url: m.url || '/' },
    })));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus(); w.postMessage({ type: 'open', url }); return; }
    await clients.openWindow(url);
  })());
});
