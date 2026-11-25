(() => {
'use strict';

const APP_VER = '1.0';
// 离线底图：用 tools/pm-extract.js 从 Protomaps 每日构建里切出来的 PMTiles（Azat 河谷走廊，z0–z15）
const BASE = {
  url: 'data/armenia-20261125.pmtiles', size: 26988669, cache: 'armenia-data-v1', build: '2026-11-25', area: 'Azat 河上游 → Garni → Geghard 一带',
  corridor: [44.40, 39.88, 45.12, 40.30] // 街道级（z15）覆盖范围：西, 南, 东, 北；全国另有 z0–z11
};
const DEMP = { url: 'data/armenia-dem-20261125.pmtiles', size: 9277218 }; // 离线高程：AWS 地形瓦片（terrarium）切片，走廊 z12 + 全国 z9，用 tools/dem-extract.js 做的
const CUSTOM = 'data/custom.pmtiles';

const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (typeof L === 'undefined' || typeof pmtiles === 'undefined' || typeof protomapsL === 'undefined') {
  document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;background:#fff;color:#222">地图组件没能加载。请联网后重新打开；如果一直这样，把图标从主屏幕删掉，再重新「添加到主屏幕」。</div>');
  return;
}

/* ================= 设置 ================= */
const DEF = { base: 'auto', lineW: 4, ends: true, halo: true, wpts: false, sort: 'add', wake: false, colorSeq: 0, custom: null, hill: true, hillOp: 0.65, ex3d: 1.5, base3d: 'off', offDist: 30, offAlert: false }; // offAlert：走偏时响声提醒，默认关。换了个新名字，免得之前版本存下来的"开着"带过来
const S = Object.assign({}, DEF, (() => { try { return JSON.parse(localStorage.getItem('at-settings-v1')) || {}; } catch (e) { return {}; } })());
delete S.alertOff; // 上一版里响声提醒的旧名字，已改成 offAlert（默认关），旧的不再用
const saveS = () => { try { localStorage.setItem('at-settings-v1', JSON.stringify(S)); } catch (e) { /* 隐私模式等：忽略 */ } };

/* ================= 小工具 ================= */
const RAD = Math.PI / 180;
const fmtKm = m => (m / 1000).toFixed(m < 100000 ? 2 : 1) + ' km';
const fmtDur = ms => { const h = Math.floor(ms / 3.6e6), m = Math.round((ms % 3.6e6) / 6e4); return h ? `${h} 时 ${m} 分` : `${m} 分`; };
const fmtMB = b => (b / 1e6).toFixed(1) + ' MB'; // 按十进制算，和 iOS 里显示的一致
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}
// 黄金角取色：相邻序号色相差约 137.5°，再错开明度，几十条也分得开
const colorAt = i => hslHex((i * 137.508 + 12) % 360, 78, [46, 38, 54][i % 3]);
function hav(la1, lo1, la2, lo2) {
  const dLat = (la2 - la1) * RAD, dLng = (lo2 - lo1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
let toastTimer;
function toast(msg, ms = 5000) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ================= 本机存储（IndexedDB）：meta 与坐标分开存，改颜色/显隐不用重写坐标 ================= */
const DB = {
  ok: true, _p: null,
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('这个浏览器没有 IndexedDB'));
      const q = indexedDB.open('armenia-trails', 1);
      q.onupgradeneeded = () => { q.result.createObjectStore('routes', { keyPath: 'id', autoIncrement: true }); q.result.createObjectStore('geom', { keyPath: 'id' }); };
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
      q.onblocked = () => rej(new Error('数据库被占用'));
    }));
  },
  async tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error || new Error('本机存储出错'));
      out = fn(t);
    });
  },
  async loadAll() {
    let a, b;
    await this.tx(['routes', 'geom'], 'readonly', t => { a = t.objectStore('routes').getAll(); b = t.objectStore('geom').getAll(); });
    return [a.result, b.result];
  },
  async add(meta, segs) {
    let id;
    await this.tx(['routes', 'geom'], 'readwrite', t => {
      t.objectStore('routes').put(meta).onsuccess = e => { id = e.target.result; t.objectStore('geom').put({ id, segs }); };
    });
    return id;
  },
  setMeta(metas) { return this.tx(['routes'], 'readwrite', t => { metas.forEach(m => t.objectStore('routes').put(m)); }); },
  remove(ids) { return this.tx(['routes', 'geom'], 'readwrite', t => { ids.forEach(id => { t.objectStore('routes').delete(id); t.objectStore('geom').delete(id); }); }); },
  clear() { return this.tx(['routes', 'geom'], 'readwrite', t => { t.objectStore('routes').clear(); t.objectStore('geom').clear(); }); }
};

/* ================= 解析：GPX / KML / TCX / GeoJSON ================= */
// 内部统一成 {name, segs:[[ [lat,lon,ele|null,time(ms)|null], … ], …], wpts:[{lat,lng,name,ele}]}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const tms = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const okLL = p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const kids = (n, name) => [...n.children].filter(c => c.localName === name);
const kidText = (n, name) => { const c = kids(n, name)[0]; return c ? c.textContent.trim() : ''; };
const all = (n, name) => [...n.getElementsByTagNameNS('*', name)];

function attachWpts(out, wpts, base) {
  if (!wpts.length) return;
  if (out.length) out[0].wpts = wpts; else out.push({ name: base, segs: [], wpts });
}
function parseGPX(doc, base) {
  const pt = e => [parseFloat(e.getAttribute('lat')), parseFloat(e.getAttribute('lon')), num(kidText(e, 'ele')), tms(kidText(e, 'time'))];
  const out = [];
  const trks = all(doc, 'trk');
  trks.forEach((trk, i) => {
    const segs = all(trk, 'trkseg').map(s => all(s, 'trkpt').map(pt).filter(okLL)).filter(s => s.length > 1);
    if (segs.length) out.push({ name: kidText(trk, 'name') || (trks.length > 1 ? `${base} #${i + 1}` : base), segs, wpts: [] });
  });
  const rtes = all(doc, 'rte');
  rtes.forEach((rte, i) => {
    const s = all(rte, 'rtept').map(pt).filter(okLL);
    if (s.length > 1) out.push({ name: kidText(rte, 'name') || (rtes.length > 1 ? `${base} 路线${i + 1}` : base), segs: [s], wpts: [] });
  });
  const wpts = all(doc, 'wpt').map(w => ({ lat: parseFloat(w.getAttribute('lat')), lng: parseFloat(w.getAttribute('lon')), name: kidText(w, 'name'), ele: num(kidText(w, 'ele')) })).filter(w => okLL([w.lat, w.lng]));
  attachWpts(out, wpts, base);
  return out;
}
function kmlCoords(str) {
  return str.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(a => a.length >= 2).map(a => [a[1], a[0], Number.isFinite(a[2]) ? a[2] : null, null]).filter(okLL);
}
function parseKML(doc, base) {
  const out = [], wpts = [];
  all(doc, 'Placemark').forEach(pm => {
    const name = kidText(pm, 'name') || base, lines = [];
    all(pm, 'LineString').forEach(ls => { const p = kmlCoords(all(ls, 'coordinates').map(c => c.textContent).join(' ')); if (p.length > 1) lines.push(p); });
    all(pm, 'Track').forEach(tr => { // Google Earth 的 gx:Track：gx:coord 是 "经 纬 高"，when 是对应的时间
      const when = all(tr, 'when').map(w => tms(w.textContent.trim()));
      const p = all(tr, 'coord').map((c, i) => { const a = c.textContent.trim().split(/\s+/).map(Number); return [a[1], a[0], Number.isFinite(a[2]) ? a[2] : null, when[i] == null ? null : when[i]]; }).filter(okLL);
      if (p.length > 1) lines.push(p);
    });
    if (lines.length) { out.push({ name, segs: lines, wpts: [] }); return; }
    const point = all(pm, 'Point')[0];
    if (point) { const p = kmlCoords(all(point, 'coordinates').map(c => c.textContent).join(' '))[0]; if (p) wpts.push({ lat: p[0], lng: p[1], name, ele: p[2] }); }
  });
  attachWpts(out, wpts, base);
  return out;
}
function parseTCX(doc, base) {
  const out = [];
  const make = (name, tracks) => {
    const segs = tracks.map(t => all(t, 'Trackpoint').map(tp => {
      const la = all(tp, 'LatitudeDegrees')[0], lo = all(tp, 'LongitudeDegrees')[0], el = all(tp, 'AltitudeMeters')[0], tm = all(tp, 'Time')[0];
      return la && lo ? [parseFloat(la.textContent), parseFloat(lo.textContent), el ? num(el.textContent) : null, tm ? tms(tm.textContent.trim()) : null] : null;
    }).filter(p => p && okLL(p))).filter(s => s.length > 1);
    if (segs.length) out.push({ name, segs, wpts: [] });
  };
  const acts = all(doc, 'Activity');
  acts.forEach((a, i) => make(acts.length > 1 ? `${base} #${i + 1}` : base, all(a, 'Track')));
  all(doc, 'Course').forEach(c => make(kidText(c, 'Name') || base, all(c, 'Track')));
  return out;
}
function parseGeoJSON(text, base) {
  const gj = JSON.parse(text);
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', geometry: gj, properties: {} }];
  const out = [], wpts = [];
  const toPts = cs => cs.map(c => [c[1], c[0], Number.isFinite(c[2]) ? c[2] : null, null]).filter(okLL);
  feats.forEach((f, i) => {
    const g = f && f.geometry; if (!g) return;
    const pr = f.properties || {};
    const name = pr.name || pr['name:en'] || pr.title || (feats.length > 1 ? `${base} #${i + 1}` : base);
    if (g.type === 'LineString') { const p = toPts(g.coordinates); if (p.length > 1) out.push({ name, segs: [p], wpts: [] }); }
    else if (g.type === 'MultiLineString') { const s = g.coordinates.map(toPts).filter(p => p.length > 1); if (s.length) out.push({ name, segs: s, wpts: [] }); }
    else if (g.type === 'Point') { const p = toPts([g.coordinates])[0]; if (p) wpts.push({ lat: p[0], lng: p[1], name: pr.name || '', ele: p[2] }); }
  });
  attachWpts(out, wpts, base);
  return out;
}
function parseFile(name, text) {
  const ext = name.split('.').pop().toLowerCase();
  const base = name.replace(/\.[^.]+$/, '');
  if (ext === 'geojson' || ext === 'json') return parseGeoJSON(text, base);
  if (ext !== 'gpx' && ext !== 'kml' && ext !== 'tcx') throw new Error(`不支持的文件类型（.${ext}）；可以导入 .gpx .kml .tcx .geojson 和 .zip 压缩包`);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('不是有效的 XML');
  return ext === 'gpx' ? parseGPX(doc, base) : ext === 'kml' ? parseKML(doc, base) : parseTCX(doc, base);
}
// 坐标打包成 Float64Array（每点 4 个数：纬、经、海拔、时间；缺的用 NaN），省内存也方便存进 IndexedDB
const pack = seg => { const a = new Float64Array(seg.length * 4); seg.forEach((p, i) => { a[4 * i] = p[0]; a[4 * i + 1] = p[1]; a[4 * i + 2] = p[2] == null ? NaN : p[2]; a[4 * i + 3] = p[3] == null ? NaN : p[3]; }); return a; };

/* ================= 统计与海拔剖面 ================= */
// 海拔按前后 25 米（沿路线）取平均，去掉 GPS 海拔的来回抖动
function smooth(d, e) {
  const sm = new Float64Array(e.length);
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < e.length; i++) {
    while (hi < e.length && d[hi] <= d[i] + 25) sum += e[hi++];
    while (d[lo] < d[i] - 25) sum -= e[lo++];
    sm[i] = sum / (hi - lo);
  }
  return sm;
}
// 距离按点间球面距离累加；累计爬升/下降在平滑后的海拔上用 3 米滞后阈值累计（估算值，和 Wikiloc 页面上的数会有出入）；最高/最低用原始值
function analyze(r) {
  let n = 0; for (const a of r.segs) n += a.length >> 2;
  const LA = new Float64Array(n), LO = new Float64Array(n), EL = new Float64Array(n), D = new Float64Array(n), ST = new Uint8Array(n); // ST[j] = 1：第 j 个点是某一段的第一个点（段与段之间不连线）
  let k = 0, dist = 0, t0 = Infinity, t1 = -Infinity;
  for (const a of r.segs) {
    for (let i = 0; i < a.length; i += 4) {
      if (i) dist += hav(a[i - 4], a[i - 3], a[i], a[i + 1]);
      LA[k] = a[i]; LO[k] = a[i + 1]; EL[k] = a[i + 2]; D[k] = dist; ST[k] = i ? 0 : 1; k++;
      const t = a[i + 3];
      if (t === t) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
    }
  }
  r.flat = { n, LA, LO, EL, D, ST };
  r.dist = dist;
  r.dur = t1 > t0 ? t1 - t0 : null;
  r.t0 = Number.isFinite(t0) ? t0 : null; // 第一个点的时间，气泡里显示日期用
  r.min = r.max = r.gain = r.loss = null;
  r.prof = null;
  const d = [], e = [], idx = [];
  let mn = Infinity, mx = -Infinity;
  for (let j = 0; j < n; j++) { const v = EL[j]; if (v === v) { d.push(D[j]); e.push(v); idx.push(j); if (v < mn) mn = v; if (v > mx) mx = v; } }
  if (e.length < 2 || !(d[d.length - 1] > d[0])) return;
  const sm = smooth(d, e), g = new Float64Array(e.length);
  let ref = sm[0], gain = 0, loss = 0;
  for (let i = 0; i < sm.length; i++) {
    const v = sm[i];
    if (Math.abs(v - ref) >= 3) { if (v > ref) gain += v - ref; else loss += ref - v; ref = v; }
    g[i] = gain;
  }
  const step = Math.max(1, Math.ceil(e.length / 700)), keep = [];
  for (let i = 0; i < e.length; i += step) keep.push(i);
  if (keep[keep.length - 1] !== e.length - 1) keep.push(e.length - 1);
  const p = { d: keep.map(i => d[i]), e: keep.map(i => sm[i]), g: keep.map(i => g[i]), ll: keep.map(i => [LA[idx[i]], LO[idx[i]]]) };
  p.total = p.d[p.d.length - 1];
  p.min = Math.min(...p.e); p.max = Math.max(...p.e);
  r.prof = p; r.min = mn; r.max = mx; r.gain = gain; r.loss = loss;
}
// 在累计距离 m 处插值出海拔、累计爬升和经纬度
function atDist(p, m) {
  if (m < 0 || m > p.total) return null;
  let lo = 0, hi = p.d.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.d[mid] <= m) lo = mid; else hi = mid; }
  const span = p.d[hi] - p.d[lo], t = span > 0 ? (m - p.d[lo]) / span : 0;
  return { e: p.e[lo] + (p.e[hi] - p.e[lo]) * t, g: p.g[lo] + (p.g[hi] - p.g[lo]) * t, ll: [p.ll[lo][0] + (p.ll[hi][0] - p.ll[lo][0]) * t, p.ll[lo][1] + (p.ll[hi][1] - p.ll[lo][1]) * t] };
}
// 坡度：取前后各 40 米之间的海拔差
function slopeAt(p, m) {
  const d1 = Math.max(0, m - 40), d2 = Math.min(p.total, m + 40);
  if (d2 - d1 < 20) return null;
  const a = atDist(p, d1), b = atDist(p, d2);
  return a && b ? (b.e - a.e) / (d2 - d1) * 100 : null;
}
function niceStep(range, target) {
  const raw = range / target, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}
