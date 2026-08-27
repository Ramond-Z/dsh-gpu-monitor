// dsh-gpu-monitor: Electron 原生应用入口。
// 默认 **菜单栏常驻**（Dock 图标隐藏，点菜单栏图标弹出监控面板）；GPU_MONITOR_UI_MODE=window 时为独立窗口。
// 复用共享监控引擎 + HTTP 传输层：引擎在应用进程内运行，面板/窗口加载本地 UI。
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, screen, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { createMonitorEngine } from "../lib/engine.mjs";
import { createMonitorServer } from "../lib/server.mjs";
import { resolveEngineConfigFromEnv } from "../lib/config.mjs";
import { makeCrystalPng, iconSvgMarkup } from "./icon.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[gpu-monitor]", ...a);

// 主题跟随系统（nativeTheme 默认 "system"）：页面（webui.mjs）与组件（client.js）随系统切换深浅色，
// 不在此处强制深色。窗口背景色按当前系统模式取值，避免加载瞬间底色与页面不一致。
const WINDOW_BG = () => (nativeTheme.shouldUseDarkColors ? "#0f1116" : "#eef0f5");

const UI_MODE = process.env.GPU_MONITOR_UI_MODE || "tray"; // tray（默认） | window

// 菜单栏常驻：模块加载时（app ready 之前）就设置 accessory 策略，避免启动瞬间
// Dock 弹出图标再消失的闪烁（此前 dock.hide 在引擎启动后才调用，有 1~3s 窗口）
if (process.platform === "darwin" && UI_MODE !== "window") {
  try { app.setActivationPolicy("accessory"); } catch {}
  try { app.dock?.hide(); } catch {}
}

let engine = null;
let server = null;
let win = null;
let tray = null;
let shields = []; // 点击拦截层（透明全屏窗，用于"点面板外自动收起"）
let tipWin = null; // 进程信息悬浮窗（独立透明置顶小窗，可伸出面板窗口范围）
let tipWinReady = false; // 悬浮窗宿主页是否已加载完成（此后才可 executeJavaScript）
let tipPending = null; // 悬浮窗未就绪时暂存的最新渲染内容
let tipAnchor = null; // 悬浮窗锚点（方块在面板窗口内的坐标）
let quitting = false;

// —— 悬浮框（进程提示）桥 ——
// 面板 DOM 会被窗口边界裁切，提示改在独立小窗里渲染：面板窗口 preload（tip-preload.mjs，
// ESM + sandbox:false，与拦截层同一套已验证模式）把 tipBridge 暴露给页面，client.js 把
// 提示内容/锚点/主题推给主进程；主进程在 tipWin 里用 executeJavaScript 渲染并测量
// （主世界执行，不依赖 preload/事件时序），随后定位显示（可伸出面板窗口，仅夹紧到
// 屏幕工作区）。页面内提示始终显示作为保底。
const TIP_PRELOAD = fileURLToPath(new URL("./tip-preload.mjs", import.meta.url));
const TIP_HOST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
</head>
<body><div id="tip-root"></div></body>
</html>`;

/** 把 SVG 栅格化成 NativeImage 的离屏渲染（nativeImage 不支持 SVG 数据 URL）。 */
async function rasterizeSvg(size) {
  const w = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, sandbox: true },
  });
  await w.loadURL(
    "data:text/html," +
      encodeURIComponent(
        "<!doctype html><meta charset=\"utf-8\">" +
          `<body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">` +
          iconSvgMarkup() +
          "</body>"
      )
  );
  // 等两帧，确保首帧已绘制
  await w.webContents.executeJavaScript(
    "new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });"
  );
  const img = await w.webContents.capturePage();
  w.destroy();
  return img.isEmpty() ? null : img;
}

/** 菜单栏图标：electron/icon.svg（freeicon.com 单色 GPU 图标）栅格化成 template PNG。 */
async function makeTrayIcon() {
  const TRAY_PT = 16; // 菜单栏图标显示尺寸(pt)，比系统图标(18)略小、留出呼吸感
  try {
    const img0 = await rasterizeSvg(32); // 按 16pt 的 2x 渲染
    if (img0) {
      // 离屏截图在 Retina 上可能是 2x/4x 像素，必须按实际像素算 scaleFactor，
      // 否则硬编码会导致图标显示成 2 倍大
      const size = img0.getSize();
      const scale = size.width > 0 ? size.width / TRAY_PT : 2;
      const img = nativeImage.createFromBuffer(img0.toPNG(), { scaleFactor: scale });
      img.setTemplateImage(true);
      return img;
    }
  } catch (e) {
    log("SVG 图标渲染失败，退回水晶球:", String(e));
  }
  const fb = nativeImage.createFromBuffer(makeCrystalPng(16));
  fb.setTemplateImage(true);
  return fb;
}

