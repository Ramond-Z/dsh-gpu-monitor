import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("injectTheme 每次都重写 <style>（HMR 换模块后旧样式元素仍留在页面里）", () => {
  // 回归守卫：模块被 HMR 替换后，页面上旧 <style id="dsh-gpu-monitor-style"> 不会被清掉，
  // 若 injectTheme 按 id 命中就 return，新版本的 CSS 永远进不了页面 —— 表现为新 DOM 配旧样式：
  // .gpu-grid 没有 display:flex（GPU 方块塌成一列）、.gpu-sys 没有宽高（CPU/内存细条不可见）。
  const src = readFileSync(CLIENT_JS_PATH, "utf8");
  const start = src.indexOf("function injectTheme()");
  const end = src.indexOf("// —— 渲染 ——");
  assert.ok(start > 0 && end > start, "应能在源码中定位 injectTheme");
  const body = src.slice(start, end);
  assert.ok(!/getElementById\("dsh-gpu-monitor-style"\)[\s\S]{0,40}return/.test(body), "injectTheme 不能按 id 命中就 return");
  assert.ok(/s\.textContent\s*=/.test(body), "injectTheme 必须写入样式内容");
  assert.ok(body.includes(".gpu-grid") && body.includes(".gpu-sys"), "样式里应包含方块网格与 CPU/内存细条规则");
});

test("网格 flex-basis 必须等于「4 个方块一行」的精确宽度", () => {
  // 回归守卫：flex 只在"4 个方块 + 细条"同行放得下时才同行，否则把细条换到下一行；
  // 若 basis 小于 4 个方块的实际宽度，flex 会把网格压窄 → 每行只放得下 3 个方块（曾经如此）。
  // 而方块实际宽度取决于 box-sizing：content-box 下 1px 边框每块多占 2px，算式必须与之一致。
  const src = readFileSync(CLIENT_JS_PATH, "utf8");
  const m = /\.gpu-grid\{[^}]*gap:(\d+)px;flex:1 1 (\d+)px/.exec(src);
  assert.ok(m, "应能在样式中找到 .gpu-grid 的 gap 与 flex-basis");
  const gap = Number(m[1]);
  const basis = Number(m[2]);
  const bw = Number(/box-sizing:border-box;position:relative;width:(\d+)px;height:(\d+)px/.exec(src)?.[1]);
  assert.ok(Number.isFinite(bw), "方块应显式声明 box-sizing:border-box 与宽高");
  assert.equal(basis, bw * 4 + gap * 3, `网格 flex-basis(${basis}) 必须等于 4 块一行宽度(${bw * 4 + gap * 3})`);
  assert.ok(
    /\.gpu-sys-track\{box-sizing:border-box/.test(src),
    "细条轨道也要 border-box，宽度才等于给网格留白时用的那个数"
  );
});
