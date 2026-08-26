// dsh-gpu-monitor: 可复用 HTTP 传输层 —— CLI sidecar 与 Electron 原生应用共用。
// 路由：状态 /status、/gpu-status.json、/gpu/status；顺序 POST /order；独立网页 UI（/、/dsh-shim.js、client.js）。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { INDEX_HTML, SHIM_JS, CLIENT_JS_PATH } from "./webui.mjs";

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

/**
 * 启动监控 HTTP 服务。
 * @param {object} opts
 * @param {object} opts.engine 共享监控引擎（lib/engine.mjs）
 * @param {string} [opts.host] 监听地址（默认 127.0.0.1）
 * @param {number} [opts.port] 监听端口（默认 0 = 随机）
 * @param {boolean} [opts.serveUi] 是否提供独立网页 UI（默认 true）
 * @param {(...a: any[]) => void} [opts.log]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function createMonitorServer(opts = {}) {
  const { engine, host = "127.0.0.1", port = 0, serveUi = true, log = () => {} } = opts;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    // —— 独立网页 UI（MacBook / Electron / 无 DSH 环境） ——
    if (serveUi && (req.method === "GET" || req.method === "HEAD")) {
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
      json(res, 200, { ok: true, servers: engine.listServers(), port });
      return;
    }
    res.writeHead(404, CORS_HEADERS);
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