async function start() {
  // ready 后再强调一次 accessory 策略（顶层调用在极端情况下可能先于 app 初始化完成）
  if (process.platform === "darwin" && UI_MODE !== "window") {
    try { app.setActivationPolicy("accessory"); } catch {}
    try { app.dock?.hide(); } catch {}
  }
  // 环境变量 → 引擎配置（默认值与变量名见 lib/config.mjs；Electron 端口默认 0 = 随机，避免冲突）
  const cfg = resolveEngineConfigFromEnv(process.env, process.platform, { portDefault: 0 });
  engine = createMonitorEngine({
    intervalMs: cfg.intervalMs,
    timeoutMs: cfg.timeoutMs,
    probeTimeoutMs: cfg.probeTimeoutMs,
    discoverIntervalMs: cfg.discoverIntervalMs,
    useSshConfig: true,
    sshConfigPath: cfg.sshConfigPath,
    includeLocal: cfg.includeLocal,
    orderFile: cfg.orderFile,
    settingsFile: cfg.settingsFile,
    source: "app",
    log,
  });
  engine.start();

  server = await createMonitorServer({
    engine,
    host: cfg.host,
    port: cfg.port, // 0 = 随机端口，避免冲突
    serveUi: true,
    log,
  });

  const url = `http://127.0.0.1:${server.port}`;
  if (UI_MODE === "window") {
    openWindowMode(url);
  } else {
    await setupTrayMode(url);
    // 启动后自动弹出一次监控面板：菜单栏常驻应用无 Dock 图标、无窗口，
    // 不弹面板的话用户会以为"启动没反应"
    setTimeout(() => {
      try { togglePopover(); } catch {}
    }, 600);
  }
  log(`已启动（${UI_MODE} 模式）: ${url}`);
}

function baseWebPreferences(preload) {
  const wp = { nodeIntegration: false, contextIsolation: true, sandbox: true };
  if (preload) wp.preload = preload;
  return wp;
}

/** 面板窗口 webPreferences：ESM preload 需要 sandbox:false（与拦截层同一套已验证模式）。 */
function panelWebPreferences() {
  return { ...baseWebPreferences(), preload: TIP_PRELOAD, sandbox: false };
}

/** 独立窗口模式（GPU_MONITOR_UI_MODE=window）。 */
function openWindowMode(url) {
  win = new BrowserWindow({
    width: 252,
    height: 760,
    minWidth: 240,
    minHeight: 320,
    title: "GPU 监控",
    backgroundColor: WINDOW_BG(),
    autoHideMenuBar: true,
    webPreferences: panelWebPreferences(),
  });
  win.loadURL(url);
  win.on("closed", () => {
    win = null;
    app.quit();
  });
}

/** 菜单栏常驻模式：Dock 隐藏，点击菜单栏图标弹出监控面板。 */
async function setupTrayMode(url) {
  // Dock 隐藏/accessory 策略已在模块加载时设置（避免启动闪烁）

  const menu = Menu.buildFromTemplate([
    { label: "显示 / 隐藏监控", click: togglePopover },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);

  tray = new Tray(await makeTrayIcon());
  tray.setToolTip("GPU 监控");
  tray.on("click", togglePopover); // macOS 上设置 context menu 会吞掉左键 click，故右键单独弹出
  tray.on("right-click", () => {
    // 不收起面板：面板层级降到 torn-off-menu（低于原生菜单），右键菜单会浮在面板上方
    menu.popup();
  });

  win = new BrowserWindow({
    width: 252,
    height: 520,
    minWidth: 240,
    minHeight: 320,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: WINDOW_BG(),
    webPreferences: panelWebPreferences(),
  });
  win.loadURL(url);
  // 层级：modal-panel(8) —— 高于拦截层 floating(3)、低于原生右键菜单 pop-up-menu(101)。
  // 注意 torn-off-menu 与 floating 同为 NSWindowLevel 3，会导致后创建的透明拦截层盖住面板（点击/滚轮失效）。
  win.setAlwaysOnTop(true, "modal-panel");
  // 不能调用 setVisibleOnAllWorkspaces(true)：它会内部触发 dock.show()，把 Dock 图标重新唤出
  // （electron#25368），与 dock.hide() 打架导致启动时 Dock 图标闪现
  win.on("blur", hideAll); // 保险：面板若拿到焦点再失去也收起
  // 关闭（Cmd+W / 退出手势）→ 隐藏而非退出
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    hideAll();
  });
}

