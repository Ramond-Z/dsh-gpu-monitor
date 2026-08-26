#!/usr/bin/env node
// dsh-gpu-monitor sidecar：独立进程 = 共享监控引擎（lib/engine.mjs）+ 共享 HTTP 传输层（lib/server.mjs）。
// 本文件只负责：环境变量解析、启动引擎、DSH 同源 JSON 桥（写入 dsh 前端 dist）、优雅退出。
// 在 MacBook / 无 DSH 环境直接运行：浏览器打开 http://127.0.0.1:3499 即可监控 ~/.ssh/config 中所有 GPU server。
//
// 环境变量：
//   GPU_MONITOR_PORT             监听端口（默认 3499）
//   GPU_MONITOR_HOST             监听地址（默认 127.0.0.1；远程浏览器访问时改 0.0.0.0）
//   GPU_MONITOR_SSH_CONFIG       ssh config 路径（默认 ~/.ssh/config）
//   GPU_MONITOR_INCLUDE_LOCAL    是否查询本机 nvidia-smi（macOS 默认 0，其余默认 1）
//   GPU_MONITOR_INTERVAL_MS      查询间隔（默认 3000）
//   GPU_MONITOR_DISCOVER_INTERVAL_MS  重新探测 server 列表间隔（默认 60000）
//   GPU_MONITOR_QUERY_TIMEOUT_MS 每台机器查询超时（默认 8000）
//   GPU_MONITOR_PROBE_TIMEOUT_MS 探测超时（默认 4000）
//   GPU_MONITOR_ORDER_FILE       分组顺序持久化文件（默认 ~/.dsh/gpu-monitor-order.json）
//   GPU_MONITOR_SETTINGS_FILE    运行时设置文件（默认 ~/.dsh/gpu-monitor-settings.json）
//   GPU_MONITOR_JSON_PATH        同源 JSON 桥写入路径（默认自动探测 dsh 前端 dist）
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createMonitorEngine } from "./engine.mjs";
import { createMonitorServer } from "./server.mjs";
import { resolveEngineConfigFromEnv } from "./config.mjs";

// 环境变量 → 引擎配置（默认值与变量名见 lib/config.mjs，与 README 环境变量表一致）
const cfg = resolveEngineConfigFromEnv(process.env, process.platform);

const log = (...a) => console.log(new Date().toISOString(), "[dsh-gpu-monitor-sidecar]", ...a);

// —— 共享监控引擎 ——
const engine = createMonitorEngine({
  intervalMs: cfg.intervalMs,
  timeoutMs: cfg.timeoutMs,
  probeTimeoutMs: cfg.probeTimeoutMs,
  discoverIntervalMs: cfg.discoverIntervalMs,
  useSshConfig: true,
  sshConfigPath: cfg.sshConfigPath,
  includeLocal: cfg.includeLocal,
  orderFile: cfg.orderFile,
  settingsFile: cfg.settingsFile,
  source: "sidecar",
  log,
});
engine.start();

// —— 同源 JSON 桥：把状态写入 dsh 前端 dist 目录，浏览器可直接 fetch /gpu-status.json（无 CORS） ——
function detectJsonPath() {
  if (cfg.jsonPath) return cfg.jsonPath;
  try {
    const npx = join(homedir(), ".npm", "_npx");
    for (const entry of readdirSync(npx)) {
      const p = join(npx, entry, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "gpu-status.json");
      if (existsSync(dirname(p))) return p;
    }
  } catch {}
  return null;
}
let jsonPath = detectJsonPath();
let jsonWarned = false;

function writeJson() {
  if (!jsonPath) return;
  try {
    const tmp = jsonPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(engine.getState()));
    renameSync(tmp, jsonPath);
  } catch (e) {
    if (!jsonWarned) {
      jsonWarned = true;
      log("写入同源 JSON 失败，已禁用:", String(e));
      jsonPath = null;
    }
  }
}
engine.onUpdate(writeJson);

// —— 共享 HTTP 传输层 ——
const server = await createMonitorServer({ engine, host: cfg.host, port: cfg.port, serveUi: true, log });
log(`listening on http://${cfg.host}:${server.port} (interval ${cfg.intervalMs}ms, local=${cfg.includeLocal})`);
if (jsonPath) log(`same-origin JSON 桥: ${jsonPath} → /gpu-status.json`);
log(`settings 文件: ${cfg.settingsFile}`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("收到", sig, "，退出");
    engine.stop();
    server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
