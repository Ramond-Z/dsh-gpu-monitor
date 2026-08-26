// dsh-gpu-monitor: 面板窗口 preload（sandboxed CJS）——把进程信息悬浮框桥接给主进程。
// 悬浮框在独立透明置顶小窗里渲染（见 main.mjs 的 showTipWindow），可以伸出面板窗口范围；
// 面板窗口内的 DOM 会被窗口边界裁切，所以提示不能留在页面里。
// 注：sandbox:true 的 preload 必须是 CommonJS（ESM preload 需要 sandbox:false）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__gpuMonitorTip", {
  show: (payload) => ipcRenderer.send("gpu-monitor-tip-show", payload),
  hide: () => ipcRenderer.send("gpu-monitor-tip-hide"),
});