// 一个定位点离这条路线最近的位置。按线段投影来算（不是只看拍下来的点：点稀疏的路线，人站在两点中间也是"在线上"），段与段之间不连线。
// 返回 { m: 沿路线的累计距离, off: 离路线的直线距离（米）, lat, lon: 路线上最近的那个点, brg: 从我看向那个点的方位（度，北 = 0，顺时针） }
// near：上一次匹配到的累计距离。往返 / 绕圈的路线，同一个地方有两处几乎一样近，这时取离 near 最近的那处，"走到哪了"才不会来回跳
function nearestOn(r, lat, lon, near) {
  const f = r.flat;
  if (f.n < 2) return null;
  const kx = 111320 * Math.cos(lat * RAD), ky = 111320, LA = f.LA, LO = f.LO, D = f.D, ST = f.ST;
  const scan = (limit, pick) => { // limit：只看离得不超过这个平方距离的线段；pick(d2, j, t) 返回 true 表示采用
    for (let j = 0; j + 1 < f.n; j++) {
      if (ST[j + 1]) continue;
      const ax = (LO[j] - lon) * kx, ay = (LA[j] - lat) * ky, dx = (LO[j + 1] - lon) * kx - ax, dy = (LA[j + 1] - lat) * ky - ay, l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx, qy = ay + t * dy, d2 = qx * qx + qy * qy;
      if (d2 <= limit) pick(d2, j, t, qx, qy);
    }
  };
  let best = null;
  scan(Infinity, (d2, j, t, qx, qy) => { if (!best || d2 < best.d2) best = { d2, j, t, qx, qy }; });
  if (!best) return null;
  if (near != null) { // 往返 / 绕圈：和最近的那处差不多近（15 米内）的几处里，挑离上次位置最近的
    const lim = (Math.sqrt(best.d2) + 15) ** 2;
    let bestGap = Infinity;
    scan(lim, (d2, j, t, qx, qy) => { // 往回走（累计距离变小）的候选加一点罚分：原路返回的折返点两趟一样近，这样平局时算"继续往前走"
      const m = D[j] + t * (D[j + 1] - D[j]), gap = m >= near ? m - near : (near - m) * 1.5 + 5;
      if (gap < bestGap) { bestGap = gap; best = { d2, j, t, qx, qy }; }
    });
  }
  const { j, t, qx, qy } = best;
  return { m: D[j] + t * (D[j + 1] - D[j]), off: Math.sqrt(best.d2), lat: lat + qy / ky, lon: lon + qx / kx, brg: (Math.atan2(qx, qy) / RAD + 360) % 360 };
}

/* ================= 地图与底图 ================= */
const map = L.map('map', { zoomControl: false, attributionControl: false, maxZoom: 19, zoomSnap: 0.5, zoomDelta: 1 }).setView([40.12, 44.77], 11);
L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);
L.control.attribution({ position: 'topleft', prefix: false }).addTo(map);
const renderer = L.canvas({ padding: 0.3, tolerance: 10 });

const darkNow = () => matchMedia('(prefers-color-scheme: dark)').matches;
const BASES = {
  auto: { label: '离线 · 自动', note: '没网也能用，跟随系统的浅色 / 深色模式', kind: 'vec', flavor: 'auto', bg: '#e8ecef' },
  light: { label: '离线 · 浅色', note: '没网也能用', kind: 'vec', flavor: 'light', bg: '#e8ecef' },
  grayscale: { label: '离线 · 灰度', note: '没网也能用，路线颜色更突出', kind: 'vec', flavor: 'grayscale', bg: '#dcdcdc' },
  dark: { label: '离线 · 深色', note: '没网也能用', kind: 'vec', flavor: 'dark', bg: '#1c1f24' },
  sat: { label: '卫星影像', note: '要联网，不会存到本机', kind: 'raster', bg: '#2a2a2a', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 18, maxZoom: 19, attribution: 'Tiles © Esri — Maxar, Earthstar Geographics 等' } },
  topo: { label: '地形图（OpenTopoMap）', note: '要联网，不会存到本机', kind: 'raster', bg: '#e8e4d8', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opts: { subdomains: 'abc', maxNativeZoom: 17, maxZoom: 19, attribution: '© OpenTopoMap (CC-BY-SA) © OpenStreetMap 贡献者' } },
  none: { label: '不显示底图', note: '只看路线', kind: 'none', bg: '#f1f1f1' }
};
// 离线底图包：state = loading / ready / error；buf = ArrayBuffer；pm = PMTiles 实例（各个样式共用，解压过的瓦片能复用）
const bm = { state: 'loading', buf: null, pm: null, key: '', layer: null, err: '', size: 0, name: '' };
// 离线高程包（山体阴影 / 3D 用）：dem = Terrain.Dem 实例；layer = 2D 的山体阴影图层
const dm = { state: 'loading', buf: null, pm: null, dem: null, layer: null, err: '', size: 0 };

class BufSource { // 给 pmtiles 库用的"从内存里读"的数据源
  constructor(buf, key) { this.buf = buf; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) { return { data: this.buf.slice(offset, offset + length) }; }
}

function setProgress(label, got, total) {
  const box = $('#dl');
  box.hidden = false;
  $('#dlText').textContent = `正在下载${label}：${fmtMB(got)}${total ? ' / ' + fmtMB(total) : ''}（只需一次）`;
  $('#dlBar').style.width = total ? Math.min(100, got / total * 100) + '%' : '30%';
}
// 取一个数据包：先看本机缓存，没有就联网下载（带进度）并存进缓存
async function fetchPack(url, size, label, forceNet) {
  const cache = window.caches ? await caches.open(BASE.cache) : null;
  if (cache && !forceNet) { const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); }
  let res;
  try { res = await fetch(url, { cache: 'no-cache' }); } catch (e) { throw new Error(`现在没有网络，${label}还没下载好。联网后重新打开一次 App 就会自动下载`); }
  if (!res.ok) throw new Error('下载失败（HTTP ' + res.status + '）');
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; setProgress(label, got, size); }
  const buf = new Uint8Array(got);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (got < 1000 || String.fromCharCode(...buf.subarray(0, 7)) !== 'PMTiles') throw new Error(`下载到的${label}不是 PMTiles 文件`);
  if (cache) { try { await cache.put(url, new Response(buf.buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) { toast(`${label}没能存进本机，下次打开还得联网下载`); } }
  return buf.buffer;
}
async function loadPack(forceNet) {
  if (S.custom) { // 用户自己导入的离线地图：只从本机缓存里取
    const cache = window.caches ? await caches.open(BASE.cache) : null;
    const hit = cache && await cache.match(CUSTOM);
    if (hit) return hit.arrayBuffer();
    throw new Error('你导入的离线地图已经不在本机了，请重新导入，或点「恢复默认离线地图」');
  }
  return fetchPack(BASE.url, BASE.size, '离线地图', forceNet);
}
async function pruneCache() { // 以后换了新的数据包文件名，旧的删掉，免得白占空间
  if (!window.caches) return;
  try {
    const c = await caches.open(BASE.cache);
    for (const rq of await c.keys()) {
      const p = new URL(rq.url).pathname;
      if (!p.endsWith('/' + BASE.url) && !p.endsWith('/' + DEMP.url) && !p.endsWith('/' + CUSTOM)) await c.delete(rq);
    }
  } catch (e) { /* 忽略 */ }
}
async function initPack(forceNet) {
  bm.state = 'loading'; bm.err = '';
  try {
    if (typeof DecompressionStream === 'undefined') throw new Error('这个系统版本太旧（需要 iOS 16.4 以上），离线地图用不了；可以改用「卫星影像 / 地形图」，但要联网');
    bm.buf = await loadPack(forceNet);
    bm.size = bm.buf.byteLength;
    bm.name = S.custom ? S.custom.name : '内置';
    bm.key = (S.custom ? 'custom:' : 'base:') + bm.size;
    bm.pm = new pmtiles.PMTiles(new BufSource(bm.buf, bm.key));
    await bm.pm.getHeader(); // 提前校验一下文件头
    bm.state = 'ready';
    pruneCache();
  } catch (e) {
    bm.state = 'error'; bm.err = e.message || String(e); bm.pm = null; bm.buf = null;
  }
  $('#dl').hidden = true;
  applyBase();
  destroy3d(); // 底图包换了，3D 里的底图数据源要重新建
  refreshSettings();
  if (bm.state === 'error' && BASES[S.base] && BASES[S.base].kind === 'vec') toast('离线地图没准备好：' + bm.err, 9000);
}
async function initDem(forceNet) {
  dm.state = 'loading'; dm.err = '';
  try {
    if (!window.Terrain) throw new Error('地形组件没加载出来');
    if (typeof DecompressionStream === 'undefined') throw new Error('这个系统版本太旧（需要 iOS 16.4 以上）');
    dm.buf = await fetchPack(DEMP.url, DEMP.size, '地形数据', forceNet);
    dm.size = dm.buf.byteLength;
    dm.pm = new pmtiles.PMTiles(new BufSource(dm.buf, 'dem:' + dm.size));
    dm.dem = await new Terrain.Dem(dm.pm).init();
    dm.state = 'ready';
    pruneCache();
  } catch (e) {
    dm.state = 'error'; dm.err = e.message || String(e); dm.pm = null; dm.buf = null; dm.dem = null;
  }
  $('#dl').hidden = true;
  applyHill();
  refreshSettings();
  if (dm.state === 'error') toast('地形数据没准备好（山体阴影和 3D 暂时用不了）：' + dm.err, 9000);
}
function applyBase() {
  if (bm.layer) { map.removeLayer(bm.layer); bm.layer = null; }
  const def = BASES[S.base] || BASES.auto;
  const flavor = def.flavor === 'auto' ? (darkNow() ? 'dark' : 'light') : def.flavor;
  $('#map').style.background = def.flavor === 'auto' && darkNow() ? BASES.dark.bg : def.bg;
  if (def.kind === 'vec' && bm.state === 'ready') {
    // 画布分辨率最多按 2 倍算：3 倍屏上能省一半多的内存和绘制时间，文字稍软一点
    bm.layer = protomapsL.leafletLayer({ url: bm.pm, flavor, lang: 'en', maxZoom: 19, zIndex: 1, devicePixelRatio: Math.min(2, window.devicePixelRatio || 1), attribution: '© OpenStreetMap 贡献者 · Protomaps' });
  } else if (def.kind === 'raster') bm.layer = L.tileLayer(def.url, { ...def.opts, zIndex: 1 });
  if (bm.layer) bm.layer.addTo(map);
  covWarned = false;
}
// 2D 山体阴影：盖在底图上面、路线下面（zIndex 2）；高程包没准备好或用户关掉就不画
function applyHill() {
  if (dm.layer) { map.removeLayer(dm.layer); dm.layer = null; }
  if (!S.hill || dm.state !== 'ready') return;
  dm.layer = Terrain.hillshadeLayer(dm.dem, { exag: 1.5, opacity: S.hillOp });
  dm.layer.addTo(map);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((BASES[S.base] || {}).flavor === 'auto') { applyBase(); if (v3.map && v3.flavor !== flavor3d()) destroy3d(); } });
// 离线包只在走廊里有街道级（z15）瓦片，全国只到 z11；放大到走廊以外时那一块是空白的，提示一次免得以为是坏了
let covWarned = false;
function checkCoverage() {
  const def = BASES[S.base] || BASES.auto;
  if (def.kind !== 'vec' || bm.state !== 'ready' || S.custom) return;
  const c = map.getCenter(), cr = BASE.corridor;
  const inCorridor = c.lat >= cr[1] && c.lat <= cr[3] && c.lng >= cr[0] && c.lng <= cr[2];
  if (map.getZoom() >= 12 && !inCorridor) {
    if (!covWarned) { covWarned = true; toast('这一带的离线地图只存到概略级别（放大后会是空白）。街道级的只存了 Azat 河谷到 Garni、Geghard 这一块', 9000); }
  } else covWarned = false;
}
map.on('moveend', checkCoverage);

/* ================= 路线对象与地图图层 ================= */
const routes = [];
let selected = null;
const esriHalo = '#ffffff';
const metaOf = r => ({ id: r.id, key: r.key, file: r.file, name: r.name, color: r.color, visible: r.visible, added: r.added, wpts: r.wpts });
const saveMeta = rs => DB.ok ? DB.setMeta(rs.map(metaOf)).catch(() => { DB.ok = false; toast('保存失败：路线的改动关掉后不会保留'); }) : Promise.resolve();

