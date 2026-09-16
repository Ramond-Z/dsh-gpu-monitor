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
// 屏幕工作区）。页面内提示作为保底（悬浮窗失败时经 fallback 信号退回）。
// 悬浮窗内容尺寸上限：宽 480px（超出面板、但不占满屏幕）、高 320px（超出内部滚动），
// 与页面内提示（lib/client.js 的 IN_PAGE_TIP_LAYOUT）保持一致。
const MAX_TIP_W = 480;
const MAX_TIP_H = 320;
const TIP_PRELOAD = fileURLToPath(new URL("./tip-preload.mjs", import.meta.url));
const TIP_HOST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
/* 提示盒滚动条常显（灰半透明细条），进程很多时可见 */
#tip-root > div::-webkit-scrollbar{width:8px}
#tip-root > div::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:4px}
#tip-root > div::-webkit-scrollbar-track{background:transparent}
/* 进程行跑马灯：固定前缀（属主+显存）不滚动，命令视口超宽时自动滚动（悬停暂停）。
   速度 = 设置值（px/s）字面含义：时长 = 距离 / 速度，不同长度的行滚动同步。 */
.gpu-tip-line{display:flex;align-items:center;min-width:0}
.gpu-tip-line .gpu-tip-line-prefix{flex:none;white-space:nowrap}
.gpu-tip-line .gpu-tip-line-inner{flex:1;min-width:0;overflow:hidden;white-space:nowrap;position:relative}
.gpu-tip-line .gpu-tip-line-text{display:inline-block;white-space:nowrap;will-change:transform}
.gpu-tip-line.gpu-marquee .gpu-tip-line-text{animation:gpu-tip-marquee var(--gpu-marquee-dur,10s) linear .8s infinite}
.gpu-tip-line.gpu-marquee:hover .gpu-tip-line-text{animation-play-state:paused}
@keyframes gpu-tip-marquee{0%{transform:translateX(0)}100%{transform:translateX(calc(-1 * var(--gpu-marquee-dist,0px)))}}
</style>
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
    // 不自动弹出面板：菜单栏常驻（无 Dock 图标），点菜单栏图标才显示监控面板
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

/** 独立窗口模式（GPU_MONITOR_UI_MODE=window）。显式初始位置（光标所在显示器居中），
 *  避免 macOS 窗口状态恢复/默认级联把窗口放到奇怪的位置。 */
