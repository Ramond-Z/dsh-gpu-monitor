// dsh-gpu-monitor: 生成 build/icon.png（1024px 应用图标，来自 electron/icon.svg）。
// 需在 electron 下运行（Chromium 栅格化 SVG）：npm run dist 的第一步。
// 用法：electron scripts/rasterize-icon.mjs
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { iconSvgMarkup } from "../electron/icon.mjs";

const SIZE = 1024;

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({
      show: false,
      width: SIZE,
      height: SIZE,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true, sandbox: true },
    });
    await w.loadURL(
      "data:text/html," +
        encodeURIComponent(
          "<!doctype html><meta charset=\"utf-8\">" +
            `<body style="margin:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden">` +
            iconSvgMarkup() +
            "</body>"
        )
    );
    await w.webContents.executeJavaScript(
      "new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });"
    );
    const img = await w.webContents.capturePage();
    w.destroy();
    if (img.isEmpty()) throw new Error("capturePage 返回空图");
    const out = new URL("../build/icon.png", import.meta.url).pathname;
    writeFileSync(out, img.toPNG());
    console.log("build/icon.png 已生成:", img.getSize(), img.toPNG().length, "bytes");
    app.exit(0);
  } catch (e) {
    console.error("生成图标失败:", e);
    app.exit(1);
  }
});
