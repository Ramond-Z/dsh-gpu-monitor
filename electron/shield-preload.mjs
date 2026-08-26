// dsh-gpu-monitor: 点击拦截层 preload（透明全屏窗专用，ESM）。
// 拦截层页面里任意 mousedown → 通知主进程收起弹出面板（macOS 菜单 popover 行为）。
// 注：ESM preload 需要 sandbox: false（主进程已对拦截层窗口设置）。
import { ipcRenderer } from "electron";

window.addEventListener("mousedown", () => {
  ipcRenderer.send("gpu-shield-click");
});
