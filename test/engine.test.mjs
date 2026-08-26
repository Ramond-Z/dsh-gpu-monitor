import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
