// dsh-gpu-monitor: 共享监控引擎 —— DSH 宿主插件（lib/index.js）与独立 sidecar 共用的核心。
// 封装：ssh config 探测（发现可用 GPU server）、周期并行查询、分组顺序持久化与调和、状态快照与订阅、
// 运行时设置（设置页可调参数与 server 选取，见 lib/settings.mjs）。
// 通过 `query`/`probe` 选项可注入查询实现（单元测试用）。
import { parseSshConfig, defaultSshConfigPath } from "./sshconfig.mjs";
import { probeServer, queryGpus, queryServer, targetHost } from "./query.mjs";
import { OrderStore } from "./orderstore.mjs";
import { SettingsStore, sanitizeSettings } from "./settings.mjs";

/**
 * @param {object} opts
 * @param {number} [opts.intervalMs] 查询间隔（默认 3000）
 * @param {number} [opts.timeoutMs] 每台机器查询超时（默认 8000）
 * @param {number} [opts.probeTimeoutMs] 探测超时（默认 4000）
 * @param {number} [opts.discoverIntervalMs] 重新探测列表间隔（默认 60000）
 * @param {boolean} [opts.useSshConfig] 解析 ~/.ssh/config 多机监控（默认 false）
 * @param {string} [opts.sshConfigPath] ssh config 路径（空 = 默认 ~/.ssh/config）
 * @param {string} [opts.sshTarget] 单目标 "user@host"（useSshConfig=false 时生效）
 * @param {boolean} [opts.includeLocal] 是否同时查询本机
 * @param {string} [opts.localLabel] 本机分组标签（默认 "本机"）
 * @param {string} [opts.orderFile] 顺序持久化文件（空 = 仅内存）
 * @param {string} [opts.settingsFile] 运行时设置持久化文件（空 = 仅内存；设置页修改存这里）
 * @param {string} [opts.source] 状态来源标识（默认 "engine"）
 * @param {(...a: any[]) => void} [opts.log]
 * @param {(ctx: {sshTarget: string, servers: object[], includeLocal: boolean, timeoutMs: number, localLabel: string}) => Promise<object[]>} [opts.query] 可注入查询（测试）
 * @param {(target: object, opts: {timeoutMs: number}) => Promise<{ok: boolean, error?: string}>} [opts.probe] 可注入探测（测试）
 * @returns {{start: Function, stop: Function, tick: Function, refresh: Function, discover: Function,
 *            getState: Function, setOrder: Function, onUpdate: Function, listServers: Function,
 *            serveOrder: Function, setSettings: Function, getSettings: Function,
 *            serverCandidates: Function, ensureDiscovered: Function}}
 */
