import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSshConfigText, parseSshConfig } from "../lib/sshconfig.mjs";

test("parses hosts with hostname/user/port", () => {
  const text = [
    "Host 5090",
    "  HostName 222.29.51.42",
    "  User zhoucz",
    "Host 2080",
    "  HostName 222.29.51.191",
    "  User zhoucz",
    "  Port 2222",
  ].join("\n");
  const hosts = [...parseSshConfigText(text).values()];
  assert.equal(hosts.length, 2);
  const [a, b] = hosts;
  assert.equal(a.alias, "5090");
  assert.equal(a.hostName, "222.29.51.42");
  assert.equal(a.user, "zhoucz");
  assert.equal(a.port, null); // 文本层保持原始值；parseSshConfig 才补默认 22
  assert.equal(b.alias, "2080");
  assert.equal(b.port, 2222);
});

test("handles multiple patterns, comments, and empty lines", () => {
  const text = [
    "# comment",
    "",
    "Host a b   # inline comment",
    "  User alice",
    "  HostName 10.0.0.1",
  ].join("\n");
  const hosts = [...parseSshConfigText(text).values()];
  assert.equal(hosts.length, 2);
  for (const h of hosts) {
    assert.equal(h.user, "alice");
    assert.equal(h.hostName, "10.0.0.1");
  }
});

test("Host * block acts as defaults; later explicit hosts inherit", () => {
  const text = [
    "Host *",
    "  User defaultuser",
    "  IdentityFile ~/.ssh/id_ed25519",
    "Host gpu01",
    "  HostName 10.1.1.1",
  ].join("\n");
  const hosts = [...parseSshConfigText(text).values()];
  assert.equal(hosts.length, 1);
  const h = hosts[0];
  assert.equal(h.alias, "gpu01");
  assert.equal(h.user, "defaultuser");
  assert.equal(h.identityFiles.length, 1);
  assert.ok(h.identityFiles[0].endsWith("id_ed25519"));
  assert.ok(h.identityFiles[0].startsWith("/"));
});

test("explicit option overrides Host * default (first-wins)", () => {
  const text = [
    "Host *",
    "  User defaultuser",
    "Host gpu01",
    "  HostName 10.1.1.1",
    "  User zhoucz",
  ].join("\n");
  const h = [...parseSshConfigText(text).values()][0];
  assert.equal(h.user, "zhoucz");
});

test("Include expands relative files and skips missing ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-sshcfg-"));
  try {
    mkdirSync(join(dir, "conf.d"));
    writeFileSync(join(dir, "conf.d", "a.conf"), "Host inc1\n  HostName 10.0.0.9\n  User u1\n");
    writeFileSync(join(dir, "conf.d", "b.conf"), "Host inc2\n  HostName 10.0.0.10\n");
    const text = [
      "Host main",
      "  HostName 10.0.0.1",
      "Include conf.d/*.conf",
      "Include missing.conf",
    ].join("\n");
    const hosts = [...parseSshConfigText(text, dir).values()];
    const aliases = hosts.map((h) => h.alias).sort();
    assert.deepEqual(aliases, ["inc1", "inc2", "main"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wildcard patterns are skipped as candidates", () => {
  const text = ["Host web*", "  HostName 10.0.0.2", "Host gpu02", "  HostName 10.0.0.3"].join("\n");
  const hosts = [...parseSshConfigText(text).values()];
  assert.deepEqual(hosts.map((h) => h.alias), ["gpu02"]);
});

test("parseSshConfig falls back to env override path", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-sshcfg-env-"));
  try {
    const p = join(dir, "config");
    writeFileSync(p, "Host gpu03\n  HostName 10.0.0.4\n");
    const old = process.env.GPU_MONITOR_SSH_CONFIG;
    process.env.GPU_MONITOR_SSH_CONFIG = p;
    try {
      const hosts = parseSshConfig();
      assert.equal(hosts.length, 1);
      assert.equal(hosts[0].alias, "gpu03");
      assert.equal(hosts[0].port, 22); // 归一化默认端口
      assert.equal(hosts[0].hostName, "10.0.0.4");
    } finally {
      if (old === undefined) delete process.env.GPU_MONITOR_SSH_CONFIG;
      else process.env.GPU_MONITOR_SSH_CONFIG = old;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
