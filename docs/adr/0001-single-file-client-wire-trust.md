# 浏览器客户端保持单文件，跨运行时规则"引擎为权威、客户端信任线上"

`lib/client.js` 是浏览器端唯一的文件：DSH 宿主经 `__ModuleLoader__`、独立网页/Electron 经 `lib/webui.mjs` 的 shim 原样加载它，两条加载路径都只支持单文件（shim 的 `require` 仅解析 `react`）。因此客户端不与 Node 侧共享代码；重复的领域规则（分组顺序的调和与时间戳仲裁，见 CONTEXT.md 的"顺序协议"）不抽共享模块，而由引擎（`serveOrder`）作为唯一权威、客户端直接信任引擎下发的 `order`，仅在 sidecar 离线时用本地缓存兜底。若将来加载机制支持多文件，可把调和规则抽为共享纯模块，届时再取代本决策。
