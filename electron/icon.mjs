// dsh-gpu-monitor: 运行时生成菜单栏/应用图标（PNG）。
// 无二进制资源依赖：用 node:zlib 直接编码 PNG。
// 图形：🔮 水晶球线稿（黑白，macOS template 风格——黑色 + alpha，菜单栏深浅色自适应）。
import { deflateSync } from "node:zlib";

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 生成 🔮 水晶球线稿 RGBA PNG（黑色 + alpha，template）。
 * 元素：球体轮廓（约 2px 线宽，左上留高光缺口）、底座（托盘线框）、两个星点（+）。
 * @param {number} size 边长（默认 18；打包应用图标用 1024）
 * @returns {Buffer}
 */
export function makeCrystalPng(size = 18) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = a;
  };

  const cx = size * 0.5;
  const cy = size * 0.38;
  const r = size * 0.24;
  const stroke = Math.max(1, Math.round(size * 0.09)); // ~2px @18 / ~92px @1024
  const dist = (x, y) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const onCircle = (x, y) => Math.abs(dist(x, y) - r) <= stroke / 2;

  // 底座：2px 线框托盘（顶横线 + 底横线 + 两侧竖线）
  const L = (v) => Math.round(v);
  const baseTop = L(size * 0.70);
  const baseBottom = L(size * 0.82) + 1;
  const bx0 = L(cx - size * 0.20);
  const bx1 = L(cx + size * 0.20);
  const onBase = (x, y) => {
    const onTop = (y === baseTop || y === baseTop + 1) && x >= bx0 && x <= bx1;
    const onBottom = (y === baseBottom || y === baseBottom + 1) && x >= bx0 && x <= bx1;
    const onSide = (x === bx0 || x === bx0 + 1 || x === bx1 || x === bx1 + 1) && y >= baseTop && y <= baseBottom + 1;
    return onTop || onBottom || onSide;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!onCircle(x, y)) continue;
      // 左上 45° 高光缺口
      const ang = Math.atan2(y - cy, x - cx);
      if (ang < -2.2 && ang > -2.8) continue;
      set(x, y, 255);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (onBase(x, y)) set(x, y, 255);
    }
  }

  // 组装 PNG
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    px.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
