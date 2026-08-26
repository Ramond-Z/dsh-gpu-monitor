import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitorEngine } from "../lib/engine.mjs";
import { createMonitorServer, makeStateHandler, makeSettingsHandler } from "../lib/server.mjs";

const mkServer = (id, ok = true) => ({ host: id, label: id, ok, at: new Date().toISOString(), gpus: [] });

test("makeStateHandler serves the same wire shape as engine.getState", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => [mkServer("local"), mkServer("gpu01")],
  });
  await engine.tick();
  // 通过 node:http 的 ServerResponse 桩调用（宿主插件也用同一个处理器）
  let body = null;
  let status = 0;
  const res = {
    writeHead: (s) => (status = s),
    end: (b) => (body = JSON.parse(b)),
  };
  makeStateHandler(engine)(null, res);
  assert.equal(status, 200);
  assert.deepEqual(body.servers.map((s) => s.host), ["local", "gpu01"]);
  assert.deepEqual(body.order, engine.getState().order);
  engine.stop();
});

test("monitor server serves status, UI and order over HTTP", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => [mkServer("local"), mkServer("gpu01"), mkServer("gpu02")],
  });
  await engine.tick();
  const srv = await createMonitorServer({ engine, port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    // 状态
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.servers.length, 3);
    assert.equal(status.source, "engine");
    assert.deepEqual(status.order.o, ["local", "gpu01", "gpu02"]);
    // 同源桥 / 宿主兼容路径
    const bridge = await (await fetch(`${base}/gpu-status.json`)).json();
    assert.equal(bridge.servers.length, 3);
    const hostLike = await (await fetch(`${base}/gpu/status`)).json();
    assert.equal(hostLike.servers.length, 3);
    // 独立网页 UI
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes("dsh-gpu-monitor-root"));
    assert.ok(html.includes("status-dot"));
    const shim = await (await fetch(`${base}/dsh-shim.js`)).text();
    assert.ok(shim.includes("__DSH_SHIM_BOOT__"));
    const client = await (await fetch(`${base}/plugins/dsh-gpu-monitor/client.js`)).text();
    assert.ok(client.includes("__ModuleLoader__"));
    // POST /order → 立即反映到 /status
    const r = await fetch(`${base}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ o: ["gpu02", "local"], t: 5 }),
    });
    const j = await r.json();
    // 提交的顺序被调和：未提及的机器追加到末尾
    assert.deepEqual(j.order.o, ["gpu02", "local", "gpu01"]);
    const after = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(after.order.o, ["gpu02", "local", "gpu01"]);
    assert.equal(after.order.t, 5);
    // 非法 body → 400
    const bad = await fetch(`${base}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: 1 }),
    });
    assert.equal(bad.status, 400);
    // 手动刷新：POST /refresh 触发一次查询并返回新状态
    const rf = await fetch(`${base}/refresh`, { method: "POST" });
    const rfState = await rf.json();
    assert.equal(rfState.servers.length, 3);
    assert.ok(rfState.at);
    // /health 上报实际监听端口（port=0 随机时不得报 0）
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.port, srv.port);
    assert.ok(health.port > 0);
  } finally {
    await srv.close();
    engine.stop();
  }
});

test("monitor server serves settings over HTTP (GET + POST)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-server-"));
  try {
    const engine = createMonitorEngine({
      useSshConfig: false,
      includeLocal: true,
      settingsFile: join(dir, "settings.json"),
      query: async () => [mkServer("local"), mkServer("gpu01")],
    });
    await engine.tick();
    const srv = await createMonitorServer({ engine, port: 0 });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // GET：生效设置 + 候选 server（单机模式候选为空）
      const g = await (await fetch(`${base}/settings`)).json();
      assert.equal(g.ok, true);
      assert.equal(g.settings.intervalMs, 3000);
      assert.equal(g.settings.useSshConfig, false);
      assert.deepEqual(g.candidates, []);
      // POST：应用补丁并立即反映到 GET
      const p = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMs: 1500, timeoutMs: 9000, includeLocal: false }),
      });
      const pj = await p.json();
      assert.equal(pj.ok, true);
      assert.equal(pj.settings.intervalMs, 1500);
      const g2 = await (await fetch(`${base}/settings`)).json();
      assert.equal(g2.settings.timeoutMs, 9000);
      assert.equal(g2.settings.includeLocal, false);
      // 非法补丁 → 400 且不改动
      const bad = await fetch(`${base}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intervalMs: 1 }),
      });
      assert.equal(bad.status, 400);
      const g3 = await (await fetch(`${base}/settings`)).json();
      assert.equal(g3.settings.intervalMs, 1500, "非法补丁不应改动现有设置");
    } finally {
      await srv.close();
      engine.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeSettingsHandler serves settings via the same handler shape the host plugin registers", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => [mkServer("local")],
  });
  await engine.tick();
  let body = null;
  let status = 0;
  const res = {
    writeHead: (s) => (status = s),
    end: (b) => (body = JSON.parse(b)),
  };
  // GET 路径（req.method 非 POST）
  await makeSettingsHandler(engine)({ method: "GET" }, res);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.settings.includeLocal, true);
  assert.ok(Array.isArray(body.candidates));
  engine.stop();
});
