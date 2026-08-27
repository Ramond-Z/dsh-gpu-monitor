// dsh-gpu-monitor: 面板窗口 preload（ESM，sandbox:false）——把进程信息悬浮框桥接给主进程。
// 悬浮框在独立透明置顶小窗里渲染（见 main.mjs 的 showTipWindow），可以伸出面板窗口范围；
// 面板窗口内的 DOM 会被窗口边界裁切，所以提示需要额外渲染到独立小窗。
// 与 shield-preload.mjs 同一套已验证模式：ESM preload 需要 sandbox:false
// （仅本地页面/数据，无远程内容）。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__gpuMonitorTip", {
  show: (payload) => ipcRenderer.send("gpu-monitor-tip-show", payload),
  hide: () => ipcRenderer.send("gpu-monitor-tip-hide"),
});
