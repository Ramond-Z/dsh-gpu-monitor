// dsh-gpu-monitor: 悬浮框宿主窗 preload（ESM，sandbox:false）——接收主进程推送的提示内容
// 并渲染进 #tip-root，然后把内容尺寸回报主进程（用于把悬浮窗缩放到刚好包住内容）。
// 与 shield-preload.mjs 同一套模式：仅本地 data: 页面，无远程内容。
import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.on("gpu-monitor-tip-render", (event, payload) => {
    const root = document.getElementById("tip-root");
    if (!root) return;
    const html = String((payload && payload.html) || "");
    if (!html) return;
    const theme = payload && payload.theme === "light" ? "light" : "dark";
    const vars = String((payload && payload.vars) || "");
    const de = document.documentElement;
    de.dataset.gpuTheme = theme;
    de.style.cssText = vars; // 主题 CSS 变量（提示盒内联样式引用 var(--gpu-*)）
    root.innerHTML = html;
    ipcRenderer.send("gpu-monitor-tip-sized", {
      w: de.scrollWidth,
      h: de.scrollHeight,
    });
  });
});