function openWindowMode(url) {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win = new BrowserWindow({
    x: Math.round(wa.x + Math.max(12, (wa.width - 252) / 2)),
    y: Math.round(wa.y + Math.max(24, (wa.height - 760) / 3)),
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
  win.on("blur", () => {
    // 焦点只是移到了提示窗（点击提示选中/滚动）：不算"点外面"，不收起
    if (tipWin && !tipWin.isDestroyed() && BrowserWindow.getFocusedWindow() === tipWin) return;
    hideAll(); // 保险：面板若拿到焦点再失去也收起
  });
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

/** 菜单栏图标坐标是否可用：macOS 上图标可能晚于窗口就绪，getBounds 短暂返回 0/坏值
 *  （y 应在菜单栏带内 ≈0~60；出现大 y/零尺寸即视为未就位）。 */
function trayBoundsOk(tb) {
  return !!(tb && tb.width > 0 && tb.height > 0 && Number.isFinite(tb.y) && tb.y >= 0 && tb.y < 200);
}

let popoverRetries = 0; // 图标未就位时的重试计数（防无限重试）

function togglePopover() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    hideAll();
    return;
  }
  const wb = win.getBounds();
  const tb = tray.getBounds();
  let x, y, wa;
  if (trayBoundsOk(tb)) {
    popoverRetries = 0;
    // 弹出定位：面板左边缘与菜单栏图标左边缘对齐（macOS 常见 popover 风格）；超出屏幕时夹紧
    wa = screen.getDisplayMatching(tb).workArea;
    x = Math.max(wa.x + 4, Math.min(tb.x, wa.x + wa.width - wb.width - 4));
    y = Math.round(tb.y + tb.height + 6);
  } else if (popoverRetries < 8) {
    // 图标未就位（启动自动弹出最容易撞上）：稍后重试定位，避免面板落到错误角落
    popoverRetries++;
    setTimeout(() => {
      try { if (win && !win.isDestroyed() && !win.isVisible()) togglePopover(); } catch {}
    }, 400);
    return;
  } else {
    // 重试耗尽仍拿不到图标坐标：兜底弹到光标所在显示器右上角（菜单栏图标常见位置），
    // 总比永不弹出/落错角落好
    wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    x = wa.x + wa.width - wb.width - 12;
    y = wa.y + 8;
  }
  win.setPosition(x, y, false);
  win.showInactive(); // 不抢焦点
  // 防 macOS 窗口状态恢复在 show 后异步覆盖帧位置：下一拍再断言一次
  setImmediate(() => {
    try { if (win && !win.isDestroyed() && win.isVisible()) win.setPosition(x, y, false); } catch {}
  });
  showShields(); // 拦截面板外的点击
  log(`面板: 弹出于 ${Math.round(x)},${Math.round(y)}`);
}

// —— 悬浮框（进程提示）独立小窗 ——
// 提示内容由 client.js 经 tip-preload 桥推送；主进程把内容写进 tipWin 的宿主页
// （executeJavaScript 在主世界执行，渲染 + 测量一次完成），按内容尺寸缩窗并锚定在
// 方块旁——可伸出面板窗口，只夹紧到屏幕工作区内。
// 注：focusable:true + showInactive 与拦截层（shields）同款——macOS 上 focusable:false
// 的窗口可能无法正常置顶显示；showInactive 保证不抢焦点（面板保持打开）。
function hideTipWindow() {
  tipAnchor = null;
  tipHidePending = false;
  stopTipCursorWatch();
  tipHovering = false;
  if (tipWin && !tipWin.isDestroyed()) {
    try { tipWin.setIgnoreMouseEvents(true); } catch {}
    tipWin.hide();
  }
}

// —— 悬浮窗鼠标穿透跟随光标 ——
// 悬浮窗平时鼠标穿透（不挡下方方块/其它应用点击）；光标进入悬浮窗时取消穿透，
// 让提示盒的滚动条可用（滚轮/触控板滚动看完整命令）；移出后恢复穿透。
// 光标在悬浮窗内期间收到的 hide 信号（面板那边方块 mouseleave 触发）先挂起，
// 等光标移出悬浮窗再隐藏——否则一进提示去滚动它就被关掉。
let tipHovering = false;
let tipHidePending = false;
let tipCursorTimer = null;

function stopTipCursorWatch() {
  if (tipCursorTimer) { clearInterval(tipCursorTimer); tipCursorTimer = null; }
}

/** 悬浮窗可见期间每 150ms 轮询光标位置，按是否在窗内切换鼠标穿透。 */
function startTipCursorWatch() {
  if (tipCursorTimer) return;
  tipCursorTimer = setInterval(() => {
    if (quitting || !tipWin || tipWin.isDestroyed() || !tipWin.isVisible()) {
      stopTipCursorWatch();
      return;
    }
    let inside = false;
    try {
      const cp = screen.getCursorScreenPoint();
      const b = tipWin.getBounds();
      inside = cp.x >= b.x - 4 && cp.x <= b.x + b.width + 4 && cp.y >= b.y - 4 && cp.y <= b.y + b.height + 4;
    } catch {}
    if (inside !== tipHovering) {
      tipHovering = inside;
      try { tipWin.setIgnoreMouseEvents(!inside); } catch {}
      log(`悬浮窗: 鼠标穿透${inside ? "关闭（窗内可滚动/选中）" : "恢复"}`);
    }
    if (tipHidePending && !inside) {
      tipHidePending = false;
      hideTipWindow();
    }
  }, 150);
  tipCursorTimer.unref?.();
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

/** 把暂存的最新提示渲染进悬浮窗并测量尺寸（悬浮窗就绪后调用）。
 *  宽度策略：先按内容自然宽（width:max-content）测量，再夹紧到上限 MAX_TIP_W
 *  （480px，超出面板但不占满屏幕）——放得下就完整一行展示；**超宽的进程行不换行，
 *  启用跑马灯自动滚动**（距离/时长写入 CSS 变量）；高度超限 MAX_TIP_H（320px）
 *  内部滚动（进程很多时）。盒子的真实外沿尺寸（含 padding/border）用
 *  getBoundingClientRect 取，窗口按它缩。 */
function flushTipRender() {
  if (!tipWin || tipWin.isDestroyed() || !tipWinReady || !tipPending) return;
  const p = tipPending;
  tipPending = null;
  const theme = p.theme === "light" ? "light" : "dark";
  let wa;
  try {
    wa = win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea;
  } catch { return; }
  const availW = Math.max(120, Math.min(MAX_TIP_W, Math.floor(wa.width - 8)));
  const availH = Math.max(120, Math.min(MAX_TIP_H, Math.floor(wa.height - 8)));
  // 跑马灯滚动速度（设置页可调，客户端随 payload 推送）：距离 / 速度 = 时长
  const speedPx = Math.max(20, Math.min(100, Number(p.speedPx) || 45));
  const js =
    "(function () {" +
    "var de=document.documentElement;" +
    "de.dataset.gpuTheme=" + JSON.stringify(theme) + ";" +
    "de.style.cssText=" + JSON.stringify(String(p.vars || "")) + ";" +
    "var root=document.getElementById('tip-root');" +
    "root.innerHTML='';" +
    "var box=document.createElement('div');" +
    "box.style.cssText=" + JSON.stringify(String(p.style || "")) + ";" +
    "box.style.boxSizing='border-box';" + // 显式宽度含 padding/border，整盒不超出可用宽
    "box.style.width='max-content';box.style.maxWidth='none';" +
    "box.innerHTML=" + JSON.stringify(String(p.html || "")) + ";" +
    "root.appendChild(box);" +
    "var naturalW=box.getBoundingClientRect().width;" + // 内容自然宽（最宽一行不换行）
    "var w=Math.max(80,Math.min(naturalW," + availW + "));" +
    "box.style.width=w+'px';box.style.maxWidth=w+'px';" +
    // 跑马灯：命令视口超宽的行不换行、自动滚动；固定前缀（属主+显存）不参与。
    // 溢出距离 = 命令文本宽 - 视口宽；时长 = 距离 / 速度（固定 px/s，行间同步）
    "var sp=" + speedPx + ";" +
    "var lines=box.querySelectorAll('.gpu-tip-line');" +
    "for(var i=0;i<lines.length;i++){var ln=lines[i],vp=ln.querySelector('.gpu-tip-line-inner'),tx=vp&&vp.querySelector('.gpu-tip-line-text');" +
    "if(!vp||!tx)continue;var d=tx.scrollWidth-vp.clientWidth;" +
    "if(d>0){ln.className+=' gpu-marquee';ln.style.setProperty('--gpu-marquee-dist',d+'px');" +
    "ln.style.setProperty('--gpu-marquee-dur',Math.max(1,Math.round(d/sp*10)/10)+'s');}}" +
    "var h=box.scrollHeight;" +
    "if(h>" + availH + "){box.style.maxHeight='" + availH + "px';box.style.overflowY='auto';}" +
    "var rect=box.getBoundingClientRect();" +
    "return {w:Math.round(rect.width),h:Math.round(rect.height),naturalW:Math.round(naturalW)};" +
    "})()";
  tipWin.webContents
    .executeJavaScript(js)
    .then((size) => {
      if (quitting || !tipWin || tipWin.isDestroyed() || !tipAnchor) return;
      positionTipWindow(Number(size && size.w) || 1, Number(size && size.h) || 1);
    })
    .catch((e) => {
      log("悬浮框渲染失败:", String(e));
      sendTipFallback(); // 退回页面内提示（保底）
    });
}

let tipBridgeSeen = false; // 是否收到过页面来的 show（诊断：preload 桥是否连通）

/** 悬浮窗失败 → 隐藏残留的悬浮窗并通知页面退回页面内提示（保底，避免"悬停无提示"）。 */
function sendTipFallback() {
  if (tipWin && !tipWin.isDestroyed()) tipWin.hide(); // 旧内容别留在屏幕上
  if (win && !win.isDestroyed()) {
    try { win.webContents.send("gpu-monitor-tip-fallback"); } catch {}
  }
}

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
  ensureTipWindow().catch((e) => {
    log("悬浮框窗口失败:", String(e));
    sendTipFallback();
  });
}

/** 按内容尺寸（来自 executeJavaScript 的测量）定位并显示悬浮窗；位置可伸出面板窗口。
 *  横向：优先向右伸出面板（左缘对齐方块）；右边放不下且左边够时翻到方块左侧
 *  （右缘对齐方块）；比屏幕还宽时从屏幕左缘铺开。仅夹紧到屏幕工作区。 */
function positionTipWindow(w, h) {
  if (!tipWin || tipWin.isDestroyed() || !win || win.isDestroyed() || !tipAnchor) return;
  const wb = win.getBounds();
  const wa = screen.getDisplayMatching(wb).workArea;
  const ax = wb.x + tipAnchor.x;
  const ay = wb.y + tipAnchor.y;
  w = Math.max(1, Math.min(Math.round(w), wa.width - 8));
  h = Math.max(1, Math.min(Math.round(h), wa.height - 8));
  const rightRoom = wa.x + wa.width - 4 - ax; // 方块左缘右侧可用的空间
  const leftRoom = ax + tipAnchor.width - (wa.x + 4); // 方块右缘左侧可用的空间
  let x;
  if (w <= rightRoom) x = ax; // 右边放得下：左缘对齐方块，向右伸出面板
  else if (w <= leftRoom) x = ax + tipAnchor.width - w; // 右边不够、左边够：右缘对齐方块，向左铺开
  else x = wa.x + 4; // 比屏幕还宽：从屏幕左缘开始
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - w - 4));
  // 优先方块下方；下方放不下翻到上方
  const below = ay + tipAnchor.height + 8;
  const y = below + h <= wa.y + wa.height - 4 ? below : Math.max(wa.y + 4, ay - h - 8);
  tipWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  tipWin.showInactive(); // 不抢焦点（面板保持打开）
  startTipCursorWatch(); // 光标进窗 → 取消穿透（可滚动）；移出 → 恢复穿透
  log(`悬浮窗: 定位显示于 ${Math.round(x)},${Math.round(y)} (${w}x${h})`);
}