function mkRoute(rec, segs) {
  const r = { id: rec.id, key: rec.key, file: rec.file, name: rec.name, color: rec.color, visible: rec.visible !== false, added: rec.added || 0, wpts: rec.wpts || [], segs };
  r.ll = segs.map(a => { const n = a.length >> 2, o = new Array(n); for (let i = 0; i < n; i++) o[i] = [a[4 * i], a[4 * i + 1]]; return o; });
  analyze(r);
  const common = { renderer, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round' };
  r.halo = L.polyline(r.ll, { ...common, color: esriHalo, weight: S.lineW + 3, opacity: S.halo ? 0.85 : 0, interactive: false });
  r.line = L.polyline(r.ll, { ...common, color: r.color, weight: S.lineW, opacity: 0.95, interactive: false }); // 点选统一由 map 的 click 处理（见 tapRoutes），这样才能一次找出重叠的好几条
  r.ends = [];
  if (r.ll.length) {
    const last = r.ll[r.ll.length - 1];
    r.ends.push(
      L.circleMarker(r.ll[0][0], { renderer, radius: 6, color: '#ffffff', weight: 2, fillColor: r.color, fillOpacity: 1, interactive: false }),
      L.circleMarker(last[last.length - 1], { renderer, radius: 6, color: r.color, weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false })
    );
  }
  r.wptMarkers = r.wpts.map(w => L.circleMarker([w.lat, w.lng], { renderer, radius: 5, color: r.color, weight: 2, fillColor: '#ffffff', fillOpacity: 1, bubblingMouseEvents: false })
    .bindPopup(`<b>${esc(w.name || '航点')}</b>${w.ele != null ? `<br>海拔 ${Math.round(w.ele)} m` : ''}`, { className: 'wp-pop', closeButton: false }));
  r.all = [r.halo, r.line, ...r.ends, ...r.wptMarkers];
  let s = 90, w = 180, n = -90, e = -180, any = false;
  const take = (la, lo) => { any = true; if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; };
  for (let j = 0; j < r.flat.n; j++) take(r.flat.LA[j], r.flat.LO[j]);
  r.wpts.forEach(p => take(p.lat, p.lng));
  r.bounds = any ? L.latLngBounds([[s, w], [n, e]]) : null;
  return r;
}
function addRoute(rec, segs) {
  const r = mkRoute(rec, segs);
  routes.push(r);
  sync(r);
  schedule3d();
  return r;
}
function sync(r) {
  const want = new Set();
  if (r.visible) {
    want.add(r.halo); want.add(r.line);
    if (S.ends) r.ends.forEach(l => want.add(l));
    if (S.wpts) r.wptMarkers.forEach(l => want.add(l));
  }
  for (const l of r.all) {
    const on = map.hasLayer(l);
    if (want.has(l) && !on) map.addLayer(l);
    else if (!want.has(l) && on) map.removeLayer(l);
  }
  if (r.visible && r === selected) { r.halo.bringToFront(); r.line.bringToFront(); }
}
function styleRoute(r) {
  const w = S.lineW + (r === selected ? 3 : 0);
  r.line.setStyle({ weight: w });
  r.halo.setStyle({ weight: w + 3 });
}
function setVisible(r, v, quiet) {
  r.visible = v;
  sync(r);
  if (r.row) { r.row.classList.toggle('off', !v); r.row.querySelector('.eye input').checked = v; }
  if (r === selected) $('#dHide').textContent = v ? '隐藏' : '显示';
  if (!quiet) { updateSummary(); saveMeta([r]); }
  schedule3d();
}
function setColor(r, c, persist) {
  r.color = c;
  r.line.setStyle({ color: c });
  if (r.ends[0]) r.ends[0].setStyle({ fillColor: c });
  if (r.ends[1]) r.ends[1].setStyle({ color: c });
  r.wptMarkers.forEach(m => m.setStyle({ color: c }));
  if (r.row) { r.row.querySelector('.rowhead .dot').style.background = c; r.row.style.setProperty('--rc', c); }
  if (r === selected) { $('#dColor').parentElement.style.background = c; schedProfile(); }
  if (persist) saveMeta([r]);
  schedule3d();
}
function removeRoute(r) {
  r.all.forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
  routes.splice(routes.indexOf(r), 1);
  schedule3d();
  if (selected === r) select(null);
  if (DB.ok && r.id > 0) DB.remove([r.id]).catch(() => {});
  renderList();
}
function allBounds() {
  const b = L.latLngBounds([]);
  routes.forEach(r => { if (r.visible && r.bounds) b.extend(r.bounds); });
  return b.isValid() ? b : null;
}
function fitAll() { const b = allBounds(); if (b) fitTo(b); }
function fitTo(b, maxZoom) {
  if (SH.state === 'full') setSheet('half');
  if (v3.on) return fit3d(b, maxZoom);
  const m = mapInsets();
  map.fitBounds(b, { paddingTopLeft: [m.left + 24, m.top + 16], paddingBottomRight: [m.right + 8, m.bottom + 16], maxZoom: maxZoom || 16 });
}
// o.open：抽屉在最小状态时展开到半屏；o.fit：地图缩放到这条路线；o.keep：从列表里点的，保持被点那一行在屏幕上的位置；o.keepInfo：别关掉地图上的气泡
function select(r, o = {}) {
  const prev = selected;
  // 列表里点的：先记下被点那一行在屏幕上的位置，上一条收起、这一条展开之后再把它挪回原位，免得列表跳来跳去
  const anchor = o.keep && r && r.row && r.row.isConnected ? r.row : null, y0 = anchor ? anchor.getBoundingClientRect().top : 0;
  selected = r;
  PF.hoverM = null; unmark();
  if (!o.keepInfo) closeInfo();
  if (prev && prev !== r) styleRoute(prev);
  if (r) {
    if (o.open && SH.state === 'peek') setSheet('half');
    if (!r.visible) setVisible(r, true);
    styleRoute(r);
    r.halo.bringToFront(); r.line.bringToFront();
  }
  renderDetail();
  markRows();
  updateSummary();
  updateGps();
  if (r) {
    if (anchor) body.scrollTop += anchor.getBoundingClientRect().top - y0;
    else revealRow(r);
    if (o.fit && r.bounds) fitTo(r.bounds, 16);
  }
  schedProfile();
  schedule3d();
}

/* ================= 底部抽屉 ================= */
const sheet = $('#sheet'), grab = $('#grab'), body = $('#body');
const SH = { state: 'peek', vis: 0, drag: null };
let insetTop = 0, insetBottom = 0;
const wide = () => innerWidth >= 700;
function readInsets() {
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(p);
  const cs = getComputedStyle(p);
  insetTop = parseFloat(cs.paddingTop) || 0; insetBottom = parseFloat(cs.paddingBottom) || 0;
  p.remove();
}
function sheetH() {
  const H = innerHeight, head = grab.offsetHeight || 60, full = H - insetTop - 14;
  const tools = $('#tools'), th = tools.hidden ? 0 : tools.offsetHeight || 52; // 筛选栏固定在头部下面，半屏时把它的高度加上，列表能看到的区域才和原来一样
  return { peek: head + insetBottom + (wide() ? 12 : 0), half: Math.min(full, Math.max(head + th + 330, Math.round(H * 0.52) + th)), full };
}
function layoutSheet(animate) {
  const h = sheetH();
  sheet.style.height = h.full + 'px';
  SH.vis = h[SH.state];
  sheet.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
  sheet.style.transform = `translateY(${h.full - SH.vis}px)`;
  body.style.setProperty('--pad', (h.full - SH.vis + insetBottom + 24) + 'px');
  $('#toast').style.bottom = (wide() ? 24 : SH.vis + 14) + 'px';
}
function setSheet(state) { SH.state = state; layoutSheet(true); }
// 地图上没被抽屉和悬浮按钮挡住的区域（fitBounds / 拖动图表时让标记保持在可见区里用）
function mapInsets() {
  if (wide()) return { top: insetTop + 12, left: 424, bottom: 12, right: 70 };
  return { top: insetTop + 12, left: 0, bottom: SH.vis, right: 66 };
}
// 把地图中心移到"没被抽屉挡住的那块区域"的正中，让 ll 落在那里（直接 setView 的话，点会跑到抽屉后面）
function centerOn(ll, zoom, animate) {
  if (v3.on) { // 3D：用内边距把中心挪到没被抽屉挡住的那块区域的正中；MapLibre 的缩放级别比 Leaflet 小 1
    if (v3.ready) v3.map.easeTo({ center: [ll[1], ll[0]], zoom: zoom == null ? v3.map.getZoom() : Math.max(v3.map.getZoom(), zoom - 1), padding: pad3d(0), duration: animate ? 500 : 0 });
    return;
  }
  const size = map.getSize(), m = mapInsets(), z = zoom == null ? map.getZoom() : zoom;
  const vx = (m.left + size.x - m.right) / 2, vy = (m.top + size.y - m.bottom) / 2;
  map.setView(map.unproject(map.project(ll, z).subtract([vx - size.x / 2, vy - size.y / 2]), z), z, { animate: !!animate });
}
function ensureVisible(ll) {
  if (v3.on) {
    if (!v3.ready) return;
    const m3 = v3.map, pt = m3.project([ll[1], ll[0]]), cv = m3.getCanvas(), w = cv.clientWidth, h = cv.clientHeight, m = mapInsets();
    const x0 = m.left + 30, x1 = w - m.right - 30, y0 = m.top + 50, y1 = h - m.bottom - 30;
    const dx = pt.x < x0 ? pt.x - x0 : pt.x > x1 ? pt.x - x1 : 0, dy = pt.y < y0 ? pt.y - y0 : pt.y > y1 ? pt.y - y1 : 0;
    if (dx || dy) m3.panBy([dx, dy], { animate: false });
    return;
  }
  const size = map.getSize(), pt = map.latLngToContainerPoint(ll), m = mapInsets();
  const x0 = m.left + 30, x1 = size.x - m.right - 30, y0 = m.top + 50, y1 = size.y - m.bottom - 30;
  const dx = pt.x < x0 ? pt.x - x0 : pt.x > x1 ? pt.x - x1 : 0, dy = pt.y < y0 ? pt.y - y0 : pt.y > y1 ? pt.y - y1 : 0;
  if (dx || dy) map.panBy([dx, dy], { animate: false });
}
grab.addEventListener('pointerdown', e => {
  if (e.target.closest('button, input, select')) return;
  grab.setPointerCapture(e.pointerId);
  SH.drag = { y0: e.clientY, vis0: SH.vis, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
  sheet.style.transition = 'none';
});
grab.addEventListener('pointermove', e => {
  const d = SH.drag; if (!d) return;
  const h = sheetH();
  if (Math.abs(e.clientY - d.y0) > 5) d.moved = true;
  d.v = (e.clientY - d.lastY) / Math.max(1, e.timeStamp - d.lastT); d.lastY = e.clientY; d.lastT = e.timeStamp;
  SH.vis = Math.min(h.full, Math.max(h.peek, d.vis0 - (e.clientY - d.y0)));
  sheet.style.transform = `translateY(${h.full - SH.vis}px)`;
});
const dragEnd = e => {
  const d = SH.drag; if (!d) return;
  SH.drag = null;
  if (!d.moved) return setSheet(SH.state === 'peek' ? 'half' : 'peek'); // 点一下：收起 / 展开
  const h = sheetH(), proj = SH.vis - d.v * 220; // 带上一点惯性
  let best = 'peek';
  for (const k of ['peek', 'half', 'full']) if (Math.abs(h[k] - proj) < Math.abs(h[best] - proj)) best = k;
  setSheet(best);
};
grab.addEventListener('pointerup', dragEnd);
grab.addEventListener('pointercancel', dragEnd);

/* ================= 列表与详情 ================= */
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const subText = r => !r.segs.length ? `仅航点 · ${r.wpts.length} 个` : `${fmtKm(r.dist)}${r.gain != null ? ` · 爬升 ${Math.round(r.gain)} m · 最高 ${Math.round(r.max)} m` : ' · 无海拔数据'}`;
const filtered = () => { const q = $('#q').value.trim().toLowerCase(); return routes.filter(r => !q || r.name.toLowerCase().includes(q) || r.file.toLowerCase().includes(q)); };

const detailEl = $('#detail'); // 先拿住它：列表重画时它所在的那一行会被清掉，之后 querySelector 就找不到了
function rowEl(r) {
  const li = document.createElement('li');
  li.className = 'row' + (r.visible ? '' : ' off') + (r === selected ? ' sel' : '');
  li.style.setProperty('--rc', r.color);
  li.innerHTML = '<div class="rowhead"><label class="dot"><input type="color" aria-label="更改颜色"></label><div class="meta"><div class="nm"></div><div class="sub"></div></div><label class="eye"><input type="checkbox" aria-label="显示或隐藏">' + EYE + '</label></div><div class="slot"></div>';
  const head = $('.rowhead', li), dot = $('.dot', head), clr = $('.dot input', head), vis = $('.eye input', head);
  dot.style.background = r.color; clr.value = r.color; vis.checked = r.visible;
  $('.nm', head).textContent = r.name;
  $('.sub', head).textContent = subText(r);
  clr.addEventListener('input', e => setColor(r, e.target.value, false));
  clr.addEventListener('change', e => setColor(r, e.target.value, true));
  vis.addEventListener('change', e => setVisible(r, e.target.checked));
  head.addEventListener('click', e => { if (!e.target.closest('label')) select(r, { open: true, fit: true, keep: true }); });
  return li;
}
function renderList() {
  const cmp = {
    add: (a, b) => a.id - b.id,
    name: (a, b) => a.name.localeCompare(b.name, 'zh'),
    len: (a, b) => b.dist - a.dist,
    gain: (a, b) => (b.gain || 0) - (a.gain || 0)
  }[S.sort] || ((a, b) => a.id - b.id);
  const ul = $('#list');
  $('#detailHome').appendChild(detailEl); // 列表要重画了：先把详情卡片搬回原位，免得它跟着旧的那一行被清掉
  ul.textContent = '';
  filtered().sort(cmp).forEach(r => ul.appendChild((r.row = rowEl(r))));
  placeDetail();
  $('#empty').hidden = routes.length > 0;
  const tools = $('#tools'), wasHidden = tools.hidden;
  tools.hidden = routes.length === 0;
  if (wasHidden !== tools.hidden) layoutSheet(false); // 筛选栏出现 / 消失，抽屉高度要重新算
  updateSummary();
}
function markRows() {
  routes.forEach(r => { if (r.row) r.row.classList.toggle('sel', r === selected); });
  placeDetail();
}
// 选中的路线在列表里有行就把详情卡片放进那一行；被筛选掉了（列表里没有这一行）就放在列表最上面
function placeDetail() {
  const r = selected, host = r && r.row && r.row.isConnected ? $('.slot', r.row) : $('#detailHome');
  if (detailEl.parentElement !== host) host.appendChild(detailEl);
}
// 把选中的那一行（展开后带着详情）滚到列表最上面，再闪一下边框，一眼就能看到它在哪
function revealRow(r) {
  const row = r.row;
  if (!row || !row.isConnected) { body.scrollTop = 0; return; }
  body.scrollTop = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}
function updateSummary() {
  const vis = routes.filter(r => r.visible);
  const km = vis.reduce((s, r) => s + r.dist, 0) / 1000;
  $('#summary').textContent = selected ? `已选：${selected.name}（${fmtKm(selected.dist)}）` : routes.length ? `${routes.length} 条路线 · 显示 ${vis.length} 条 · 合计 ${km.toFixed(1)} km` : '还没有路线';
}
const statsText = r => !r.segs.length ? `仅航点 · ${r.wpts.length} 个`
  : [fmtKm(r.dist), r.gain != null ? `爬升 ${Math.round(r.gain)} m · 下降 ${Math.round(r.loss)} m` : '无海拔数据', r.max != null ? `最高 ${Math.round(r.max)} m · 最低 ${Math.round(r.min)} m` : '', r.dur ? `用时 ${fmtDur(r.dur)}（含休息）` : ''].filter(Boolean).join(' · ');
function renderDetail() {
  const r = selected, d = $('#detail');
  d.hidden = !r;
  if (!r) return;
  $('#dName').textContent = r.name;
  $('#dColor').value = r.color;
  $('#dColor').parentElement.style.background = r.color;
  $('#dStats').textContent = statsText(r);
  const has = !!r.prof;
  $('#pfCanvas').hidden = !has; $('#pfNone').hidden = has;
  $('#dHide').textContent = r.visible ? '隐藏' : '显示';
  $('#pfClear').hidden = true;
  $('#pfInfo').textContent = '';
}

/* ================= 点一下路线：气泡里显示这条线的信息，列表里同步突出显示 ================= */
const INFO = { pop: null, pop3: null, last: null, cur: null };
const fmtDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tapTol = () => matchMedia('(pointer: coarse)').matches ? 16 : 8; // 点选的容差（像素）：手指比鼠标粗

// 2D：用经纬度自己算「点离哪几条路线在容差以内」，重叠的路线能一次全找出来，不依赖 Leaflet 只返回最上面那条的命中检测
function candidates2d(ll, tolPx) {
  const cosL = Math.cos(ll.lat * RAD), mpp = 156543.03392804097 * cosL / 2 ** map.getZoom(), tol = tolPx * mpp;
  const kx = 111320 * cosL, ky = 111320, dLat = tol / ky, dLng = tol / kx, out = [];
  for (const r of routes) {
    if (!r.visible || !r.bounds) continue;
    const b = r.bounds;
    if (ll.lat < b.getSouth() - dLat || ll.lat > b.getNorth() + dLat || ll.lng < b.getWest() - dLng || ll.lng > b.getEast() + dLng) continue;
    let best = Infinity;
    for (const seg of r.ll) {
      for (let i = 1; i < seg.length; i++) {
        const a = seg[i - 1], c = seg[i];
        if ((a[0] < ll.lat - dLat && c[0] < ll.lat - dLat) || (a[0] > ll.lat + dLat && c[0] > ll.lat + dLat) || (a[1] < ll.lng - dLng && c[1] < ll.lng - dLng) || (a[1] > ll.lng + dLng && c[1] > ll.lng + dLng)) continue;
        const ax = (a[1] - ll.lng) * kx, ay = (a[0] - ll.lat) * ky, dx = (c[1] - a[1]) * kx, dy = (c[0] - a[0]) * ky, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) best = d;
      }
    }
    if (best <= tol) out.push({ r, d: best / mpp });
  }
  return out.sort((x, y) => x.d - y.d);
}
// 3D：先让 MapLibre 找出点附近画着哪些路线（框大一点，因为地形夸张时它的命中会偏几个像素），再按投影到屏幕上的距离精确排序
function candidates3d(pt) {
  const m = v3.map, tol = tapTol() + 6, ids = new Set();
  try { for (const f of m.queryRenderedFeatures([[pt.x - tol - 10, pt.y - tol - 10], [pt.x + tol + 10, pt.y + tol + 10]], { layers: ['r-line'] })) ids.add(f.properties.id); } catch (e) { /* 忽略 */ }
  if (!ids.size) { const r = pick3d(pt); return r ? [{ r, d: 0 }] : []; }
  const out = [];
  for (const r of routes) {
    if (!r.visible || !ids.has(r.id)) continue;
    let best = Infinity;
    const n = r.ll.reduce((s, g) => s + g.length, 0), k = Math.max(1, Math.ceil(n / 3000));
    for (const seg of r.ll) {
      let prev = null;
      for (let i = 0; i < seg.length; i += k) {
        const s = m.project([seg[i][1], seg[i][0]]);
        if (prev) { const d = dseg(pt, prev, s); if (d < best) best = d; }
        prev = s;
      }
    }
    if (best <= tol) out.push({ r, d: best });
  }
  return out.sort((x, y) => x.d - y.d);
}

// 气泡里的内容：名称、关键数据、日期和文件名；这里有好几条路线重叠时，下面再列出来，点名称就切换
function infoNode(sel, cands) {
  const el = document.createElement('div'), line = (cls, txt) => { const d = document.createElement('div'); d.className = cls; d.textContent = txt; return d; };
  el.className = 'co';
  const t = document.createElement('div'), dot = document.createElement('i'), nm = document.createElement('b');
  t.className = 'co-t'; dot.style.background = sel.color; nm.textContent = sel.name;
  t.append(dot, nm); el.append(t);
  el.append(line('co-s', [fmtKm(sel.dist), sel.gain != null ? `爬升 ${Math.round(sel.gain)} m · 下降 ${Math.round(sel.loss)} m` : '无海拔数据'].join(' · ')));
  const s2 = [sel.max != null ? `最高 ${Math.round(sel.max)} m · 最低 ${Math.round(sel.min)} m` : '', sel.dur ? `用时 ${fmtDur(sel.dur)}` : ''].filter(Boolean).join(' · ');
  if (s2) el.append(line('co-s', s2));
  const meta = [sel.t0 ? fmtDate(sel.t0) : '', sel.file].filter(Boolean).join(' · ');
  if (meta) el.append(line('co-m', meta));
  if (cands.length > 1) {
    el.append(line('co-l', `这里有 ${cands.length} 条路线重叠，点名称切换：`));
    const ul = document.createElement('ul');
    ul.className = 'co-u';
    for (const c of cands.slice(0, 8)) {
      const li = document.createElement('li'), i = document.createElement('i'), sp = document.createElement('span'), em = document.createElement('em');
      li.dataset.id = c.r.id; if (c.r === sel) li.className = 'on';
      i.style.background = c.r.color; sp.textContent = c.r.name; em.textContent = fmtKm(c.r.dist);
      li.append(i, sp, em); ul.append(li);
    }
    el.append(ul);
  }
  return el;
}
function closeInfo() {
  INFO.cur = null;
  if (INFO.pop) { map.closePopup(INFO.pop); INFO.pop = null; }
  if (INFO.pop3) { INFO.pop3.remove(); INFO.pop3 = null; }
}
function showInfo(at, cands, sel) {
  INFO.cur = { at, cands, sel };
  const node = infoNode(sel, cands);
  node.addEventListener('click', e => { // 点气泡里列出的某一条：切换选中，气泡内容跟着换
    e.stopPropagation(); // 换内容时旧的节点会被摘掉，不拦住的话 Leaflet 认不出这次点击发生在气泡里，会当成点了地图（→ 取消选中、气泡关闭）
    const li = e.target.closest('li[data-id]');
    const r = li && routes.find(x => String(x.id) === li.dataset.id);
    if (r && r !== selected) { select(r, { keepInfo: true }); if (INFO.last) INFO.last.sel = r; showInfo(at, cands, r); }
  });
  if (v3.on) {
    if (!INFO.pop3) INFO.pop3 = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '300px', offset: 12, className: 'info-pop' });
    INFO.pop3.setLngLat(at.lngLat).setDOMContent(node);
    if (!INFO.pop3.isOpen()) INFO.pop3.addTo(v3.map);
    return;
  }
  const m = mapInsets();
  if (!INFO.pop) INFO.pop = L.popup({ className: 'info-pop', closeButton: false, closeOnClick: false, autoClose: false, maxWidth: 300, minWidth: 220, offset: [0, -2] });
  INFO.pop.options.autoPanPaddingTopLeft = L.point(m.left + 12, m.top + 10);
  INFO.pop.options.autoPanPaddingBottomRight = L.point(m.right + 8, m.bottom + 12);
  INFO.pop.setLatLng(at.ll).setContent(node);
  if (!map.hasLayer(INFO.pop)) map.openPopup(INFO.pop);
}
// 地图上点了一下：cands 是容差内的路线（已按距离排好）。点在空白处 → 取消选中；点到了 → 选最近的那条、展开抽屉、列表里突出显示、气泡显示信息
function tapRoutes(at, pt, cands) {
  if (!cands.length) { INFO.last = null; if (selected) select(null); else closeInfo(); return; }
  let sel = cands[0].r;
  const last = INFO.last;
  if (last && last.sel === selected && cands.length > 1 && cands.some(c => c.r === selected)) { // 在同一个位置再点一次：切到下一条重叠的路线（位置按地理坐标比，地图被挪动过也认得出来）
    const p = last.at.ll ? map.latLngToContainerPoint(last.at.ll) : v3.map.project(last.at.lngLat);
    if (Math.hypot(pt.x - p.x, pt.y - p.y) < 14) sel = cands[(cands.findIndex(c => c.r === selected) + 1) % cands.length].r;
  }
  select(sel, { open: true });
  INFO.last = { at, sel };
  const ll = at.ll ? [at.ll.lat, at.ll.lng] : [at.lngLat.lat, at.lngLat.lng];
  ensureVisible(ll); // 抽屉展开后会盖住地图下半部分，把被点的位置挪到还看得见的区域里
  showInfo(at, cands, sel);
}

