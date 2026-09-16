import { test } from "node:test";
import assert from "node:assert/strict";
import { targetArgs, remoteSshPrefix, closeSshConnections } from "../lib/query.mjs";

/** 从 ssh 参数数组中取某个 -o 选项的值（格式 ["-o", "Name=value", ...]）。 */
function optOf(args, name) {
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === "-o" && args[k + 1].startsWith(`${name}=`)) {
      return args[k + 1].slice(name.length + 1);
    }
  }
  return undefined;
}

test("targetArgs: null/empty means local", () => {
  assert.equal(targetArgs(null), null);
  assert.equal(targetArgs(""), null);
  assert.equal(targetArgs(undefined), null);
});

test("targetArgs: plain string passes through", () => {
  assert.deepEqual(targetArgs("user@gpu01"), { ssh: ["user@gpu01"] });
});

test("targetArgs: object with default port omits -p", () => {
  const t = targetArgs({ alias: "gpu01", hostName: "10.1.1.1", user: "zhoucz", port: 22, identityFiles: [] });
  assert.deepEqual(t, { ssh: ["zhoucz@10.1.1.1"] });
});

test("targetArgs: object with non-default port and identity files", () => {
  const t = targetArgs({
    alias: "gpu01",
    hostName: "10.1.1.1",
    user: "zhoucz",
    port: 2222,
    identityFiles: ["/home/u/.ssh/id_ed25519", "/home/u/.ssh/id_rsa"],
  });
  assert.deepEqual(t, {
    ssh: ["-p", "2222", "-i", "/home/u/.ssh/id_ed25519", "-i", "/home/u/.ssh/id_rsa", "zhoucz@10.1.1.1"],
  });
});

test("targetArgs: host already containing @ wins over user", () => {
  const t = targetArgs({ alias: "g", hostName: "root@10.1.1.1", user: "zhoucz", port: 22 });
  assert.deepEqual(t, { ssh: ["root@10.1.1.1"] });
});

test("targetArgs: object without host returns null", () => {
  assert.equal(targetArgs({ alias: "", hostName: "", user: "u" }), null);
  assert.equal(targetArgs({}), null);
});

// —— SSH 连接复用（ControlMaster/ControlPersist）——

test("remoteSshPrefix: local target returns null", () => {
  assert.equal(remoteSshPrefix(null), null);
  assert.equal(remoteSshPrefix(""), null);
});

test("remoteSshPrefix: remote includes persistent-master options and stable per-target socket", () => {
  const a = remoteSshPrefix("user@gpu01");
  assert.ok(a.includes("ControlMaster=auto"));
  assert.ok(Number(optOf(a, "ControlPersist")) > 0);
  const sockA = optOf(a, "ControlPath");
  assert.ok(sockA.endsWith(".sock"));
  // 同一目标重复组装 → 同一控制 socket（复用同一条常驻连接）
  assert.equal(optOf(remoteSshPrefix("user@gpu01"), "ControlPath"), sockA);
  // 不同目标 → 不同 socket
  assert.notEqual(optOf(remoteSshPrefix("user@gpu02"), "ControlPath"), sockA);
  // 目标参数保留在末尾（后面仍会追加要执行的命令）
  assert.equal(a[a.length - 1], "user@gpu01");
});

test("remoteSshPrefix: config-object target reuses same socket across port/identity variants of same host", () => {
  const t1 = { alias: "g1", hostName: "10.1.1.1", user: "zhoucz", port: 22, identityFiles: [] };
  const t2 = { alias: "g1b", hostName: "10.1.1.1", user: "zhoucz", port: 22, identityFiles: ["/home/u/.ssh/id_ed25519"] };
  assert.equal(optOf(remoteSshPrefix(t1), "ControlPath"), optOf(remoteSshPrefix(t2), "ControlPath"));
  const t3 = { alias: "g2", hostName: "10.1.1.2", user: "zhoucz", port: 22, identityFiles: [] };
  assert.notEqual(optOf(remoteSshPrefix(t1), "ControlPath"), optOf(remoteSshPrefix(t3), "ControlPath"));
});

test("remoteSshPrefix: GPU_MONITOR_SSH_CONTROL_PERSIST=0 disables multiplexing", () => {
  const prev = process.env.GPU_MONITOR_SSH_CONTROL_PERSIST;
  try {
    process.env.GPU_MONITOR_SSH_CONTROL_PERSIST = "0";
    const a = remoteSshPrefix("user@gpu01");
    assert.equal(optOf(a, "ControlMaster"), undefined);
    assert.equal(optOf(a, "ControlPath"), undefined);
  } finally {
    if (prev === undefined) delete process.env.GPU_MONITOR_SSH_CONTROL_PERSIST;
    else process.env.GPU_MONITOR_SSH_CONTROL_PERSIST = prev;
  }
});

test("closeSshConnections: safe for registered fake targets (no throw, no hang)", async () => {
  // 前面用例注册的控制 socket 并不存在对应 master：ssh -O exit 会立即失败退出，
  // 只验证清理逻辑不抛错、不悬挂（真实 master 的关闭见引擎 stop 集成路径）。
  closeSshConnections();
  await new Promise((r) => setTimeout(r, 50));
});
