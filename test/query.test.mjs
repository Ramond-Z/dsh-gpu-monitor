import { test } from "node:test";
import assert from "node:assert/strict";
import { targetArgs } from "../lib/query.mjs";

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
