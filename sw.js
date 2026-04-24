// ============================================================
// Daily Plan — Service Worker v1.0
// Handles: Offline cache, Push Notifications, Background Sync
// ============================================================

const CACHE_VERSION = 'dailyplan-v3.0';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const DATA_CACHE    = `${CACHE_VERSION}-data`;

// Files to cache on install
const PRECACHE_URLS = [
  './DASHBOARD.html',
  './manifest.json',
  './sw.js',
];

// CDN resources to cache on first fetch
const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
];

// ────────────────────────────────────
// INSTALL: pre-cache static files
// ────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Install', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ────────────────────────────────────
// ACTIVATE: clean up old caches
// ────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activate', CACHE_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== DATA_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ────────────────────────────────────
// FETCH: Stale-While-Revalidate strategy
// ────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and Supabase API calls (always fresh)
  if (request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) return;

  // For HTML: Network first, fallback to cache
  if (request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // For CDN scripts/styles: Cache first, then revalidate in background
  if (CDN_ORIGINS.some(o => url.origin.startsWith(o))) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fetchPromise = fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          });
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Default: Stale-While-Revalidate
  event.respondWith(
    caches.open(DATA_CACHE).then(cache =>
      cache.match(request).then(cached => {
        const fetchPromise = fetch(request).then(res => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => {});
        return cached || fetchPromise;
      })
    )
  );
});

// ────────────────────────────────────
// BACKGROUND SYNC: flush queued saves
// ────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-user-data') {
    console.log('[SW] Background sync triggered');
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'BACKGROUND_SYNC_TRIGGERED' });
        });
      })
    );
  }
});

// ────────────────────────────────────
// PUSH NOTIFICATIONS
// ────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch(e) { payload = { title: 'Daily Plan', body: event.data.text() }; }

  const options = {
    body:    payload.body    || 'Nhắc nhở từ Daily Plan',
    icon:    payload.icon    || './manifest.json',
    badge:   payload.badge   || './manifest.json',
    tag:     payload.tag     || 'dailyplan-reminder',
    data:    payload.data    || { url: './DASHBOARD.html' },
    actions: payload.actions || [
      { action: 'open',    title: '📋 Mở app' },
      { action: 'dismiss', title: '✕ Bỏ qua' },
    ],
    requireInteraction: payload.requireInteraction || false,
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Daily Plan', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || './DASHBOARD.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes('DASHBOARD'));
        if (existing) {
          existing.focus();
          existing.postMessage({ type: 'NOTIFICATION_CLICKED', data: event.notification.data });
        } else {
          self.clients.openWindow(targetUrl);
        }
      })
  );
});

// ────────────────────────────────────
// MESSAGE: handle messages from app
// ────────────────────────────────────
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (type === 'SCHEDULE_NOTIFICATION') {
    // Delay notification (for local scheduling without push server)
    const { title, body, tag, delayMs } = payload;
    setTimeout(() => {
      self.registration.showNotification(title, {
        body, tag,
        icon: './manifest.json',
        requireInteraction: false,
        vibrate: [200, 100, 200],
      });
    }, delayMs || 0);
  }

  if (type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});
