#!/usr/bin/env node
// dsh-gpu-monitor sidecar：独立进程，解析 ~/.ssh/config → 探测可用 GPU server →
// 周期并行查询（本机 + 各 server）→ 本地 HTTP 输出 JSON（带 CORS）。
// 用途：在“宿主插件无法热加载（不能重启 dsh）”时，为浏览器端提供多机 GPU 数据。
//
// 环境变量：
//   GPU_MONITOR_PORT             监听端口（默认 3499）
//   GPU_MONITOR_HOST             监听地址（默认 127.0.0.1；远程浏览器访问时改 0.0.0.0）
//   GPU_MONITOR_SSH_CONFIG       ssh config 路径（默认 ~/.ssh/config）
//   GPU_MONITOR_INCLUDE_LOCAL    是否查询本机 nvidia-smi（默认 1）
//   GPU_MONITOR_INTERVAL_MS      查询间隔（默认 3000）
//   GPU_MONITOR_DISCOVER_INTERVAL_MS  重新探测 server 列表间隔（默认 60000）
//   GPU_MONITOR_QUERY_TIMEOUT_MS 每台机器查询超时（默认 8000）
//   GPU_MONITOR_PROBE_TIMEOUT_MS 探测超时（默认 4000）
import { createServer } from "node:http";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseSshConfig } from "./sshconfig.mjs";
import { probeServer, queryServer } from "./query.mjs";

const PORT = Number(process.env.GPU_MONITOR_PORT || 3499);
const HOST = process.env.GPU_MONITOR_HOST || "127.0.0.1";
const INTERVAL_MS = Number(process.env.GPU_MONITOR_INTERVAL_MS || 3000);
const DISCOVER_MS = Number(process.env.GPU_MONITOR_DISCOVER_INTERVAL_MS || 60000);
const QUERY_TIMEOUT_MS = Number(process.env.GPU_MONITOR_QUERY_TIMEOUT_MS || 8000);
const PROBE_TIMEOUT_MS = Number(process.env.GPU_MONITOR_PROBE_TIMEOUT_MS || 4000);
const SSH_CONFIG = process.env.GPU_MONITOR_SSH_CONFIG || "";
const INCLUDE_LOCAL = (process.env.GPU_MONITOR_INCLUDE_LOCAL ?? "1") !== "0";

/** 同源桥：把状态写入 dsh 前端 dist 目录，浏览器可直接 fetch /gpu-status.json（无 CORS）。 */
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
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, jsonPath);
  } catch (e) {
    if (!jsonWarned) {
      jsonWarned = true;
      log("写入同源 JSON 失败，已禁用:", String(e));
      jsonPath = null;
    }
  }
}

const log = (...a) => console.log(new Date().toISOString(), "[dsh-gpu-monitor-sidecar]", ...a);

let state = { ok: false, at: null, source: "sidecar", servers: [], error: "初始化中…" };
let available = []; // 已探测可用的 server 目标
let running = false;
let lastDiscover = 0;

const keyOf = (t) => (typeof t === "string" ? t : t.alias || t.hostName || t.host || "?");

/** 探测所有候选，合并进 available（保留旧列表中仍可用者，避免瞬时失败误删）。 */
async function discover() {
  const candidates = parseSshConfig(SSH_CONFIG); // 解析失败会抛错 → 上层捕获
  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        return { target: c, ok: await probeServer(c, { timeoutMs: PROBE_TIMEOUT_MS }) };
      } catch {
        return { target: c, ok: false };
      }
    })
  );
  const fresh = new Map();
  for (const r of results) if (r.ok) fresh.set(keyOf(r.target), r.target);
  const merged = new Map(fresh);
  for (const t of available) if (fresh.has(keyOf(t))) merged.set(keyOf(t), t);
  available = [...merged.values()];
  log(`发现 ${available.length} 个可用 GPU server: ${available.map((t) => keyOf(t)).join(", ") || "（无）"}`);
}

/** 周期查询：本机 + 每个 server 并行。 */
async function tick() {
  if (running) return;
  running = true;
  try {
    const jobs = [];
    if (INCLUDE_LOCAL) jobs.push({ target: null, label: "本机" });
    for (const t of available) jobs.push({ target: t, label: keyOf(t) });
    const results = await Promise.all(
      jobs.map(async ({ target, label }) => {
        try {
          return await queryServer(target, { timeoutMs: QUERY_TIMEOUT_MS, label });
        } catch (e) {
          return { host: label, label, ok: false, at: new Date().toISOString(), error: String(e) };
        }
      })
    );
    state = {
      ok: results.some((r) => r.ok),
      at: new Date().toISOString(),
      source: "sidecar",
      servers: results,
    };
    writeJson();
  } catch (e) {
    state = { ok: false, at: new Date().toISOString(), source: "sidecar", servers: [], error: String(e) };
  } finally {
    running = false;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(state));
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, servers: available.map(keyOf), local: INCLUDE_LOCAL, port: PORT }));
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (interval ${INTERVAL_MS}ms, local=${INCLUDE_LOCAL})`);
  if (jsonPath) log(`same-origin JSON 桥: ${jsonPath} → /gpu-status.json`);
});

async function boot() {
  try {
    await discover();
  } catch (e) {
    log("ssh config 解析失败:", String(e));
    available = [];
  }
  await tick();
  lastDiscover = Date.now();
}

boot();
const tickTimer = setInterval(tick, INTERVAL_MS);
const discoverTimer = setInterval(async () => {
  try {
    await discover();
  } catch (e) {
    log("重新探测失败:", String(e));
  }
}, DISCOVER_MS);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("收到", sig, "，退出");
    clearInterval(tickTimer);
    clearInterval(discoverTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
