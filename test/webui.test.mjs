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
  // 浅色覆盖必须出现在基础（深色）规则之后：同特异性下后写的规则胜出，
  // 否则浅色模式下 meta/refresh 仍会显示深色的浅灰/白色文字
  const lightIdx = INDEX_HTML.indexOf("@media (prefers-color-scheme: light)");
  assert.ok(lightIdx > INDEX_HTML.indexOf(".app-bar .refresh:hover"), "浅色媒体查询应位于基础深色规则之后");
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
