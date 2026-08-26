// dsh-gpu-monitor: 运行时生成菜单栏/应用图标（PNG）。
// 无二进制资源依赖：用 node:zlib 直接编码 PNG。macOS template 图标 = 黑色 + alpha，
// 菜单栏自动适配深浅色。
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

/** 标准圆角矩形包含测试。 */
function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nx = Math.max(x0 + r, Math.min(x, x1 - r));
  const ny = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - nx;
  const dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 生成芯片样式的 RGBA PNG（黑色 + alpha，template）。
 * @param {number} size 边长（默认 18，菜单栏推荐 16–22）
 * @returns {Buffer}
 */
export function makeIconPng(size = 18) {
  const px = Buffer.alloc(size * size * 4);
  const idx = (x, y) => (y * size + x) * 4;
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = idx(x, y);
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = a;
  };

  // 芯片主体：圆角矩形（solid）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y, 3, 5, size - 4, size - 6, 2)) set(x, y, 255);
    }
  }
  // 内部镂空小方框（细节）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y, 6, 7, size - 7, size - 8, 1)) set(x, y, 0);
    }
  }
  // 上下引脚（3 组，每组 2x2）
  for (const gx of [5, 8, 11]) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        set(gx + dx, 2 + dy, 255);
        set(gx + dx, size - 4 + dy, 255);
      }
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