/* ================= 海拔剖面（拖动手指看每一点的海拔和坡度） ================= */
const PF = { raf: 0, hoverM: null, view: null, marker: null, gpsM: null };
const pfCv = $('#pfCanvas');
function schedProfile() { if (!PF.raf) PF.raf = requestAnimationFrame(drawProfile); }
function mark(ll, color) {
  if (v3.on) { if (v3.ready) { v3.map.getSource('hm').setData(pt3([ll[1], ll[0]], { color })); v3.hmOn = true; } return; }
  if (!PF.marker) PF.marker = L.circleMarker(ll, { renderer, radius: 8, weight: 3, color: '#ffffff', fillOpacity: 1, interactive: false });
  PF.marker.setLatLng(ll).setStyle({ fillColor: color });
  if (!map.hasLayer(PF.marker)) PF.marker.addTo(map);
  PF.marker.bringToFront();
}
function unmark() {
  if (PF.marker && map.hasLayer(PF.marker)) map.removeLayer(PF.marker);
  if (v3.hmOn && v3.ready) v3.map.getSource('hm').setData(EMPTY_FC);
  v3.hmOn = false;
}
// 深色背景上，太暗的颜色（深蓝、深紫）看不清：往白色混一点，提到够亮
function onDark(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.4) return hex;
  const k = (0.4 - lum) / (1 - lum), mix = c => Math.round(c + (255 - c) * k);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
