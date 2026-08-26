import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEngineConfigFromEnv,
  resolveEngineConfigFromCordis,
  ENGINE_DEFAULTS,
  defaultOrderFile,
} from "../lib/config.mjs";

test("config from env: defaults", () => {
  const c = resolveEngineConfigFromEnv({}, "linux");
  assert.equal(c.intervalMs, ENGINE_DEFAULTS.intervalMs);
  assert.equal(c.timeoutMs, ENGINE_DEFAULTS.queryTimeoutMs);
  assert.equal(c.probeTimeoutMs, ENGINE_DEFAULTS.probeTimeoutMs);
  assert.equal(c.discoverIntervalMs, ENGINE_DEFAULTS.discoverIntervalMs);
  assert.equal(c.port, 3499);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.includeLocal, true);
  assert.equal(c.sshConfigPath, "");
  assert.ok(c.orderFile.endsWith("gpu-monitor-order.json"));
});

test("config from env: darwin defaults includeLocal off, env can override", () => {
  assert.equal(resolveEngineConfigFromEnv({}, "darwin").includeLocal, false);
  assert.equal(resolveEngineConfigFromEnv({ GPU_MONITOR_INCLUDE_LOCAL: "1" }, "darwin").includeLocal, true);
  assert.equal(resolveEngineConfigFromEnv({ GPU_MONITOR_INCLUDE_LOCAL: "0" }, "linux").includeLocal, false);
});

test("config from env: overrides", () => {
  const c = resolveEngineConfigFromEnv(
    {
      GPU_MONITOR_INTERVAL_MS: "1500",
      GPU_MONITOR_QUERY_TIMEOUT_MS: "9000",
      GPU_MONITOR_PROBE_TIMEOUT_MS: "2500",
      GPU_MONITOR_DISCOVER_INTERVAL_MS: "120000",
      GPU_MONITOR_PORT: "4000",
      GPU_MONITOR_HOST: "0.0.0.0",
      GPU_MONITOR_SSH_CONFIG: "/tmp/sshcfg",
      GPU_MONITOR_ORDER_FILE: "/tmp/order.json",
      GPU_MONITOR_JSON_PATH: "/tmp/dist/gpu-status.json",
    },
    "linux"
  );
  assert.equal(c.intervalMs, 1500);
  assert.equal(c.timeoutMs, 9000);
  assert.equal(c.probeTimeoutMs, 2500);
  assert.equal(c.discoverIntervalMs, 120000);
  assert.equal(c.port, 4000);
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.sshConfigPath, "/tmp/sshcfg");
  assert.equal(c.orderFile, "/tmp/order.json");
  assert.equal(c.jsonPath, "/tmp/dist/gpu-status.json");
});

test("config from env: Electron port default 0, empty strings fall back", () => {
  const c = resolveEngineConfigFromEnv({ GPU_MONITOR_PORT: "", GPU_MONITOR_INTERVAL_MS: "" }, "linux", {
    portDefault: 0,
  });
  assert.equal(c.port, 0);
  assert.equal(c.intervalMs, ENGINE_DEFAULTS.intervalMs);
});

test("config from cordis: defaults", () => {
  const c = resolveEngineConfigFromCordis({});
  assert.equal(c.intervalMs, ENGINE_DEFAULTS.intervalMs);
  assert.equal(c.timeoutMs, ENGINE_DEFAULTS.queryTimeoutMs);
  assert.equal(c.probeTimeoutMs, ENGINE_DEFAULTS.probeTimeoutMs);
  assert.equal(c.discoverIntervalMs, ENGINE_DEFAULTS.discoverIntervalMs);
  assert.equal(c.sshTarget, "");
  assert.equal(c.useSshConfig, false);
  assert.equal(c.includeLocal, true);
  assert.ok(c.sshConfigPath.length > 0, "默认使用 ~/.ssh/config");
});

test("config from cordis: overrides and coercions", () => {
  const c = resolveEngineConfigFromCordis({
    intervalMs: "2000",
    queryTimeoutMs: 7000,
    probeTimeoutMs: "1500",
    discoverIntervalMs: 30000,
    useSshConfig: "true",
    sshTarget: " user@gpu01 ",
    sshConfigPath: "/x/y",
    includeLocal: false,
  });
  assert.equal(c.intervalMs, 2000);
  assert.equal(c.timeoutMs, 7000);
  assert.equal(c.probeTimeoutMs, 1500);
  assert.equal(c.discoverIntervalMs, 30000);
  assert.equal(c.useSshConfig, true);
  assert.equal(c.sshTarget, "user@gpu01");
  assert.equal(c.sshConfigPath, "/x/y");
  assert.equal(c.includeLocal, false);
});

test("config: default order file path is deterministic", () => {
  assert.match(defaultOrderFile(), /gpu-monitor-order\.json$/);
});
