// dsh-gpu-monitor: 浏览器半部（纯 DOM + React 挂载点）。
// GPU 监控停靠进左侧边栏底部（sidebar.footer.action 槽位），是页面布局的固定部分（非悬浮）：
//   每 GPU 一个方块——填充百分比 = 显存占用；填充颜色 = 功率（按功率/上限占比分级）；
//   方块上写 显存 与 功率 数字。
//   鼠标在方块上停留 ~0.5s → 显示该卡上的计算进程（属主 / PID / 占用显存 / 命令行）。
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
    const HOVER_DELAY_MS = 500;

    let monitorRoot = null;
    let headTitle, headTime, blocksEl;
    let data = null;
    let wide = true;
    let hadError = false;
    let docked = false;
    const blockNodes = new Map(); // index -> {block, fill, tMem, tPwr}

    // 悬停提示
    let tip = null;
    let hoverTimer = null;
    let hoverIdx = null;

    function el(tag, props, parent) {
      const n = document.createElement(tag);
      if (props) for (const k in props) n[k] = props[k];
      if (parent) parent.appendChild(n);
      return n;
    }

    function colorOf(util) {
      return util >= 90 ? "#ef4444" : util >= 50 ? "#f59e0b" : "#22c55e";
    }

    function powerColor(g) {
      const p = g.powerW;
      const limit = g.powerLimitW;
      const ratio = limit > 0 ? p / limit : p <= 0 ? 0 : p / 300;
      if (!Number.isFinite(ratio) || ratio <= 0) return "#3b82f6";
      return ratio >= 0.9 ? "#ef4444" : ratio >= 0.7 ? "#f59e0b" : ratio >= 0.4 ? "#eab308" : "#22c55e";
    }

    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }

    function fmtMem(mb) {
      return mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M";
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
      const head = el("div", {
        style:
          "display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--gpu-head);" +
          "border-bottom:1px solid var(--gpu-border);user-select:none",
      });
      headTitle = el("span", { textContent: "🎮 GPU", style: "font-weight:600;flex:1;font-size:11px" }, head);
      headTime = el("span", { textContent: "…", style: "opacity:.55;font-size:10px" }, head);
      root.appendChild(head);
      blocksEl = el("div", {
        style: "display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;align-items:flex-start",
      }, root);
    }

    function makeBlock(index) {
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
      // 悬停（延迟）显示进程；触摸点击切换
      block.addEventListener("mouseenter", () => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (block.isConnected) showTip(index, block);
        }, HOVER_DELAY_MS);
      });
      block.addEventListener("mouseleave", () => {
        clearTimeout(hoverTimer);
        hideTip();
      });
      block.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (hoverIdx === index) hideTip();
        else showTip(index, block);
      }, { passive: false });
      blockNodes.set(index, { block, fill, tMem, tPwr });
      return block;
    }

    function renderBlocks() {
      if (!data || !data.ok) {
        hadError = true;
        if (headTitle) headTitle.textContent = "🎮 GPU !";
        if (headTime) {
          headTime.textContent = "!";
          headTime.title = data && data.error ? data.error : "无数据";
        }
        if (blocksEl && blockNodes.size === 0) {
          blocksEl.innerHTML = "";
          el("div", {
            style: "color:#f87171;font-size:10px;word-break:break-all;max-width:220px;flex:none",
            textContent: data && data.error ? data.error : "无数据",
          }, blocksEl);
        }
        return;
      }
      if (hadError && blocksEl) {
        blocksEl.innerHTML = "";
        blockNodes.clear();
        hadError = false;
      }
      if (headTitle) headTitle.textContent = `🎮 GPU ${data.gpus.length}卡`;
      if (headTime) {
        headTime.textContent = new Date(data.at).toLocaleTimeString();
        headTime.title = "";
      }
      if (!blocksEl) return;
      for (const g of data.gpus) {
        let n = blockNodes.get(g.index);
        if (!n || !n.block.isConnected) {
          if (n) blockNodes.delete(g.index);
          blocksEl.appendChild(makeBlock(g.index));
          n = blockNodes.get(g.index);
        }
        const memPct = g.memTotalMB > 0 ? clamp((g.memUsedMB / g.memTotalMB) * 100, 0, 100) : 0;
        n.fill.style.height = memPct + "%";
        n.fill.style.background = powerColor(g);
        n.tMem.textContent = `${(g.memUsedMB / 1024).toFixed(0)}/${(g.memTotalMB / 1024).toFixed(0)}`;
        n.tPwr.textContent = `${Math.round(g.powerW)}W`;
      }
      for (const [idx, n] of blockNodes) {
        if (!data.gpus.some((g) => g.index === idx)) {
          n.block.remove();
          blockNodes.delete(idx);
        }
      }
    }

    // —— 悬停进程提示 ——
    function ensureTip() {
      if (tip) return tip;
      tip = el("div", {
        id: "dsh-gpu-monitor-tip",
        className: "dsh-gpu-monitor",
        style:
          "position:fixed;z-index:2147483001;display:none;pointer-events:none;max-width:340px;" +
          "background:var(--gpu-bg);color:var(--gpu-fg);border:1px solid var(--gpu-border);" +
          "border-radius:8px;padding:6px 9px;box-shadow:0 4px 16px rgba(0,0,0,.45);" +
          "font:11px/1.5 ui-monospace,Menlo,monospace",
      });
      document.body.appendChild(tip);
      return tip;
    }

    function renderTip() {
      if (hoverIdx == null || !tip) return;
      const g = data && data.gpus && data.gpus.find((x) => x.index === hoverIdx);
      tip.innerHTML = "";
      if (!g) {
        tip.textContent = "…";
        return;
      }
      const head = el("div", { style: "font-weight:700;margin-bottom:4px" }, tip);
      head.textContent = `GPU${g.index} ${g.name}`;
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
        el("div", {
          style: "font-weight:600;margin-top:2px",
          textContent: `● ${p.user || "?"} · PID ${p.pid} · ${fmtMem(p.memMB)} · ${p.name || ""}`,
        }, tip);
        if (p.cmd) {
          el("div", {
            style: "opacity:.7;margin-left:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px",
            textContent: p.cmd.length > 70 ? p.cmd.slice(0, 70) + "…" : p.cmd,
          }, tip);
        }
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

    function showTip(index, block) {
      hoverIdx = index;
      ensureTip();
      renderTip();
      positionTip(block.getBoundingClientRect());
      tip.style.display = "block";
    }

    function hideTip() {
      clearTimeout(hoverTimer);
      hoverIdx = null;
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
          renderBlocks();
        }
      }, [props.wide]);
      return React.createElement("div", { ref, id: "dsh-gpu-monitor-dock" });
    }

    function render(d) {
      data = d;
      renderBlocks();
      if (hoverIdx != null) renderTip();
    }

    async function tick() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(STATUS_URL, { signal: ctrl.signal });
        render(await res.json());
      } catch (e) {
        render({ ok: false, error: `连接失败 ${STATUS_URL}\n${e && e.message ? e.message : e}` });
      } finally {
        clearTimeout(timer);
      }
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
