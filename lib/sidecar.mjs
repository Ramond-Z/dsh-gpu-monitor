#!/usr/bin/env node
// dsh-gpu-monitor sidecar：独立进程 = 共享监控引擎（lib/engine.mjs）+ HTTP 传输层。
// 传输层职责：环境变量解析、HTTP 路由（状态 / 顺序 / 独立网页 UI）、同源 JSON 桥（写入 dsh 前端 dist）。
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
//   GPU_MONITOR_JSON_PATH        同源 JSON 桥写入路径（默认自动探测 dsh 前端 dist）
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createMonitorEngine } from "./engine.mjs";
import { INDEX_HTML, SHIM_JS, CLIENT_JS_PATH } from "./webui.mjs";

const PORT = Number(process.env.GPU_MONITOR_PORT || 3499);
const HOST = process.env.GPU_MONITOR_HOST || "127.0.0.1";
const INTERVAL_MS = Number(process.env.GPU_MONITOR_INTERVAL_MS || 3000);
const DISCOVER_MS = Number(process.env.GPU_MONITOR_DISCOVER_INTERVAL_MS || 60000);
const QUERY_TIMEOUT_MS = Number(process.env.GPU_MONITOR_QUERY_TIMEOUT_MS || 8000);
const PROBE_TIMEOUT_MS = Number(process.env.GPU_MONITOR_PROBE_TIMEOUT_MS || 4000);
const SSH_CONFIG = process.env.GPU_MONITOR_SSH_CONFIG || "";
const ORDER_FILE = process.env.GPU_MONITOR_ORDER_FILE || join(homedir(), ".dsh", "gpu-monitor-order.json");
// macOS（如 MacBook）没有 nvidia-smi，默认不查本机；可用 GPU_MONITOR_INCLUDE_LOCAL=1 覆盖
const INCLUDE_LOCAL =
  process.env.GPU_MONITOR_INCLUDE_LOCAL !== undefined
    ? process.env.GPU_MONITOR_INCLUDE_LOCAL !== "0"
    : process.platform !== "darwin";

const log = (...a) => console.log(new Date().toISOString(), "[dsh-gpu-monitor-sidecar]", ...a);

// —— 共享监控引擎 ——
const engine = createMonitorEngine({
  intervalMs: INTERVAL_MS,
  timeoutMs: QUERY_TIMEOUT_MS,
  probeTimeoutMs: PROBE_TIMEOUT_MS,
  discoverIntervalMs: DISCOVER_MS,
  useSshConfig: true,
  sshConfigPath: SSH_CONFIG,
  includeLocal: INCLUDE_LOCAL,
  orderFile: ORDER_FILE,
  source: "sidecar",
  log,
});

// —— 同源 JSON 桥：把状态写入 dsh 前端 dist 目录，浏览器可直接 fetch /gpu-status.json（无 CORS） ——
function detectJsonPath() {
  if (process.env.GPU_MONITOR_JSON_PATH) return process.env.GPU_MONITOR_JSON_PATH;
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

// —— HTTP 传输层 ——
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (res, status, body) => {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

/** 读取请求体（限制大小，防滥用）。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  // —— 独立网页 UI（MacBook 等无 DSH 环境直接访问） ——
  if (req.method === "GET" || req.method === "HEAD") {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (url.pathname === "/dsh-shim.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(SHIM_JS);
      return;
    }
    if (url.pathname === "/plugins/dsh-gpu-monitor/client.js") {
      try {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readFileSync(CLIENT_JS_PATH));
        return;
      } catch {
        res.writeHead(404);
        res.end("client.js not found");
        return;
      }
    }
  }
  // —— 数据接口 ——
  if (url.pathname === "/status" || url.pathname === "/gpu-status.json" || url.pathname === "/gpu/status") {
    json(res, 200, engine.getState());
    return;
  }
  if (url.pathname === "/order" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const next = engine.setOrder(body?.o, Number(body?.t));
      if (next === null) {
        json(res, 400, { ok: false, error: "需要 {o: string[], t: number}" });
        return;
      }
      log(`收到新顺序 (t=${Number(body?.t)}): ${next.o.join(", ") || "（空）"}`);
      json(res, 200, { ok: true, order: next });
      return;
    } catch (e) {
      json(res, 400, { ok: false, error: String(e) });
      return;
    }
  }
  if (url.pathname === "/health") {
    json(res, 200, { ok: true, servers: engine.listServers(), local: INCLUDE_LOCAL, port: PORT });
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (interval ${INTERVAL_MS}ms, local=${INCLUDE_LOCAL})`);
  if (jsonPath) log(`same-origin JSON 桥: ${jsonPath} → /gpu-status.json`);
});

engine.start();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("收到", sig, "，退出");
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
