// dsh-gpu-monitor: 面板窗口 preload（ESM，sandbox:false）——把进程信息悬浮框桥接给主进程。
// 悬浮框在独立透明置顶小窗里渲染（见 main.mjs 的 showTipWindow），可以伸出面板窗口范围；
// 面板窗口内的 DOM 会被窗口边界裁切，所以提示需要额外渲染到独立小窗。
// onFallback：主进程在悬浮窗创建/渲染失败时发 "gpu-monitor-tip-fallback"，
// 页面收到后退回页面内提示（保底）。与 shield-preload.mjs 同一套已验证模式。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__gpuMonitorTip", {
  show: (payload) => ipcRenderer.send("gpu-monitor-tip-show", payload),
  update: (payload) => ipcRenderer.send("gpu-monitor-tip-update", payload),
  hide: () => ipcRenderer.send("gpu-monitor-tip-hide"),
  onFallback: (cb) => {
    ipcRenderer.removeAllListeners("gpu-monitor-tip-fallback");
    ipcRenderer.on("gpu-monitor-tip-fallback", () => {
      try { cb(); } catch {}
    });
  },
});
