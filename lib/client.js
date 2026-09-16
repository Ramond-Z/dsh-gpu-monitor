// dsh-gpu-monitor: 浏览器半部（纯 DOM + React 挂载点）。
// GPU 监控停靠进左侧边栏底部（sidebar.footer.action 槽位），是页面布局的固定部分（非悬浮）。
// 支持多台机器：每台机器（本机 + ~/.ssh/config 中可用 GPU server）纵向堆叠成一个分组；
// 每组内每 GPU 一个方块——填充百分比 = 显存占用；填充颜色 = 功率（按功率/上限占比分级）；
// 方块上写 显存 与 功率 数字。
// 鼠标在方块上停留 ~0.5s → 显示该卡上的计算进程（属主 / PID / 占用显存 / 命令行）。
// 数据源：优先本地 sidecar（http://127.0.0.1:3499/status，多机），失败回退同源 /gpu/status。
// 主题跟随系统深浅色（CSS 变量 + prefers-color-scheme）。
// 若侧边栏槽位注册失败，退回右下角（自动浮于输入框上方）悬浮模式。
window.__ModuleLoader__.load({
  id: "dsh-gpu-monitor",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    // ────────────────────────────────────────────────────────────────
    // 本文件是一个单文件浏览器模块（DSH 加载器 / webui shim 均只加载它），
    // 内部按三个"内部接缝"分区，各接缝间只通过少量模块级状态与函数往来：
    //   ① view        —— 纯 DOM：渲染 / 拖动 / 悬停 / 主题 / 悬浮兜底
    //   ② orderState  —— 分组顺序协议：localStorage 缓存、调和、回同步（见 maybeAdoptServerOrder）
    //   ③ dataSource  —— 多源拉取与归一化：同源桥 → /gpu/status → 绝对 sidecar
    //   ④ 入口编排     —— apply() + tick()：把三个接缝接起来
    // 跨接缝的状态读取都有注释标明来源，避免"改一处需通读全文件"。
    // ────────────────────────────────────────────────────────────────

    const REFRESH_MS = 3000;
    const STATUS_URL = "/gpu/status";
    const SIDECAR_JSON_URL = "/gpu-status.json"; // 同源桥：sidecar 写入 dsh 前端 dist
    const SETTINGS_URL = "/settings"; // 设置页：宿主 / sidecar / Electron 都注册同源路由
    const HOVER_DELAY_MS = 300; // 首次悬停显示进程的延迟（防扫过方块误触）
    const HIDE_DELAY_MS = 350;
    const LS_HEIGHT_KEY = "dsh-gpu-monitor:height";
    const LS_ORDER_KEY = "dsh-gpu-monitor:order";
    const DEFAULT_MAX_HEIGHT = "42vh";
    const MIN_PANEL_H = 64;
    const MAX_PANEL_H_RATIO = 0.9;

    // —— 主题变量（injectTheme 注入页面；Electron 悬浮窗桥接时同样需要） ——
    const THEME_DARK_VARS =
      "--gpu-bg:#0f1116;--gpu-fg:#dbe0ea;--gpu-fg-dim:rgba(219,224,234,.55);" +
      "--gpu-border:#232833;--gpu-head:#151924;--gpu-card:#1a1f2c;--gpu-track:#2a3040;" +
      "--gpu-shadow:0 6px 20px rgba(0,0,0,.45)";
    const THEME_LIGHT_VARS =
      "--gpu-bg:rgba(255,255,255,.98);--gpu-fg:#23272f;--gpu-fg-dim:rgba(35,39,47,.55);" +
      "--gpu-border:#e3e6ec;--gpu-head:#f4f5f9;--gpu-card:#ffffff;--gpu-track:#e9ecf2;" +
      "--gpu-shadow:0 6px 20px rgba(15,18,30,.10)";

    // —— Electron 悬浮窗桥（tip-preload.mjs 暴露）：进程提示渲染到独立透明置顶小窗，
    //    可伸出面板窗口范围（面板 DOM 会被窗口边界裁切）。**桥可用时只显示悬浮窗**，
    //    页面内提示隐藏（两者同锚点会叠成"双框"）；悬浮窗创建/渲染失败时主进程发
    //    fallback 信号，退回页面内提示（保底）——任何环境下悬停都有提示。
    //    桥必须**懒读取**：ESM preload 异步执行、可能晚于页面脚本（electron#40777），
    //    模块加载时读到的可能是 undefined，导致悬浮窗永远不启用。 ——
    const tipBridge = () => {
      try { return window.__gpuMonitorTip || null; } catch { return null; }
    };
    let tipBridgeBroken = false; // 悬浮窗失败 → 本会话内退回页面内提示，不再尝试悬浮窗
    let marqueeSpeedPx = 45; // 跑马灯滚动速度（px/s，越小越慢）；设置页可调，启动时与打开设置时同步
    let tipFallbackBound = false; // fallback 监听只绑定一次（懒绑定：桥可能晚于模块加载出现）
    /** 绑定主进程的 fallback 信号（悬浮窗失败 → 退回页面内提示）。 */
    function bindTipFallback(bridge) {
      if (tipFallbackBound || !bridge || typeof bridge.onFallback !== "function") return;
      tipFallbackBound = true;
      try {
        bridge.onFallback(() => {
          tipBridgeBroken = true;
          // 立即补显页面内提示（悬停状态仍在时按当前锚点定位）
          if (hoverServerId != null) {
            const anchor = hoverElement();
            if (anchor) positionTip(anchor.getBoundingClientRect());
          }
          if (tip) {
            tip.style.display = "block";
            enableMarquee(tip);
          }
        });
      } catch {}
    }
    // 提示盒样式（页面内提示与 Electron 悬浮窗共用）。**不含宽度约束**：浏览器里
    // 由页面内元素样式（max-width 兜底）决定，Electron 悬浮窗里由主进程按内容自然宽
    // 度与屏幕工作区夹紧后显式设宽——这样长命令行不会被 340px 硬上限截断。
    const TIP_BOX_STYLE =
      "background:var(--gpu-bg);color:var(--gpu-fg);" +
      "border:1px solid var(--gpu-border);border-radius:8px;padding:6px 9px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.45);font:11px/1.5 ui-monospace,Menlo,monospace;user-select:text";
    // 页面内提示的布局兜底（浏览器/DSH；Electron 面板里即面板宽度）：
    // 与悬浮窗同款截断值（宽 480 / 高 320），超宽换行、超高内部滚动，信息不丢失。
    const IN_PAGE_TIP_LAYOUT =
      "max-width:min(480px,calc(100vw - 24px));" +
      "max-height:min(320px,calc(100vh - 24px));overflow-y:auto";

    // ════════════════════════════════════════════════════════════════
    // ① view —— 视图层（渲染 / 拖动 / 悬停 / 主题 / 悬浮兜底）
    // ════════════════════════════════════════════════════════════════

    // —— 面板偏好（localStorage） ——
    // 面板高度（用户可上下拖动调整，记住在 localStorage）
    let savedHeight = null; // px；null = 用默认 max-height
    try {
      const v = Number(localStorage.getItem(LS_HEIGHT_KEY));
      if (Number.isFinite(v) && v >= MIN_PANEL_H) savedHeight = v;
    } catch (e) {}

    // —— 拖动排序状态 ——
    let dragging = false; // 分组拖动进行中（抑制方块悬停提示）
    let dropMarker = null; // 插入位置指示线
    let dragState = null; // {group, id, before}
    // 拖动排序期间阻止触摸滚动干扰
    document.addEventListener("touchmove", (e) => {
      if (dragging) e.preventDefault();
    }, { passive: false });

    // —— 渲染状态 ——
    let monitorRoot = null;
    let groupsEl = null;
    let data = null; // 归一化后: {source, at, order, servers:[{id,label,ok,at,gpus,error}]}
    let lastGood = null; // 最近一次成功数据（拉取失败时沿用）
    let dataStale = false;
    let errorBannerEl = null;
    let wide = true;
    let docked = false;
    const groupNodes = new Map(); // serverId -> {group, head, title, time, blocksEl, gridEl, sysEl, cpu, mem}
    const blockNodes = new Map(); // "serverId::index" -> {block, fill, tMem, tPwr}

    // —— 悬停提示状态 ——
    let tip = null;
    let hoverTimer = null;
    let hoverServerId = null;
    let hoverGpuIndex = null;
    let hoverKind = null; // "gpu" = 悬停某个 GPU 方块；"sys" = 悬停 CPU/内存细条

    /** 建元素（props 直接赋值；可带 parent 挂载）。 */
    function el(tag, props, parent) {
      const n = document.createElement(tag);
      if (props) for (const k in props) n[k] = props[k];
      if (parent) parent.appendChild(n);
      return n;
    }

    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }

    function fmtMem(mb) {
      return mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M";
    }

    /** 提示进程行的固定前缀（属主 + 显存）：不参与跑马灯滚动；显存变了只改这里。 */
    function tipRowPrefix(p) {
      return `● ${p.user || "?"} · ${fmtMem(p.memMB)} · `;
    }

    // —— 主题 ——
    /** 主题跟随：每次调用都重新计算并写入 <html data-gpu-theme>（watchTheme 监听系统切换与
     *  DSH 内联样式变化，随时可重算，不会在首次设置后锁死主题）。
     *  来源优先级：
     *    1) 页面 HTML 显式写死的 data-gpu-theme（未带 gpuThemeAuto 标记）—— 固定主题宿主，不跟随；
     *    2) DSH 写在 <html> 内联 style 的 color-scheme —— 跟随 DSH 主题；
     *    3) 系统 prefers-color-scheme —— 独立页/应用默认跟随系统。 */
    function syncTheme() {
      const de = document.documentElement;
      if (de.dataset.gpuTheme && de.dataset.gpuThemeAuto !== "1") return; // 页面显式指定（固定）
      const inline = de.style && de.style.colorScheme;
      const next =
        inline === "dark" || inline === "light"
          ? inline
          : matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
      de.dataset.gpuTheme = next;
      de.dataset.gpuThemeAuto = "1"; // 此后 data-gpu-theme 由本模块持续维护
    }

    function watchTheme() {
      syncTheme();
      try {
        const mo = new MutationObserver(syncTheme);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
      } catch {}
      try {
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);
      } catch {}
    }

    /** 注入主题变量与组件样式。**每次调用都重写内容**，不能"按 id 命中就跳过"：
     *  模块被 HMR 替换后，页面上旧 <style> 仍在（dispose 不清理 head），若沿用旧元素，
     *  新版本的规则永远进不了页面——旧 CSS 配新 DOM 会出现：.gpu-grid 没有 display:flex
     *  （方块塌成一列）、.gpu-sys 没有宽高（CPU/内存细条不可见）。 */
    function injectTheme() {
      let s = document.getElementById("dsh-gpu-monitor-style");
      if (!s) {
        s = document.createElement("style");
        s.id = "dsh-gpu-monitor-style";
        document.head.appendChild(s);
      }
      const darkVars = THEME_DARK_VARS;
      const lightVars = THEME_LIGHT_VARS;
      s.textContent =
        ".dsh-gpu-monitor{" + darkVars + ";color:var(--gpu-fg)}" +
        'html[data-gpu-theme="light"] .dsh-gpu-monitor{' + lightVars + ";color:var(--gpu-fg)}" +
        "@media (prefers-color-scheme: light){.dsh-gpu-monitor{" + lightVars + ";color:var(--gpu-fg)}}" +
        'html[data-gpu-theme="dark"] .dsh-gpu-monitor{' + darkVars + ";color:var(--gpu-fg)}" +
        ".dsh-gpu-monitor .gpu-group{border-radius:8px;overflow:hidden;background:var(--gpu-card);" +
        "box-shadow:var(--gpu-shadow);margin:0 6px;border:1px solid var(--gpu-border)}" +
        ".dsh-gpu-monitor .gpu-head{background:var(--gpu-head)}" +
        ".dsh-gpu-monitor .gpu-block{border-radius:8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)," +
        "0 1px 3px rgba(0,0,0,.35)}" +
        ".dsh-gpu-monitor .gpu-fill{box-shadow:0 -1px 10px -2px currentColor}" +
        ".dsh-gpu-monitor .gpu-error{color:#f87171;font-size:10px;word-break:break-all;max-width:240px;flex:none}" +
        // 分组内容区 = GPU 方块网格（左，自动换行）+ CPU/内存细条（右）。外层 flex-wrap + 网格
        // flex-basis = "4 个方块的精确宽度"（44px×4 + 3×4px 间隙 = 188px）—— flex 只有在放得下
        // "4 个方块 + 细条" 时才让两者同行，否则细条整块换到下一行：两种情况方块都是 4 个一行。
        // （方块/细条都设了 box-sizing:border-box，宽度含边框，这里的算式才成立。）
        ".dsh-gpu-monitor .gpu-blocks{display:flex;flex-wrap:wrap;gap:3px;padding:8px 5px;align-items:flex-start;justify-content:flex-end}" +
        ".dsh-gpu-monitor .gpu-grid{display:flex;flex-wrap:wrap;gap:4px;flex:1 1 188px;min-width:0;align-content:flex-start}" +
        // CPU/内存：两条竖向细条（填充高度=占用率、颜色=与方块同一套分级），随方块区高度拉伸。
        // 百分数放在条**下方横排**：列宽 14px + 6.5px 字号，最宽的 `100%` 约 16.3px —— 两侧各溢出
        // 约 1.2px，两列之间还有 3px 间隙，所以不会叠在一起（8px 字号时会溢出 3px/侧 → 重叠）。
        // align-self:stretch 让细条与方块网格同高；track 的 min-height 兜底：高度链万一算不出来也不会被压成 0。
        ".dsh-gpu-monitor .gpu-sys{display:flex;gap:3px;flex:0 0 auto;align-self:stretch;min-height:44px}" +
        ".dsh-gpu-monitor .gpu-sys-col{display:flex;flex-direction:column;align-items:center;gap:2px;width:14px;flex:none}" +
        ".dsh-gpu-monitor .gpu-sys-tag{font-size:7px;line-height:1;color:var(--gpu-fg-dim);flex:none}" +
        ".dsh-gpu-monitor .gpu-sys-track{box-sizing:border-box;position:relative;flex:1;width:14px;min-height:26px;" +
        "border-radius:6px;overflow:hidden;background:var(--gpu-track);border:1px solid var(--gpu-border)}" +
        ".dsh-gpu-monitor .gpu-sys-fill{position:absolute;left:0;right:0;bottom:0;background:#22c55e;transition:height .4s,background .4s}" +
        ".dsh-gpu-monitor .gpu-sys-val{flex:none;font-size:6.5px;font-weight:700;line-height:1;color:var(--gpu-fg);white-space:nowrap;" +
        "font-variant-numeric:tabular-nums}" +
        // 进程行跑马灯：固定前缀（属主+显存）不滚动，命令视口超宽时自动滚动（悬停暂停）。
        // 速度 = 设置值（px/s）字面含义：时长 = 距离 / 速度，不同长度的行滚动同步。
        ".dsh-gpu-monitor .gpu-tip-line{display:flex;align-items:center;min-width:0}" +
        ".dsh-gpu-monitor .gpu-tip-line .gpu-tip-line-prefix{flex:none;white-space:nowrap}" +
        ".dsh-gpu-monitor .gpu-tip-line .gpu-tip-line-inner{flex:1;min-width:0;overflow:hidden;white-space:nowrap;position:relative}" +
        ".dsh-gpu-monitor .gpu-tip-line .gpu-tip-line-text{display:inline-block;white-space:nowrap;will-change:transform}" +
        ".dsh-gpu-monitor .gpu-tip-line.gpu-marquee .gpu-tip-line-text{animation:gpu-tip-marquee var(--gpu-marquee-dur,10s) linear .8s infinite}" +
        ".dsh-gpu-monitor .gpu-tip-line.gpu-marquee:hover .gpu-tip-line-text{animation-play-state:paused}" +
        "@keyframes gpu-tip-marquee{0%{transform:translateX(0)}100%{transform:translateX(calc(-1 * var(--gpu-marquee-dist,0px)))}}";
      document.head.appendChild(s);
    }

    // —— 渲染 ——
    /** 占用率 → 颜色（四级：绿 <40% < 黄 <70% < 橙 <90% < 红）；GPU 功率与 CPU/内存共用同一套。 */
    function levelColor(ratio) {
      if (!Number.isFinite(ratio) || ratio <= 0) return "#3b82f6";
      return ratio >= 0.9 ? "#ef4444" : ratio >= 0.7 ? "#f59e0b" : ratio >= 0.4 ? "#eab308" : "#22c55e";
    }

    /** 方块填充色 = 功率（按 功率/功率上限 占比分级）。 */
    function powerColor(g) {
      const p = g.powerW;
      const limit = g.powerLimitW;
      const ratio = limit > 0 ? p / limit : p <= 0 ? 0 : p / 300;
      return levelColor(ratio);
    }

    // —— 监控本体（构建进任意容器 root） ——
    function buildMonitorInto(root, isWide) {
      root.innerHTML = "";
      monitorRoot = root;
      wide = isWide;
      root.classList.add("dsh-gpu-monitor");
      if (!wide) {
        // 侧边栏收起成窄栏：只显示图标
        el("div", {
          style:
            "text-align:center;padding:5px 0;color:var(--gpu-fg);font-size:14px;cursor:default;user-select:none",
          textContent: "🎮",
        }, root);
        return;
      }
      // app 模式（独立页/Electron，<html data-gpu-mode="app">）：占满整个窗口，无高度把手
      const appMode = document.documentElement.dataset.gpuMode === "app";
      groupsEl = el("div", {
        style:
          "display:flex;flex-direction:column;gap:6px;position:relative;overflow-y:auto;scrollbar-width:thin;" +
          (appMode ? "flex:1;min-height:0;max-height:none" : "max-height:" + DEFAULT_MAX_HEIGHT),
      }, root);
      if (appMode) {
        root.style.display = "flex";
        root.style.flexDirection = "column";
        root.style.flex = "1";
        root.style.minHeight = "0";
        return;
      }
      initResizeHandle(root, groupsEl);
      // 设置入口（停靠模式；独立页/应用顶栏的 ⚙ 由 webui.mjs 提供，见 apply() 的事件监听）
      const toolbar = el("div", { style: "display:flex;justify-content:flex-end;flex:none;padding:2px 8px 0" });
      const gear = el("button", {
        type: "button",
        title: "监控设置",
        textContent: "⚙",
        style: "background:none;border:none;color:var(--gpu-fg-dim);font-size:14px;cursor:pointer;padding:0 4px;line-height:1.4",
      }, toolbar);
      gear.addEventListener("click", (e) => { e.stopPropagation(); openSettings(); });
      root.insertBefore(toolbar, groupsEl);
      applyHeight();
    }

    /** 把用户拖出来的高度（或默认）应用到分组容器。 */
    function applyHeight() {
      if (!groupsEl) return;
      if (savedHeight) {
        groupsEl.style.height = savedHeight + "px";
        groupsEl.style.maxHeight = "none";
      } else {
        groupsEl.style.height = "";
        groupsEl.style.maxHeight = DEFAULT_MAX_HEIGHT;
      }
    }

    /** 面板顶部加一条可上下拖动的把手（双击重置为默认高度）。 */
    function initResizeHandle(root, target) {
      const bar = el("div", {
        title: "拖动调整面板高度；双击恢复默认",
        style:
          "height:7px;flex:none;cursor:ns-resize;touch-action:none;user-select:none;" +
          "display:flex;align-items:center;justify-content:center;" +
          "background:var(--gpu-head);border-bottom:1px solid var(--gpu-border);opacity:.65",
      });
      const grip = el("div", {
        style: "width:26px;height:3px;border-radius:2px;background:var(--gpu-track)",
      }, bar);
      bar.addEventListener("mouseenter", () => { bar.style.opacity = "1"; });
      bar.addEventListener("mouseleave", () => { bar.style.opacity = ".65"; });
      bar.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        savedHeight = null;
        try { localStorage.removeItem(LS_HEIGHT_KEY); } catch {}
        applyHeight();
      });
      bar.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startH = target.getBoundingClientRect().height;
        let moved = false;
        const maxH = Math.max(MIN_PANEL_H, Math.round(window.innerHeight * MAX_PANEL_H_RATIO));
        const onMove = (ev) => {
          moved = true;
          const h = clamp(startH + (startY - ev.clientY), MIN_PANEL_H, maxH);
          savedHeight = h;
          target.style.height = h + "px";
          target.style.maxHeight = "none";
        };
        const onUp = () => {
          bar.removeEventListener("pointermove", onMove);
          bar.removeEventListener("pointerup", onUp);
          bar.removeEventListener("pointercancel", onUp);
          document.body.style.cursor = "";
          if (moved) {
            try { localStorage.setItem(LS_HEIGHT_KEY, String(savedHeight)); } catch {}
          }
        };
        bar.addEventListener("pointermove", onMove);
        bar.addEventListener("pointerup", onUp);
        bar.addEventListener("pointercancel", onUp);
        document.body.style.cursor = "ns-resize";
      });
      root.insertBefore(bar, target);
    }

    function makeGroup(s) {
      const group = el("div", { className: "gpu-group", style: "flex:none" });
      const head = el("div", {
        className: "gpu-head",
        style:
          "display:flex;align-items:center;gap:6px;padding:6px 10px;" +
          "border-bottom:1px solid var(--gpu-border);user-select:none;touch-action:none",
      });
      const grip = el("div", {
        style:
          "cursor:grab;flex:none;font-size:10px;opacity:.55;padding:0 2px;user-select:none;" +
          "touch-action:none;letter-spacing:1px",
        textContent: "⠿",
        title: "拖动表头可调整服务器顺序",
      }, head);
      const title = el("span", {
        style:
          "font-weight:600;flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
      }, head);
      const time = el("span", { textContent: "…", style: "opacity:.55;font-size:10px" }, head);
      group.appendChild(head);
      // 内容区：左 = GPU 方块网格（自动换行）；右 = CPU/内存两条竖向细条
      // （换行规则见 injectTheme：不够宽时细条整块落到方块下方，方块每行数量不变）
      const blocksEl = el("div", { className: "gpu-blocks" }, group);
      const gridEl = el("div", { className: "gpu-grid" }, blocksEl);
      const sysEl = el("div", { className: "gpu-sys", title: "CPU / 内存占用（悬停看详情）" }, blocksEl);
      const cpuBar = makeSysBar("C", "CPU");
      const memBar = makeSysBar("M", "内存");
      sysEl.appendChild(cpuBar.col);
      sysEl.appendChild(memBar.col);
      // 悬停/点按细条 → 系统详情提示（与方块提示共用同一个提示盒；Electron 里同样走独立悬浮窗）
      sysEl.addEventListener("mouseenter", () => {
        if (dragging) return;
        clearTimeout(hoverTimer);
        if (tip && tip.style.display === "block") showSysTip(s.id, sysEl);
        else hoverTimer = setTimeout(() => { if (sysEl.isConnected) showSysTip(s.id, sysEl); }, HOVER_DELAY_MS);
      });
      sysEl.addEventListener("mouseleave", () => {
        clearTimeout(hoverTimer);
        scheduleHide();
      });
      sysEl.addEventListener("touchstart", (e) => {
        if (dragging) return;
        e.preventDefault();
        e.stopPropagation();
        if (hoverKind === "sys" && hoverServerId === s.id) hideTip();
        else showSysTip(s.id, sysEl);
      }, { passive: false });
      groupNodes.set(s.id, { group, head, title, time, blocksEl, gridEl, sysEl, cpu: cpuBar, mem: memBar });
      initGroupDrag(group, head, s);
      return groupNodes.get(s.id);
    }

    /** 系统细条（CPU / 内存各一条）：标签 + 轨道（自底向上填充）+ 条下方横排百分数。 */
    function makeSysBar(tag, name) {
      const col = el("div", { className: "gpu-sys-col" });
      el("div", { className: "gpu-sys-tag", textContent: tag, title: name }, col);
      const track = el("div", { className: "gpu-sys-track", title: name }, col);
      const fill = el("div", { className: "gpu-sys-fill" }, track);
      // 百分数挂在 col 上（不放进轨道）：轨道只有 14px 宽且 overflow:hidden，横排数字会被裁掉
      const val = el("div", { className: "gpu-sys-val", textContent: "—" }, col);
      return { col, track, fill, val, name };
    }

    /** 更新一条系统细条：占用率 → 填充高度 + 分级色 + 条下横排百分数（无数据时显示 —）。 */
    function setSysBar(bar, pct, detail) {
      bar.track.title = bar.name + "：" + detail;
      if (!Number.isFinite(pct)) {
        bar.fill.style.height = "0%";
        bar.val.textContent = "—";
        return;
      }
      const p = clamp(pct, 0, 100);
      const c = levelColor(p / 100);
      bar.fill.style.height = p + "%";
      bar.fill.style.background = c;
      bar.fill.style.color = c;
      bar.val.textContent = Math.round(p) + "%";
    }

    /** 渲染某分组的 CPU/内存细条；这台机器没有系统数据（非 Linux / 采样失败）时整块隐藏。 */
    function renderSystem(g, s) {
      const cpu = s.cpu || null;
      const mem = s.mem || null;
      const has = !!(cpu || mem);
      g.sysEl.style.display = has ? "flex" : "none";
      if (!has) return;
      const cpuDetail = cpu
        ? (cpu.pct == null ? "采样中…" : cpu.pct.toFixed(1) + "%" + (cpu.cores ? " · " + cpu.cores + " 核" : ""))
        : "无数据";
      setSysBar(g.cpu, cpu && cpu.pct != null ? cpu.pct : NaN, cpuDetail);
      const memDetail = mem
        ? (mem.usedMB / 1024).toFixed(1) + "G / " + (mem.totalMB / 1024).toFixed(1) + "G（" + mem.pct.toFixed(1) + "%）"
        : "无数据";
      setSysBar(g.mem, mem && mem.pct != null ? mem.pct : NaN, memDetail);
    }

    /** 分组 DOM 节点 → server id（非分组子节点返回 null）。 */
    function groupIdOf(child) {
      for (const [id, x] of groupNodes) if (x.group === child) return id;
      return null;
    }

    function ensureDropMarker() {
      if (dropMarker) return dropMarker;
      dropMarker = el("div", {
        style:
          "position:absolute;left:8px;right:8px;height:2px;border-radius:1px;background:#22c55e;" +
          "display:none;pointer-events:none;z-index:5;transition:top .12s ease",
      });
      groupsEl.appendChild(dropMarker);
      return dropMarker;
    }

    /** 最后一个非拖拽分组（before 为空时用于定位"末尾"指示线）。 */
    function lastOtherGroup() {
      let last = null;
      for (const child of groupsEl.children) {
        const id = groupIdOf(child);
        if (id === null || id === dragState.id) continue;
        last = child;
      }
      return last;
    }

    /** 指针位置 → 插入点，并移动指示线（参考工作区列表的 drop marker）。
     * 顶部/底部 32px 边缘直接吸附到最前/最后，避免高分组中点判定死区导致"拖不回第一位"。 */
    function positionDropMarker(y) {
      const gRect = groupsEl.getBoundingClientRect();
      const marker = ensureDropMarker();
      let before = null;
      if (y < gRect.top + 32) {
        // 吸附到最前：第一个非拖拽分组之前
        for (const child of groupsEl.children) {
          const id = groupIdOf(child);
          if (id === null || id === dragState.id) continue;
          before = child;
          break;
        }
      } else if (y > gRect.bottom - 32) {
        // 吸附到最后
        before = null;
      } else {
        // 中部：中点判定（插入到第一个中点低于指针的分组之前）
        for (const child of groupsEl.children) {
          const id = groupIdOf(child);
          if (id === null || id === dragState.id) continue;
          const r = child.getBoundingClientRect();
          if (y < r.top + r.height / 2) { before = child; break; }
        }
      }
      let top;
      if (before) top = before.getBoundingClientRect().top - gRect.top + groupsEl.scrollTop - 2;
      else {
        const last = lastOtherGroup();
        top = last ? last.getBoundingClientRect().bottom - gRect.top + groupsEl.scrollTop - 2 : 0;
      }
      marker.style.top = Math.max(0, top) + "px";
      marker.style.display = "block";
      dragState.before = before;
    }

    /** 松手：执行 DOM 移动 + FLIP 滑动动画（位移分组平滑让位）。
     * 注意：锚点可能已被 tick 移除（如错误横幅），故校验 parentNode 后回退到横幅/末尾。 */
    function commitDrag() {
      const { group, before } = dragState;
      dragState = null;
      if (dropMarker) dropMarker.style.display = "none";
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      // First：记录各分组当前位置
      const first = new Map();
      for (const child of groupsEl.children) {
        if (child === group) continue;
        first.set(child, child.getBoundingClientRect());
      }
      const movedFirst = group.getBoundingClientRect();
      // Last：执行移动（锚点可能已被 tick 移除 → 校验后回退到横幅/末尾）
      const anchor = before && before.parentNode === groupsEl ? before : null;
      const banner = errorBannerEl && errorBannerEl.parentNode === groupsEl ? errorBannerEl : null;
      groupsEl.insertBefore(group, anchor || banner);
      persistOrderFromDom(); // → orderState：把新顺序写入 localStorage 并回同步 sidecar
      // 复位拖拽样式
      group.style.opacity = "";
      group.style.outline = "";
      if (reduced) return;
      // 计算位移并 FLIP：先反位移到原位，再过渡回 0
      const ease = "cubic-bezier(.2,.7,.3,1)";
      const animated = new Set();
      const movedLast = group.getBoundingClientRect();
      const movedDy = movedFirst.top - movedLast.top;
      for (const [child, fr] of first) {
        const dy = fr.top - child.getBoundingClientRect().top;
        if (Math.abs(dy) < 0.5) continue;
        child.style.transition = "none";
        child.style.transform = `translateY(${dy}px)`;
        animated.add(child);
      }
      if (Math.abs(movedDy) > 0.5) {
        group.style.transition = "none";
        group.style.transform = `translateY(${movedDy}px)`;
        animated.add(group);
      }
      if (animated.size === 0) return;
      void groupsEl.offsetHeight; // 强制回流
      for (const child of animated) {
        child.style.transition = `transform 220ms ${ease}`;
        child.style.transform = "";
      }
      setTimeout(() => {
        for (const child of animated) {
          child.style.transition = "";
          child.style.transform = "";
        }
      }, 260);
    }

    /** 取消：不做移动，只复位样式。 */
    function cancelDrag() {
      if (!dragState) return;
      const { group } = dragState;
      dragState = null;
      if (dropMarker) dropMarker.style.display = "none";
      group.style.opacity = "";
      group.style.outline = "";
    }

    /** 表头整行可拖动排序（带 5px 阈值，普通点击不受影响）；grip 只是视觉提示。
     * 拖动期间分组保持原位 + 插入指示线（参考工作区列表），松手后 FLIP 滑动让位。
     * 用 window 级 pointermove/up 监听而非 setPointerCapture：指针离开表头后仍能继续拖动。 */
    function initGroupDrag(group, head, s) {
      head.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        dragging = true;
        dragState = { group, id: s.id, before: null };
        const startY = e.clientY;
        const startX = e.clientX;
        let engaged = false;
        const onMove = (ev) => {
          if (!engaged) {
            if (Math.abs(ev.clientY - startY) < 5 && Math.abs(ev.clientX - startX) < 5) return;
            engaged = true;
            group.style.opacity = ".45";
            group.style.outline = "1px dashed var(--gpu-border)";
            document.body.style.cursor = "grabbing";
          }
          positionDropMarker(ev.clientY);
          // 接近容器上下边缘时自动滚动（与边缘吸附一致的 32px 区域，滚动更快）
          const gRect = groupsEl.getBoundingClientRect();
          if (ev.clientY < gRect.top + 32) groupsEl.scrollTop -= 16;
          else if (ev.clientY > gRect.bottom - 32) groupsEl.scrollTop += 16;
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("blur", onCancel);
          document.body.style.cursor = "";
          dragging = false;
          if (engaged) commitDrag();
          else cancelDrag(); // 纯点击（未超过阈值）不改变顺序
        };
        const onCancel = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("blur", onCancel);
          document.body.style.cursor = "";
          dragging = false;
          cancelDrag();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("blur", onCancel);
      });
    }

    function makeBlock(serverId, index) {
      const block = el("div", {
        className: "gpu-block",
        style:
          // box-sizing:border-box：宽度**含边框**，才能用"44px×4 + 间隙 = 188px"精确算出
          // 网格的 flex-basis（content-box 下 1px 边框会让每块多占 2px，4 块一行就放不下了）
          "box-sizing:border-box;position:relative;width:44px;height:44px;border-radius:8px;overflow:hidden;" +
          "border:1px solid var(--gpu-border);background:var(--gpu-card);cursor:pointer;flex:none",
      });
      const fill = el("div", {
        className: "gpu-fill",
        style:
          "position:absolute;left:0;right:0;bottom:0;background:#22c55e;transition:height .4s,background .4s",
      }, block);
      const tMem = el("div", {
        style:
          "position:absolute;top:3px;left:4px;right:3px;font-size:9px;font-weight:700;white-space:nowrap;" +
          "text-shadow:0 0 3px var(--gpu-bg),0 0 2px var(--gpu-bg)",
      }, block);
      const tPwr = el("div", {
        style:
          "position:absolute;bottom:3px;right:4px;font-size:9px;font-weight:700;white-space:nowrap;" +
          "text-shadow:0 0 3px var(--gpu-bg),0 0 2px var(--gpu-bg)",
      }, block);
      // 悬停显示进程（首次显示延迟 300ms 防误触；提示已显示时切块立即换内容，不闪烁不等待）；触摸点击切换
      // 拖动排序期间（dragging）抑制悬停，避免拖拽过程中误弹提示
      block.addEventListener("mouseenter", () => {
        if (dragging) return;
        clearTimeout(hoverTimer);
        if (tip && tip.style.display === "block") {
          // 提示正开着：切到别的块立即更新（避免"隐藏→再等 300ms→显示"的卡手感）
          showTip(serverId, index, block);
        } else {
          hoverTimer = setTimeout(() => {
            if (block.isConnected) showTip(serverId, index, block);
          }, HOVER_DELAY_MS);
        }
      });
      block.addEventListener("mouseleave", () => {
        clearTimeout(hoverTimer);
        scheduleHide();
      });
      block.addEventListener("touchstart", (e) => {
        if (dragging) return;
        e.preventDefault();
        e.stopPropagation();
        if (hoverServerId === serverId && hoverGpuIndex === index) hideTip();
        else showTip(serverId, index, block);
      }, { passive: false });
      blockNodes.set(`${serverId}::${index}`, { block, fill, tMem, tPwr });
      return block;
    }

    /** 清除某分组下的全部方块 DOM 与记录。 */
    function clearBlocksOf(serverId) {
      for (const [key, n] of blockNodes) {
        if (key.startsWith(serverId + "::")) {
          n.block.remove();
          blockNodes.delete(key);
        }
      }
      const g = groupNodes.get(serverId);
      if (g && g.gridEl) g.gridEl.innerHTML = "";
    }

    function renderGroup(g, s, isFirst) {
      g.group.style.borderTop = isFirst ? "none" : "1px solid var(--gpu-border)";
      if (!s.ok) {
        g.title.textContent = `🎮 ${s.label} !`;
        g.title.title = s.error || "查询失败";
        g.time.textContent = "!";
        g.time.title = s.error || "";
        // 失败时清掉旧方块与系统细条，只留错误说明
        clearBlocksOf(s.id);
        g.sysEl.style.display = "none";
        el("div", { className: "gpu-error", textContent: s.error || "无数据" }, g.gridEl);
        return;
      }
      g.time.textContent = s.at ? new Date(s.at).toLocaleTimeString() : "…";
      g.time.title = "";
      // 从失败恢复：清掉上次残留的错误说明（错误 div 不在 blockNodes 簿记里，
      // 不清除会与恢复后的方块并存——手动刷新/下一轮刷新后仍可见）
      const errs = g.gridEl.querySelectorAll(".gpu-error");
      for (const e of errs) e.remove();
      renderSystem(g, s); // CPU/内存细条（与 GPU 方块同期刷新）
      // 表头：机型统计（如 8×RTX 3090）
      const counts = {};
      for (const gg of s.gpus) {
        const n = (gg.name || "GPU").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");
        counts[n] = (counts[n] || 0) + 1;
      }
      const text = Object.entries(counts)
        .map(([n, c]) => (c === 1 ? n : `${c}×${n}`))
        .join(" · ");
      g.title.textContent = `🎮 ${s.label}${text ? " · " + text : ""}`;
      g.title.title = text;
      for (const gg of s.gpus) {
        const key = `${s.id}::${gg.index}`;
        let n = blockNodes.get(key);
        if (!n || !n.block.isConnected) {
          if (n) blockNodes.delete(key);
          g.gridEl.appendChild(makeBlock(s.id, gg.index));
          n = blockNodes.get(key);
        }
        const memPct = gg.memTotalMB > 0 ? clamp((gg.memUsedMB / gg.memTotalMB) * 100, 0, 100) : 0;
        n.fill.style.height = memPct + "%";
        n.fill.style.background = powerColor(gg);
        n.fill.style.color = powerColor(gg); // 让 gpu-fill 的 currentColor 发光与功率色一致
        n.tMem.textContent = `${(gg.memUsedMB / 1024).toFixed(0)}/${(gg.memTotalMB / 1024).toFixed(0)}`;
        n.tPwr.textContent = `${Math.round(gg.powerW)}W`;
      }
      // 移除该分组下已不存在的方块
      for (const [key, n] of blockNodes) {
        if (key.startsWith(s.id + "::") && !s.gpus.some((g2) => key === `${s.id}::${g2.index}`)) {
          n.block.remove();
          blockNodes.delete(key);
        }
      }
    }

    /** 全量渲染：按 serverOrder（← orderState）排序分组，附错误/警告横幅。 */
    function renderGroups() {
      if (!groupsEl) return;
      // 清除上次的错误/警告横幅（避免残留红字）
      if (errorBannerEl && errorBannerEl.parentNode === groupsEl) errorBannerEl.remove();
      errorBannerEl = null;
      if (!data) {
        // 从未成功拉取过：显示连接错误
        const wrap = el("div", { style: "flex:none;border-top:1px solid var(--gpu-border)" }, groupsEl);
        el("div", {
          style: "color:#f87171;font-size:10px;word-break:break-all;max-width:240px;padding:6px 8px",
          textContent: `连接失败：${SIDECAR_JSON_URL} / ${STATUS_URL} 均不可用`,
        }, wrap);
        errorBannerEl = wrap;
        return;
      }
      // 按用户拖出的 serverOrder 排序（未知 id 排最后，保持到达顺序）
      const orderIdx = new Map(serverOrder.map((id, i) => [id, i]));
      const sorted = [...data.servers].sort((a, b) => {
        const ia = orderIdx.has(a.id) ? orderIdx.get(a.id) : 1e9;
        const ib = orderIdx.has(b.id) ? orderIdx.get(b.id) : 1e9;
        return ia - ib || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const seen = new Set();
      sorted.forEach((s, i) => {
        seen.add(s.id);
        let g = groupNodes.get(s.id);
        if (!g || !g.group.isConnected) {
          if (g) groupNodes.delete(s.id);
          g = makeGroup(s);
        }
        if (g.group.parentNode !== groupsEl) groupsEl.appendChild(g.group);
        renderGroup(g, s, i === 0);
      });
      for (const [id, g] of groupNodes) {
        if (!seen.has(id)) {
          g.group.remove();
          groupNodes.delete(id);
        }
      }
      // 把分组 DOM 排成 serverOrder（appendChild 会把已有节点移到末尾）
      const anchor = errorBannerEl;
      for (const s of sorted) {
        const g = groupNodes.get(s.id);
        if (g && g.group.parentNode === groupsEl) groupsEl.insertBefore(g.group, anchor);
      }
      if (data.servers.length === 0) {
        // 整体无数据：显示诊断信息（引擎在无 server 时给出具体原因）
        const label = data.message || data.error || "未发现可用 GPU server";
        const wrap = el("div", { style: "flex:none;border-top:1px solid var(--gpu-border)" }, groupsEl);
        el("div", {
          style: "color:#f87171;font-size:10px;word-break:break-all;max-width:240px;padding:6px 8px",
          textContent: label,
        }, wrap);
        errorBannerEl = wrap;
      } else if (dataStale) {
        // 有旧数据但本次拉取失败：小黄条提示，不遮内容
        const wrap = el("div", {
          style:
            "flex:none;border-top:1px solid var(--gpu-border);color:#f59e0b;font-size:10px;" +
            "padding:3px 8px;user-select:none",
          textContent: "⚠ 数据更新失败，显示上次结果",
        }, groupsEl);
        errorBannerEl = wrap;
      }
    }

    // —— 悬停进程提示 ——
    function ensureTip() {
      if (tip) return tip;
      tip = el("div", {
        id: "dsh-gpu-monitor-tip",
        className: "dsh-gpu-monitor",
        style: "position:fixed;z-index:2147483001;display:none;" + IN_PAGE_TIP_LAYOUT + ";" + TIP_BOX_STYLE,
      });
      // 移入提示框保持显示；移出后延迟隐藏
      tip.addEventListener("mouseenter", () => clearTimeout(hoverTimer));
      tip.addEventListener("mouseleave", () => scheduleHide());
      document.body.appendChild(tip);
      return tip;
    }

    /** 延迟隐藏：给鼠标从方块移到提示框（或反向）留出缓冲，期间移入任意一方即取消。 */
    function scheduleHide() {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(hideTip, HIDE_DELAY_MS);
    }

    /** 渲染提示内容。返回状态：0=无变化；1=仅显存数字变了（原地更新前缀，不重建 DOM，
     *  跑马灯动画不打断）；2=结构/命令变了，已重建 DOM（打断跑马灯属正常——内容真变了）。
     *  布局签名只取"会改变布局/滚动内容"的部分：进程列表（属主 + 命令行）+ GPU 身份；
     *  显存只出现在固定前缀里、不参与滚动，单独成签名——它变化时原地改数字即可。 */
    function renderTip() {
      if (hoverServerId == null || !tip) return 0;
      if (hoverKind === "sys") return renderSysTip();
      if (hoverGpuIndex == null) return 0;
      const server = data && data.servers.find((s) => s.id === hoverServerId);
      const g = server && server.gpus.find((x) => x.index === hoverGpuIndex);
      const procs = g && g.processes;
      const procsArr = Array.isArray(procs) ? procs : null;
      const layoutSig = g
        ? JSON.stringify([
            hoverServerId, hoverGpuIndex, g.name,
            procsArr === null ? (procs == null ? "na" : "other") : procsArr.map((p) => [p.user, p.cmd]),
          ])
        : "none";
      const memSig = procsArr ? JSON.stringify(procsArr.map((p) => fmtMem(p.memMB))) : "none";
      if (tip._layoutSig === layoutSig && tip._memSig === memSig) return 0; // 完全没变
      if (tip._layoutSig === layoutSig) {
        // 进程列表/命令行没变，仅显存数字变了：原地更新前缀（不重建 → 跑马灯继续滚）
        tip._memSig = memSig;
        const lines = tip.querySelectorAll(".gpu-tip-line");
        procsArr.forEach((p, i) => {
          const pre = lines[i] && lines[i].querySelector(".gpu-tip-line-prefix");
          if (pre) pre.textContent = tipRowPrefix(p);
        });
        return 1;
      }
      // 结构变了：整体重建
      tip._layoutSig = layoutSig;
      tip._memSig = memSig;
      tip.innerHTML = "";
      if (!g) {
        tip.textContent = "…";
        return 2;
      }
      const head = el("div", { style: "font-weight:700;margin-bottom:4px" }, tip);
      head.textContent =
        data.servers.length > 1 ? `${server.label} · GPU${g.index} ${g.name}` : `GPU${g.index} ${g.name}`;
      if (procsArr === null) {
        el("div", { style: "color:#f59e0b", textContent: "进程数据暂不可用（宿主需重启生效）" }, tip);
        return 2;
      }
      if (procsArr.length === 0) {
        el("div", { style: "opacity:.8", textContent: "无计算进程" }, tip);
        return 2;
      }
      for (const p of procsArr) {
        // 每行：固定前缀（属主 + 显存）不滚动，命令在右侧视口内单行展示，
        // 超宽时该视口自动滚动（跑马灯）显示完整命令；悬停暂停；字重与"无计算进程"统一
        const line = el("div", { className: "gpu-tip-line", style: "margin-top:2px" }, tip);
        el("span", {
          className: "gpu-tip-line-prefix",
          textContent: tipRowPrefix(p),
        }, line);
        const vp = el("span", { className: "gpu-tip-line-inner" }, line);
        el("span", {
          className: "gpu-tip-line-text",
          textContent: p.cmd || p.name || "",
          title: p.cmd || "",
        }, vp);
      }
      return 2;
    }

    /** 渲染 CPU/内存细条的提示内容（悬停整组细条）：CPU 占用 + 核数 + 负载，内存已用/总量。
     *  返回值语义与 renderTip 一致（0=无变化 2=已重建）；细条提示没有跑马灯，逐轮重建即可。 */
    function renderSysTip() {
      const server = data && data.servers.find((s) => s.id === hoverServerId);
      if (!server) return 0;
      const cpu = server.cpu || null;
      const mem = server.mem || null;
      const sig = JSON.stringify([
        "sys", hoverServerId, server.label,
        cpu && [cpu.pct, cpu.cores, cpu.load1, cpu.windowSec],
        mem && [mem.usedMB, mem.totalMB, mem.pct],
      ]);
      if (tip._layoutSig === sig) return 0; // 完全没变
      tip._layoutSig = sig;
      tip._memSig = "sys";
      tip.innerHTML = "";
      const head = el("div", { style: "font-weight:700;margin-bottom:4px" }, tip);
      head.textContent = `${server.label} · CPU / 内存`;
      if (!cpu && !mem) {
        el("div", { style: "opacity:.8", textContent: "无系统数据（非 Linux 或 /proc 不可读）" }, tip);
        return 2;
      }
      if (cpu) {
        const pct = cpu.pct == null ? "采样中…" : cpu.pct.toFixed(1) + "%";
        el("div", { style: "margin-top:2px" }, tip).textContent = `CPU ${pct}`;
        const bits = [];
        if (Number.isFinite(cpu.cores) && cpu.cores > 0) bits.push(`${cpu.cores} 核`);
        if (Number.isFinite(cpu.load1)) bits.push(`load ${cpu.load1}`);
        if (bits.length) el("div", { style: "opacity:.8" }, tip).textContent = bits.join(" · ");
      }
      if (mem) {
        el("div", { style: "margin-top:2px" }, tip).textContent =
          `内存 ${fmtMem(mem.usedMB)} / ${fmtMem(mem.totalMB)}（${mem.pct.toFixed(1)}%）`;
      }
      return 2;
    }

    /** 跑马灯：命令视口超宽的单行自动滚动展示完整内容（悬停暂停）。
     *  必须在盒子宽度定稿后调用（display:none 时测量为 0，跑马灯不会启用）。
     *  溢出距离 = 命令文本宽 - 视口宽（前缀固定在开头不参与滚动）；
     *  时长 = 距离 / 速度（固定 px/s，不同长度的行滚动同步）。 */
    function enableMarquee(root) {
      const lines = root.querySelectorAll(".gpu-tip-line");
      for (const line of lines) {
        const vp = line.querySelector(".gpu-tip-line-inner");
        const text = vp && vp.querySelector(".gpu-tip-line-text");
        if (!vp || !text) continue;
        const dist = text.scrollWidth - vp.clientWidth;
        if (dist > 0) {
          line.classList.add("gpu-marquee");
          line.style.setProperty("--gpu-marquee-dist", dist + "px");
          line.style.setProperty("--gpu-marquee-dur", marqueeDuration(dist) + "s");
        }
      }
    }

    /** 跑马灯时长：距离 / 速度（px/s）——速度即设置值的字面含义，不按长度截断；
     *  下限 1s 只防微溢出（几像素）闪烁。 */
    function marqueeDuration(dist) {
      const speed = Math.max(20, Math.min(100, Number(marqueeSpeedPx) || 45));
      return Math.max(1, Math.round((dist / speed) * 10) / 10);
    }

    function positionTip(anchorRect) {
      if (!tip) return;
      tip.style.visibility = "hidden";
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.visibility = "visible";
      // 优先放在方块下方（左对齐，避开同一排的方块）；下方放不下则翻到上方
      const left = clamp(anchorRect.left, 4, Math.max(4, window.innerWidth - tw - 4));
      const below = anchorRect.bottom + 8;
      const top = below + th <= window.innerHeight - 4 ? below : Math.max(4, anchorRect.top - th - 8);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }

    /** 当前悬停的锚点元素（bridge 重新定位 / 每轮刷新同步用）：GPU 方块或 CPU/内存细条。 */
    function hoverElement() {
      if (hoverServerId == null) return null;
      if (hoverKind === "sys") {
        const g = groupNodes.get(hoverServerId);
        return g ? g.sysEl : null;
      }
      if (hoverGpuIndex == null) return null;
      const n = blockNodes.get(hoverServerId + "::" + hoverGpuIndex);
      return n ? n.block : null;
    }

    /** 悬停某个 GPU 方块：提示内容 = 该卡计算进程。 */
    function showTip(serverId, index, block) {
      hoverKind = "gpu";
      hoverServerId = serverId;
      hoverGpuIndex = index;
      ensureTip();
      presentTip(block);
    }

    /** 悬停 CPU/内存细条：提示内容 = 该机器的 CPU/内存占用。 */
    function showSysTip(serverId, railEl) {
      hoverKind = "sys";
      hoverServerId = serverId;
      hoverGpuIndex = null;
      ensureTip();
      presentTip(railEl);
    }

    /** 呈现当前提示内容：Electron 走独立悬浮窗（可伸出面板），其余走页面内提示。 */
    function presentTip(anchorEl) {
      const st = renderTip(); // 0=无变化 1=仅显存变（已原地更新） 2=已重建
      const bridge = tipBridge();
      if (bridge && !tipBridgeBroken) {
        if (st === 0) return; // 悬浮窗里已经在滚：不推不重建，跑马灯不被打断
        if (st === 1) {
          // 结构没变、仅显存数字变了：整窗不重渲染（跑马灯继续），只推前缀数字原地更新
          const server = data && data.servers.find((s) => s.id === hoverServerId);
          const g = server && server.gpus.find((x) => x.index === hoverGpuIndex);
          const prefixes = (Array.isArray(g && g.processes) ? g.processes : []).map((p) => tipRowPrefix(p));
          try {
            if (typeof bridge.update === "function") bridge.update({ prefixes });
          } catch { tipBridgeBroken = true; }
          return;
        }
        bindTipFallback(bridge); // 懒绑定：桥可能晚于模块加载才出现
        try {
          const r = anchorEl.getBoundingClientRect();
          const theme = document.documentElement.dataset.gpuTheme === "light" ? "light" : "dark";
          bridge.show({
            html: tip.innerHTML, // 仅内容；盒子样式由主进程按测量后的宽度重建
            style: TIP_BOX_STYLE,
            anchor: { x: r.left, y: r.top, width: r.width, height: r.height },
            theme,
            vars: theme === "light" ? THEME_LIGHT_VARS : THEME_DARK_VARS,
            speedPx: marqueeSpeedPx, // 跑马灯滚动速度（主进程据此算时长）
          });
          return; // 悬浮窗接管：页面内提示保持隐藏，避免同锚点双框
        } catch (e) { tipBridgeBroken = true; }
      }
      if (st === 0 || st === 1) return; // 页面内提示无变化 / 已在 renderTip 原地更新（跑马灯继续）
      // 已重建：无桥（浏览器/DSH）或悬浮窗失败：页面内提示（保底）
      positionTip(anchorEl.getBoundingClientRect());
      tip.style.display = "block";
      enableMarquee(tip); // 盒子宽度已定稿，超宽行启用跑马灯
    }

    function hideTip() {
      clearTimeout(hoverTimer);
      hoverServerId = null;
      hoverGpuIndex = null;
      hoverKind = null;
      const bridge = tipBridge();
      if (bridge) {
        try { bridge.hide(); } catch {}
      }
      if (tip) tip.style.display = "none"; // 页面内提示（保底）一并隐藏
    }

    // —— 悬浮兜底（仅当槽位注册失败） ——
    function buildFloatingFallback() {
      const root = el("div", {
        id: "dsh-gpu-monitor",
        className: "dsh-gpu-monitor",
        style:
          "position:fixed;right:12px;z-index:2147483000;width:auto;min-width:150px;max-width:300px;" +
          "background:var(--gpu-bg);color:var(--gpu-fg);border:1px solid var(--gpu-border);" +
          "border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.45);overflow:hidden",
      });
      document.body.appendChild(root);
      buildMonitorInto(root, true);
      placeFloating();
      return root;
    }

    function findInputBox() {
      const sels = ["textarea", "[contenteditable=true]", "[role=textbox]"];
      for (const s of sels) {
        const list = document.querySelectorAll(s);
        for (const e of list) {
          const r = e.getBoundingClientRect();
          if (r.width > 50 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight) return r;
        }
      }
      return null;
    }

    function placeFloating() {
      if (!monitorRoot || docked) return;
      const r = findInputBox();
      monitorRoot.style.left = "auto";
      monitorRoot.style.top = "auto";
      monitorRoot.style.bottom = (r ? Math.max(12, window.innerHeight - r.top + 8) : 12) + "px";
    }

    // —— 设置弹窗（设置页：可调参数 + server 选取） ——
    let settingsModal = null; // {modal, body, errEl, btnSave, inputs, checkboxes, saving}
    const SETTINGS_INPUT_STYLE =
      "background:var(--gpu-head);border:1px solid var(--gpu-border);border-radius:6px;" +
      "color:var(--gpu-fg);padding:4px 6px;font-size:12px;min-width:0";
    const SETTINGS_BTN_STYLE =
      "background:var(--gpu-head);border:1px solid var(--gpu-border);border-radius:6px;" +
      "color:var(--gpu-fg);padding:5px 14px;font-size:12px;cursor:pointer";
    const SETTINGS_BTN_PRIMARY = SETTINGS_BTN_STYLE + ";background:#2563eb;border-color:#2563eb;color:#fff";

    function openSettings() {
      if (settingsModal) return;
      const modal = el("div", {
        id: "dsh-gpu-monitor-settings-modal",
        className: "dsh-gpu-monitor",
        style:
          "position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;" +
          "background:rgba(0,0,0,.5)",
      });
      const box = el("div", {
        style:
          "background:var(--gpu-card);border:1px solid var(--gpu-border);border-radius:10px;" +
          "box-shadow:var(--gpu-shadow);width:min(380px,calc(100vw - 32px));max-height:84vh;" +
          "display:flex;flex-direction:column;overflow:hidden;color:var(--gpu-fg);font-size:12px",
      }, modal);
      el("div", {
        style: "flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;" +
          "border-bottom:1px solid var(--gpu-border);font-weight:700;font-size:13px",
        textContent: "⚙ 监控设置",
      }, box);
      const body = el("div", { style: "flex:1;min-height:0;overflow-y:auto;padding:12px" }, box);
      el("div", {
        style: "color:var(--gpu-fg-dim);padding:10px 0;text-align:center",
        textContent: "正在加载设置…",
      }, body);
      const foot = el("div", {
        style: "flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;" +
          "border-top:1px solid var(--gpu-border)",
      }, box);
      const errEl = el("div", { style: "flex:1;color:#f87171;font-size:11px;word-break:break-all;min-width:0" }, foot);
      const btnCancel = el("button", { type: "button", textContent: "取消", style: SETTINGS_BTN_STYLE }, foot);
      const btnSave = el("button", { type: "button", textContent: "保存", style: SETTINGS_BTN_PRIMARY }, foot);
      settingsModal = { modal, body, errEl, btnSave, inputs: null, checkboxes: [], saving: false };
      modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeSettings(); });
      btnCancel.addEventListener("click", closeSettings);
      btnSave.addEventListener("click", () => saveSettings(settingsModal));
      document.body.appendChild(modal);
      loadSettingsInto(settingsModal);
    }

    function closeSettings() {
      if (!settingsModal) return;
      settingsModal.modal.remove();
      settingsModal = null;
    }

    /** 拉取当前设置与候选 server 列表，构建表单；加载失败时在弹窗内给出错误。 */
    async function loadSettingsInto(m) {
      const data = await fetchSettings();
      if (!settingsModal || settingsModal !== m) return; // 弹窗已关闭
      m.body.innerHTML = "";
      if (!data || !data.settings) {
        el("div", {
          style: "color:#f87171;padding:10px 0;text-align:center",
          textContent: "设置接口不可达（sidecar 或宿主未运行）",
        }, m.body);
        return;
      }
      const s = data.settings;
      marqueeSpeedPx = Math.max(20, Math.min(100, Number(s.marqueeSpeedPx) || 45)); // 同步本地速度缓存
      const inputs = {};
      const row = (labelText, input, hint) => {
        const r = el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:9px" }, m.body);
        el("label", { style: "flex:none;width:118px;color:var(--gpu-fg-dim)", textContent: labelText, title: hint || "" }, r);
        r.appendChild(input);
      };
      inputs.intervalMs = el("input", { type: "number", value: String(s.intervalMs), style: SETTINGS_INPUT_STYLE + ";width:90px;flex:none" });
      row("查询间隔 (ms)", inputs.intervalMs, "两次查询之间的间隔；越小刷新越快、负载越高");
      inputs.timeoutMs = el("input", { type: "number", value: String(s.timeoutMs), style: SETTINGS_INPUT_STYLE + ";width:90px;flex:none" });
      row("查询超时 (ms)", inputs.timeoutMs, "每台机器单轮查询超时；单台超时不影响其它机器");
      inputs.probeTimeoutMs = el("input", { type: "number", value: String(s.probeTimeoutMs), style: SETTINGS_INPUT_STYLE + ";width:90px;flex:none" });
      row("探测超时 (ms)", inputs.probeTimeoutMs, "判定一台机器是否可用的超时");
      inputs.discoverIntervalMs = el("input", { type: "number", value: String(s.discoverIntervalMs), style: SETTINGS_INPUT_STYLE + ";width:90px;flex:none" });
      row("重新探测间隔 (ms)", inputs.discoverIntervalMs, "重新扫描 ssh config 并探测 server 的间隔");
      // 跑马灯滚动速度（拖动条）：进程命令行超宽时自动滚动的速度，越小越慢
      {
        const r = el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:9px" }, m.body);
        el("label", {
          style: "flex:none;width:118px;color:var(--gpu-fg-dim)",
          textContent: "滚动速度 (px/s)",
          title: "进程命令行跑马灯滚动速度；越小越慢，悬停该行可暂停",
        }, r);
        inputs.marqueeSpeedPx = el("input", {
          type: "range", min: "20", max: "100", step: "5",
          style: "flex:1;accent-color:#2563eb;cursor:pointer",
        }, r);
        inputs.marqueeSpeedPx.value = String(marqueeSpeedPx);
        const speedVal = el("span", { style: "flex:none;width:52px;text-align:right;color:var(--gpu-fg)" }, r);
        const upd = () => { speedVal.textContent = inputs.marqueeSpeedPx.value + " px/s"; };
        inputs.marqueeSpeedPx.addEventListener("input", upd);
        upd();
      }
      inputs.includeLocal = el("input", { type: "checkbox", style: "flex:none" });
      inputs.includeLocal.checked = !!s.includeLocal;
      row("同时监控本机", inputs.includeLocal, "是否查询本机 nvidia-smi（macOS 无 nvidia-smi 时建议关闭）");
      inputs.sshConfigPath = el("input", { type: "text", value: s.sshConfigPath || "", placeholder: "默认 ~/.ssh/config", style: SETTINGS_INPUT_STYLE + ";flex:1" });
      row("SSH 配置路径", inputs.sshConfigPath, "留空 = ~/.ssh/config；可用 GPU_MONITOR_SSH_CONFIG 覆盖");
      // server 选取（仅多机模式；候选含不可达主机，勾选后恢复可达即自动纳入监控）
      if (s.useSshConfig) {
        const sec = el("div", { style: "border-top:1px solid var(--gpu-border);margin-top:10px;padding-top:10px" }, m.body);
        el("div", {
          style: "color:var(--gpu-fg-dim);margin-bottom:6px",
          textContent: "监控的 server（勾选启用；不勾选 = 不监控）",
        }, sec);
        const listEl = el("div", { style: "max-height:180px;overflow-y:auto" }, sec);
        const candidates = Array.isArray(data.candidates) ? data.candidates : [];
        if (candidates.length === 0) {
          el("div", {
            style: "color:var(--gpu-fg-dim);padding:4px 2px",
            textContent: "未发现候选主机（~/.ssh/config 为空或解析失败）",
          }, listEl);
        }
        for (const c of candidates) {
          const r = el("label", { style: "display:flex;align-items:center;gap:8px;padding:4px 2px;cursor:pointer" }, listEl);
          const cb = el("input", { type: "checkbox" }, r);
          cb.checked = !!c.enabled;
          cb.dataset.id = c.id;
          m.checkboxes.push(cb);
          el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", textContent: c.label, title: c.id }, r);
          el("span", {
            style: c.ok
              ? "flex:none;color:#22c55e;font-size:10px"
              : "flex:none;color:#f87171;font-size:10px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
            textContent: c.ok ? "✓ 可达" : "✗ " + (c.error || "不可达"),
            title: c.error || "",
          }, r);
        }
      } else {
        el("div", {
          style: "color:var(--gpu-fg-dim);border-top:1px solid var(--gpu-border);margin-top:10px;padding-top:10px",
          textContent: "当前为单机模式（未启用 ssh config 多机监控），无需选取 server",
        }, m.body);
      }
      m.inputs = inputs;
    }

    /** 收集表单并提交（本地先做与服务端一致的整数范围校验，避免无谓的 400）。 */
    async function saveSettings(m) {
      if (m.saving || !m.inputs) return;
      const i = m.inputs;
      const nums = [
        ["intervalMs", i.intervalMs.value, 100, 600000],
        ["timeoutMs", i.timeoutMs.value, 500, 300000],
        ["probeTimeoutMs", i.probeTimeoutMs.value, 500, 60000],
        ["discoverIntervalMs", i.discoverIntervalMs.value, 5000, 600000],
      ];
      for (const [key, v, lo, hi] of nums) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < lo || n > hi) {
          m.errEl.textContent = `${key} 必须是 ${lo}–${hi} 之间的整数`;
          return;
        }
      }
      const payload = {
        intervalMs: Number(i.intervalMs.value),
        timeoutMs: Number(i.timeoutMs.value),
        probeTimeoutMs: Number(i.probeTimeoutMs.value),
        discoverIntervalMs: Number(i.discoverIntervalMs.value),
        includeLocal: i.includeLocal.checked,
        sshConfigPath: i.sshConfigPath.value.trim(),
        marqueeSpeedPx: Number(i.marqueeSpeedPx.value),
      };
      // 有可勾选的候选才提交选取；空列表/单机模式不改动已有选取
      if (m.checkboxes.length) {
        payload.enabledServers = m.checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.id);
      }
      m.saving = true;
      m.btnSave.disabled = true;
      m.errEl.textContent = "";
      const r = await postSettings(payload);
      m.saving = false;
      m.btnSave.disabled = false;
      if (!settingsModal || settingsModal !== m) return; // 弹窗已关闭
      if (r.ok) {
        marqueeSpeedPx = Number(i.marqueeSpeedPx.value); // 立即生效（下次渲染提示时用新速度）
        closeSettings();
        tick(); // 立即按新设置拉取数据
      } else {
        m.errEl.textContent = "保存失败：" + (r.error || "未知错误");
      }
    }

    // —— 侧边栏槽位（React 挂载点） ——
    function GpuSection(props) {
      const ref = React.useRef();
      React.useEffect(() => {
        if (ref.current) {
          buildMonitorInto(ref.current, !!props.wide);
          renderGroups();
        }
      }, [props.wide]);
      return React.createElement("div", { ref, id: "dsh-gpu-monitor-dock" });
    }

    /** 视图入口：写入新快照并重渲染（data ← dataSource 归一化结果；dataStale 标记失败沿用）。 */
    function render(d, stale) {
      data = d;
      dataStale = !!stale;
      renderGroups();
      // 悬停期间每轮数据刷新同步提示：结构没变（进程列表一致）时不重建，
      // 悬浮窗/页面内提示的跑马灯动画不被打断；进程真正变化时立即更新内容与位置
      if (hoverServerId != null) {
        const anchor = hoverElement();
        if (anchor) {
          if (hoverKind === "sys") showSysTip(hoverServerId, anchor);
          else showTip(hoverServerId, hoverGpuIndex, anchor);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════
    // ② orderState —— 分组顺序协议
    // 顺序持久化在两侧：localStorage（本浏览器缓存）+ sidecar（宿主侧，跨浏览器共享"上次退出时的顺序"）。
    // 存储格式 {o: string[], t: 时间戳}；旧格式（裸数组）读取时兼容。
    // 协议：引擎下发的 order 已调和 → 直接信任；本地缓存仅离线兜底 → 用时按当前 ids 调和；
    //       时间戳大的胜出；本地比服务端新时回同步 POST（见 maybeAdoptServerOrder）。
    // ════════════════════════════════════════════════════════════════

    let serverOrder = [];
    let serverOrderTs = 0; // 当前生效顺序的时间戳
    let serverOrderDirty = false; // 本会话用户已手动排序 → 本地顺序优先，不再采纳服务端顺序
    let orderSyncTs = -1; // 已采纳过的服务端顺序时间戳
    let localOrder = null; // {o, t} | null（localStorage 缓存）
    try {
      const v = JSON.parse(localStorage.getItem(LS_ORDER_KEY) || "null");
      if (Array.isArray(v)) localOrder = { o: v.filter((x) => typeof x === "string"), t: 0 };
      else if (v && Array.isArray(v.o)) localOrder = { o: v.o.filter((x) => typeof x === "string"), t: Number(v.t) || 0 };
    } catch (e) {}
    if (localOrder) { serverOrder = localOrder.o; serverOrderTs = localOrder.t; }

    function saveLocalOrder(o, t) {
      try { localStorage.setItem(LS_ORDER_KEY, JSON.stringify({ o, t })); } catch {}
      localOrder = { o, t };
    }

    /**
     * 把顺序与当前机器 id 列表调和：保留已知 id 的顺序，新机器追加末尾。
     * 与引擎侧 engine.serveOrder 同一规则；客户端只在"离线缓存兜底"路径使用
     * （正常路径直接信任引擎下发的 order，见 maybeAdoptServerOrder）。
     */
    function reconcileOrder(order, ids) {
      const seen = new Set();
      const out = [];
      for (const id of order) if (ids.includes(id) && !seen.has(id)) { out.push(id); seen.add(id); }
      for (const id of ids) if (!seen.has(id)) out.push(id);
      return out;
    }

    /** 候选 sidecar 源（origin，去重），按序尝试：显式覆盖 → 当前页面同源（独立网页=sidecar 自己）→ DSH 默认 127.0.0.1:3499。 */
    function sidecarOrigins() {
      const out = [];
      const add = (u) => {
        try {
          const x = new URL(u, location.origin).origin;
          if (!out.includes(x)) out.push(x);
        } catch {}
      };
      try {
        const override = window.__DSH_GPU_MONITOR__ && window.__DSH_GPU_MONITOR__.sidecarUrl;
        if (typeof override === "string" && override) add(override);
      } catch {}
      try {
        const p = new URLSearchParams(location.search).get("gpuMonitorSidecar");
        if (p) add(p);
      } catch {}
      add(location.origin); // 独立网页：页面就是 sidecar 提供的 → 同源 POST
      add("http://127.0.0.1:3499"); // DSH 集成：默认 sidecar
      return out;
    }

    /** 尽力把顺序同步给所有候选源（宿主 /gpu/status 同源 + sidecar，跨浏览器共享）。
     * 全部失败静默（本浏览器 localStorage 仍生效）；任一成功即持久化到共享 order 文件。 */
    function postOrder(o, t) {
      const body = JSON.stringify({ o, t });
      for (const origin of sidecarOrigins()) {
        try {
          fetch(origin + "/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            cache: "no-store",
          }).catch(() => {});
        } catch {}
      }
    }

    /**
     * 会话开始/数据到达时，采纳宿主侧"上次退出时的顺序"；用户已手动排序则跳过。
     * 顺序协议（与 engine.serveOrder / orderstore 一致）：
     * - 引擎下发的 order 已按当前机器调和过（保留已知 id 顺序、新机器追加末尾），直接信任；
     * - 本地 localStorage 缓存仅在 sidecar 短暂离线时兜底，可能含过期 id，需按当前 ids 调和后再用；
     * - 时间戳大的胜出；本地比服务端新时回同步 POST 给 sidecar。
     * @param {object} d 归一化后的快照（含 d.order；由 dataSource.normalize 提供）
     * @param {string[]} ids 当前机器 id 列表
     */
    function maybeAdoptServerOrder(d, ids) {
      if (serverOrderDirty) return;
      const serverMeta = d && d.order && Array.isArray(d.order.o) ? d.order : null;
      let chosen = null;
      let ts = -1;
      if (serverMeta && (!localOrder || serverMeta.t >= localOrder.t)) {
        chosen = serverMeta.o; // 引擎已调和，直接信任线上的顺序
        ts = Number(serverMeta.t) || 0;
      } else if (localOrder) {
        chosen = reconcileOrder(localOrder.o, ids); // 离线缓存可能过期，按当前 ids 调和
        ts = localOrder.t;
        postOrder(chosen, ts); // 本地比服务端新（如 sidecar 曾短暂离线）→ 回同步
      }
      if (chosen && ts > orderSyncTs) {
        serverOrder = chosen;
        serverOrderTs = ts;
        orderSyncTs = ts;
        saveLocalOrder(serverOrder, ts);
      }
    }

    /** view → orderState 的接缝：从当前 DOM 顺序（排除错误/警告横幅与指示线）持久化 serverOrder，
     * 写入 localStorage 并回同步 sidecar。由拖动提交（commitDrag）调用。 */
    function persistOrderFromDom() {
      const order = [];
      for (const child of groupsEl.children) {
        const found = [...groupNodes.entries()].find(([, x]) => x.group === child);
        if (found) order.push(found[0]);
      }
      serverOrder = order;
      serverOrderDirty = true;
      const t = Date.now();
      serverOrderTs = t;
      saveLocalOrder(order, t);
      postOrder(order, t);
    }

    // ════════════════════════════════════════════════════════════════
    // ③ dataSource —— 数据源（多源拉取 + 归一化）
    // 优先级：同源桥(多机) → 宿主 /gpu/status(单机) → 可选绝对 sidecar。
    // 任一成功即返回；全失败返回 null（由编排层决定沿用上次数据）。
    // ════════════════════════════════════════════════════════════════

    /** 数据归一化：把三种线格式（servers[] / 旧扁平 gpus[] / sidecar JSON）统一成本地快照。 */
    function normalize(d) {
      if (!d) return null;
      const servers = Array.isArray(d.servers)
        ? d.servers
        : Array.isArray(d.gpus)
          ? [{ host: "local", label: "本机", ok: !!d.ok, at: d.at, gpus: d.gpus, error: d.error }]
          : [];
      return {
        source: d.source || "host",
        at: d.at,
        error: d.error || "",
        message: d.message || "",
        order: d.order || null, // 引擎已调和好的分组顺序（信任线上，见 maybeAdoptServerOrder）
        servers: servers.map((s, i) => ({
          id: String(s.host || s.label || "srv" + i),
          label: s.label || s.host || "server",
          ok: !!s.ok,
          at: s.at,
          gpus: Array.isArray(s.gpus) ? s.gpus : [],
          error: s.error || "",
          cpu: s.cpu || null, // {pct, cores, load1, windowSec}（非 Linux / 采样失败 = null）
          mem: s.mem || null, // {usedMB, totalMB, pct}
        })),
      };
    }

    /** 可选 sidecar 绝对地址：window.__DSH_GPU_MONITOR__.sidecarUrl 或 ?gpuMonitorSidecar= 覆盖；空串=禁用。默认 null（走同源桥）。 */
    function sidecarUrlOf() {
      const override = window.__DSH_GPU_MONITOR__ && window.__DSH_GPU_MONITOR__.sidecarUrl;
      if (override !== undefined) return override === "" ? null : override;
      const p = new URLSearchParams(location.search).get("gpuMonitorSidecar");
      if (p !== null) return p === "" ? null : p;
      return null;
    }

    async function fetchJson(url, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }

    /** POST JSON，返回 {status, body}；网络错误抛出（由调用方尝试下一个候选源）。 */
    async function postJson(url, body, timeoutMs = 3000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: ctrl.signal,
          cache: "no-store",
        });
        let j = null;
        try { j = await res.json(); } catch {}
        return { status: res.status, body: j };
      } finally {
        clearTimeout(timer);
      }
    }

    // —— 设置（设置页：可调参数 + server 选取） ——
    /** 从任一候选源读取设置（含候选 server 列表）；全部失败返回 null。
     *  超时放宽到 8s：首次打开时 GET 会触发一次探测（最坏 ~probeTimeoutMs）。 */
    async function fetchSettings() {
      for (const o of sidecarOrigins()) {
        try {
          const x = await fetchJson(o + SETTINGS_URL, 8000);
          if (x && x.settings) return x;
        } catch (e) {}
      }
      return null;
    }

    /** 提交设置补丁；任一候选源成功即成功，否则返回服务端错误或"不可达"。 */
    async function postSettings(payload) {
      const body = JSON.stringify(payload);
      for (const o of sidecarOrigins()) {
        try {
          const r = await postJson(o + SETTINGS_URL, body);
          if (r.status === 200) return { ok: true };
          // 服务端已响应但拒绝（校验失败）：把具体错误带给用户，不再尝试其它源
          return { ok: false, error: (r.body && r.body.error) || `设置被拒绝（HTTP ${r.status}）` };
        } catch (e) {}
      }
      return { ok: false, error: "设置接口不可达（sidecar 或宿主未运行）" };
    }

    /** 多源拉取：同源桥(多机) → 宿主 /gpu/status(本机) → 可选绝对 sidecar。任一成功即返回。 */
    async function fetchStatus() {
      // 1) 同源 /gpu-status.json（sidecar 写入，无 CORS）
      try {
        const x = await fetchJson(SIDECAR_JSON_URL, 2500);
        if (x && Array.isArray(x.servers) && x.servers.some((s) => s.ok)) return x;
      } catch (e) {}
      // 2) 宿主 /gpu/status（旧扁平结构 = 单机“本机”分组）
      try {
        const x = await fetchJson(STATUS_URL, 4000);
        if (x) return x;
      } catch (e) {}
      // 3) 可选绝对 sidecar 地址（远程部署）
      const override = sidecarUrlOf();
      if (override) {
        try {
          const x = await fetchJson(override, 2000);
          if (x && Array.isArray(x.servers)) return x;
        } catch (e) {}
      }
      return null;
    }

    // ════════════════════════════════════════════════════════════════
    // ④ 入口与编排 —— apply() + tick()：把三个接缝接起来
    // ════════════════════════════════════════════════════════════════

    /** 编排一轮：dataSource 拉取 → orderState 采纳顺序 → view 渲染。 */
    async function tick() {
      syncTheme(); // 保险：每轮刷新时同步主题（DSH 切换主题后及时跟上）
      const d = await fetchStatus();
      if (d) {
        lastGood = normalize(d);
        // 会话开始时采纳宿主侧"上次退出时的顺序"（用户已手动排序则不覆盖）
        maybeAdoptServerOrder(lastGood, lastGood.servers.map((s) => s.id));
      }
      // 失败时沿用上次数据；仅从未成功过才显示全局错误
      render(lastGood, d === null);
      if (!docked) placeFloating();
    }

    function apply(ctx) {
      if (document.getElementById("dsh-gpu-monitor-dock") || document.getElementById("dsh-gpu-monitor")) return;
      watchTheme();
      injectTheme();
      // 独立页/App 的"手动刷新"按钮：触发立即拉取新数据（等不到下一个 3s 周期）
      window.addEventListener("gpu-monitor-refresh", () => {
        tick();
      });
      // 独立页/App 顶栏的 ⚙（webui.mjs）：打开设置弹窗
      window.addEventListener("gpu-monitor-open-settings", () => openSettings());
      // 停靠进侧边栏底部（布局固定部件）；失败则退回悬浮
      try {
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-gpu-monitor",
          order: 10,
          inject: () => ({}),
        }, GpuSection));
        docked = true;
      } catch (e) {
        docked = false;
        buildFloatingFallback();
      }
      tick();
      setInterval(tick, REFRESH_MS);
      // 启动时后台同步一次设置（滚动速度等），未打开设置页也生效；失败静默用默认值
      fetchSettings()
        .then((x) => {
          const v = x && x.settings && Number(x.settings.marqueeSpeedPx);
          if (Number.isFinite(v)) marqueeSpeedPx = Math.max(20, Math.min(100, v));
        })
        .catch(() => {});
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