/** 收起面板 + 销毁点击拦截层 + 隐藏悬浮框。 */
function hideAll() {
  if (win && !win.isDestroyed()) win.hide();
  hideTipWindow();
  for (const s of shields) {
    try { s.destroy(); } catch {}
  }
  shields = [];
}

/**
 * 显示点击拦截层：透明全屏窗口（'status' 层级，高于普通应用、低于面板），
 * 点面板外任意处（含其它应用窗口/桌面）都会命中拦截层 → 自动收起面板。
 * 点击检测走 preload 的 mousedown → IPC（before-input-event 只对键盘事件生效，鼠标无效）。
 */
function showShields() {
  const preload = fileURLToPath(new URL("./shield-preload.mjs", import.meta.url));
  for (const disp of screen.getAllDisplays()) {
    const wa = disp.workArea;
    const s = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: wa.width,
      height: wa.height,
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      // ESM preload 需要 sandbox: false（仅本地 data: 页面，无远程内容）
      webPreferences: { ...baseWebPreferences(), preload, sandbox: false },
    });
    s.setAlwaysOnTop(true, "floating"); // 高于普通应用窗口、低于面板
    s.loadURL("data:text/html,<body style='margin:0;background:transparent'></body>");
    s.on("closed", () => {
      shields = shields.filter((w) => w !== s);
    });
    s.showInactive();
    shields.push(s);
  }
}

function togglePopover() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    hideAll();
    return;
  }
  // 弹出定位：面板左边缘与菜单栏图标左边缘对齐（macOS 常见 popover 风格）；超出屏幕时夹紧
  const tb = tray.getBounds();
  const wb = win.getBounds();
  const wa = screen.getDisplayMatching(tb).workArea;
  const x = Math.max(wa.x + 4, Math.min(tb.x, wa.x + wa.width - wb.width - 4));
  const y = Math.round(tb.y + tb.height + 6);
  win.setPosition(x, y, false);
  win.showInactive(); // 不抢焦点
  showShields(); // 拦截面板外的点击
}

// —— 悬浮框（进程提示）独立小窗 ——
// 提示内容由 client.js 经 tip-preload 桥推送；主进程把内容写进 tipWin 的宿主页
// （executeJavaScript 在主世界执行，渲染 + 测量一次完成），按内容尺寸缩窗并锚定在
// 方块旁——可伸出面板窗口，只夹紧到屏幕工作区内。
// 注：focusable:true + showInactive 与拦截层（shields）同款——macOS 上 focusable:false
// 的窗口可能无法正常置顶显示；showInactive 保证不抢焦点（面板保持打开）。
function hideTipWindow() {
  tipAnchor = null;
  if (tipWin && !tipWin.isDestroyed()) tipWin.hide();
}

async function ensureTipWindow() {
  if (tipWin && !tipWin.isDestroyed()) return tipWin;
  tipWinReady = false;
  tipWin = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true, // 同拦截层：macOS 上 focusable:false 可能显示不出来
    // 无 preload：渲染走 executeJavaScript（主世界），宿主页只是空壳
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  try { tipWin.setAlwaysOnTop(true, "modal-panel"); } catch {}
  try { if (win && !win.isDestroyed()) tipWin.setParentWindow(win); } catch {}
  // 纯信息展示：鼠标穿透（不挡下方方块悬停 / 其它应用的点击）
  try { tipWin.setIgnoreMouseEvents(true); } catch {}
  tipWin.on("closed", () => { tipWin = null; tipWinReady = false; });
  tipWin.webContents.once("did-finish-load", () => {
    tipWinReady = true;
    log("悬浮窗: 页面加载完成");
    flushTipRender();
  });
  tipWin.webContents.once("did-fail-load", (event, code, desc) => {
    log("悬浮窗: 页面加载失败", code, desc);
    try { tipWin.destroy(); } catch {} // 销毁以便下次重试
  });
  await tipWin.loadURL("data:text/html," + encodeURIComponent(TIP_HOST_HTML)).catch((e) => {
    log("悬浮窗: loadURL 失败", String(e));
    try { tipWin.destroy(); } catch {}
  });
  // 保险：loadURL 已返回但 did-finish-load 未触发时也放行
  if (tipWin && !tipWin.isDestroyed() && !tipWinReady) {
    tipWinReady = true;
    flushTipRender();
  }
  log("悬浮窗: 窗口已创建");
  return tipWin;
}