function drawProfile() {
  PF.raf = 0;
  const r = selected;
  if (!r || !r.prof || pfCv.hidden || $('#detail').hidden) { PF.view = null; return; }
  const W = pfCv.clientWidth, H = pfCv.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (pfCv.width !== Math.round(W * dpr) || pfCv.height !== Math.round(H * dpr)) { pfCv.width = Math.round(W * dpr); pfCv.height = Math.round(H * dpr); }
  const g = pfCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const cMuted = css.getPropertyValue('--muted').trim(), cGrid = css.getPropertyValue('--line').trim(), cText = css.getPropertyValue('--text').trim(), cAcc = css.getPropertyValue('--accent').trim();
  g.font = '11px -apple-system, "PingFang SC", "Segoe UI", sans-serif';
  const p = r.prof, xmax = p.total;
  let ymin = p.min, ymax = p.max;
  if (!(ymax > ymin)) ymax = ymin + 10;
  const padY = (ymax - ymin) * 0.08;
  ymin -= padY; ymax += padY;
  const L0 = 42, R0 = 10, T0 = 10, B0 = 22, pw = W - L0 - R0, ph = H - T0 - B0;
  const X = m => L0 + m / xmax * pw, Y = v => T0 + (1 - (v - ymin) / (ymax - ymin)) * ph;
  PF.view = { L: L0, R: R0, W, pw, xmax };

  g.lineWidth = 1; g.strokeStyle = cGrid; g.fillStyle = cMuted; g.textAlign = 'right'; g.textBaseline = 'middle';
  const ys = niceStep(ymax - ymin, 3);
  for (let v = Math.ceil(ymin / ys) * ys; v <= ymax; v += ys) {
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath(); g.moveTo(L0, y); g.lineTo(W - R0, y); g.stroke();
    g.fillText(Math.round(v) + '', L0 - 5, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  const xs = niceStep(xmax / 1000, Math.max(2, Math.floor(pw / 80)));
  for (let v = 0; v <= xmax / 1000 + 1e-9; v += xs) {
    const x = Math.round(X(v * 1000)) + 0.5;
    g.beginPath(); g.moveTo(x, T0); g.lineTo(x, T0 + ph); g.stroke();
    g.fillText(+v.toFixed(2) + ' km', x, T0 + ph + 5);
  }
  const path = new Path2D();
  p.d.forEach((m, i) => { const x = X(m), y = Y(p.e[i]); if (i) path.lineTo(x, y); else path.moveTo(x, y); });
  const area = new Path2D(path);
  area.lineTo(X(p.total), T0 + ph); area.lineTo(X(0), T0 + ph); area.closePath();
  const col = darkNow() ? onDark(r.color) : r.color;
  g.globalAlpha = 0.18; g.fillStyle = col; g.fill(area);
  g.globalAlpha = 1; g.lineJoin = 'round'; g.lineWidth = 2.4; g.strokeStyle = col; g.stroke(path);

  if (PF.gpsM != null && PF.gpsM <= xmax) { // 我现在在这条路线的哪一段
    const a = atDist(p, PF.gpsM), x = X(PF.gpsM);
    g.setLineDash([4, 3]); g.strokeStyle = cAcc; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, T0); g.lineTo(Math.round(x) + 0.5, T0 + ph); g.stroke(); g.setLineDash([]);
    if (a) { g.beginPath(); g.arc(x, Y(a.e), 5, 0, Math.PI * 2); g.fillStyle = '#1a73e8'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
  }
  const info = $('#pfInfo'), clr = $('#pfClear');
  let a = null;
  if (PF.hoverM != null && PF.hoverM <= xmax) {
    const m = PF.hoverM, x = X(m);
    a = atDist(p, m);
    g.globalAlpha = 0.6; g.strokeStyle = cText; g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, T0); g.lineTo(Math.round(x) + 0.5, T0 + ph); g.stroke();
    g.globalAlpha = 1;
    if (a) { g.beginPath(); g.arc(x, Y(a.e), 4.5, 0, Math.PI * 2); g.fillStyle = r.color; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
  }
  if (a) {
    const sl = slopeAt(p, PF.hoverM);
    info.textContent = `${fmtKm(PF.hoverM)} · ${Math.round(a.e)} m${sl == null ? '' : ` · 坡度 ${sl >= 0 ? '+' : ''}${sl.toFixed(1)}%`} · 已爬 ${Math.round(a.g)} m`;
    clr.hidden = false;
    mark(a.ll, r.color);
    if (PF.pan) { PF.pan = false; ensureVisible(a.ll); } // 只在手指正在拖的时候才把地图挪到标记旁边；别的原因触发的重画（比如定位更新）不要抢地图
  } else {
    clr.hidden = true;
    unmark();
    info.textContent = '在图上按住并左右拖动，地图上会同步显示位置';
  }
}
function scrub(e) {
  const v = PF.view; if (!v) return;
  const rc = pfCv.getBoundingClientRect(), x = e.clientX - rc.left;
  PF.hoverM = Math.max(0, Math.min(v.xmax, (x - v.L) / v.pw * v.xmax));
  PF.pan = true;
  schedProfile();
}
pfCv.addEventListener('pointerdown', e => { pfCv.setPointerCapture(e.pointerId); scrub(e); });
pfCv.addEventListener('pointermove', scrub);
$('#pfClear').onclick = () => { PF.hoverM = null; schedProfile(); };
new ResizeObserver(() => schedProfile()).observe($('#pfWrap'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedProfile);

/* ================= 我的位置：蓝点 + 「我在不在路线上」 ================= */
// 定位不需要网络（卫星信号直接给位置），所以断网、用离线地图时一样能用。
// 判断：选中了一条路线就看那一条（"我要沿着它走"）；没选就在所有显示着的路线里自动找最近的。
// 离路线 ≤ 阈值 = 在路线上（绿）；超出一点、但还在定位误差范围内 = 靠近（黄）；再远 = 偏离（红，只有选中了路线才报偏离）；定位误差太大 / 位置太旧 = 灰，不下结论
const GPS = { id: null, follow: false, ll: null, acc: 0, alt: null, t: 0, t0: 0, dot: null, circ: null, guide: null, tdot: null, st: { shown: null, cand: null, cnt: 0 }, last: null, lastTgt: null, tgt: null, other: null, tick: 0, ac: null };
const GPS_OPT = { enableHighAccuracy: true, maximumAge: 4000, timeout: 30000 };
const GCOL = { on: '#1b9e55', near: '#e69500', off: '#d93025' };
const fmtM = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
const dir8 = b => ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(b / 45) % 8]; // 方位角（北 = 0，顺时针）→ 八个方向
function syncFab() {
  const b = $('#btnLocate');
  b.classList.toggle('on', GPS.id != null);
  b.classList.toggle('free', GPS.id != null && !GPS.follow);
}
function toggleLocate() {
  if (!navigator.geolocation) return toast('这个浏览器没有定位功能');
  if (GPS.id == null) {
    GPS.follow = true; GPS.t = 0; GPS.t0 = Date.now(); GPS.last = null; GPS.lastTgt = null; GPS.st = { shown: null, cand: null, cnt: 0 };
    GPS.id = navigator.geolocation.watchPosition(onPos, onPosErr, GPS_OPT);
    initAlertAudio(); // 在点按钮这个动作里创建音频，iPhone 才允许后面自动响
    GPS.tick = setInterval(() => updateGps(), 3000); // 没有新定位时也要刷新"多久以前"
    toast('正在定位…（不需要网络）' + (S.wake ? '' : '。想一直看着位置，可在设置里打开「屏幕常亮」'), 5000);
  } else if (!GPS.follow) {
    GPS.follow = true;
    if (GPS.ll) centerOn(GPS.ll, Math.max(map.getZoom(), 15), true);
  } else stopGps();
  syncFab();
  updateGps();
}
function stopGps() {
  if (GPS.id != null) navigator.geolocation.clearWatch(GPS.id);
  clearInterval(GPS.tick); GPS.tick = 0;
  GPS.id = null; GPS.follow = false; GPS.ll = null; GPS.t = 0; GPS.tgt = null; GPS.other = null;
  if (GPS.dot) { map.removeLayer(GPS.dot); GPS.dot = null; }
  if (GPS.circ) { map.removeLayer(GPS.circ); GPS.circ = null; }
  clearGuide();
  if (GPS.ac) { try { GPS.ac.close(); } catch (e) { /* 忽略 */ } GPS.ac = null; }
  PF.gpsM = null;
  $('#gps').hidden = true;
  syncGps3d();
  syncFab(); schedProfile();
}
function onPos(pos) {
  const c = pos.coords, ll = [c.latitude, c.longitude], first = !GPS.ll;
  GPS.ll = ll; GPS.acc = c.accuracy; GPS.alt = Number.isFinite(c.altitude) ? c.altitude : null;
  GPS.t = pos.timestamp > 0 && Math.abs(Date.now() - pos.timestamp) < 60000 ? pos.timestamp : Date.now();
  if (!GPS.dot) {
    GPS.circ = L.circle(ll, { radius: c.accuracy, renderer, weight: 1, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
    GPS.dot = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"><i></i></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
  } else { GPS.dot.setLatLng(ll); GPS.circ.setLatLng(ll).setRadius(c.accuracy); }
  syncGps3d();
  if (first) centerOn(ll, Math.max(map.getZoom(), 15), false);
  else if (GPS.follow) centerOn(ll, null, true);
  updateGps(true);
}
function onPosErr(err) {
  if (err.code === 1) { toast('没有定位权限。到「设置 → 隐私与安全性 → 定位服务」里允许 Safari 网站 / 本 App 使用定位', 9000); stopGps(); }
  else toast('暂时定位不到（' + (err.message || '信号弱') + '），会继续尝试', 4000);
}

// 在 routes 里（不含 exclude）找离我最近的一条显示着的路线：先用外框排除远的，再精确算
function autoPick(exclude) {
  const [lat, lon] = GPS.ll, kx = 111320 * Math.cos(lat * RAD), T = S.offDist, cands = [];
  for (const r of routes) {
    if (r === exclude || !r.visible || r.flat.n < 2 || !r.bounds) continue;
    const b = r.bounds;
    cands.push({ r, bd: Math.hypot(Math.max(b.getWest() - lon, 0, lon - b.getEast()) * kx, Math.max(b.getSouth() - lat, 0, lat - b.getNorth()) * 111320) });
  }
  cands.sort((a, b) => a.bd - b.bd);
  let best = null, within = 0;
  for (const c of cands) {
    if (best && c.bd > Math.max(best.eff, T)) break;
    const n = nearestOn(c.r, lat, lon, GPS.last && GPS.last.r === c.r ? GPS.last.m : null);
    if (!n) continue;
    const eff = n.off + (c.r.segs.length > 20 ? 15 : 0); // 整片路网（OSM 土路那种）排在普通路线后面
    if (n.off <= T) within++;
    if (!best || eff < best.eff) best = { r: c.r, n, auto: true, eff };
  }
  if (best) best.overlap = Math.max(0, within - (best.n.off <= T ? 1 : 0)); // 除了它之外，还有几条路线也在这儿
  return best;
}
function clearGuide() {
  if (GPS.guide) { map.removeLayer(GPS.guide); GPS.guide = null; }
  if (GPS.tdot) { map.removeLayer(GPS.tdot); GPS.tdot = null; }
}
function initAlertAudio() {
  if (!S.offAlert || GPS.ac) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try { GPS.ac = new AC(); GPS.ac.resume().catch(() => {}); } catch (e) { GPS.ac = null; }
}
// 偏离：三声低音 + 震动（iPhone 的网页不能震动，静音键打开时也没声音）；回到路线：一声高音
function gpsBeep(kind) {
  const ac = GPS.ac;
  if (ac) {
    try {
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      const tone = (f, at, d) => {
        const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + at;
        o.frequency.value = f; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.start(t); o.stop(t + d + 0.05);
      };
      if (kind === 'off') { tone(620, 0, 0.25); tone(620, 0.35, 0.25); tone(480, 0.7, 0.45); } else tone(900, 0, 0.2);
    } catch (e) { /* 忽略 */ }
  }
  if (kind === 'off' && navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 250]);
}
function gpsAlert(kind, tg) {
  const box = $('#gps');
  if (kind === 'off') {
    toast(`偏离路线了：离路线 ${fmtM(tg.n.off)}，往${dir8(tg.n.brg)}走回到路线`, 8000);
    box.classList.remove('alert'); void box.offsetWidth; box.classList.add('alert');
  } else toast('回到路线上了', 3000);
  if (S.offAlert) gpsBeep(kind); // 状态条变红闪一下 + 弹提示是一直有的；响声 / 震动要在设置里打开
}

function updateGps(fresh) {
  const box = $('#gps'), T = S.offDist;
  if (GPS.id == null) { PF.gpsM = null; box.hidden = true; clearGuide(); return; }
  if (!GPS.ll) { // 还在等第一次定位
    box.className = 'st-wait';
    box.innerHTML = `<div class="g1"><b>正在定位…</b></div><div class="g2">已等了 ${Math.round((Date.now() - GPS.t0) / 1000)} 秒。在室内、树下、峡谷里信号弱，到开阔的地方会快一些。定位不需要网络。</div>`;
    box.hidden = false; PF.gpsM = null; clearGuide();
    return;
  }
  const acc = GPS.acc || 0, age = (Date.now() - GPS.t) / 1000;
  let tg = null;
  if (selected && selected.flat.n > 1) {
    const n = nearestOn(selected, GPS.ll[0], GPS.ll[1], GPS.last && GPS.last.r === selected ? GPS.last.m : null);
    if (n) tg = { r: selected, n, auto: false, overlap: 0 };
  } else tg = autoPick(null);
  if ((tg && tg.r) !== GPS.lastTgt) { GPS.lastTgt = tg && tg.r; GPS.st = { shown: null, cand: null, cnt: 0 }; } // 换了路线：不用等，马上按新的算
  // 先判断这一刻的状态
  let raw;
  if (age > 120) raw = 'stale';
  else if (!routes.some(r => r.visible)) raw = 'noroute';
  else if (acc > Math.max(60, 2 * T)) raw = 'weak';
  else if (!tg) raw = 'none';
  else if (tg.n.off <= T) raw = 'on';
  else if (tg.n.off <= T + Math.min(acc, 100)) raw = 'near';
  else raw = tg.auto ? 'none' : 'off';
  // 在 绿 / 黄 / 红 之间切换要连续两次定位都一样，免得在边界上来回闪；其余状态立刻切
  const s = GPS.st, prev = s.shown, reg = x => x === 'on' || x === 'near' || x === 'off';
  if (!reg(raw) || !reg(prev)) { s.shown = raw; s.cand = raw; s.cnt = 0; }
  else if (raw === s.shown) { s.cand = raw; s.cnt = 0; }
  else if (fresh) { if (raw === s.cand) s.cnt++; else { s.cand = raw; s.cnt = 1; } if (s.cnt >= 2) { s.shown = raw; s.cnt = 0; } }
  const shown = s.shown;
  if (prev !== shown && tg && !tg.auto) { // 沿着选中的路线走：走偏了提醒一次，回来了说一声
    if (shown === 'off' && (prev === 'on' || prev === 'near')) gpsAlert('off', tg);
    else if (shown === 'on' && prev === 'off') gpsAlert('back', tg);
  }
  if (tg && reg(shown) && tg.n.off <= T + Math.min(acc, 100) + 50) GPS.last = { r: tg.r, m: tg.n.m }; // 记住"走到哪了"，往返 / 绕圈的路线靠它分清走的是哪一趟
  GPS.tgt = tg;
  // 显示
  const n = tg && tg.n, nm = tg ? `「${esc(tg.r.name)}」` : '';
  let h1 = '', t1 = '', h2 = '';
  const prog = () => {
    const r = tg.r, a = r.prof ? atDist(r.prof, Math.min(n.m, r.prof.total)) : null;
    return `在路线 ${(n.m / 1000).toFixed(2)} / ${(r.dist / 1000).toFixed(2)} km 处 · 还剩 ${((r.dist - n.m) / 1000).toFixed(2)} km` + (a && r.gain != null ? ` · 还要爬 ${Math.max(0, Math.round(r.gain - a.g))} m` : '');
  };
  GPS.other = null;
  if (shown === 'on') {
    h1 = tg.auto ? `在${nm}上` : '在路线上'; t1 = n.off < 8 ? '' : `离路线 ${fmtM(n.off)}`;
    h2 = prog() + (tg.overlap ? ` · 这里还有 ${tg.overlap} 条路线重合` : '');
  } else if (shown === 'near') {
    h1 = '靠近路线'; t1 = `约 ${fmtM(n.off)}`;
    h2 = `误差 ±${Math.round(acc)} m，可能还在路线上 · 路线在你${dir8(n.brg)}边`;
  } else if (shown === 'off') {
    h1 = '偏离路线'; t1 = fmtM(n.off);
    h2 = `往${dir8(n.brg)}走约 ${fmtM(n.off)} 回到路线（最近的点在路线 ${(n.m / 1000).toFixed(2)} km 处）`;
    const o = autoPick(selected);
    if (o && o.n.off <= T) { GPS.other = o.r; h2 += `<br>不过你在「${esc(o.r.name)}」上（点这里改看它）`; }
  } else if (shown === 'weak') {
    h1 = `定位不准（±${Math.round(acc)} m）`; h2 = acc > 500 ? '误差太大，没法判断是否在路线上。检查「设置 → 隐私与安全性 → 定位服务」里这个 App 的「精确位置」是不是开着。' : '误差太大，暂时没法判断是否在路线上；到开阔的地方等几秒会好一些。';
  } else if (shown === 'stale') {
    h1 = `位置已过时（${age < 3600 ? Math.round(age / 60) + ' 分钟' : '很久'}前）`; h2 = '没有收到新的定位。在峡谷、树下、室内信号会断；打开屏幕、到开阔的地方再看。';
  } else if (shown === 'noroute') {
    h1 = '定位中'; h2 = '还没有显示着的路线。导入、画一条，或在列表里打开一条，就能判断你在不在路线上。';
  } else { // none
    h1 = '附近没有路线';
    h2 = n ? `最近的是${nm}，在你${dir8(n.brg)}边 ${fmtM(n.off)}` : '显示着的路线离这里都很远';
  }
  const tail = [`精度 ±${Math.round(acc)} m${acc > 100 ? '（较差）' : ''}`, GPS.alt != null ? `海拔 ${Math.round(GPS.alt)} m` : '', age > 20 && shown !== 'stale' ? `位置是 ${Math.round(age)} 秒前的` : ''].filter(Boolean).join(' · ');
  const name = tg && !tg.auto && (shown === 'on' || shown === 'near' || shown === 'off') ? `${nm} · ` : '';
  box.innerHTML = `<div class="g1"><b>${h1}</b>${t1 ? `<span>${t1}</span>` : ''}</div>${h2 ? `<div class="g2">${h2}</div>` : ''}<div class="g3">${name}${tail}</div>`;
  box.className = 'st-' + shown + (box.classList.contains('alert') ? ' alert' : '');
  box.hidden = false;
  // 地图上：靠近 / 偏离时，从我画一条虚线到路线上最近的点
  if (tg && (shown === 'near' || shown === 'off') && n.off >= 8) {
    const col = GCOL[shown], here = [n.lat, n.lon];
    if (!GPS.guide) {
      GPS.guide = L.polyline([GPS.ll, here], { renderer, color: col, weight: 3, dashArray: '7 6', opacity: 1, interactive: false }).addTo(map);
      GPS.tdot = L.circleMarker(here, { renderer, radius: 7, weight: 3, color: col, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(map);
    } else { GPS.guide.setLatLngs([GPS.ll, here]).setStyle({ color: col }); GPS.tdot.setLatLng(here).setStyle({ color: col }); }
    GPS.guide.bringToFront(); GPS.tdot.bringToFront();
  } else clearGuide();
  PF.gpsM = tg && !tg.auto && (shown === 'on' || shown === 'near') ? n.m : null; // 剖面图上的"我在这儿"
  schedProfile();
}
$('#gps').onclick = () => { const r = GPS.tgt && GPS.tgt.auto ? GPS.tgt.r : GPS.other; if (r) select(r, { open: true }); };
$('#gps').addEventListener('animationend', e => e.currentTarget.classList.remove('alert')); // 闪完就去掉，免得状态条上一直留着这个类
document.addEventListener('visibilitychange', () => { // 锁屏 / 切走再回来：位置多半是旧的，重新要一次
  if (document.visibilityState !== 'visible' || GPS.id == null) return;
  if (GPS.ac && GPS.ac.state === 'suspended') GPS.ac.resume().catch(() => {});
  if (GPS.ll && Date.now() - GPS.t > 15000) { navigator.geolocation.clearWatch(GPS.id); GPS.id = navigator.geolocation.watchPosition(onPos, onPosErr, GPS_OPT); }
  updateGps();
});
map.on('dragstart', () => { if (GPS.id != null && GPS.follow) { GPS.follow = false; syncFab(); } });

/* ================= 导入 / 导出 ================= */
async function importFiles(list) {
  const picked = [...list]; // 必须在第一个 await 之前取出，FileList 随后会被清空
  if (!picked.length) return;
  const known = new Set(routes.map(r => r.key));
  let added = 0, dup = 0, big = 0, custom = null;
  const bad = [];
  // 待导入的文件：普通文件原样放进来；.zip 先展开成里面的轨迹文件（key 用「条目名 + 大小 + CRC」，同一个压缩包再导入一次，重复的会自动跳过）
  const jobs = [];
  for (const f of picked) {
    if (!/\.zip$/i.test(f.name)) { jobs.push({ name: f.name, label: f.name, stamp: [f.name, f.size, f.lastModified].join('|'), text: () => f.text(), file: f }); continue; }
    try {
      if (!window.Zip) throw new Error('压缩包读取组件没加载出来');
      toast(`正在读取压缩包：${f.name}`, 60000);
      const es = await Zip.readZip(f);
      if (!es.length) bad.push(`${f.name}（压缩包里没有 gpx / kml / tcx / geojson 文件）`);
      for (const e of es) jobs.push({ name: e.name.split('/').pop(), label: `${f.name} › ${e.name}`, stamp: `zip:${e.name}|${e.size}|${e.crc}`, text: async () => new TextDecoder('utf-8').decode(await e.read()) });
    } catch (e) { bad.push(`${f.name}（${e.message}）`); }
  }
  for (let i = 0; i < jobs.length; i++) {
    const f = jobs[i];
    if (jobs.length > 1) toast(`正在导入 ${i + 1} / ${jobs.length}：${f.name}`, 60000);
    try {
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'pmtiles' && f.file) { custom = f.file; continue; }
      const text = await f.text();
      const stamp = f.stamp;
      let items;
      if (ext === 'json' && /"format"\s*:\s*"armenia-trails-backup"/.test(text.slice(0, 400))) items = fromBackup(JSON.parse(text));
      else items = parseFile(f.name, text).map((p, j) => ({ key: `${stamp}#${j}`, name: p.name, segs: p.segs.map(pack), wpts: p.wpts }));
      if (!items.length) { bad.push(`${f.label}（里面没有轨迹）`); continue; }
      for (const it of items) {
        if (known.has(it.key)) { dup++; continue; }
        known.add(it.key);
        const rec = { key: it.key, file: it.file || f.name, name: it.name, color: it.color || colorAt(S.colorSeq++), visible: it.visible !== false, added: Date.now(), wpts: it.wpts || [] };
        let id;
        try { id = DB.ok ? await DB.add(rec, it.segs) : -(routes.length + 1); } catch (e) { DB.ok = false; id = -(routes.length + 1); toast('这台设备不让保存数据（' + e.message + '），路线只在本次打开期间有效', 8000); }
        rec.id = id;
        const r = addRoute(rec, it.segs);
        if (it.visible === undefined && r.dist > 300000) { setVisible(r, false, true); saveMeta([r]); big++; } // 超长的多半是整片路网（比如 OSM 的所有土路），默认先隐藏，免得盖住别的路线
        added++;
      }
    } catch (e) { bad.push(`${f.label}（${e.message}）`); }
  }
  saveS();
  renderList();
  if (added) { fitAll(); if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); refreshSettings(); }
  if (custom) await importPack(custom);
  const msg = [added && `已添加 ${added} 条路线`, big && `其中 ${big} 条超长（多半是整片路网）已默认隐藏，要看就在列表里打开`, dup && `${dup} 条已经有了，已跳过`, bad.length && `${bad.length} 个文件没读成功：${bad.slice(0, 3).join('；')}${bad.length > 3 ? '…' : ''}`].filter(Boolean).join('；');
  if (msg) toast(msg, 8000); else if (!custom) toast('没有找到可以导入的内容');
}
async function importPack(f) {
  if (!window.caches) return toast('这个浏览器不能保存离线地图文件');
  try {
    const buf = await f.arrayBuffer();
    if (String.fromCharCode(...new Uint8Array(buf, 0, 7)) !== 'PMTiles') throw new Error('不是 PMTiles 文件');
    await (await caches.open(BASE.cache)).put(CUSTOM, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
    S.custom = { name: f.name, size: buf.byteLength }; saveS();
    await initPack();
    if (bm.state === 'ready') toast(`已换成你导入的离线地图：${f.name}`);
  } catch (e) { toast('离线地图文件导入失败：' + e.message, 8000); }
}
function toBackup() {
  return {
    format: 'armenia-trails-backup', version: 1, exported: new Date().toISOString(),
    routes: routes.map(r => ({
      key: r.key, file: r.file, name: r.name, color: r.color, visible: r.visible, wpts: r.wpts,
      segs: r.segs.map(a => Array.from(a, v => v === v ? v : null)) // 不做舍入：数值本来就是从文本里读出来的，原样存，恢复后统计才和原来一模一样
    }))
  };
}
const fromBackup = j => j.routes.map(x => ({ key: x.key, file: x.file, name: x.name, color: x.color, visible: x.visible, wpts: x.wpts || [], segs: x.segs.map(a => Float64Array.from(a, v => v == null ? NaN : v)) }));
async function exportBackup() {
  if (!routes.length) return toast('还没有路线可以导出');
  const stamp = new Date().toISOString().slice(0, 10);
  const file = new File([JSON.stringify(toBackup())], `徒步轨迹备份-${stamp}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function clearAllRoutes() {
  if (!routes.length) return;
  if (!confirm(`清空全部 ${routes.length} 条路线？\n（建议先「导出备份」。清空后不能恢复）`)) return;
  routes.forEach(r => r.all.forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); }));
  routes.length = 0;
  schedule3d();
  select(null);
  try { await DB.clear(); } catch (e) { /* 忽略 */ }
  renderList(); refreshSettings();
  toast('已清空');
}

/* ================= 设置面板 ================= */
const settings = $('#settings');
function buildBaseList() {
  $('#baseList').innerHTML = Object.entries(BASES).map(([id, b]) => `<label><input type="radio" name="base" value="${id}"${S.base === id ? ' checked' : ''}><span>${esc(b.label)}<br><small>${esc(b.note)}</small></span></label>`).join('');
}
async function refreshSettings() {
  $('#optWidth').value = S.lineW; $('#optWidthVal').textContent = S.lineW;
  $('#optEnds').checked = S.ends; $('#optHalo').checked = S.halo; $('#optWpts').checked = S.wpts; $('#optWake').checked = S.wake;
  $('#optOff').value = S.offDist; $('#optOffVal').textContent = S.offDist + ' m'; $('#optAlert').checked = S.offAlert;
  $('#offNote').innerHTML = bm.state === 'ready'
    ? (S.custom ? `现在用的是你导入的离线地图：${esc(S.custom.name)}（${fmtMB(S.custom.size)}）。` : `已保存在本机（${fmtMB(bm.size)}）：${BASE.area}有街道级细节，亚美尼亚全境只到概略级别（大路、地名、河流）。数据是 Protomaps ${BASE.build} 的版本。`)
    : bm.state === 'loading' ? '正在准备…' : `没准备好：${esc(bm.err)}`;
  $('#btnResetBase').hidden = !S.custom;
  $('#optHill').checked = S.hill; $('#optHillOp').value = S.hillOp; $('#optHillOpVal').textContent = Math.round(S.hillOp * 100) + '%';
  $('#optEx3d').value = S.ex3d; $('#optEx3dVal').textContent = S.ex3d.toFixed(1) + '×';
  $('#demNote').innerHTML = dm.state === 'ready' ? `已保存在本机（${fmtMB(dm.size)}）：走廊一带约 30 米精度（SRTM 等），其他地方较粗。山体阴影和 3D 都用它。` : dm.state === 'loading' ? '正在准备…' : `没准备好：${esc(dm.err)}`;
  buildBase3dList();
  let usage = '';
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = `本机共占用约 ${fmtMB(e.usage || 0)}。`; } } catch (e) { /* 忽略 */ }
  $('#dataNote').textContent = `${routes.length} 条路线，保存在这台手机的浏览器存储里。${DB.ok ? '' : '（当前存不了，关掉就没了）'}${usage}iOS 偶尔会清理网站数据，所以重要的路线请用「导出备份」存一份到「文件」里。`;
  $('#about').innerHTML = `徒步轨迹 v${APP_VER}。底图数据 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap 贡献者</a>（ODbL），矢量切片 <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>；地形数据 Mapzen / AWS Terrain Tiles（NASA SRTM 等）；地图库 Leaflet、MapLibre GL、protomaps-leaflet、PMTiles、Protomaps basemaps。在线底图（卫星 / 地形）分别来自 Esri 和 OpenTopoMap，仅联网时使用。海拔的「累计爬升」是估算值，和轨迹网站上显示的会有出入。`;
}
function buildBase3dList() {
  $('#base3dList').innerHTML = Object.entries(BASES3D).map(([id, b]) => `<label><input type="radio" name="base3d" value="${id}"${S.base3d === id ? ' checked' : ''}><span>${esc(b.label)}<br><small>${esc(b.note)}</small></span></label>`).join('');
}
function openSettings() { buildBaseList(); refreshSettings(); settings.hidden = false; }
$('#baseList').addEventListener('change', e => { if (e.target.name === 'base') { S.base = e.target.value; saveS(); applyBase(); if (v3.map && v3.flavor !== flavor3d()) destroy3d(); if (BASES[S.base].kind === 'vec' && bm.state !== 'ready') toast('离线地图还没准备好：' + (bm.err || '正在加载')); } });
$('#optWidth').oninput = e => { S.lineW = +e.target.value; $('#optWidthVal').textContent = S.lineW; saveS(); routes.forEach(styleRoute); schedule3d(); };
$('#optEnds').onchange = e => { S.ends = e.target.checked; saveS(); routes.forEach(sync); schedule3d(); };
$('#optHalo').onchange = e => { S.halo = e.target.checked; saveS(); routes.forEach(r => r.halo.setStyle({ opacity: S.halo ? 0.85 : 0 })); schedule3d(); };
$('#optWpts').onchange = e => { S.wpts = e.target.checked; saveS(); routes.forEach(sync); schedule3d(); };
$('#optWake').onchange = e => { S.wake = e.target.checked; saveS(); setWake(S.wake); };
$('#optOff').oninput = e => { S.offDist = +e.target.value; $('#optOffVal').textContent = S.offDist + ' m'; saveS(); updateGps(); };
$('#optAlert').onchange = e => { S.offAlert = e.target.checked; saveS(); if (S.offAlert && GPS.id != null) initAlertAudio(); };
$('#base3dList').addEventListener('change', e => { if (e.target.name === 'base3d') { S.base3d = e.target.value; saveS(); apply3dBase(); } });
$('#optHill').onchange = e => { S.hill = e.target.checked; saveS(); applyHill(); apply3dHill(); };
$('#optHillOp').oninput = e => { S.hillOp = +e.target.value; $('#optHillOpVal').textContent = Math.round(S.hillOp * 100) + '%'; saveS(); if (dm.layer) dm.layer.setOpacity(S.hillOp); apply3dHill(); };
$('#optEx3d').oninput = e => { S.ex3d = +e.target.value; $('#optEx3dVal').textContent = S.ex3d.toFixed(1) + '×'; saveS(); if (v3.ready) v3.map.setTerrain({ source: 'dem', exaggeration: S.ex3d }); };
$('#btnRedem').onclick = async () => {
  if (!confirm('重新下载地形数据（约 ' + fmtMB(DEMP.size) + '）？需要联网。')) return;
  settings.hidden = true;
  await initDem(true);
  if (dm.state === 'ready') toast('地形数据已更新');
};
$('#btnCloseSettings').onclick = () => { settings.hidden = true; };
settings.addEventListener('click', e => { if (e.target === settings) settings.hidden = true; });
$('#btnExport').onclick = exportBackup;
$('#btnClear').onclick = clearAllRoutes;
$('#btnRedownload').onclick = async () => {
  if (S.custom) return toast('现在用的是你导入的地图；先点「恢复默认离线地图」');
  if (!confirm('重新下载离线地图（约 ' + fmtMB(BASE.size) + '）？需要联网。')) return;
  settings.hidden = true;
  await initPack(true);
  if (bm.state === 'ready') toast('离线地图已更新');
};
$('#btnResetBase').onclick = async () => {
  try { if (window.caches) await (await caches.open(BASE.cache)).delete(CUSTOM); } catch (e) { /* 忽略 */ }
  S.custom = null; saveS();
  settings.hidden = true;
  await initPack();
};

/* ================= 在地图上画线 → 生成新路线 → 导出 GPX ================= */
// 操作：点一下加一个点；手指在地图上划一笔就画出一段（松手后自动简化）；已有的点可以拖动调整；
// 画完点「完成」：沿线每约 30 米取一个点，海拔从离线地形数据里取，生成一条新路线（和导入的一样存在手机里），再问要不要导出 GPX
const DR = { on: false, pts: [], halo: null, line: null, prev: null, markers: [], pan: false, stroke: null, ele: null, tok: 0, timer: 0 };
const mapBox = map.getContainer();

// 沿折线每隔 step 米插一个点（线太长时放宽，最多约 6000 个点）
function densify(pts, step) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  step = Math.max(step, total / 6000);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.round(hav(a[0], a[1], b[0], b[1]) / step));
    for (let k = 1; k <= n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// 从离线高程里给一串 [纬, 经] 取海拔（双线性插值）；高程数据没准备好返回 null
async function sampleElev(points) {
  if (dm.state !== 'ready' || !dm.dem) return null;
  const dem = dm.dem, z = Math.min(dem.max, 12), n = 2 ** z * 256;
  const fx = lng => (lng + 180) / 360 * n - 0.5, fy = lat => { const s = Math.sin(lat * RAD); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - 0.5; };
  const need = new Set();
  for (const [la, lo] of points) { const x = Math.floor(fx(lo)), y = Math.floor(fy(la)); for (const dx of [0, 1]) for (const dy of [0, 1]) need.add(((x + dx) >> 8) + '/' + ((y + dy) >> 8)); }
  const tiles = new Map();
  await Promise.all([...need].map(async k => { const [tx, ty] = k.split('/').map(Number); tiles.set(k, await dem.tile(z, tx, ty)); }));
  const val = (ix, iy) => { const t = tiles.get((ix >> 8) + '/' + (iy >> 8)); return t ? t[(iy & 255) * 256 + (ix & 255)] : NaN; };
  return points.map(([la, lo]) => {
    const x = fx(lo), y = fy(la), x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    return (val(x0, y0) * (1 - tx) + val(x0 + 1, y0) * tx) * (1 - ty) + (val(x0, y0 + 1) * (1 - tx) + val(x0 + 1, y0 + 1) * tx) * ty;
  });
}
const r6 = v => Math.round(v * 1e6) / 1e6; // 6 位小数 ≈ 11 厘米，导出的 GPX 不会拖一长串小数
const toSeg = (dense, ele) => dense.map((p, i) => [r6(p[0]), r6(p[1]), ele && Number.isFinite(ele[i]) ? Math.round(ele[i] * 10) / 10 : null, null]);

// Douglas–Peucker 抽稀（屏幕像素坐标），把手划出来的密密麻麻的点收成几十个
function rdp(p, tol) {
  if (p.length < 3) return p;
  const dist = (q, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; if (!l2) return Math.hypot(q.x - a.x, q.y - a.y); const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)); return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)); };
  const keep = new Uint8Array(p.length), st = [[0, p.length - 1]];
  keep[0] = keep[p.length - 1] = 1;
  while (st.length) {
    const [a, b] = st.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = dist(p[i], p[a], p[b]); if (d > md) { md = d; mi = i; } }
    if (md > tol && mi >= 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return p.filter((_, i) => keep[i]);
}

async function startDraw() {
  if (DR.on) return;
  if (v3.on) await set3d(false); // 画线只在 2D 地图上
  select(null); closeInfo();
  DR.on = true; DR.pts = []; DR.pan = false; DR.ele = null;
  document.body.classList.add('drawing');
  $('#drawbar').hidden = false;
  $('#btnDraw').classList.add('on');
  $('#drPan').classList.remove('on'); $('#drPan').textContent = '移动地图';
  DR.halo = L.polyline([], { renderer, color: '#ffffff', weight: S.lineW + 5, opacity: 0.9, interactive: false }).addTo(map);
  DR.line = L.polyline([], { renderer, color: '#d81b60', weight: S.lineW + 1, dashArray: '9 7', interactive: false }).addTo(map);
  DR.prev = L.polyline([], { renderer, color: '#d81b60', weight: S.lineW + 1, interactive: false });
  map.dragging.disable(); // 一根手指拖动 = 画线；要移动地图就点「移动地图」，捏合缩放照常可用
  map.doubleClickZoom.disable(); // 连点两下是在加两个点，别触发"双击放大"
  drUpdate(true);
}
function stopDraw() {
  if (!DR.on) return;
  DR.on = false;
  clearTimeout(DR.timer); DR.tok++;
  DR.markers.forEach(m => map.removeLayer(m)); DR.markers = [];
  [DR.halo, DR.line, DR.prev].forEach(l => { if (l && map.hasLayer(l)) map.removeLayer(l); });
  DR.halo = DR.line = DR.prev = null; DR.stroke = null; DR.pts = [];
  map.dragging.enable(); map.doubleClickZoom.enable();
  document.body.classList.remove('drawing');
  $('#drawbar').hidden = true;
  $('#btnDraw').classList.remove('on');
}
function drCancel() {
  if (DR.pts.length >= 2 && !confirm('放弃这条还没保存的线？')) return;
  stopDraw();
}
function drTogglePan() {
  DR.pan = !DR.pan;
  DR.stroke = null;
  for (const h of [map.dragging, map.doubleClickZoom]) DR.pan ? h.enable() : h.disable();
  $('#drPan').classList.toggle('on', DR.pan);
  $('#drPan').textContent = DR.pan ? '继续画线' : '移动地图';
  drInfoText();
}
function drUpdate(rebuild) {
  DR.line.setLatLngs(DR.pts); DR.halo.setLatLngs(DR.pts);
  if (rebuild) drMarkers();
  drInfoText();
  clearTimeout(DR.timer);
  DR.timer = setTimeout(drElev, 350); // 手停下来再算海拔，免得每加一个点都算
}
function drMarkers() { // 每个点一个可以拖动的圆点；起点绿色、终点白色
  DR.markers.forEach(m => map.removeLayer(m)); DR.markers = [];
  DR.pts.forEach((ll, i) => {
    const cls = i === 0 ? 'dv start' : i === DR.pts.length - 1 ? 'dv end' : 'dv';
    const m = L.marker(ll, { draggable: true, keyboard: false, zIndexOffset: 600, icon: L.divIcon({ className: 'dvw', html: `<i class="${cls}"></i>`, iconSize: [26, 26], iconAnchor: [13, 13] }) });
    m.on('drag', () => { DR.pts[i] = m.getLatLng(); DR.line.setLatLngs(DR.pts); DR.halo.setLatLngs(DR.pts); });
    m.on('dragend', () => drUpdate(false));
    m.addTo(map); DR.markers.push(m);
  });
}
function drInfoText() {
  let d = 0;
  for (let i = 1; i < DR.pts.length; i++) d += hav(DR.pts[i - 1].lat, DR.pts[i - 1].lng, DR.pts[i].lat, DR.pts[i].lng);
  const el = DR.ele && DR.ele.gain != null ? ` · 爬升约 ${Math.round(DR.ele.gain)} m` : '';
  $('#drInfo').textContent = DR.pan ? '移动地图中：点「继续画线」回来继续画' : DR.pts.length ? `${DR.pts.length} 个点 · ${fmtKm(d)}${el}` : '点地图加点，或直接用手指划线';
}
async function drElev() { // 沿线取海拔，估算爬升
  const tok = ++DR.tok;
  if (DR.pts.length < 2 || dm.state !== 'ready') { DR.ele = null; return drInfoText(); }
  try {
    const dense = densify(DR.pts.map(p => [p.lat, p.lng]), 30), ele = await sampleElev(dense);
    if (tok !== DR.tok || !DR.on) return;
    const r = { segs: [pack(toSeg(dense, ele))] };
    analyze(r);
    DR.ele = r.gain == null ? null : { gain: r.gain, loss: r.loss };
  } catch (e) { DR.ele = null; }
  drInfoText();
}
// 加点：太近的（手抖）不要
function drAppend(lls) {
  for (const ll of lls) {
    const last = DR.pts[DR.pts.length - 1];
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 4) continue;
    DR.pts.push(L.latLng(ll.lat, ll.lng));
  }
  drUpdate(true);
}
// 手指输入：点一下 = 加一个点；拖动超过 8 像素 = 划一笔（松手后抽稀再加进去）；第二根手指落下 = 在捏合，放弃这一笔
mapBox.addEventListener('pointerdown', e => {
  if (!DR.on || DR.pan || e.target.closest('.dvw, .leaflet-control, .leaflet-popup')) return;
  if (!e.isPrimary) { if (DR.stroke) { DR.stroke = null; if (map.hasLayer(DR.prev)) map.removeLayer(DR.prev); } return; }
  DR.stroke = { x0: e.clientX, y0: e.clientY, id: e.pointerId, moved: false, pts: [] };
});
mapBox.addEventListener('pointermove', e => {
  const s = DR.stroke;
  if (!s || e.pointerId !== s.id) return;
  const rc = mapBox.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
  if (!s.moved) {
    if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < 8) return;
    s.moved = true; s.pts.push({ x: s.x0 - rc.left, y: s.y0 - rc.top });
    DR.prev.setLatLngs([map.containerPointToLatLng([s.pts[0].x, s.pts[0].y])]);
    if (!map.hasLayer(DR.prev)) DR.prev.addTo(map);
  }
  const last = s.pts[s.pts.length - 1];
  if (Math.hypot(x - last.x, y - last.y) >= 5) { s.pts.push({ x, y }); DR.prev.addLatLng(map.containerPointToLatLng([x, y])); }
});
const drEnd = e => {
  const s = DR.stroke;
  if (!s || e.pointerId !== s.id) return;
  DR.stroke = null;
  if (map.hasLayer(DR.prev)) map.removeLayer(DR.prev);
  if (e.type === 'pointercancel') return;
  const rc = mapBox.getBoundingClientRect();
  if (!s.moved) { drAppend([map.containerPointToLatLng([e.clientX - rc.left, e.clientY - rc.top])]); return; }
  drAppend(rdp(s.pts, 3).map(p => map.containerPointToLatLng([p.x, p.y])));
};
mapBox.addEventListener('pointerup', drEnd);
mapBox.addEventListener('pointercancel', drEnd);

async function finishDraw() {
  if (DR.pts.length < 2) return toast('至少要有两个点才能生成路线');
  $('#drDone').disabled = true;
  try {
    const dense = densify(DR.pts.map(p => [p.lat, p.lng]), 30), ele = await sampleElev(dense);
    const def = `手绘路线 ${routes.filter(r => r.file === '手绘').length + 1}`;
    const ans = prompt('给这条新路线起个名字：', def);
    if (ans === null) return; // 取消：留在画线模式里继续改
    const name = ans.trim() || def, segs = [pack(toSeg(dense, ele))];
    const rec = { key: `draw:${Date.now()}`, file: '手绘', name, color: colorAt(S.colorSeq++), visible: true, added: Date.now(), wpts: [] };
    let id;
    try { id = DB.ok ? await DB.add(rec, segs) : -(routes.length + 1); } catch (e) { DB.ok = false; id = -(routes.length + 1); toast('这台设备不让保存数据（' + e.message + '），路线只在本次打开期间有效', 8000); }
    rec.id = id;
    const r = addRoute(rec, segs);
    saveS();
    stopDraw();
    renderList();
    select(r, { open: true, fit: true });
    toast(`已生成「${name}」${fmtKm(r.dist)}${r.gain != null ? `，爬升约 ${Math.round(r.gain)} m` : '（没有海拔数据）'}。点「分享」可以发给别人`, 7000);
  } finally { $('#drDone').disabled = false; }
}

// 导出成 GPX 1.1：轨迹点带海拔（有时间也带时间），航点一并带上
function gpxOf(r) {
  const x = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="亚美尼亚徒步轨迹" xmlns="http://www.topografix.com/GPX/1/1">', `<metadata><name>${x(r.name)}</name></metadata>`];
  for (const w of r.wpts) out.push(`<wpt lat="${w.lat}" lon="${w.lng}">${w.ele != null ? `<ele>${w.ele}</ele>` : ''}<name>${x(w.name || '')}</name></wpt>`);
  out.push(`<trk><name>${x(r.name)}</name>`);
  for (const a of r.segs) {
    out.push('<trkseg>');
    for (let i = 0; i < a.length; i += 4) out.push(`<trkpt lat="${a[i]}" lon="${a[i + 1]}">${a[i + 2] === a[i + 2] ? `<ele>${a[i + 2]}</ele>` : ''}${a[i + 3] === a[i + 3] ? `<time>${new Date(a[i + 3]).toISOString()}</time>` : ''}</trkpt>`);
    out.push('</trkseg>');
  }
  out.push('</trk>', '</gpx>');
  return out.join('\n');
}
async function exportRoute(r) {
  const fname = (r.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || '路线') + '.gpx';
  const text = gpxOf(r);
  for (const type of ['application/gpx+xml', 'application/xml', 'text/xml', 'text/plain']) { // 分享面板对文件类型有白名单，挑第一个被接受的
    const file = new File([text], fname, { type });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: fname }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); // 不支持分享：走普通下载
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' })); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`已下载 ${fname}`);
}

/* ================= 分享：GPX 文件 / 链接 ================= */
// 链接里装的就是路线本身（不经过任何服务器，# 后面的内容浏览器也不会发给网站）：
// 先抽稀到最多 300 个点，每个点取到 1e-5 度（约 1 米）、海拔取整米，相邻点做差 → 变长整数 → deflate 压缩 → base64url
const SHARE_MAX_PTS = 300, SHARE_MAX_SEGS = 20, SHARE_ABS_MAX = 5000;
const b64u = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const zig = n => ((n << 1) ^ (n >> 31)) >>> 0, unzig = u => (u >>> 1) ^ -(u & 1);
function putVar(out, u) { u >>>= 0; while (u > 127) { out.push((u & 127) | 128); u >>>= 7; } out.push(u); }
function getVar(b, o) {
  let u = 0, s = 0, x;
  do { x = b[o.i++]; if (x === undefined || s > 28) throw new Error('数据不完整'); u |= (x & 127) << s; s += 7; } while (x & 128);
  return u >>> 0;
}
async function pipeBytes(bytes, stream, max) { // 读完整个流；超过 max 字节就停（防止恶意链接解压出一大坨）
  const rd = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
  let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > max) { rd.cancel(); throw new Error('数据太大'); } parts.push(value); }
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// 路线 → 字符串。r.segs 里每段是 [纬, 经, 海拔|NaN, 时间|NaN] 四个一组的 Float64Array；返回 base64url
async function shareEncode(r) {
  if (r.segs.length > SHARE_MAX_SEGS) throw new Error('这条路线由太多段组成');
  const segs = r.segs.map(a => { const o = []; for (let i = 0; i < a.length; i += 4) o.push({ lat: a[i], lon: a[i + 1], ele: a[i + 2] }); return o; }).filter(s => s.length > 1);
  if (!segs.length) throw new Error('这条路线没有轨迹点');
  let total = 0; for (const s of segs) total += s.length;
  let keep = segs;
  if (total > SHARE_MAX_PTS) { // 逐步放宽抽稀的距离（米），直到点数够少
    const k0 = Math.cos(segs[0][0].lat * RAD) * 111320, k1 = 111320;
    for (let tol = 4; ; tol *= 1.5) {
      keep = segs.map(s => rdp(s.map(p => ({ x: p.lon * k0, y: p.lat * k1, p })), tol).map(q => q.p));
      let n = 0; for (const s of keep) n += s.length;
      if (n <= SHARE_MAX_PTS || tol > 5000) break;
    }
  }
  const hasEle = keep.every(s => s.every(p => Number.isFinite(p.ele)));
  const q = v => Math.round(v * 1e5);
  const nameB = new TextEncoder().encode(Array.from(r.name.replace(/[\u0000-\u001f]/g, ' ').trim()).slice(0, 60).join('')); // 最多 60 个字
  const inner = [(1 << 4) | (hasEle ? 1 : 0)];
  putVar(inner, nameB.length); for (const c of nameB) inner.push(c);
  putVar(inner, keep.length);
  for (const s of keep) {
    putVar(inner, s.length);
    let pa = 0, po = 0, pe = 0;
    s.forEach((p, i) => {
      const a = q(p.lat), o = q(p.lon), e = hasEle ? Math.round(p.ele) : 0;
      putVar(inner, zig(i ? a - pa : a)); putVar(inner, zig(i ? o - po : o)); if (hasEle) putVar(inner, zig(i ? e - pe : e));
      pa = a; po = o; pe = e;
    });
  }
  const raw = Uint8Array.from(inner);
  let body = null;
  if (typeof CompressionStream !== 'undefined') { try { body = await pipeBytes(raw, new CompressionStream('deflate-raw'), 1 << 20); } catch (e) { body = null; } }
  const out = new Uint8Array((body || raw).length + 1);
  out[0] = body ? 1 : 0; out.set(body || raw, 1);
  return b64u(out);
}
// 字符串 → { name, segs: [Float64Array…], hasEle }；任何不对劲的地方都抛出带中文说明的错误
async function shareDecode(str) {
  if (!/^[A-Za-z0-9_-]{8,40000}$/.test(str)) throw new Error('链接不完整（可能复制的时候被截断了）');
  let bytes;
  try { bytes = unb64u(str); } catch (e) { throw new Error('链接不完整（可能复制的时候被截断了）'); }
  let inner;
  if (bytes[0] === 1) {
    if (typeof DecompressionStream === 'undefined') throw new Error('这个系统版本太旧，打不开');
    try { inner = await pipeBytes(bytes.subarray(1), new DecompressionStream('deflate-raw'), 400000); } catch (e) { throw new Error(e.message === '数据太大' ? e.message : '链接不完整（可能复制的时候被截断了）'); }
  } else if (bytes[0] === 0) inner = bytes.subarray(1);
  else throw new Error('链接不是这个版本的 App 生成的');
  const o = { i: 0 }, flags = inner[o.i++];
  if ((flags >> 4) !== 1) throw new Error('链接不是这个版本的 App 生成的');
  const hasEle = !!(flags & 1);
  const nl = getVar(inner, o);
  if (nl > 400 || o.i + nl > inner.length) throw new Error('链接内容不对');
  const name = new TextDecoder('utf-8').decode(inner.subarray(o.i, o.i + nl)).replace(/[\u0000-\u001f�]/g, ' ').trim().slice(0, 80); o.i += nl;
  const ns = getVar(inner, o);
  if (!ns || ns > SHARE_MAX_SEGS) throw new Error('链接内容不对');
  const segs = []; let total = 0;
  for (let s = 0; s < ns; s++) {
    const n = getVar(inner, o);
    total += n;
    if (n < 2 || total > SHARE_ABS_MAX) throw new Error('链接内容不对');
    const a = new Float64Array(n * 4);
    let pa = 0, po = 0, pe = 0;
    for (let i = 0; i < n; i++) {
      pa += unzig(getVar(inner, o)); po += unzig(getVar(inner, o)); if (hasEle) pe += unzig(getVar(inner, o));
      const lat = pa / 1e5, lon = po / 1e5;
      if (!okLL([lat, lon])) throw new Error('链接内容不对');
      if (hasEle && (pe < -500 || pe > 9000)) throw new Error('链接内容不对');
      a[4 * i] = lat; a[4 * i + 1] = lon; a[4 * i + 2] = hasEle ? pe : NaN; a[4 * i + 3] = NaN;
    }
    segs.push(a);
  }
  return { name: name || '分享的路线', segs, hasEle };
}
const hash32 = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const shareUrlOf = payload => location.origin + location.pathname + '#s=' + payload;

// 收到分享：text 可以是整条链接，也可以只是 #s= 后面那一串
async function openShared(text) {
  const m = /(?:^|[#&?])s=([A-Za-z0-9_-]+)/.exec(String(text).trim()) || (/^[A-Za-z0-9_-]{20,}$/.test(String(text).trim()) ? [null, String(text).trim()] : null);
  if (!m) return toast('这不是分享链接：链接里应该有「#s=」，后面跟着一长串字母数字');
  let d;
  try { d = await shareDecode(m[1]); } catch (e) { return toast('这条分享链接打不开：' + e.message, 9000); }
  const key = `share:${hash32(m[1])}:${m[1].length}`, have = routes.find(r => r.key === key);
  if (have) { select(have, { open: true, fit: true }); return toast('这条路线已经在你的列表里了'); }
  let pts = []; for (const a of d.segs) for (let i = 0; i < a.length; i += 4) pts.push([a[i], a[i + 1]]);
  if (!d.hasEle) { // 没带海拔的（比如手绘的）用本机的离线地形补上
    let ele = null; try { ele = await sampleElev(pts); } catch (e) { ele = null; }
    if (ele) { let k = 0; for (const a of d.segs) for (let i = 0; i < a.length; i += 4) { a[i + 2] = Number.isFinite(ele[k]) ? Math.round(ele[k] * 10) / 10 : NaN; k++; } }
  }
  const tmp = { segs: d.segs }; analyze(tmp);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const hint = ios && !standalone ? '\n\n（如果你已经把 App 装到主屏幕：这里存的路线不会出现在主屏幕的 App 里，请回到 App，在「设置 → 路线数据 → 导入分享链接」里粘贴这条链接。）' : '';
  if (!confirm(`收到一条分享的路线：\n「${d.name}」 ${fmtKm(tmp.dist)}${tmp.gain != null ? `，爬升约 ${Math.round(tmp.gain)} m` : ''}\n\n保存到「我的路线」吗？${hint}`)) return;
  const rec = { key, file: '分享链接', name: d.name, color: colorAt(S.colorSeq++), visible: true, added: Date.now(), wpts: [] };
  let id;
  try { id = DB.ok ? await DB.add(rec, d.segs) : -(routes.length + 1); } catch (e) { DB.ok = false; id = -(routes.length + 1); toast('这台设备不让保存数据（' + e.message + '），路线只在本次打开期间有效', 8000); }
  rec.id = id;
  const r = addRoute(rec, d.segs);
  saveS(); renderList(); refreshSettings();
  select(r, { open: true, fit: true });
  toast(`已保存「${d.name}」`);
}
// 打开的地址带 #s=…（别人发来的链接）：处理完就把地址栏里那一长串去掉，免得刷新一次又问一次
function openSharedFromHash() {
  if (!/(?:^#|&)s=[A-Za-z0-9_-]+/.test(location.hash)) return;
  const h = location.hash;
  try { history.replaceState(null, '', location.pathname + location.search + (/(?:^#|&)debug\b/.test(h) ? '#debug' : '')); } catch (e) { /* 忽略 */ }
  return openShared(h);
}

// 分享面板：先把链接算好（几毫秒），点按钮时同步调用系统分享，免得被 iOS 当成"不是用户点的"
const SH_ = { r: null, url: null, err: '' };
async function openShare(r) {
  if (!r) return;
  SH_.r = r; SH_.url = null; SH_.err = '';
  $('#shTitle').textContent = `分享「${r.name}」`;
  $('#shInfo').textContent = [fmtKm(r.dist), r.gain != null && `爬升约 ${Math.round(r.gain)} m`].filter(Boolean).join(' · ');
  $('#shLink').disabled = true; $('#shLinkNote').textContent = '正在准备链接…';
  $('#shareSheet').hidden = false;
  try {
    const p = await shareEncode(r);
    if (SH_.r !== r) return;
    SH_.url = shareUrlOf(p);
    $('#shLink').disabled = false;
    $('#shLinkNote').textContent = `对方点开链接就能看到这条路线并保存到自己的 App（链接里是简化过的路线，最多约 ${SHARE_MAX_PTS} 个点，爬升会略有出入；要完整轨迹请发 GPX 文件）。链接 ${SH_.url.length} 个字符。`;
  } catch (e) {
    if (SH_.r !== r) return;
    SH_.err = e.message; $('#shLinkNote').textContent = `这条路线没法做成链接（${e.message}），请发 GPX 文件。`;
  }
}
function closeShare() { $('#shareSheet').hidden = true; SH_.r = null; SH_.url = null; }
async function shareLink() {
  const r = SH_.r, url = SH_.url;
  if (!r || !url) return;
  const title = r.name, text = `${r.name} · ${fmtKm(r.dist)}${r.gain != null ? ` · 爬升约 ${Math.round(r.gain)} m` : ''}`;
  closeShare();
  try { if (navigator.share) { await navigator.share({ title, text, url }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('链接已复制，可以粘贴给别人了'); }
  catch (e) { prompt('复制这条链接，发给别人：', url); }
}

/* ================= 屏幕常亮 ================= */
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* 不支持或被拒绝：忽略 */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.wake) setWake(true); });

/* ================= 3D 地形视图（MapLibre GL；离线：矢量底图和高程都从本机的 PMTiles 里来，第一次点「3D」才加载 MapLibre） ================= */
const v3 = { on: false, map: null, ready: false, loading: null, sig: '', popup: null, q: 0, proto: null, dot: null, hmOn: false, flavor: '', baseIds: [] };
const ML = { js: 'lib/maplibre-gl.js', css: 'lib/maplibre-gl.css', themes: 'lib/basemaps.js' };
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const pt3 = (c, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: c } });
const BASES3D = {
  off: { label: '离线地形图', note: '没网也能用：离线矢量地图 + 山体阴影' },
  sat: { label: '卫星影像', note: '要联网，不会存到本机' },
  topo: { label: '地形图（OpenTopoMap）', note: '要联网，不会存到本机' }
};

function loadMapLibre() {
  if (window.maplibregl && window.basemaps) return Promise.resolve();
  const tag = (name, attrs) => new Promise((res, rej) => {
    const el = Object.assign(document.createElement(name), attrs);
    el.onload = res;
    el.onerror = () => rej(new Error('加载失败：' + (attrs.src || attrs.href)));
    document.head.appendChild(el);
  });
  return v3.loading || (v3.loading = Promise.all([tag('link', { rel: 'stylesheet', href: ML.css }), tag('script', { src: ML.js }), tag('script', { src: ML.themes })]).catch(e => { v3.loading = null; throw e; }));
}
// 两个自定义协议：pmtiles://（矢量底图，直接用 pmtiles 库）和 dem://（高程：包里有的原样给，没有的现编）
function setupProtocols() {
  if (!v3.proto) {
    v3.proto = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', v3.proto.tile);
    maplibregl.addProtocol('dem', async params => {
      const m = /\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
      if (!m || !dm.dem) throw new Error('没有高程数据');
      return { data: await dm.dem.pngFor(+m[1], +m[2], +m[3]) };
    });
  }
  if (bm.pm) v3.proto.add(bm.pm);
}
const flavor3d = () => { const f = (BASES[S.base] || BASES.auto).flavor; return f === 'auto' || !f ? (darkNow() ? 'dark' : 'light') : f; };

// 样式：离线矢量底图（Protomaps 官方样式去掉文字标注，所以不用字体文件）+ 山体阴影 + 地形 + 路线 / 起终点 / 航点 / 拖动标记；线图层会自动贴在地形表面上
function style3d() {
  const raster = (tiles, maxzoom, attribution) => ({ type: 'raster', tiles, tileSize: 256, maxzoom, attribution });
  const dem = { type: 'raster-dem', tiles: ['dem://x/{z}/{x}/{y}'], encoding: 'terrarium', tileSize: 256, minzoom: 0, maxzoom: dm.dem ? dm.dem.max : 12 };
  const vis = on => ({ visibility: on ? 'visible' : 'none' });
  const line = { 'line-cap': 'round', 'line-join': 'round' };
  const none = ['==', ['get', 'id'], -1];
  const colorOf = ['get', 'color'];
  const offline = S.base3d === 'off';
  v3.flavor = flavor3d();
  const baseLayers = basemaps.layers('base', basemaps.namedFlavor(v3.flavor)).map(l => ({ ...l, layout: { ...(l.layout || {}), ...vis(offline) } }));
  v3.baseIds = baseLayers.map(l => l.id);
  return {
    version: 8,
    sources: {
      base: { type: 'vector', url: 'pmtiles://' + bm.key, attribution: '© OpenStreetMap 贡献者 · Protomaps' },
      sat: raster(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], 18, 'Tiles © Esri — Maxar, Earthstar Geographics 等'),
      topo: raster(['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), 17, '© OpenTopoMap (CC-BY-SA) © OpenStreetMap 贡献者'),
      dem: { ...dem, attribution: '地形：Mapzen / AWS Terrain Tiles' },
      demhs: dem,
      routes: { type: 'geojson', data: EMPTY_FC },
      ends: { type: 'geojson', data: EMPTY_FC },
      wpts: { type: 'geojson', data: EMPTY_FC },
      hm: { type: 'geojson', data: EMPTY_FC }
    },
    layers: [
      { id: 'bg3d', type: 'background', paint: { 'background-color': v3.flavor === 'dark' ? '#1c1f24' : '#e8ecef' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: vis(S.base3d === 'sat') },
      { id: 'topo', type: 'raster', source: 'topo', layout: vis(S.base3d === 'topo') },
      ...baseLayers,
      { id: 'hs', type: 'hillshade', source: 'demhs', layout: vis(S.hill || !offline), paint: { 'hillshade-exaggeration': hsEx(), 'hillshade-shadow-color': v3.flavor === 'dark' ? '#000000' : '#3d4652', 'hillshade-highlight-color': v3.flavor === 'dark' ? '#7d8691' : '#ffffff', 'hillshade-accent-color': v3.flavor === 'dark' ? '#2b3138' : '#5a6573' } },
      { id: 'r-casing', type: 'line', source: 'routes', layout: line, paint: { 'line-color': '#ffffff', 'line-width': S.lineW + 3, 'line-opacity': S.halo ? 0.85 : 0 } },
      { id: 'r-line', type: 'line', source: 'routes', layout: line, paint: { 'line-color': colorOf, 'line-width': S.lineW, 'line-opacity': 0.95 } },
      { id: 'r-sel-casing', type: 'line', source: 'routes', filter: none, layout: line, paint: { 'line-color': '#ffffff', 'line-width': S.lineW + 5, 'line-opacity': 0.9 } },
      { id: 'r-sel', type: 'line', source: 'routes', filter: none, layout: line, paint: { 'line-color': colorOf, 'line-width': S.lineW + 2 } },
      { id: 'ends', type: 'circle', source: 'ends', layout: vis(S.ends), paint: { 'circle-radius': 6, 'circle-color': ['case', ['==', ['get', 'kind'], 'start'], colorOf, '#ffffff'], 'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'start'], '#ffffff', colorOf], 'circle-stroke-width': 2.5 } },
      { id: 'wpts', type: 'circle', source: 'wpts', layout: vis(S.wpts), paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': colorOf, 'circle-stroke-width': 2 } },
      { id: 'hm', type: 'circle', source: 'hm', paint: { 'circle-radius': 8, 'circle-color': colorOf, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } }
    ],
    terrain: { source: 'dem', exaggeration: S.ex3d }
  };
}
const hsEx = () => Math.min(1, 0.25 + S.hillOp * 0.6) * (v3.flavor === 'dark' ? 0.7 : 1); // 3D 里山体阴影的强度，跟 2D 的「阴影浓度」滑块联动；深色底图上收一点

// 把当前状态（哪些路线显示、颜色、选中、线宽、开关）同步到 3D 地图；路线数据只在「显示的集合 / 颜色」变了才重新灌入
function sync3d() {
  const m = v3.map;
  if (!m || !v3.ready) return;
  const vis = routes.filter(r => r.visible && r.segs.length);
  const sig = routes.map(r => `${r.id}:${r.visible ? 1 : 0}:${r.color}`).join(',') + `|${S.wpts ? 1 : 0}`;
  if (sig !== v3.sig) {
    v3.sig = sig;
    const thin = seg => { // 点太密时抽稀，3D 里画线不需要几万个点
      const k = Math.max(1, Math.ceil(seg.length / 2500)), out = [];
      for (let i = 0; i < seg.length; i += k) out.push([seg[i][1], seg[i][0]]);
      const last = seg[seg.length - 1];
      if ((seg.length - 1) % k) out.push([last[1], last[0]]);
      return out;
    };
    m.getSource('routes').setData({ type: 'FeatureCollection', features: vis.map(r => ({ type: 'Feature', properties: { id: r.id, color: r.color, name: r.name }, geometry: { type: 'MultiLineString', coordinates: r.ll.map(thin) } })) });
    m.getSource('ends').setData({ type: 'FeatureCollection', features: vis.flatMap(r => {
      const a = r.ll[0][0], lastSeg = r.ll[r.ll.length - 1], z = lastSeg[lastSeg.length - 1];
      return [pt3([a[1], a[0]], { color: r.color, kind: 'start' }), pt3([z[1], z[0]], { color: r.color, kind: 'end' })];
    }) });
    m.getSource('wpts').setData({ type: 'FeatureCollection', features: routes.filter(r => r.visible).flatMap(r => r.wpts.map(w => pt3([w.lng, w.lat], { color: r.color, name: w.name || '航点', ...(w.ele != null ? { ele: w.ele } : {}) }))) });
  }
  const selId = selected && selected.visible ? selected.id : -1;
  for (const id of ['r-sel-casing', 'r-sel']) m.setFilter(id, ['==', ['get', 'id'], selId]);
  const w = S.lineW;
  m.setPaintProperty('r-casing', 'line-width', w + 3); m.setPaintProperty('r-casing', 'line-opacity', S.halo ? 0.85 : 0);
  m.setPaintProperty('r-line', 'line-width', w);
  m.setPaintProperty('r-sel-casing', 'line-width', w + 5); m.setPaintProperty('r-sel', 'line-width', w + 2);
  m.setLayoutProperty('ends', 'visibility', S.ends ? 'visible' : 'none');
  m.setLayoutProperty('wpts', 'visibility', S.wpts ? 'visible' : 'none');
}
function schedule3d() { if (!v3.on || v3.q) return; v3.q = requestAnimationFrame(() => { v3.q = 0; sync3d(); }); }
function apply3dBase() {
  const m = v3.map;
  if (!m || !v3.ready) return;
  const off = S.base3d === 'off', set = (id, on) => m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  v3.baseIds.forEach(id => set(id, off));
  set('sat', S.base3d === 'sat'); set('topo', S.base3d === 'topo'); set('hs', S.hill || !off);
}
function apply3dHill() {
  const m = v3.map;
  if (!m || !v3.ready) return;
  m.setLayoutProperty('hs', 'visibility', S.hill || S.base3d !== 'off' ? 'visible' : 'none');
  m.setPaintProperty('hs', 'hillshade-exaggeration', hsEx());
}
// 3D 地图里没被抽屉和按钮挡住的区域，作为 fitBounds / easeTo 的内边距；extra 是上下再留的余量
function pad3d(extra = 30) { const m = mapInsets(); return { top: m.top + extra, bottom: m.bottom + extra, left: m.left + (extra ? 24 : 0), right: m.right + (extra ? 8 : 0) }; }
function fit3d(b, maxZoom) {
  if (!v3.map || !v3.ready || !b) return;
  v3.map.fitBounds([[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], { padding: pad3d(), pitch: 60, maxZoom: Math.min(maxZoom || 15, 16), duration: 800 });
}
function syncGps3d() { // 「我的位置」的蓝点在 3D 里是个 Marker（DOM 元素，不受地形遮挡的影响）
  if (!v3.map || !v3.ready) return;
  if (!GPS.ll) { if (v3.dot) { v3.dot.remove(); v3.dot = null; } return; }
  const ll = [GPS.ll[1], GPS.ll[0]];
  if (!v3.dot) {
    const el = document.createElement('div');
    el.innerHTML = '<div class="me"><i></i></div>';
    v3.dot = new maplibregl.Marker({ element: el, occludedOpacity: 0.7 }).setLngLat(ll).addTo(v3.map); // 被山挡住时也别淡到看不见
  } else v3.dot.setLngLat(ll);
}
function destroy3d() {
  if (!v3.map) return;
  const wasOn = v3.on;
  v3.map.remove(); v3.map = null; v3.ready = false; v3.sig = ''; v3.dot = null; v3.popup = null; v3.hmOn = false;
  if (wasOn) init3d(); // 正在看 3D 时底图换了：原地重建
}

// 3D 里点选 / 命中检测自己做：开了地形夸张后 MapLibre 自带的 queryRenderedFeatures 会偏几个像素，
// 而 map.project() 算出的位置和画出来的线是对得上的。每条路线抽到约 150 个点，投到屏幕上算到手指的最近距离
const dseg = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
function coarse(r) {
  const n = r.ll.reduce((s, g) => s + g.length, 0), k = Math.max(1, Math.ceil(n / 150));
  return r.ll.map(g => {
    const out = [];
    for (let i = 0; i < g.length; i += k) out.push([g[i][1], g[i][0]]);
    const l = g[g.length - 1];
    if ((g.length - 1) % k) out.push([l[1], l[0]]);
    return out;
  });
}
function pick3d(pt) {
  let best = null, bestD = matchMedia('(pointer: coarse)').matches ? 22 : 12; // 手指比鼠标粗，容差大一点
  for (const r of routes) {
    if (!r.visible || !r.segs.length) continue;
    for (const seg of r.c3 || (r.c3 = coarse(r))) {
      let prev = null;
      for (const ll of seg) {
        const s = v3.map.project(ll);
        if (prev) { const d = dseg(pt, prev, s); if (d < bestD) { bestD = d; best = r; } }
        prev = s;
      }
    }
  }
  return best;
}
function pickWpt3d(pt) {
  let best = null, bestD = matchMedia('(pointer: coarse)').matches ? 20 : 9;
  for (const r of routes) {
    if (!r.visible) continue;
    for (const w of r.wpts) { const s = v3.map.project([w.lng, w.lat]), d = Math.hypot(pt.x - s.x, pt.y - s.y); if (d < bestD) { bestD = d; best = w; } }
  }
  return best;
}
const textDom = (title, sub) => { // 用 DOM 而不是拼 HTML，文件里的名字不会被当成代码
  const d = document.createElement('div'), b = document.createElement('b');
  b.textContent = title; d.append(b);
  if (sub) d.append(document.createElement('br'), document.createTextNode(sub));
  return d;
};

function init3d() {
  const c = map.getCenter();
  setupProtocols();
  let m;
  try {
    m = new maplibregl.Map({ container: 'map3d', style: style3d(), center: [c.lng, c.lat], zoom: Math.max(1, map.getZoom() - 1), pitch: 60, bearing: -15, maxPitch: 80, maxZoom: 18, attributionControl: false, fadeDuration: 0 });
  } catch (e) { toast('这个浏览器没能启动 3D 视图（需要 WebGL）：' + e.message, 8000); return false; }
  v3.map = m; v3.ready = false; v3.sig = '';
  m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'top-left');
  m.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
  v3.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'tip3d' });
  m.on('dragstart', () => { if (GPS.id != null && GPS.follow) { GPS.follow = false; syncFab(); } });
  m.on('click', e => {
    const w = S.wpts ? pickWpt3d(e.point) : null;
    if (w) { v3.popup.setLngLat([w.lng, w.lat]).setDOMContent(textDom(w.name || '航点', w.ele != null ? `${Math.round(w.ele)} m` : '')).addTo(m); return; }
    v3.popup.remove();
    tapRoutes({ lngLat: e.lngLat }, e.point, candidates3d(e.point));
  });
  m.on('load', () => {
    v3.ready = true; sync3d(); syncGps3d();
    const b = (selected && selected.bounds) || allBounds();
    if (b) fit3d(b);
  });
  return true;
}
async function set3d(on) {
  if (on === v3.on) return;
  if (on && DR.on) return toast('画线的时候不能进 3D：先点「完成」或退出画线', 4000);
  const btn = $('#btn3d');
  if (on) {
    if (dm.state !== 'ready') return toast(dm.state === 'loading' ? '地形数据还在下载，下载完才能用 3D' : '地形数据没准备好：' + dm.err, 7000);
    if (bm.state !== 'ready' && S.base3d === 'off') toast('离线地图没准备好，3D 里暂时只有地形', 5000);
    btn.disabled = true;
    try { await loadMapLibre(); } catch (e) { btn.disabled = false; return toast('3D 组件没能加载：' + e.message, 8000); }
    btn.disabled = false;
    if (v3.map && v3.flavor !== flavor3d()) { v3.map.remove(); v3.map = null; v3.ready = false; v3.sig = ''; v3.dot = null; } // 系统深浅色变了：重建
  }
  unmark();
  closeInfo();
  INFO.last = null;
  v3.on = on;
  document.body.classList.toggle('mode3d', on);
  btn.classList.toggle('on', on);
  if (on) {
    if (!v3.map) { if (!init3d()) { v3.on = false; document.body.classList.remove('mode3d'); btn.classList.remove('on'); return; } }
    else { const c = map.getCenter(); v3.map.resize(); v3.map.jumpTo({ center: [c.lng, c.lat], zoom: Math.max(1, map.getZoom() - 1) }); sync3d(); syncGps3d(); }
  } else {
    if (v3.popup) v3.popup.remove();
    if (v3.map) { const c = v3.map.getCenter(); map.invalidateSize(); map.setView([c.lat, c.lng], Math.min(map.getMaxZoom(), Math.round(v3.map.getZoom() + 1)), { animate: false }); }
  }
  schedProfile();
}

/* ================= 按钮与启动 ================= */
$('#btnImport').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { const inp = e.target; importFiles(inp.files).finally(() => { inp.value = ''; }); };
$('#btnLocate').onclick = toggleLocate;
$('#btnFit').onclick = () => { const b = allBounds(); if (b) fitTo(b); else toast('还没有路线'); };
$('#btnSettings').onclick = openSettings;
$('#btn3d').onclick = () => set3d(!v3.on);
$('#btnDraw').onclick = () => (DR.on ? drCancel() : startDraw());
$('#dShare').onclick = () => { if (selected) openShare(selected); };
$('#shClose').onclick = closeShare;
$('#shareSheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeShare(); });
$('#shLink').onclick = shareLink;
$('#shFile').onclick = () => { const r = SH_.r; closeShare(); if (r) exportRoute(r); };
$('#btnPasteLink').onclick = () => { const t = prompt('把收到的分享链接粘贴到这里：'); if (t && t.trim()) { settings.hidden = true; openShared(t); } };
$('#drUndo').onclick = () => { DR.pts.pop(); drUpdate(true); };
$('#drClear').onclick = () => { if (DR.pts.length > 2 && !confirm('清除已经画的线？')) return; DR.pts = []; DR.ele = null; drUpdate(true); };
$('#drPan').onclick = drTogglePan;
$('#drDone').onclick = finishDraw;
$('#drCancel').onclick = drCancel;
$('#dClose').onclick = () => select(null);
$('#dFit').onclick = () => { if (selected && selected.bounds) fitTo(selected.bounds, 16); };
$('#dHide').onclick = () => { if (selected) setVisible(selected, !selected.visible); };
$('#dDel').onclick = () => { if (selected && confirm(`删除「${selected.name}」？`)) removeRoute(selected); };
$('#dColor').addEventListener('input', e => { if (selected) setColor(selected, e.target.value, false); });
$('#dColor').addEventListener('change', e => { if (selected) setColor(selected, e.target.value, true); });
$('#q').oninput = renderList;
$('#sort').value = S.sort;
$('#sort').onchange = e => { S.sort = e.target.value; saveS(); renderList(); };
$('#btnAll').onclick = () => { const rs = filtered(); rs.forEach(r => setVisible(r, true, true)); updateSummary(); saveMeta(rs); };
$('#btnNone').onclick = () => { const rs = filtered(); rs.forEach(r => setVisible(r, false, true)); updateSummary(); saveMeta(rs); };
map.on('click', e => { if (!DR.on) tapRoutes({ ll: e.latlng }, e.containerPoint, candidates2d(e.latlng, tapTol())); });
addEventListener('resize', () => { layoutSheet(false); map.invalidateSize(); if (v3.map) v3.map.resize(); schedProfile(); });
addEventListener('orientationchange', () => setTimeout(() => { layoutSheet(false); map.invalidateSize(); if (v3.map) v3.map.resize(); }, 300));

function boot() {
  readInsets();
  layoutSheet(false);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let dismissed = false; try { dismissed = !!localStorage.getItem('at-install-dismissed'); } catch (e) { /* 忽略 */ }
  if (ios && !standalone && !dismissed) $('#install').hidden = false;
  $('#installX').onclick = () => { $('#install').hidden = true; try { localStorage.setItem('at-install-dismissed', '1'); } catch (e) { /* 忽略 */ } };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本：把 App 彻底关掉再打开一次就更新了', 8000); });
      });
    }).catch(() => { /* 非 https 等情况：忽略，只是不能离线 */ });
  }
  if (S.wake) setWake(true);
  $('#map').style.background = (BASES[S.base] || BASES.light).bg;
  loadSaved();
  initPack().then(() => initDem()); // 先下载地图（马上就能用），再下载地形数据
  setTimeout(() => { readInsets(); layoutSheet(false); map.invalidateSize(); }, 400); // 部分 iOS 版本刚启动时量到的窗口高度不准
}
async function loadSaved() {
  try {
    const [metas, geoms] = await DB.loadAll();
    const g = new Map(geoms.map(x => [x.id, x.segs]));
    metas.sort((a, b) => a.id - b.id);
    for (const m of metas) { const segs = g.get(m.id); if (segs) addRoute(m, segs); }
  } catch (e) { DB.ok = false; toast('这台设备不让保存路线数据（' + e.message + '）。导入的路线只在本次打开期间有效', 9000); }
  renderList();
  // 打开的是别人发来的分享链接：先不缩放到全部路线（Leaflet 在缩放动画进行中会忽略下一次缩放），等处理完直接缩放到那条路线；没选中任何路线（比如点了取消）再缩放到全部
  const shared = /(?:^#|&)s=[A-Za-z0-9_-]+/.test(location.hash);
  if (routes.length && !shared) fitAll();
  refreshSettings();
  if (shared) Promise.resolve(openSharedFromHash()).finally(() => { if (!selected && routes.length) fitAll(); });
}
if (/(?:^#|&)debug\b/.test(location.hash)) window.__app = { map, routes, S, BASE, DEMP, bm, dm, v3, GPS, PF, SH, INFO, select, set3d, candidates2d, candidates3d, tapRoutes, DR, startDraw, exportRoute, gpxOf, shareEncode, shareDecode, shareUrlOf, openShared, openShare, SH_, GPS, updateGps, nearestOn, autoPick, onPos, toggleLocate, setSheet }; // 测试用：地址后面加 #debug 才暴露
boot();
})();
