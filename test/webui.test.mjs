import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { INDEX_HTML, SHIM_JS, CLIENT_JS_PATH } from "../lib/webui.mjs";

test("index.html carries the shim boot sequence", () => {
  assert.ok(INDEX_HTML.includes('<div id="dsh-gpu-monitor-root"></div>'));
  assert.ok(INDEX_HTML.includes("/dsh-shim.js"));
  assert.ok(INDEX_HTML.includes("/plugins/dsh-gpu-monitor/client.js"));
  assert.ok(INDEX_HTML.includes("__DSH_SHIM_BOOT__"));
});

test("standalone page follows system theme (not hardcoded dark)", () => {
  // 不再写死深色：data-gpu-theme 由 client.js 按系统偏好维护
  assert.ok(!INDEX_HTML.includes('data-gpu-theme="dark"'));
  assert.ok(!INDEX_HTML.includes('data-gpu-theme="light"'));
  assert.ok(!INDEX_HTML.includes('color-scheme: dark'));
  // 浅色样式走纯媒体查询，随系统切换
  assert.ok(INDEX_HTML.includes("@media (prefers-color-scheme: light)"));
  assert.ok(INDEX_HTML.includes("color-scheme: light dark"));
});

test("shim script is syntactically valid and defines the expected globals", () => {
  // 语法校验（不执行，避免 DOM 依赖）
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(SHIM_JS));
  assert.ok(SHIM_JS.includes("window.__ModuleLoader__"));
  assert.ok(SHIM_JS.includes("window.__DSH_SHIM_BOOT__"));
  assert.ok(SHIM_JS.includes('spec === "react"'));
});

test("client bundle path resolves to an existing file", () => {
  assert.ok(CLIENT_JS_PATH.endsWith("/lib/client.js"));
  assert.ok(existsSync(CLIENT_JS_PATH), "lib/client.js 应存在");
});
