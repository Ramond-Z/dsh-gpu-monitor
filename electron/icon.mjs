// dsh-gpu-monitor: 图标资源（electron/icon.svg，freeicon.com 单色 GPU 图标）。
// nativeImage 不支持 SVG（Chromium 图像解码器不处理 SVG），所以由主进程用
// 离屏窗口栅格化成 PNG（见 main.mjs 的 makeTrayIcon）；本模块只提供 SVG 处理。
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const svgRaw = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

/**
 * 取处理过的 SVG 标记：去掉 XML 声明与 XMP metadata，注入 viewBox 以便任意缩放。
 * @returns {string}
 */
export function iconSvgMarkup() {
  return svgRaw
    .replace(/^\s*<\?xml[^?]*\?>\s*/, "")
    .replace(/<\?xpacket[^?]*\?>/g, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
    .replace(/<svg([^>]*)>/, (m, attrs) => {
      const noSize = attrs.replace(/\s(width|height)="[^"]*"/g, "");
      return `<svg${noSize} viewBox="0 0 1024 1024">`;
    });
}

/** SVG 的 data URL（可直接给 <img src>）。 */
export function iconSvgDataUrl() {
  return "data:image/svg+xml;base64," + Buffer.from(iconSvgMarkup(), "utf8").toString("base64");
}

// —— 兜底：原水晶球 PNG 生成器（离屏渲染失败时使用） ——
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
 * 生成 🔮 水晶球 RGBA PNG（黑色 + alpha，template）——兜底图标。
 * @param {number} size 边长（默认 18；打包图标用 1024）
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
  const r = size * 0.30;
  const inCircle = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  // 高光：左上小圆镂空 → 月牙
  const hx = cx - r * 0.45;
  const hy = cy - r * 0.52;
  const hr = r * 0.30;
  const inHighlight = (x, y) => (x - hx) ** 2 + (y - hy) ** 2 <= hr * hr;
  // 底座：实心圆角矩形（与球体底部相接）
  const L = (v) => Math.round(v);
  const bx0 = L(cx - r * 0.55);
  const bx1 = L(cx + r * 0.55);
  const by0 = L(cy + r - size * 0.03);
  const by1 = L(size * 0.84);
  const inBase = (x, y) => {
    if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;
    const nx = Math.max(bx0 + 1, Math.min(x, bx1 - 1));
    const ny = Math.max(by0 + 1, Math.min(y, by1 - 1));
    const dx = x - nx;
    const dy = y - ny;
    return dx * dx + dy * dy <= 1; // 圆角 r=1
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inCircle(x, y) || inBase(x, y)) {
        if (inHighlight(x, y)) continue;
        set(x, y, 255);
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
