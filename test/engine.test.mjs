import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitorEngine } from "../lib/engine.mjs";
const mkServer = (id, ok = true) => ({ host: id, label: id, ok, at: new Date().toISOString(), gpus: [] });

test("engine produces unified servers-shape state with arrival order", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => [mkServer("local", true), mkServer("gpu01"), mkServer("gpu02")],
  });
  await engine.tick();
  const st = engine.getState();
  assert.equal(st.ok, true);
  assert.equal(st.servers.length, 3);
  assert.deepEqual(st.order.o, ["local", "gpu01", "gpu02"]);
  engine.stop();
});

test("engine setOrder reconciles, persists and reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  try {
    const orderFile = join(dir, "order.json");
    const make = () =>
      createMonitorEngine({
        useSshConfig: false,
        includeLocal: true,
        orderFile,
        query: async () => [mkServer("local"), mkServer("a"), mkServer("b")],
      });
    const engine = make();
    await engine.tick();
    // 新顺序 + 未知 id 被调和剔除，新机器追加
    const next = engine.setOrder(["b", "local", "ghost", "a"], 1000);
    assert.deepEqual(next.o, ["b", "local", "a"]);
    assert.equal(next.t, 1000);
    // 旧时间戳拒绝
    assert.equal(engine.setOrder(["local", "a", "b"], 500) === null, false);
    assert.deepEqual(engine.getState().order.o, ["b", "local", "a"]);
    engine.stop();
    // 重启后从文件恢复
    const reloaded = make();
    await reloaded.tick();
    assert.equal(reloaded.getState().order.t, 1000);
    assert.deepEqual(reloaded.getState().order.o, ["b", "local", "a"]);
    reloaded.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine tick failure keeps last state and marks error", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    query: async () => {
      throw new Error("boom");
    },
  });
  await engine.tick();
  const st = engine.getState();
  assert.equal(st.ok, false);
  assert.ok(st.error.includes("boom"));
  engine.stop();
});

test("engine onUpdate fires on tick and setOrder", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    query: async () => [mkServer("local")],
  });
  let calls = 0;
  engine.onUpdate(() => calls++);
  await engine.tick();
  engine.setOrder(["local"], 1);
  assert.equal(calls, 2);
  engine.stop();
});

test("engine legacy single-target mode via sshTarget string", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    sshTarget: "user@gpu01",
    query: async ({ sshTarget }) => [mkServer(sshTarget)],
  });
  await engine.tick();
  const st = engine.getState();
  assert.equal(st.servers.length, 1);
  assert.equal(st.servers[0].host, "user@gpu01");
  engine.stop();
});

test("engine refresh returns the fresh snapshot after a completed query", async () => {
  let n = 0;
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => {
      n++;
      await new Promise((r) => setTimeout(r, 20));
      return [mkServer(`local-${n}`)];
    },
  });
  await engine.tick();
  const before = engine.getState().servers[0].host;
  const st = await engine.refresh();
  assert.equal(st.servers[0].host, `local-${n}`);
  assert.notEqual(st.servers[0].host, before, "refresh 应返回新查询结果");
  engine.stop();
});

test("engine refresh queues a re-tick while a query is running", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const engine = createMonitorEngine({
    useSshConfig: false,
    query: async () => {
      calls++;
      await gate; // 第一次查询卡住，模拟慢查询
      return [mkServer("local")];
    },
  });
  const p1 = engine.tick(); // 不 await：让查询卡在 gate 上
  while (calls < 1) await new Promise((r) => setTimeout(r, 5));
  const p2 = engine.refresh(); // 查询进行中 → 应排队一次补查
  release();
  await p1;
  const st = await p2;
  assert.equal(st.ok, true);
  assert.equal(calls, 2, "refresh 应触发一次补查");
  engine.stop();
});