ipcMain.on("gpu-monitor-tip-show", (e, payload) => showTipWindow(payload));
// 提示内容"仅显存数字变化"的轻量更新：原地改写各行的固定前缀（属主+显存），
// 不整窗重渲染 —— .gpu-tip-line-text 元素与跑马灯动画不动，滚动不从头开始。
ipcMain.on("gpu-monitor-tip-update", (e, payload) => {
  const prefixes = payload && Array.isArray(payload.prefixes) ? payload.prefixes : null;
  if (!prefixes || quitting || !tipWin || tipWin.isDestroyed() || !tipWinReady || !tipWin.isVisible()) return;
  const js =
    "(function(){" +
    "var box=document.querySelector('#tip-root>div');if(!box)return;" +
    "var ps=" + JSON.stringify(prefixes) + ";" +
    "var lines=box.querySelectorAll('.gpu-tip-line');" +
    "for(var i=0;i<ps.length&&i<lines.length;i++){" +
    "var pre=lines[i].querySelector('.gpu-tip-line-prefix');if(pre)pre.textContent=ps[i];}})()";
  tipWin.webContents.executeJavaScript(js).catch(() => {});
});
ipcMain.on("gpu-monitor-tip-hide", () => {
  // 光标正在悬浮窗内（滚动/选中中）：挂起隐藏，等移出再关，避免"一进提示就消失"
  if (tipHovering) { tipHidePending = true; return; }
  hideTipWindow();
});

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
