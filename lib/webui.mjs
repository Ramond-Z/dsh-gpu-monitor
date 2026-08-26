// dsh-gpu-monitor: 独立网页资源（index.html + DSH 兼容 shim）。
// 让 sidecar 在任何机器（如 MacBook）上直接提供完整 UI：浏览器打开 http://127.0.0.1:3499
// 即可监控 ~/.ssh/config 中所有可用 GPU server，无需 DSH 外壳。
// lib/client.js 通过 shim 以原样运行（同一份代码，零重复维护）。

/** 页面骨架。 */
export const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPU 监控</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body { background: #17171a; color: #e4e4e7; font: 13px/1.5 system-ui, -apple-system, sans-serif; }
    #dsh-gpu-monitor-root { height: 100vh; display: flex; flex-direction: column; min-height: 0; }
  </style>
</head>
<body>
  <div id="dsh-gpu-monitor-root"></div>
  <script src="/dsh-shim.js"></script>
  <script src="/plugins/dsh-gpu-monitor/client.js"></script>
  <script>window.__DSH_SHIM_BOOT__ && window.__DSH_SHIM_BOOT__();</script>
</body>
</html>
`;

/** DSH 兼容 shim：模拟 __ModuleLoader__ / React / slots，把 client.js 挂进 #dsh-gpu-monitor-root。 */
export const SHIM_JS = `// dsh-gpu-monitor 独立运行 shim：在无 DSH 的页面里模拟 __ModuleLoader__/React/slots，
// 让 lib/client.js 原样以独立网页程序运行（如 MacBook 上 ssh 到 GPU server 监控）。
(function () {
  "use strict";
  var factories = new Map();
  var pendingEffect = null;

  window.__ModuleLoader__ = {
    load: function (def) { factories.set(def.id, def.factory); },
  };

  // 最小 React stub：client.js 只用 useRef/useEffect/createElement（GpuSection 挂载点）
  var ReactStub = {
    useRef: function (init) { return { current: init === undefined ? null : init }; },
    useEffect: function (cb) { pendingEffect = cb; },
    createElement: function (type, props) {
      var n = document.createElement(type);
      if (props) for (var k in props) {
        if (k === "ref") { props.ref.current = n; continue; }
        if (k === "className") { n.className = props[k]; continue; }
        if (typeof props[k] === "function") continue;
        n[k] = props[k];
      }
      return n;
    },
  };

  var require = function (spec) {
    if (spec === "react") return ReactStub;
    throw new Error("dsh-shim: 未知模块 " + spec);
  };

  window.__DSH_SHIM_BOOT__ = function () {
    var root = document.getElementById("dsh-gpu-monitor-root");
    if (!root) throw new Error("缺少 #dsh-gpu-monitor-root");
    var def = factories.get("dsh-gpu-monitor");
    if (!def) throw new Error("dsh-gpu-monitor 客户端未加载");
    var mod = def(require);
    var ctx = {
      slots: {
        inject: function (name, fn) { fn(); },
        register: function (opts, Component) {
          var host = document.createElement("div");
          host.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";
          root.appendChild(host);
          pendingEffect = null;
          var node = Component({ wide: true });
          if (node) host.appendChild(node);
          if (pendingEffect) pendingEffect(); // 等效 React effect：buildMonitorInto + 首轮渲染
          return { dispose: function () { host.remove(); } };
        },
      },
    };
    mod.apply(ctx);
  };
})();
`;

/** lib/client.js 的绝对路径（sidecar 同目录）。 */
export const CLIENT_JS_PATH = new URL("./client.js", import.meta.url).pathname;
