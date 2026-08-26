// dsh-gpu-monitor: 共享监控引擎 —— DSH 宿主插件（lib/index.js）与独立 sidecar 共用的核心。
// 封装：ssh config 探测（发现可用 GPU server）、周期并行查询、分组顺序持久化与调和、状态快照与订阅。
// 通过 `query` 选项可注入查询实现（单元测试用）。
import { parseSshConfig, defaultSshConfigPath } from "./sshconfig.mjs";
import { probeServer, queryGpus, queryServer, targetHost } from "./query.mjs";
import { OrderStore } from "./orderstore.mjs";

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
 * @param {string} [opts.source] 状态来源标识（默认 "engine"）
 * @param {(...a: any[]) => void} [opts.log]
 * @param {(ctx: {sshTarget: string, servers: object[], includeLocal: boolean, timeoutMs: number, localLabel: string}) => Promise<object[]>} [opts.query] 可注入查询（测试）
 * @returns {{start: Function, stop: Function, tick: Function, discover: Function,
 *            getState: Function, setOrder: Function, onUpdate: Function, listServers: Function}}
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
    source = "engine",
    log = () => {},
    query = null,
  } = opts;

  const orderStore = new OrderStore(orderFile, log);
  let state = { ok: false, at: null, source, servers: [], error: "初始化中…" };
  let available = []; // 已探测可用的 server 目标（sshconfig 解析结果）
  let discovered = false;
  let running = false;
  let started = false;
  let tickTimer = null;
  let discoverTimer = null;
  const listeners = new Set();

  const keyOf = targetHost;

  /** 当前机器 id 列表（本机 + 已探测 server + 最近一次查询结果，去重保序）。 */
  function serverIds() {
    const ids = [];
    const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
    if (includeLocal) push("local");
    for (const t of available) push(keyOf(t));
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
    if (query) {
      return (await query({ sshTarget, servers: available, includeLocal, timeoutMs, localLabel })) || [];
    }
    if (useSshConfig) {
      // 没有本机也没有可用 server 时直接返回空，避免在 macOS 上空跑一次本机 nvidia-smi
      if (!includeLocal && available.length === 0) return [];
      const r = await queryGpus({ servers: available, includeLocal, timeoutMs, localLabel });
      return r.servers || [];
    }
    if (sshTarget) return [await queryServer(sshTarget, { timeoutMs, label: sshTarget })];
    return [await queryServer(null, { timeoutMs, label: localLabel })];
  }

  let lastDiscoveryMessage = "";

  /** 探测 ssh config 候选，合并进 available；同时记录"无可用 server"时的诊断信息。 */
  async function discover() {
    try {
      const candidates = parseSshConfig(sshConfigPath);
      if (candidates.length === 0) {
        discovered = true;
        available = [];
        lastDiscoveryMessage = `~/.ssh/config 未找到主机条目（${sshConfigPath || defaultSshConfigPath()}）`;
        log(lastDiscoveryMessage);
        return;
      }
      const results = await Promise.all(
        candidates.map(async (c) => {
          try {
            const p = await probeServer(c, { timeoutMs: probeTimeoutMs });
            return p.ok ? { target: c, error: "" } : { target: null, error: p.error };
          } catch (e) {
            return { target: null, error: String(e) };
          }
        })
      );
      const fresh = results.filter((r) => r.target).map((r) => r.target);
      if (fresh.length > 0 || discovered) available = fresh;
      discovered = true;
      let msg = "";
      if (fresh.length === 0) {
        const sample = results.find((r) => r.error)?.error || "";
        msg = `探测了 ${candidates.length} 个候选主机（${candidates.map(keyOf).join(", ")}），均不可达或无 GPU`;
        if (sample) msg += `；示例错误: ${sample}`;
      }
      lastDiscoveryMessage = msg;
      log(`ssh config 发现 ${available.length} 个可用 GPU server: ${available.map(keyOf).join(", ") || "（无）"}`);
    } catch (e) {
      log("ssh config 解析失败:", String(e));
      available = [];
      discovered = true;
      lastDiscoveryMessage = `~/.ssh/config 解析失败: ${String(e).split("\n")[0]}`;
    }
  }

  /** 周期查询：本机 + 每个 server 并行。 */
  async function tick() {
    if (running) return;
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
      notify();
    }
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

  /** 启动：立即 tick + 周期查询（+ ssh config 周期重探测）。 */
  function start() {
    if (started) return;
    started = true;
    tick();
    tickTimer = setInterval(tick, intervalMs);
    tickTimer.unref?.();
    if (useSshConfig) {
      discoverTimer = setInterval(() => {
        discover().catch(() => {});
      }, discoverIntervalMs);
      discoverTimer.unref?.();
    }
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

  return { start, stop, tick, discover, getState, setOrder, onUpdate, listServers, serveOrder };
}
