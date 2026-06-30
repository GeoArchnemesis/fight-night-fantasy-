// admin-sw.js — FNF Admin Panel Service Worker
// მიზანი: მხოლოდ "shell"-ის (HTML/JS/CSS) ქეშირება offline/PWA install-ისთვის.
// Supabase API მოთხოვნები (სხვა origin-ია) აქ არასდროს არ ქეშირდება —
// ადმინ მონაცემები ყოველთვის ცოცხალი/network-დან მოდის.

const CACHE_NAME = 'fnf-admin-shell-v1';
const SHELL_FILES = [
  './fnf-ctrl-9x4k.html',
  './admin-manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // მხოლოდ საკუთარი origin-ის GET მოთხოვნები — Supabase/ESPN/Telegram
  // API calls (სხვა origin) ხელუხლებელი რჩება, ყოველთვის network-ზე მიდის.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