test("engine keeps servers across transient discovery failures, removes after repeated fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  try {
    const cfg = join(dir, "sshconfig");
    writeFileSync(cfg, "Host g1\n  HostName 10.0.0.1\n  User u\nHost g2\n  HostName 10.0.0.2\n  User u\n");
    let failAll = false;
    const engine = createMonitorEngine({
      useSshConfig: true,
      sshConfigPath: cfg,
      includeLocal: false,
      probe: async () => (failAll ? { ok: false, error: "boom" } : { ok: true, error: "" }),
      query: async ({ servers }) => servers.map((t) => ({ host: t.alias, label: t.alias, ok: true, gpus: [] })),
    });
    await engine.discover();
    assert.equal(engine.listServers().length, 2);
    failAll = true;
    await engine.discover(); // 第 1 次全失败：保留
    assert.equal(engine.listServers().length, 2, "一次瞬时失败不应清空列表");
    await engine.discover(); // 第 2 次连续全失败：移除
    assert.equal(engine.listServers().length, 0);
    await engine.tick(); // tick 把诊断信息写入 state
    assert.ok(engine.getState().message.includes("均不可达"), "无 server 时应给出诊断信息");
    failAll = false;
    await engine.discover(); // 恢复后可重新发现
    assert.equal(engine.listServers().length, 2);
    engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine setSettings updates effective settings, applies immediately and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  try {
    const seen = [];
    const engine = createMonitorEngine({
      useSshConfig: false,
      includeLocal: true,
      settingsFile: join(dir, "settings.json"),
      query: async (ctx) => {
        seen.push({ includeLocal: ctx.includeLocal, timeoutMs: ctx.timeoutMs });
        return [mkServer("local")];
      },
    });
    await engine.tick();
    assert.equal(seen[0].timeoutMs, 8000);
    const out = engine.setSettings({ intervalMs: 1500, timeoutMs: 9000, includeLocal: false });
    assert.equal(out.settings.intervalMs, 1500);
    assert.equal(out.settings.timeoutMs, 9000);
    assert.equal(out.settings.includeLocal, false);
    assert.equal(out.settings.enabledServers, null);
    // setSettings 已触发查询链；refresh() 等它完成后返回，保证读到新设置下的查询
    await engine.refresh();
    const last = seen[seen.length - 1];
    assert.equal(last.timeoutMs, 9000);
    assert.equal(last.includeLocal, false);
    // 重启后从文件恢复（文件优先于启动配置）
    const reloaded = createMonitorEngine({
      useSshConfig: false,
      includeLocal: true,
      intervalMs: 5000,
      settingsFile: join(dir, "settings.json"),
      query: async () => [mkServer("local")],
    });
    const gs = reloaded.getSettings();
    assert.equal(gs.intervalMs, 1500, "设置文件里的键优先于启动配置");
    assert.equal(gs.timeoutMs, 9000);
    assert.equal(gs.includeLocal, false);
    reloaded.stop();
    engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine setSettings rejects invalid values without changing anything", async () => {
  const engine = createMonitorEngine({
    useSshConfig: false,
    includeLocal: true,
    query: async () => [mkServer("local")],
  });
  await engine.tick();
  assert.throws(() => engine.setSettings({ intervalMs: 1 }), /intervalMs/);
  assert.throws(() => engine.setSettings({ includeLocal: "x" }), /includeLocal/);
  assert.equal(engine.getSettings().intervalMs, 3000, "非法补丁不应改动现有设置");
  engine.stop();
});

test("engine enabledServers filters which servers are queried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  try {
    const cfg = join(dir, "sshconfig");
    writeFileSync(cfg, "Host g1\n  HostName 10.0.0.1\n  User u\nHost g2\n  HostName 10.0.0.2\n  User u\n");
    const queried = [];
    const engine = createMonitorEngine({
      useSshConfig: true,
      sshConfigPath: cfg,
      includeLocal: false,
      probe: async () => ({ ok: true, error: "" }),
      query: async ({ servers }) => {
        queried.push(servers.map((s) => s.alias));
        return servers.map((t) => ({ host: t.alias, label: t.alias, ok: true, gpus: [] }));
      },
    });
    await engine.discover();
    await engine.tick();
    assert.deepEqual(queried.at(-1), ["g1", "g2"], "默认全部启用");
    // 只启用 g1
    engine.setSettings({ enabledServers: ["g1"] });
    await engine.tick();
    assert.deepEqual(queried.at(-1), ["g1"], "只查询选中的 server");
    // 空数组 = 一个都不查
    engine.setSettings({ enabledServers: [] });
    await engine.tick();
    assert.deepEqual(queried.at(-1), [], "空选取 = 不查询任何 server");
    // 候选列表仍包含全部（含 enabled 标记）
    const cands = engine.serverCandidates();
    assert.deepEqual(cands.map((c) => c.id), ["g1", "g2"]);
    assert.deepEqual(cands.map((c) => c.enabled), [false, false]);
    // 恢复 null = 全部
    engine.setSettings({ enabledServers: null });
    await engine.tick();
    assert.deepEqual(queried.at(-1), ["g1", "g2"]);
    engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine serverCandidates reports reachability from probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-engine-"));
  try {
    const cfg = join(dir, "sshconfig");
    writeFileSync(cfg, "Host g1\n  HostName 10.0.0.1\n  User u\nHost g2\n  HostName 10.0.0.2\n  User u\n");
    const engine = createMonitorEngine({
      useSshConfig: true,
      sshConfigPath: cfg,
      includeLocal: false,
      probe: async (t) => (t.alias === "g1" ? { ok: true, error: "" } : { ok: false, error: "ssh: 拒绝连接" }),
      query: async ({ servers }) => servers.map((t) => ({ host: t.alias, label: t.alias, ok: true, gpus: [] })),
    });
    await engine.discover();
    const cands = engine.serverCandidates();
    assert.deepEqual(cands.map((c) => c.id), ["g1", "g2"]);
    assert.equal(cands[0].ok, true);
    assert.equal(cands[1].ok, false);
    assert.match(cands[1].error, /拒绝连接/);
    assert.deepEqual(cands.map((c) => c.enabled), [true, true]);
    engine.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
