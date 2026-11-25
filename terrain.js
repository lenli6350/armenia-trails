// 地形：离线高程（terrarium PNG，存在 PMTiles 里）→ 2D 山体阴影图层（Leaflet）和 3D 视图用的高程瓦片。
// 包里只有走廊的 z12 和全国的 z9；没有的瓦片用最近一级上级瓦片裁出对应区域、双线性放大，所以任何缩放级别、任何位置都有高程。
(() => {
'use strict';
const TS = 256;
const CELL0 = 156543.03392804097; // 赤道上 z0 一个像素（256 瓦片）的米数
const RAD = Math.PI / 180;

const concat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const inflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());

// 解 terrarium PNG（8 位 RGB、非隔行）→ Float32Array(256*256)，单位米。自己解码，不走 canvas：免得浏览器的色彩管理悄悄改了像素值
async function decodeTerrarium(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), idat = [];
  let off = 8, w = 0, h = 0;
  while (off + 12 <= png.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === 'IHDR') { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); if (png[off + 16] !== 8 || png[off + 17] !== 2 || png[off + 20] !== 0) throw new Error('高程瓦片不是 8 位 RGB 的 PNG'); }
    else if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  if (w !== TS || h !== TS) throw new Error('高程瓦片尺寸不对');
  const raw = await inflate(concat(idat)), stride = w * 3, rgb = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, d = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i], a = i >= 3 ? rgb[d + i - 3] : 0, b = y ? rgb[d - stride + i] : 0, c = i >= 3 && y ? rgb[d - stride + i - 3] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      rgb[d + i] = v & 255;
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rgb[i * 3] * 256 + rgb[i * 3 + 1] + rgb[i * 3 + 2] / 256 - 32768;
  return out;
}

