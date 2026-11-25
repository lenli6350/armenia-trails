// 只读 ZIP：把压缩包里的轨迹文件（gpx / kml / tcx / geojson / json）取出来，这样在手机上可以直接选 .zip 导入。
// 纯 JS，不依赖任何库。解压优先用浏览器自带的 DecompressionStream('deflate-raw')（快），没有或出错就用下面自己写的 inflate。
(() => {
'use strict';

/* ---------- RFC 1951 inflate（照 zlib 自带的 puff.c 写的：按位解码，慢一点但简单可靠）---------- */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function mkHuff(lengths) { // 规范哈夫曼码：count[len] = 该长度的码有几个；symbol = 按（长度, 符号）排好的符号表
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}
let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  return (FIXED = { lit: mkHuff(l), dist: mkHuff(new Uint8Array(30).fill(5)) });
}

function inflateRaw(src, sizeHint) {
  let pos = 0, bitbuf = 0, bitcnt = 0, o = 0, out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1024, src.length * 4));
  const bits = n => {
    while (bitcnt < n) { if (pos >= src.length) throw new Error('压缩数据不完整'); bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('压缩数据损坏');
  };
  const room = n => { if (o + n > out.length) { const bigger = new Uint8Array(Math.max(out.length * 2, o + n)); bigger.set(out); out = bigger; } };
  for (let last = 0; !last;) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) { // 不压缩的块
      bitbuf = 0; bitcnt = 0; // 丢掉当前字节里剩下的位
      if (pos + 4 > src.length) throw new Error('压缩数据不完整');
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('压缩数据损坏');
      pos += 4;
      if (pos + len > src.length) throw new Error('压缩数据不完整');
      room(len); out.set(src.subarray(pos, pos + len), o); o += len; pos += len;
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) ({ lit, dist } = fixedTables());
      else {
        const nlit = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        if (nlit > 286 || ndist > 30) throw new Error('压缩数据损坏');
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[ORDER[i]] = bits(3);
        const clh = mkHuff(cl), lens = new Uint8Array(nlit + ndist);
        for (let i = 0; i < nlit + ndist;) {
          const sym = decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep, val = 0;
            if (sym === 16) { if (!i) throw new Error('压缩数据损坏'); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > nlit + ndist) throw new Error('压缩数据损坏');
            while (rep--) lens[i++] = val;
          }
        }
        lit = mkHuff(lens.subarray(0, nlit)); dist = mkHuff(lens.subarray(nlit));
      }
      for (;;) {
        let sym = decode(lit);
        if (sym < 256) { room(1); out[o++] = sym; }
        else if (sym === 256) break;
        else {
          sym -= 257;
          if (sym >= 29) throw new Error('压缩数据损坏');
          const len = LBASE[sym] + bits(LEXT[sym]), ds = decode(dist);
          if (ds >= 30) throw new Error('压缩数据损坏');
          const d = DBASE[ds] + bits(DEXT[ds]);
          if (d > o) throw new Error('压缩数据损坏');
          room(len);
          for (let k = 0; k < len; k++, o++) out[o] = out[o - d];
        }
      }
    } else throw new Error('压缩数据损坏');
  }
  return out.subarray(0, o);
}

async function inflate(src, size) {
  if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && Blob.prototype.stream) {
    try { return new Uint8Array(await new Response(new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
    catch (e) { /* 不支持 deflate-raw 或数据有问题：用自己的再试一次 */ }
  }
  return inflateRaw(src, size);
}

/* ---------- ZIP 目录 ---------- */
const WANT = /\.(gpx|kml|tcx|geojson|json)$/i;
// file 只要有 arrayBuffer() 就行。返回 [{ name, size, crc, read() }]：只列出轨迹文件；目录、macOS 的 __MACOSX/._ 垃圾文件、其他类型的文件都跳过
async function readZip(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf), dv = new DataView(buf), dec = new TextDecoder('utf-8');
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 ZIP 压缩包');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || p === 0xffffffff) throw new Error('这个压缩包用了 ZIP64（太大），读不了');
  const out = [];
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) throw new Error('压缩包的目录损坏了');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX\/|\._)/.test(name) || !WANT.test(name)) continue;
    out.push({
      name, size: usize, crc,
      async read() {
        if (flags & 1) throw new Error('这个压缩包设了密码，读不了');
        if (lho + 30 > buf.byteLength || dv.getUint32(lho, true) !== 0x04034b50) throw new Error('压缩包损坏了');
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        if (start + csize > buf.byteLength) throw new Error('压缩包不完整（可能没传完）');
        const raw = u8.subarray(start, start + csize);
        const data = method === 0 ? raw : method === 8 ? await inflate(raw, usize) : null;
        if (!data) throw new Error('不支持的压缩方式 ' + method);
        if (data.length !== usize) throw new Error('解压出来的大小对不上，压缩包可能损坏了');
        return data;
      }
    });
  }
  return out;
}

const api = { readZip, inflateRaw, inflate };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else window.Zip = api;
})();