export function createMonitorEngine(opts = {}) {
  const {
    intervalMs = 3000,
    timeoutMs = 8000,
    probeTimeoutMs = 4000,
    discoverIntervalMs = 60000,
    useSshConfig = false,
    sshConfigPath = "",
    sshTarget = "",
    includeLocal = true,
    localLabel = "本机",
    orderFile = "",
    settingsFile = "",
    source = "engine",
    log = () => {},
    query = null,
    probe = probeServer,
  } = opts;

  const orderStore = new OrderStore(orderFile, log);
  // 运行时设置：启动配置（env/cordis）只作初始值；设置文件（settingsFile）里存在的键优先。
  const settingsStore = new SettingsStore(settingsFile, log);
  const settings = {
    intervalMs,
    timeoutMs,
    probeTimeoutMs,
    discoverIntervalMs,
    includeLocal,
    sshConfigPath,
    enabledServers: null, // null = 全部 server；数组 = 显式选取（仅这些）
  };
  Object.assign(settings, settingsStore.get());

  let state = { ok: false, at: null, source, servers: [], error: "初始化中…" };
  let available = []; // 已探测可用的 server 目标（sshconfig 解析结果）
  let allCandidates = []; // 最近一次解析出的全部候选（含不可达；设置页展示用）
  const candidateStatus = new Map(); // server key -> {ok, error, lastProbeAt}
  let discovered = false;
  let running = false;
  let started = false;
  let tickTimer = null;
  let discoverTimer = null;
  const listeners = new Set();

  const keyOf = targetHost;

  /** 是否启用某 server（enabledServers 为 null = 全部启用）。 */
  function enabledOf(id) {
    return settings.enabledServers === null || settings.enabledServers.includes(id);
  }

  /** 当前实际要查询的 server 列表（可用 ∩ 用户选取）。 */
  function queryable() {
    return available.filter((t) => enabledOf(keyOf(t)));
  }

  /** 当前机器 id 列表（本机 + 已启用 server + 最近一次查询结果，去重保序）。 */
  function serverIds() {
    const ids = [];
    const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
    if (settings.includeLocal) push("local");
    for (const t of queryable()) push(keyOf(t));
    for (const s of state.servers || []) push(s && (s.host || s.label));
    return ids;
  }

  /** 存储顺序与当前机器调和：保留已知 id 的顺序，新机器追加到末尾。 */
  function serveOrder() {
    const ids = serverIds();
    const { o, t } = orderStore.get();
    const seen = new Set();
    const out = [];
    for (const id of o) if (ids.includes(id) && !seen.has(id)) { out.push(id); seen.add(id); }
    for (const id of ids) if (!seen.has(id)) out.push(id);
    return { o: out, t };
  }

  /** 执行一次查询，返回 servers 数组（统一结构）。 */
  async function runQuery() {
    const servers = queryable();
    if (query) {
      return (await query({ sshTarget, servers, includeLocal: settings.includeLocal, timeoutMs: settings.timeoutMs, localLabel })) || [];
    }
    if (useSshConfig) {
      // 没有本机也没有可查询 server 时直接返回空，避免在 macOS 上空跑一次本机 nvidia-smi
      if (!settings.includeLocal && servers.length === 0) return [];
      const r = await queryGpus({ servers, includeLocal: settings.includeLocal, timeoutMs: settings.timeoutMs, localLabel });
      return r.servers || [];
    }
    if (sshTarget) return [await queryServer(sshTarget, { timeoutMs: settings.timeoutMs, label: sshTarget })];
    return [await queryServer(null, { timeoutMs: settings.timeoutMs, label: localLabel })];
  }

  let lastDiscoveryMessage = "";
  const probeFails = new Map(); // server key -> 连续探测失败次数
  const MAX_PROBE_FAILS = 2; // 连续失败 ≥2 次才移除（容忍瞬时网络抖动）

  /** 探测 ssh config 候选，合并进 available；同时记录"无可用 server"时的诊断信息。
   *  单次全失败不会清空列表：旧主机连续失败不足 MAX_PROBE_FAILS 次的保留。
   *  候选与可达状态记入 allCandidates / candidateStatus，供设置页展示。 */
  async function discover() {
    try {
      const candidates = parseSshConfig(settings.sshConfigPath);
      allCandidates = candidates;
      if (candidates.length === 0) {
        discovered = true;
        available = [];
        candidateStatus.clear();
        lastDiscoveryMessage = `~/.ssh/config 未找到主机条目（${settings.sshConfigPath || defaultSshConfigPath()}）`;
        log(lastDiscoveryMessage);
        return;
      }
      const results = await Promise.all(
        candidates.map(async (c) => {
          const key = keyOf(c);
          try {
            const p = await probe(c, { timeoutMs: settings.probeTimeoutMs });
            candidateStatus.set(key, { ok: p.ok, error: p.ok ? "" : (p.error || ""), lastProbeAt: Date.now() });
            if (p.ok) {
              probeFails.set(key, 0);
              return { target: c, ok: true, error: "" };
            }
            probeFails.set(key, (probeFails.get(key) || 0) + 1);
            return { target: null, ok: false, error: p.error || "" };
          } catch (e) {
            candidateStatus.set(key, { ok: false, error: String(e), lastProbeAt: Date.now() });
            probeFails.set(key, (probeFails.get(key) || 0) + 1);
            return { target: null, ok: false, error: String(e) };
          }
        })
      );
      const okTargets = results.filter((r) => r.ok).map((r) => r.target);
      const candidateKeys = new Set(candidates.map(keyOf));
      // 保留：仍在配置中 且 连续失败未达上限 的旧主机
      const kept = available.filter(
        (t) => candidateKeys.has(keyOf(t)) && (probeFails.get(keyOf(t)) || 0) < MAX_PROBE_FAILS
      );
      const keptKeys = new Set(kept.map(keyOf));
      const added = okTargets.filter((t) => !keptKeys.has(keyOf(t)));
      available = [...kept, ...added];
      discovered = true;

      let msg = "";
      if (available.length === 0) {
        const sample = results.find((r) => r.error)?.error || "";
        msg = `探测了 ${candidates.length} 个候选主机（${candidates.map(keyOf).join(", ")}），均不可达或无 GPU`;
        if (sample) msg += `；示例错误: ${sample}`;
      }
      lastDiscoveryMessage = msg;
      if (okTargets.length === 0 && available.length > 0) {
        log(`本轮探测全部失败，保留上次 ${available.length} 个 server，等待恢复`);
      } else {
        log(`ssh config 发现 ${available.length} 个可用 GPU server: ${available.map(keyOf).join(", ") || "（无）"}`);
      }
    } catch (e) {
      log("ssh config 解析失败:", String(e));
      allCandidates = [];
      available = [];
      candidateStatus.clear();
      discovered = true;
      lastDiscoveryMessage = `~/.ssh/config 解析失败: ${String(e).split("\n")[0]}`;
    }
  }

  /** 周期查询：本机 + 每个 server 并行。 */
  let pendingTick = false;
  let refreshWaiter = null; // refresh() 的完成信号（一次查询链结束后触发）

  async function tick() {
    if (running) {
      // 查询进行中（如手动刷新撞上周期查询）：标记一次补查，结束后立即执行
      pendingTick = true;
      return;
    }
    running = true;
    try {
      if (useSshConfig && !discovered) await discover();
      const servers = await runQuery();
      state = {
        ok: servers.some((s) => s && s.ok),
        at: new Date().toISOString(),
        source,
        servers,
        error: "",
        message: servers.length === 0 ? lastDiscoveryMessage : "",
      };
    } catch (e) {
      // 保留上次数据，仅标记失败（不搞崩启动）
      state = { ...state, ok: false, at: new Date().toISOString(), error: String(e) };
    } finally {
      running = false;
      const again = pendingTick;
      pendingTick = false;
      notify();
      if (again) tick(); // 补一次查询（手动刷新不应被周期查询吞掉）
      else if (refreshWaiter) {
        const w = refreshWaiter;
        refreshWaiter = null;
        w();
      }
    }
  }

  /**
   * 立即执行一次查询并返回完成后的状态快照（手动刷新用）。
   * 查询进行中则排队一次补查，等补查链结束再返回 —— 调用方（HTTP /refresh）无需轮询。
   * @returns {Promise<object>} 查询完成后的新状态快照
   */
  async function refresh() {
    if (!running) {
      await tick();
      return getState();
    }
    // 查询进行中：标记补查，等补查链结束
    pendingTick = true;
    await new Promise((resolve) => {
      refreshWaiter = () => resolve();
      // 兜底：查询异常悬挂时也要返回（正常路径下补查结束即 resolve，此为双保险）
      setTimeout(resolve, settings.timeoutMs * 2 + 5000).unref?.();
    });
    return getState();
  }

  function notify() {
    for (const cb of listeners) {
      try { cb(getState()); } catch {}
    }
  }

  /** 最新状态快照（order 实时调和）。 */
  function getState() {
    return { ...state, order: serveOrder() };
  }

  /** 当前可用的 server 别名列表（供 /health 等展示）。 */
  function listServers() {
    return available.map(keyOf);
  }

  /**
   * 接受客户端提交的顺序（POST /order）。时间戳不低于当前值才生效。
   * @returns {{o: string[], t: number}|null} 调和后的顺序；参数非法返回 null
   */
  function setOrder(o, t) {
    if (!Array.isArray(o) || !Number.isFinite(t)) return null;
    orderStore.set(o, t);
    const next = serveOrder();
    notify();
    return next;
  }

  /** 订阅状态更新（tick 完成 / 顺序变更）。返回退订函数。 */
  function onUpdate(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** 按当前设置重启 tick / discover 定时器（started 后调用才真正生效）。 */
  function restartTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (discoverTimer) clearInterval(discoverTimer);
    tickTimer = null;
    discoverTimer = null;
    if (!started) return;
    tickTimer = setInterval(tick, settings.intervalMs);
    tickTimer.unref?.();
    if (useSshConfig) {
      discoverTimer = setInterval(() => {
        discover().catch(() => {});
      }, settings.discoverIntervalMs);
      discoverTimer.unref?.();
    }
  }

  /** 启动：立即 tick + 周期查询（+ ssh config 周期重探测）。 */
  function start() {
    if (started) return;
    started = true;
    tick();
    restartTimers();
  }

  /** 停止所有定时器与订阅。 */
  function stop() {
    started = false;
    if (tickTimer) clearInterval(tickTimer);
    if (discoverTimer) clearInterval(discoverTimer);
    tickTimer = null;
    discoverTimer = null;
    listeners.clear();
  }

  // —— 运行时设置（设置页） ——

  /** 当前生效的设置（sshConfigPath 显示为解析后的实际路径；useSshConfig 只读）。 */
  function getSettings() {
    return {
      intervalMs: settings.intervalMs,
      timeoutMs: settings.timeoutMs,
      probeTimeoutMs: settings.probeTimeoutMs,
      discoverIntervalMs: settings.discoverIntervalMs,
      includeLocal: settings.includeLocal,
      sshConfigPath: settings.sshConfigPath || defaultSshConfigPath(),
      enabledServers: settings.enabledServers,
      useSshConfig,
    };
  }

  /** 设置页候选 server 列表（含不可达；enabled 反映用户选取）。 */
  function serverCandidates() {
    return allCandidates.map((c) => {
      const id = keyOf(c);
      const st = candidateStatus.get(id);
      return {
        id,
        label: c.alias || id,
        ok: !!(st && st.ok),
        error: (st && st.error) || "",
        enabled: enabledOf(id),
      };
    });
  }

  /** 设置页打开时确保至少探测过一次（仅在尚未探测时执行一次；其余情况立即返回）。 */
  async function ensureDiscovered() {
    if (useSshConfig && !discovered) await discover();
  }

  /**
   * 应用设置补丁（POST /settings）：校验 → 合并 → 持久化 → 立即生效。
   * 间隔类改动重启定时器；sshConfigPath 改动触发重新探测；其余改动立即补一次查询。
   * @param {object} patch 见 lib/settings.mjs 的 sanitizeSettings
   * @returns {{settings: object, candidates: object[]}}
   */
  function setSettings(patch) {
    const clean = sanitizeSettings(patch);
    Object.assign(settings, clean);
    settingsStore.set(clean);
    log("设置已更新:", JSON.stringify(clean));
    if (started) {
      restartTimers();
      if (clean.sshConfigPath !== undefined) {
        (async () => {
          try { await discover(); } finally { tick(); }
        })().catch(() => {});
      } else {
        tick();
      }
    }
    return { settings: getSettings(), candidates: serverCandidates() };
  }

  return {
    start, stop, tick, refresh, discover, getState, setOrder, onUpdate, listServers, serveOrder,
    setSettings, getSettings, serverCandidates, ensureDiscovered,
  };
}