// 把 Float32Array 高程编码成 terrarium PNG（zlib 用"不压缩块"，只在内存里给 MapLibre 用，不需要压缩）
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = crcT[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function adler32(buf) { let a = 1, b = 0; for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
function encodeTerrarium(e) {
  const stride = TS * 3, raw = new Uint8Array((stride + 1) * TS);
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const v = e[y * TS + x] + 32768, f = Math.floor(v), k = y * (stride + 1) + 1 + x * 3;
      raw[k] = f >> 8; raw[k + 1] = f & 255; raw[k + 2] = Math.min(255, Math.floor((v - f) * 256));
    }
  }
  const blocks = [];
  for (let pos = 0; pos < raw.length;) {
    const n = Math.min(65535, raw.length - pos), h = new Uint8Array(5);
    h[0] = pos + n >= raw.length ? 1 : 0; h[1] = n & 255; h[2] = n >> 8; h[3] = ~n & 255; h[4] = (~n >> 8) & 255;
    blocks.push(h, raw.subarray(pos, pos + n)); pos += n;
  }
  const ad = adler32(raw);
  const z = concat([new Uint8Array([0x78, 0x01]), ...blocks, new Uint8Array([ad >>> 24, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255])]);
  const chunk = (type, data) => {
    const o = new Uint8Array(12 + data.length), dv = new DataView(o.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    o.set(data, 8);
    dv.setUint32(8 + data.length, crc32(o.subarray(4, 8 + data.length)));
    return o;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, TS); dv.setUint32(4, TS); ihdr[8] = 8; ihdr[9] = 2;
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}

// 从上级瓦片 src（256×256）里裁出下面第 k 级、位置 (ox, oy) 的那一块，双线性放大回 256×256
function crop(src, k, ox, oy) {
  const n = 2 ** k, out = new Float32Array(TS * TS);
  for (let j = 0; j < TS; j++) {
    const sy = (oy * TS + j + 0.5) / n - 0.5, y0 = Math.max(0, Math.min(TS - 2, Math.floor(sy))), fy = Math.max(0, Math.min(1, sy - y0));
    for (let i = 0; i < TS; i++) {
      const sx = (ox * TS + i + 0.5) / n - 0.5, x0 = Math.max(0, Math.min(TS - 2, Math.floor(sx))), fx = Math.max(0, Math.min(1, sx - x0));
      const p = y0 * TS + x0;
      out[j * TS + i] = (src[p] * (1 - fx) + src[p + 1] * fx) * (1 - fy) + (src[p + TS] * (1 - fx) + src[p + TS + 1] * fx) * fy;
    }
  }
  return out;
}

class Dem {
  constructor(pm) { this.pm = pm; this.cache = new Map(); this.inflight = new Map(); this.max = 12; this.min = 0; }
  async init() {
    const h = await this.pm.getHeader();
    if (h.tileType !== 2) throw new Error('高程包里不是 PNG 瓦片');
    this.max = h.maxZoom; this.min = h.minZoom;
    return this;
  }
  _get(k) { const v = this.cache.get(k); if (v) { this.cache.delete(k); this.cache.set(k, v); } return v; }
  _put(k, v) { this.cache.set(k, v); while (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value); } // 最多留 96 块（约 25 MB）
  async raw(z, x, y) {
    if (z < this.min || z > this.max) return null;
    const n = 2 ** z;
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    const r = await this.pm.getZxy(z, x, y);
    return r ? new Uint8Array(r.data) : null;
  }
  // z/x/y 这一块的高程（米），Float32Array(256*256)；包里没有就用上级瓦片放大；坐标越界返回 null
  tile(z, x, y) {
    const k = z + '/' + x + '/' + y, hit = this._get(k);
    if (hit) return Promise.resolve(hit);
    let p = this.inflight.get(k);
    if (!p) {
      p = this._build(z, x, y).then(v => { if (v) this._put(k, v); this.inflight.delete(k); return v; }, e => { this.inflight.delete(k); throw e; });
      this.inflight.set(k, p);
    }
    return p;
  }
  async _build(z, x, y) {
    const n = 2 ** z;
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    if (z <= this.max) { const png = await this.raw(z, x, y); if (png) return decodeTerrarium(png); }
    for (let pz = z > this.max ? this.max : z - 1; pz >= this.min; pz--) {
      const k = z - pz, px = x >> k, py = y >> k;
      if (await this.raw(pz, px, py)) return crop(await this.tile(pz, px, py), k, x - (px << k), y - (py << k));
    }
    return null;
  }
  // 给 MapLibre 的 3D 地形用：包里有的瓦片原样给 PNG；没有的现编一张
  async pngFor(z, x, y) {
    const raw = await this.raw(z, x, y);
    if (raw) return raw;
    const t = await this.tile(z, x, y);
    return encodeTerrarium(t || new Float32Array(TS * TS));
  }
}

// 山体阴影（Horn 法：用 3×3 邻域算坡度和坡向）；光从西北来、高度角 45°。
// 画成半透明黑白两层：背光坡涂黑、向光坡涂白，平地完全透明，盖在任何底图上都能用
async function renderHillshade(dem, z, x, y, ctx, opt) {
  const n = 2 ** z;
  const T = await Promise.all([-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => dem.tile(z, ((x + dx) % n + n) % n, y + dy))));
  const c = T[4];
  if (!c) return;
  const P = TS + 2, g = new Float32Array(P * P);
  const cl = v => v < 0 ? 0 : v > TS - 1 ? TS - 1 : v;
  for (let j = -1; j <= TS; j++) {
    const ty = j < 0 ? 0 : j > TS - 1 ? 2 : 1, jj = j < 0 ? TS - 1 : j > TS - 1 ? 0 : j;
    for (let i = -1; i <= TS; i++) {
      const tx = i < 0 ? 0 : i > TS - 1 ? 2 : 1, t = T[ty * 3 + tx];
      g[(j + 1) * P + i + 1] = t ? t[jj * TS + (i < 0 ? TS - 1 : i > TS - 1 ? 0 : i)] : c[cl(j) * TS + cl(i)];
    }
  }
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) / RAD;
  const cell = CELL0 * Math.cos(lat * RAD) / n, k8 = 1 / (8 * cell), zf = opt.exag;
  const cosZ = Math.SQRT1_2, sinZ = Math.SQRT1_2, ax = 0.7071067811865476, ay = 0.7071067811865476; // 高度角 45°（天顶角 45°）、方位角 315°
  const img = ctx.createImageData(TS, TS), d = img.data;
  for (let j = 0; j < TS; j++) {
    for (let i = 0; i < TS; i++) {
      const p = (j + 1) * P + i + 1;
      const dzdx = ((g[p - P + 1] + 2 * g[p + 1] + g[p + P + 1]) - (g[p - P - 1] + 2 * g[p - 1] + g[p + P - 1])) * k8;
      const dzdy = ((g[p + P - 1] + 2 * g[p + P] + g[p + P + 1]) - (g[p - P - 1] + 2 * g[p - P] + g[p - P + 1])) * k8;
      const shade = (cosZ + sinZ * zf * (ax * dzdx + ay * dzdy)) / Math.sqrt(1 + zf * zf * (dzdx * dzdx + dzdy * dzdy));
      const delta = shade - cosZ, o = (j * TS + i) * 4;
      if (delta < 0) { d[o + 3] = Math.min(255, -delta * 1.3 * 255); } // 背光：黑
      else { d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.min(255, delta * 1.0 * 255); } // 向光：白
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Leaflet 图层：每块 256×256 的画布，现算现画；opt = { exag, opacity }
function hillshadeLayer(dem, opt) {
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TS;
      renderHillshade(dem, coords.z, coords.x, coords.y, cv.getContext('2d'), opt).then(() => done(null, cv), e => { console.warn('山体阴影出错', e); done(null, cv); });
      return cv;
    }
  });
  return new Layer({ tileSize: TS, zIndex: 2, opacity: opt.opacity, maxZoom: 19, updateWhenZooming: false, attribution: '地形：Mapzen / AWS Terrain Tiles' });
}

window.Terrain = { Dem, hillshadeLayer, decodeTerrarium, encodeTerrarium };
})();
