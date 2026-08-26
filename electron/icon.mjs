// dsh-gpu-monitor: 运行时生成图标（PNG）。
// 无二进制资源依赖：用 node:zlib 直接编码 PNG。macOS template 图标 = 黑色 + alpha，
// 菜单栏自动适配深浅色。图形：三根活动柱状条（GPU 活动度），简洁易辨识。
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
 * 生成"三根活动柱"样式的 RGBA PNG（黑色 + alpha，template）。
 * @param {number} size 边长（默认 18，菜单栏推荐 16–22；打包图标用 1024）
 * @returns {Buffer}
 */
export function makeIconPng(size = 18) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = a;
  };

  // 三根柱：等宽、圆角顶，底部对齐；高度递增（左矮右高）
  const barW = Math.max(2, Math.round(size * 0.18)); // ~3px @18 / ~184px @1024
  const gap = Math.max(1, Math.round(size * 0.12)); // ~2px @18
  const bottom = size - Math.round(size * 0.16); // 底部内缩
  const total = barW * 3 + gap * 2;
  const start = Math.round((size - total) / 2);
  const heights = [
    Math.round(size * 0.24),
    Math.round(size * 0.42),
    Math.round(size * 0.6),
  ];
  for (let b = 0; b < 3; b++) {
    const x0 = start + b * (barW + gap);
    const x1 = x0 + barW - 1;
    const y0 = bottom - heights[b] + 1;
    for (let y = y0; y <= bottom; y++) {
      for (let x = x0; x <= x1; x++) {
        if (inRounded(x, y, x0, y0, x1, bottom, Math.max(1, Math.round(size * 0.06)))) set(x, y, 255);
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
