// dsh-gpu-monitor: 独立网页资源（index.html + DSH 兼容 shim）。
// 让 sidecar 在任何机器（如 MacBook）上直接提供完整 UI：浏览器打开 http://127.0.0.1:3499
// 即可监控 ~/.ssh/config 中所有可用 GPU server，无需 DSH 外壳。
// lib/client.js 通过 shim 以原样运行（同一份代码，零重复维护）。

/** 页面骨架（顶栏状态条；data-gpu-theme=dark 强制深色；data-gpu-mode=app 占满窗口、无高度把手）。 */
export const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-gpu-theme="dark" data-gpu-mode="app" style="color-scheme: dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPU 监控</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body {
      background: radial-gradient(1100px 700px at 75% -10%, #1b2233 0%, #0f1116 55%) fixed, #0f1116;
      color: #dbe0ea;
      font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      display: flex; flex-direction: column; min-height: 0;
    }
    /* 若有人去掉 data-gpu-theme=dark，页面随系统切换为浅色，保持与组件一致 */
    @media (prefers-color-scheme: light) {
      html:not([data-gpu-theme="dark"]) body {
        background: radial-gradient(1100px 700px at 75% -10%, #ffffff 0%, #eef0f5 55%) fixed, #eef0f5;
        color: #23272f;
      }
      html:not([data-gpu-theme="dark"]) .app-bar { border-bottom-color: rgba(0,0,0,.08); }
      html:not([data-gpu-theme="dark"]) .app-bar .meta { color: rgba(35,39,47,.55); }
    }
    .app-bar {
      flex: none; display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.06);
      -webkit-user-select: none; user-select: none;
    }
    .app-bar .meta { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                     white-space: nowrap; font-size: 12px; color: rgba(219,224,234,.55); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #4b5563; flex: none;
           box-shadow: 0 0 0 3px rgba(75,85,99,.18); transition: background .3s, box-shadow .3s; }
    .dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18), 0 0 10px rgba(34,197,94,.6); }
    .dot.off { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }
    #dsh-gpu-monitor-root { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 0 14px; }
  </style>
</head>
<body>
  <header class="app-bar">
    <span class="dot" id="status-dot"></span>
    <span class="meta" id="status-meta">连接中…</span>
  </header>
  <div id="dsh-gpu-monitor-root"></div>
  <script src="/dsh-shim.js"></script>
  <script src="/plugins/dsh-gpu-monitor/client.js"></script>
  <script>
    window.__DSH_SHIM_BOOT__ && window.__DSH_SHIM_BOOT__();
    // 顶栏状态：机器/GPU 数量与更新时间
    (function () {
      var dot = document.getElementById("status-dot");
      var meta = document.getElementById("status-meta");
      function refresh() {
        fetch("/gpu-status.json", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var servers = Array.isArray(j.servers) ? j.servers : [];
            var gpus = servers.reduce(function (n, s) { return n + (s.gpus ? s.gpus.length : 0); }, 0);
            dot.className = "dot " + (j.ok ? "on" : "off");
            meta.textContent = j.ok
              ? (servers.length + " 台机器 · " + gpus + " 张 GPU · " + new Date(j.at).toLocaleTimeString())
              : "连接失败";
          })
          .catch(function () { dot.className = "dot off"; meta.textContent = "连接失败"; });
      }
      refresh();
      setInterval(refresh, 3000);
    })();
  </script>
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
