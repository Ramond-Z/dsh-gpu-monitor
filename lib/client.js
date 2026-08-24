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

    const REFRESH_MS = 3000;
    const STATUS_URL = "/gpu/status";
    const SIDECAR_JSON_URL = "/gpu-status.json"; // 同源桥：sidecar 写入 dsh 前端 dist
    const SIDECAR_URL = "http://127.0.0.1:3499/status"; // 可选绝对地址（远程部署覆盖）
    const HOVER_DELAY_MS = 500;
    const HIDE_DELAY_MS = 350;
    const LS_HEIGHT_KEY = "dsh-gpu-monitor:height";
    const LS_ORDER_KEY = "dsh-gpu-monitor:order";
    const DEFAULT_MAX_HEIGHT = "42vh";
    const MIN_PANEL_H = 64;
    const MAX_PANEL_H_RATIO = 0.9;

    // 面板高度（用户可上下拖动调整，记住在 localStorage）
    let savedHeight = null; // px；null = 用默认 max-height
    try {
      const v = Number(localStorage.getItem(LS_HEIGHT_KEY));
      if (Number.isFinite(v) && v >= MIN_PANEL_H) savedHeight = v;
    } catch (e) {}

    // 服务器分组显示顺序（用户拖动排序，记住在 localStorage）
    let serverOrder = [];
    try {
      const v = JSON.parse(localStorage.getItem(LS_ORDER_KEY) || "[]");
      if (Array.isArray(v)) serverOrder = v.filter((x) => typeof x === "string");
    } catch (e) {}
    let dragging = false; // 分组拖动进行中（抑制方块悬停提示）
    let dropMarker = null; // 插入位置指示线
    let dragState = null; // {group, id, before}
    // 拖动排序期间阻止触摸滚动干扰
    document.addEventListener("touchmove", (e) => {
      if (dragging) e.preventDefault();
    }, { passive: false });

    let monitorRoot = null;
    let groupsEl = null;
    let data = null; // 归一化后: {source, at, servers:[{id,label,ok,at,gpus,error}]}
    let lastGood = null; // 最近一次成功数据（拉取失败时沿用）
    let dataStale = false;
    let errorBannerEl = null;
    let wide = true;
    let docked = false;
    const groupNodes = new Map(); // serverId -> {group, head, title, time, blocksEl}
    const blockNodes = new Map(); // "serverId::index" -> {block, fill, tMem, tPwr}

    // 悬停提示
    let tip = null;
    let hoverTimer = null;
    let hoverServerId = null;
    let hoverGpuIndex = null;

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

    /** 从完整命令行提炼简短标签：保留解释器前缀（python/bash），脚本取文件名，最多带 2 个参数。 */
    function shortCmd(cmd) {
      if (!cmd) return "";
      const parts = cmd.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "";
      const py = (t) => /^(?:.*\/)?python3?(?:\.[0-9]+)?$/.test(t);
      const shell = (t) => /^(?:.*\/)?(?:bash|sh)$/.test(t);
      let i = 0;
      // 跳过运行器包装（uv run / conda run / nohup / env KEY=VAL…）
      while (i < parts.length) {
        const b = parts[i].split("/").pop();
        if (b === "uv" || b === "conda" || b === "nohup") {
          i++;
          if (parts[i] === "run") i++;
          continue;
        }
        if (b === "env") {
          i++;
          while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
          continue;
        }
        break;
      }
      const out = [];
      // 保留解释器前缀
      if (i < parts.length && (py(parts[i]) || shell(parts[i]))) {
        out.push(parts[i].split("/").pop());
        i++;
      }
      // 脚本 basename + 最多 2 个关键参数
      const rest = parts.slice(i);
      if (rest.length) {
        out.push(rest[0].split("/").pop());
        let n = 1;
        for (let j = 1; j < rest.length && n < 3; j++) {
          const v = rest[j];
          if (v.length > 40) continue;
          out.push(v);
          n++;
        }
      }
      return out.join(" ") || cmd.trim().split("/").pop().slice(0, 40);
    }

    function injectTheme() {
      if (document.getElementById("dsh-gpu-monitor-style")) return;
      const s = document.createElement("style");
      s.id = "dsh-gpu-monitor-style";
      s.textContent =
        ".dsh-gpu-monitor{--gpu-bg:rgba(17,17,19,.96);--gpu-fg:#e4e4e7;--gpu-border:#333;" +
        "--gpu-head:#1c1c1e;--gpu-card:#141416;--gpu-track:#2a2a2d}" +
        "@media (prefers-color-scheme: light){.dsh-gpu-monitor{--gpu-bg:rgba(255,255,255,.97);" +
        "--gpu-fg:#1f2937;--gpu-border:#d1d5db;--gpu-head:#f3f4f6;--gpu-card:#fafafa;--gpu-track:#e5e7eb}}";
      document.head.appendChild(s);
    }

    // —— 数据归一化 ——
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
        servers: servers.map((s, i) => ({
          id: String(s.host || s.label || "srv" + i),
          label: s.label || s.host || "server",
          ok: !!s.ok,
          at: s.at,
          gpus: Array.isArray(s.gpus) ? s.gpus : [],
          error: s.error || "",
        })),
      };
    }

    function powerColor(g) {
      const p = g.powerW;
      const limit = g.powerLimitW;
      const ratio = limit > 0 ? p / limit : p <= 0 ? 0 : p / 300;
      if (!Number.isFinite(ratio) || ratio <= 0) return "#3b82f6";
      return ratio >= 0.9 ? "#ef4444" : ratio >= 0.7 ? "#f59e0b" : ratio >= 0.4 ? "#eab308" : "#22c55e";
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
      groupsEl = el("div", {
        style:
          "display:flex;flex-direction:column;gap:2px;max-height:" + DEFAULT_MAX_HEIGHT + ";overflow-y:auto;" +
          "scrollbar-width:thin;position:relative",
      }, root);
      initResizeHandle(root, groupsEl);
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
      const group = el("div", { style: "flex:none" });
      const head = el("div", {
        style:
          "display:flex;align-items:center;gap:6px;padding:5px 9px;background:var(--gpu-head);" +
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
      const blocksEl = el("div", {
        style: "display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;align-items:flex-start",
      }, group);
      groupNodes.set(s.id, { group, head, title, time, blocksEl });
      initGroupDrag(group, head, s);
      return groupNodes.get(s.id);
    }

    /** 从当前 DOM 顺序持久化 serverOrder（排除错误/警告横幅与指示线）。 */
    function persistOrderFromDom() {
      const order = [];
      for (const child of groupsEl.children) {
        const found = [...groupNodes.entries()].find(([, x]) => x.group === child);
        if (found) order.push(found[0]);
      }
      serverOrder = order;
      try { localStorage.setItem(LS_ORDER_KEY, JSON.stringify(serverOrder)); } catch {}
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

    /** 松手：执行 DOM 移动 + FLIP 滑动动画（位移分组平滑让位）。 */
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
      persistOrderFromDom();
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
        style:
          "position:relative;width:46px;height:46px;border-radius:6px;overflow:hidden;" +
          "border:1px solid var(--gpu-border);background:var(--gpu-card);cursor:pointer;flex:none",
      });
      const fill = el("div", {
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
      // 悬停（延迟）显示进程；触摸点击切换（拖动排序时抑制）
      block.addEventListener("mouseenter", () => {
        if (dragging) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (block.isConnected) showTip(serverId, index, block);
        }, HOVER_DELAY_MS);
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
      if (g && g.blocksEl) g.blocksEl.innerHTML = "";
    }

    function renderGroup(g, s, isFirst) {
      g.group.style.borderTop = isFirst ? "none" : "1px solid var(--gpu-border)";
      if (!s.ok) {
        g.title.textContent = `🎮 ${s.label} !`;
        g.title.title = s.error || "查询失败";
        g.time.textContent = "!";
        g.time.title = s.error || "";
        // 失败时清掉旧方块，只留错误说明
        clearBlocksOf(s.id);
        el("div", {
          style: "color:#f87171;font-size:10px;word-break:break-all;max-width:240px;flex:none",
          textContent: s.error || "无数据",
        }, g.blocksEl);
        return;
      }
      g.time.textContent = s.at ? new Date(s.at).toLocaleTimeString() : "…";
      g.time.title = "";
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
          g.blocksEl.appendChild(makeBlock(s.id, gg.index));
          n = blockNodes.get(key);
        }
        const memPct = gg.memTotalMB > 0 ? clamp((gg.memUsedMB / gg.memTotalMB) * 100, 0, 100) : 0;
        n.fill.style.height = memPct + "%";
        n.fill.style.background = powerColor(gg);
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
        // 整体无数据：显示全局错误（不破坏旧分组 DOM）
        const label = data.error || "未发现可用 GPU server（sidecar 未运行？）";
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
        style:
          "position:fixed;z-index:2147483001;display:none;max-width:340px;" +
          "background:var(--gpu-bg);color:var(--gpu-fg);border:1px solid var(--gpu-border);" +
          "border-radius:8px;padding:6px 9px;box-shadow:0 4px 16px rgba(0,0,0,.45);" +
          "font:11px/1.5 ui-monospace,Menlo,monospace;user-select:text",
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

    function renderTip() {
      if (hoverServerId == null || hoverGpuIndex == null || !tip) return;
      const server = data && data.servers.find((s) => s.id === hoverServerId);
      const g = server && server.gpus.find((x) => x.index === hoverGpuIndex);
      // 内容没变化就不重建（避免打断选中/复制）
      const sig = g
        ? JSON.stringify([hoverServerId, hoverGpuIndex, g.memUsedMB, g.memTotalMB, g.utilPct, g.tempC, g.powerW, g.processes])
        : "none";
      if (tip._sig === sig) return;
      tip._sig = sig;
      tip.innerHTML = "";
      if (!g) {
        tip.textContent = "…";
        return;
      }
      const head = el("div", { style: "font-weight:700;margin-bottom:4px" }, tip);
      head.textContent =
        data.servers.length > 1 ? `${server.label} · GPU${g.index} ${g.name}` : `GPU${g.index} ${g.name}`;
      const procs = g.processes;
      if (!Array.isArray(procs)) {
        el("div", { style: "color:#f59e0b", textContent: "进程数据暂不可用（宿主需重启生效）" }, tip);
        return;
      }
      if (procs.length === 0) {
        el("div", { style: "opacity:.8", textContent: "无计算进程" }, tip);
        return;
      }
      for (const p of procs) {
        const label = shortCmd(p.cmd) || p.name || "";
        el("div", {
          style:
            "font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px",
          textContent: `● ${p.user || "?"} · ${fmtMem(p.memMB)} · ${label}`,
          title: p.cmd || "",
        }, tip);
      }
    }

    function positionTip(anchorRect) {
      if (!tip) return;
      tip.style.visibility = "hidden";
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.visibility = "visible";
      let left = anchorRect.right + 8;
      if (left + tw > window.innerWidth - 4) left = Math.max(4, anchorRect.left - tw - 8);
      const top = clamp(anchorRect.top - 4, 4, Math.max(4, window.innerHeight - th - 4));
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }

    function showTip(serverId, index, block) {
      hoverServerId = serverId;
      hoverGpuIndex = index;
      ensureTip();
      renderTip();
      positionTip(block.getBoundingClientRect());
      tip.style.display = "block";
    }

    function hideTip() {
      clearTimeout(hoverTimer);
      hoverServerId = null;
      hoverGpuIndex = null;
      if (tip) tip.style.display = "none";
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

    function render(d, stale) {
      data = d;
      dataStale = !!stale;
      renderGroups();
      if (hoverServerId != null) renderTip();
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

    async function tick() {
      const d = await fetchStatus();
      if (d) {
        lastGood = normalize(d);
      }
      // 失败时沿用上次数据；仅从未成功过才显示全局错误
      render(lastGood, d === null);
      if (!docked) placeFloating();
    }

    function apply(ctx) {
      if (document.getElementById("dsh-gpu-monitor-dock") || document.getElementById("dsh-gpu-monitor")) return;
      injectTheme();
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
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
