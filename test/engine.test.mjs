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
