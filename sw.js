// 只缓存「应用外壳」（页面、脚本、样式、图标、地图库）。
// 离线底图（data/*.pmtiles）由页面自己下载并放进 Cache Storage（这样能显示下载进度），这里不拦；
// 跨域请求（在线底图瓦片等）也一律不拦，直接走网络——不缓存第三方瓦片。
const VER = 'at-shell-3655d36a';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'terrain.js', 'lib/leaflet.js', 'lib/leaflet.css', 'lib/pmtiles.js', 'lib/protomaps-leaflet.js',
  'lib/maplibre-gl.js', 'lib/maplibre-gl.css', 'lib/basemaps.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VER)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('at-shell-') && k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
