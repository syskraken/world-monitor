/* World Monitor service worker — receives Web Push and shows notifications,
   so alerts arrive even when the tab is closed. */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch { d = { body: event.data ? event.data.text() : '' }; }

  const title = d.title || 'World Monitor';
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    requireInteraction: d.sev === 'extreme',
    timestamp: d.ts || Date.now(),
    data: { url: d.url || '/', reason: d.reason || '' },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An external article link always opens fresh; otherwise focus an open tab.
    if (url && /^https?:\/\//.test(url) && new URL(url).origin !== self.location.origin) {
      return self.clients.openWindow(url);
    }
    for (const c of wins) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url || '/');
  })());
});