/** 把暂存的最新提示渲染进悬浮窗并测量尺寸（悬浮窗就绪后调用）。 */
function flushTipRender() {
  if (!tipWin || tipWin.isDestroyed() || !tipWinReady || !tipPending) return;
  const p = tipPending;
  tipPending = null;
  const theme = p.theme === "light" ? "light" : "dark";
  const js =
    "(function () {" +
    "var de=document.documentElement;" +
    "de.dataset.gpuTheme=" + JSON.stringify(theme) + ";" +
    "de.style.cssText=" + JSON.stringify(String(p.vars || "")) + ";" +
    "document.getElementById('tip-root').innerHTML=" + JSON.stringify(String(p.html || "")) + ";" +
    "return {w:de.scrollWidth,h:de.scrollHeight};" +
    "})()";
  tipWin.webContents
    .executeJavaScript(js)
    .then((size) => {
      if (quitting || !tipWin || tipWin.isDestroyed() || !tipAnchor) return;
      positionTipWindow(Number(size && size.w) || 1, Number(size && size.h) || 1);
    })
    .catch((e) => log("悬浮框渲染失败:", String(e)));
}

let tipBridgeSeen = false; // 是否收到过页面来的 show（诊断：preload 桥是否连通）

function showTipWindow(payload) {
  if (quitting || !win || win.isDestroyed()) return;
  if (!tipBridgeSeen) {
    tipBridgeSeen = true;
    log("悬浮窗: 桥已连通（收到首次 show）");
  }
  const html = String((payload && payload.html) || "");
  if (!html) { hideTipWindow(); return; }
  const a = (payload && payload.anchor) || {};
  tipAnchor = {
    x: Number(a.x) || 0,
    y: Number(a.y) || 0,
    width: Number(a.width) || 0,
    height: Number(a.height) || 0,
  };
  tipPending = payload;
  if (tipWin && !tipWin.isDestroyed() && tipWinReady) {
    flushTipRender();
    return;
  }
  ensureTipWindow().catch((e) => log("悬浮框窗口失败:", String(e)));
}

/** 按内容尺寸（来自 executeJavaScript 的测量）定位并显示悬浮窗；位置可伸出面板窗口。 */
function positionTipWindow(w, h) {
  if (!tipWin || tipWin.isDestroyed() || !win || win.isDestroyed() || !tipAnchor) return;
  const wb = win.getBounds();
  const wa = screen.getDisplayMatching(wb).workArea;
  const ax = wb.x + tipAnchor.x;
  const ay = wb.y + tipAnchor.y;
  // 左边缘与方块对齐（夹紧到屏幕内；宽度超出面板窗口不受限）
  const x = Math.max(wa.x + 4, Math.min(ax, wa.x + wa.width - w - 4));
  // 优先方块下方；下方放不下翻到上方
  const below = ay + tipAnchor.height + 8;
  const y = below + h <= wa.y + wa.height - 4 ? below : Math.max(wa.y + 4, ay - h - 8);
  tipWin.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
  tipWin.showInactive(); // 不抢焦点（面板保持打开）
  log(`悬浮窗: 定位显示于 ${Math.round(x)},${Math.round(y)} (${Math.round(w)}x${Math.round(h)})`);
}

ipcMain.on("gpu-monitor-tip-show", (e, payload) => showTipWindow(payload));
ipcMain.on("gpu-monitor-tip-hide", () => hideTipWindow());

// 拦截层点击 → 收起
ipcMain.on("gpu-shield-click", hideAll);

app.whenReady().then(start).catch((e) => {
  log("启动失败:", String(e));
  app.exit(1);
});

app.on("window-all-closed", () => {
  // 菜单栏常驻模式不退出；窗口模式在窗口关闭时已 app.quit()
  if (UI_MODE === "window") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  hideAll();
  if (tipWin && !tipWin.isDestroyed()) { try { tipWin.destroy(); } catch {} }
  try { engine?.stop(); } catch {}
  try { server?.close(); } catch {}
});
