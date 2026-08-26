// dsh-gpu-monitor: Electron 原生应用入口（自包含，无需浏览器）。
// 复用共享监控引擎 + HTTP 传输层：引擎在应用进程内运行，窗口直接加载本地 UI。
// 运行：npm run app（开发） / npm run dist（打包 .app/.dmg）。
import { app, BrowserWindow, nativeTheme } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMonitorEngine } from "../lib/engine.mjs";
import { createMonitorServer } from "../lib/server.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[gpu-monitor]", ...a);

// 监控面板固定深色（与页面 data-gpu-theme=dark 一致），不受系统浅色模式影响
nativeTheme.themeSource = "dark";

const INCLUDE_LOCAL =
  process.env.GPU_MONITOR_INCLUDE_LOCAL !== undefined
    ? process.env.GPU_MONITOR_INCLUDE_LOCAL !== "0"
    : process.platform !== "darwin";

let engine = null;
let server = null;
let win = null;

async function start() {
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
  // 默认宽度：8 卡按 4×2 两排刚好放下（方块 46px×4 + 间距 + 内边距/卡片边距 ≈ 226px，留 ~26px 余量）
  win = new BrowserWindow({
    width: 252,
    height: 760,
    minWidth: 240,
    minHeight: 320,
    title: "GPU 监控",
    backgroundColor: "#0f1116",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.loadURL(url);
  log(`窗口已打开: ${url}`);
  win.on("closed", () => {
    win = null;
    app.quit();
  });
}

app.whenReady().then(start).catch((e) => {
  log("启动失败:", String(e));
  app.exit(1);
});

app.on("window-all-closed", () => {
  app.quit(); // 监控应用：窗口关闭即退出（不驻留 Dock）
});

app.on("before-quit", () => {
  try { engine?.stop(); } catch {}
  try { server?.close(); } catch {}
});
