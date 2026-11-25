/* =========================================================
   서비스 워커 — 앱 파일을 저장해 오프라인에서도 학습 가능
   words.js 등을 바꿔서 다시 올렸다면 VERSION 을 올려 주세요.
   (음성 파일은 app.js 가 'canada500-audio-v1' 캐시에 따로 저장)
   ========================================================= */
var VERSION = 'canada500-shell-v1.0.0';
var AUDIO_CACHE = 'canada500-audio-v1';
var SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'words.js', 'manifest.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== AUDIO_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* 같은 출처 파일: 네트워크 우선(2.5초 안에 응답 없으면 저장본) → 오프라인이면 저장본 */
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 API·음성은 건드리지 않음
  e.respondWith(new Promise(function (resolve) {
    var settled = false;
    function fromCache() {
      return caches.open(VERSION).then(function (c) {
        return c.match(req, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          if (req.mode === 'navigate') return c.match('index.html');
          return null;
        });
      });
    }
    var timer = setTimeout(function () {
      fromCache().then(function (hit) { if (hit && !settled) { settled = true; resolve(hit); } });
    }, 2500);
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      if (!settled) { settled = true; clearTimeout(timer); resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      fromCache().then(function (hit) {
        if (!settled) { settled = true; resolve(hit || new Response('오프라인입니다', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })); }
      });
    });
  }));
});
