// admin-sw.js — FNF Admin Panel Service Worker
// მიზანი: "shell"-ის (HTML/JS/CSS) ქეშირება offline/PWA install-ისთვის.
// #18: NETWORK-FIRST სტრატეგია — deploy-ის შემდეგ ადმინი ყოველთვის ახალ
// ვერსიას ხედავს; cache მხოლოდ offline fallback-ია (ძველი cache-first
// ჯერ ძველ ვერსიას აჩვენებდა და მეორე ჩატვირთვამდე ასე რჩებოდა).
// Supabase/ESPN/Telegram API (სხვა origin) აქ არასდროს ქეშირდება.

const CACHE_NAME = 'fnf-admin-shell-v3';
const SHELL_FILES = [
  './admin.html',
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

  // მხოლოდ საკუთარი origin-ის GET მოთხოვნები — API calls ხელუხლებელი რჩება
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // network-first: ჯერ ქსელი (და cache-ის განახლება), offline-ზე — cache
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
