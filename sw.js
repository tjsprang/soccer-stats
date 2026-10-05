// Soccer Stats service worker: keeps the app's own files so it opens without signal.
// League data isn't handled here (the app keeps its own copy); Supabase requests go straight to the network.
const CACHE = 'soccer-stats-v1';
const SHELL = ['./', './index.html', './stats.js', './league.js', './extras.js', './teamadmin.js', './practice.js', './match.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;   // data: always live
  const ours = url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net';
  if (!ours) return;
  // Network first (so updates arrive right away), falling back to the saved copy when offline.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});

// Tapping a phone notification opens the app at the right page.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = e.notification.data?.link || '';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) { open.focus(); return open.navigate(self.registration.scope + link); }
    return self.clients.openWindow(self.registration.scope + link);
  }));
});
