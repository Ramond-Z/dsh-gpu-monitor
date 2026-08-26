// dsh-gpu-monitor: Electron 原生应用入口。
// 默认 **菜单栏常驻**（Dock 图标隐藏，点菜单栏图标弹出监控面板）；GPU_MONITOR_UI_MODE=window 时为独立窗口。
// 复用共享监控引擎 + HTTP 传输层：引擎在应用进程内运行，面板/窗口加载本地 UI。
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, screen, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMonitorEngine } from "../lib/engine.mjs";
import { createMonitorServer } from "../lib/server.mjs";
import { makeCrystalPng, iconSvgMarkup } from "./icon.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[gpu-monitor]", ...a);

// 监控面板固定深色（与页面 data-gpu-theme=dark 一致），不受系统浅色模式影响
nativeTheme.themeSource = "dark";

const UI_MODE = process.env.GPU_MONITOR_UI_MODE || "tray"; // tray（默认） | window
const INCLUDE_LOCAL =
  process.env.GPU_MONITOR_INCLUDE_LOCAL !== undefined
    ? process.env.GPU_MONITOR_INCLUDE_LOCAL !== "0"
    : process.platform !== "darwin";

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
let quitting = false;

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
  engine = createMonitorEngine({
    intervalMs: Number(process.env.GPU_MONITOR_INTERVAL_MS || 3000),
    timeoutMs: Number(process.env.GPU_MONITOR_QUERY_TIMEOUT_MS || 8000),
    probeTimeoutMs: Number(process.env.GPU_MONITOR_PROBE_TIMEOUT_MS || 4000),
    discoverIntervalMs: Number(process.env.GPU_MONITOR_DISCOVER_INTERVAL_MS || 60000),
    useSshConfig: true,
    sshConfigPath: process.env.GPU_MONITOR_SSH_CONFIG || "",
    includeLocal: INCLUDE_LOCAL,
    orderFile: process.env.GPU_MONITOR_ORDER_FILE || join(homedir(), ".dsh", "gpu-monitor-order.json"),
    source: "app",
    log,
  });
  engine.start();

  server = await createMonitorServer({
    engine,
    host: "127.0.0.1",
    port: Number(process.env.GPU_MONITOR_PORT || 0), // 0 = 随机端口，避免冲突
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

function baseWebPreferences() {
  return { nodeIntegration: false, contextIsolation: true, sandbox: true };
}

/** 独立窗口模式（GPU_MONITOR_UI_MODE=window）。 */
function openWindowMode(url) {
  win = new BrowserWindow({
    width: 252,
    height: 760,
    minWidth: 240,
    minHeight: 320,
    title: "GPU 监控",
    backgroundColor: "#0f1116",
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences(),
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
    backgroundColor: "#0f1116",
    webPreferences: baseWebPreferences(),
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

/** 收起面板 + 销毁点击拦截层。 */
function hideAll() {
  if (win && !win.isDestroyed()) win.hide();
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
  try { engine?.stop(); } catch {}
  try { server?.close(); } catch {}
});
