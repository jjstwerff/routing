// Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later
// Service worker for the serverless routing app (PLAN-APP Track 1d): caches the app shell (html/js)
// and the browser wasm so a FULLY-offline reload still loads and runs. The test-set dataset lives
// outside this worker's /browser/ scope, so the app caches THAT in IndexedDB (see index.html); the
// two layers together make the whole app work with no network.
const CACHE = 'routing-shell-v1';
const SHELL = ['./', './index.html', './web_kernel.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first for same-origin GETs in scope; runtime-cache new ones; fall back to the shell offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
