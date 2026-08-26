import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeSettings, SettingsStore, defaultSettingsFile, SETTINGS_KEYS } from "../lib/settings.mjs";

test("settings: sanitize accepts a full valid patch and ignores unknown keys", () => {
  const clean = sanitizeSettings({
    intervalMs: 2000,
    timeoutMs: 9000,
    probeTimeoutMs: 2500,
    discoverIntervalMs: 120000,
    includeLocal: false,
    sshConfigPath: "  /tmp/cfg  ",
    enabledServers: ["gpu01", "gpu01", "gpu02", ""],
    useSshConfig: true, // 未知键：忽略（引擎内部只读字段）
    foo: 1,
  });
  assert.deepEqual(clean, {
    intervalMs: 2000,
    timeoutMs: 9000,
    probeTimeoutMs: 2500,
    discoverIntervalMs: 120000,
    includeLocal: false,
    sshConfigPath: "/tmp/cfg", // trim
    enabledServers: ["gpu01", "gpu02"], // 去重 + 过滤空串
  });
});

test("settings: sanitize rejects out-of-range numbers and bad types", () => {
  assert.throws(() => sanitizeSettings({ intervalMs: 10 }), /intervalMs/);
  assert.throws(() => sanitizeSettings({ intervalMs: 1e9 }), /intervalMs/);
  assert.throws(() => sanitizeSettings({ intervalMs: "abc" }), /intervalMs/);
  assert.throws(() => sanitizeSettings({ timeoutMs: 100 }), /timeoutMs/);
  assert.throws(() => sanitizeSettings({ includeLocal: "yes" }), /includeLocal/);
  assert.throws(() => sanitizeSettings({ sshConfigPath: 5 }), /sshConfigPath/);
  assert.throws(() => sanitizeSettings({ enabledServers: "gpu01" }), /enabledServers/);
  assert.throws(() => sanitizeSettings(null), /设置必须是对象/);
});

test("settings: sanitize accepts enabledServers null (= all) and empty array (= none)", () => {
  assert.equal(sanitizeSettings({ enabledServers: null }).enabledServers, null);
  assert.deepEqual(sanitizeSettings({ enabledServers: [] }).enabledServers, []);
});

test("settings: store persists, merges and reloads atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-settings-"));
  try {
    const file = join(dir, "settings.json");
    const store = new SettingsStore(file);
    store.set({ intervalMs: 2000 });
    store.set({ timeoutMs: 9000, includeLocal: false });
    assert.deepEqual(store.get(), { intervalMs: 2000, timeoutMs: 9000, includeLocal: false });
    // 重新加载：文件内容恢复
    const reloaded = new SettingsStore(file);
    assert.deepEqual(reloaded.get(), { intervalMs: 2000, timeoutMs: 9000, includeLocal: false });
    // 文件是合法 JSON（原子写盘）
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { intervalMs: 2000, timeoutMs: 9000, includeLocal: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings: store tolerates a corrupt file and memory mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-settings-"));
  try {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    const store = new SettingsStore(file);
    assert.deepEqual(store.get(), {});
    // 仅内存：不写盘也不报错
    const mem = new SettingsStore("");
    mem.set({ intervalMs: 1111 });
    assert.deepEqual(mem.get(), { intervalMs: 1111 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings: default file path is deterministic and key list is complete", () => {
  assert.match(defaultSettingsFile(), /gpu-monitor-settings\.json$/);
  assert.deepEqual(
    [...SETTINGS_KEYS].sort(),
    [
      "discoverIntervalMs",
      "enabledServers",
      "includeLocal",
      "intervalMs",
      "probeTimeoutMs",
      "sshConfigPath",
      "timeoutMs",
    ]
  );
});
