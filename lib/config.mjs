// dsh-gpu-monitor: 共享引擎配置契约 —— 三个宿主壳（cordis 插件 / sidecar / Electron）
// 用同一份默认值与解析规则构建 createMonitorEngine 的选项。
// 引擎的一切旋钮（间隔 / 超时 / 探测周期 / 本机开关 / 顺序文件）在这里定义一次：
// 改默认值只动这一处；README 的环境变量表与本模块一一对应。
// 注意：这些解析结果只是引擎的"初始值"，运行时设置文件（lib/settings.mjs）里的键优先。
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSshConfigPath } from "./sshconfig.mjs";
import { defaultSettingsFile } from "./settings.mjs";

/** 引擎默认值（sidecar / Electron / 宿主插件共用）。 */
export const ENGINE_DEFAULTS = {
  intervalMs: 3000, // 查询间隔
  queryTimeoutMs: 8000, // 每台机器查询超时
  probeTimeoutMs: 4000, // 探测超时
  discoverIntervalMs: 60000, // 重新探测 server 列表间隔
};

/** 分组顺序持久化文件的默认路径（sidecar / Electron 共用）。 */
export function defaultOrderFile() {
  return join(homedir(), ".dsh", "gpu-monitor-order.json");
}

/** 环境布尔："0" 关闭，其余字符串开启；未设置用 fallback（与旧实现保持一致）。 */
function envBool(v, fallback) {
  return v === undefined ? fallback : v !== "0";
}

/** 数字：空/未设置用默认值；其余 Number()（与旧实现保持一致，非法值得 NaN 由引擎容忍）。 */
function num(v, d) {
  return v === undefined || v === "" ? d : Number(v);
}

/**
 * 从环境变量解析引擎配置（sidecar / Electron 共用）。
 * 变量名与 README 的环境变量表一致；platform 为 "darwin" 时默认不查本机（macOS 无 nvidia-smi）。
 * @param {object} [env] 环境变量（默认 process.env）
 * @param {string} [platform] 平台（默认 process.platform）
 * @param {{portDefault?: number, hostDefault?: string}} [opts]
 *   sidecar 默认端口 3499；Electron 默认 0（随机端口，避免冲突）。
 * @returns {{
 *   port: number, host: string, intervalMs: number, timeoutMs: number,
 *   probeTimeoutMs: number, discoverIntervalMs: number,
 *   sshConfigPath: string, includeLocal: boolean, orderFile: string, jsonPath: string,
 *   settingsFile: string,
 * }}
 */
export function resolveEngineConfigFromEnv(env = process.env, platform = process.platform, opts = {}) {
  const { portDefault = 3499, hostDefault = "127.0.0.1" } = opts;
  return {
    port: Number(env.GPU_MONITOR_PORT || portDefault),
    host: env.GPU_MONITOR_HOST || hostDefault,
    intervalMs: num(env.GPU_MONITOR_INTERVAL_MS, ENGINE_DEFAULTS.intervalMs),
    timeoutMs: num(env.GPU_MONITOR_QUERY_TIMEOUT_MS, ENGINE_DEFAULTS.queryTimeoutMs),
    probeTimeoutMs: num(env.GPU_MONITOR_PROBE_TIMEOUT_MS, ENGINE_DEFAULTS.probeTimeoutMs),
    discoverIntervalMs: num(env.GPU_MONITOR_DISCOVER_INTERVAL_MS, ENGINE_DEFAULTS.discoverIntervalMs),
    sshConfigPath: env.GPU_MONITOR_SSH_CONFIG || "",
    includeLocal: envBool(env.GPU_MONITOR_INCLUDE_LOCAL, platform !== "darwin"),
    orderFile: env.GPU_MONITOR_ORDER_FILE || defaultOrderFile(),
    jsonPath: env.GPU_MONITOR_JSON_PATH || "",
    settingsFile: env.GPU_MONITOR_SETTINGS_FILE || defaultSettingsFile(),
  };
}

/**
 * 从 cordis 插件配置（profile 的 cordis.patch.yml）解析引擎配置（宿主插件用）。
 * @param {object} [cfg] 插件配置
 * @returns {{intervalMs: number, timeoutMs: number, probeTimeoutMs: number,
 *   discoverIntervalMs: number, sshTarget: string, useSshConfig: boolean,
 *   sshConfigPath: string, includeLocal: boolean, orderFile: string, settingsFile: string}}
 */
export function resolveEngineConfigFromCordis(cfg = {}) {
  return {
    intervalMs: num(cfg.intervalMs, ENGINE_DEFAULTS.intervalMs),
    timeoutMs: num(cfg.queryTimeoutMs, ENGINE_DEFAULTS.queryTimeoutMs),
    probeTimeoutMs: num(cfg.probeTimeoutMs, ENGINE_DEFAULTS.probeTimeoutMs),
    discoverIntervalMs: num(cfg.discoverIntervalMs, ENGINE_DEFAULTS.discoverIntervalMs),
    sshTarget: String(cfg.sshTarget ?? "").trim(),
    useSshConfig: cfg.useSshConfig === true || cfg.useSshConfig === "true",
    sshConfigPath: String(cfg.sshConfigPath ?? "").trim() || defaultSshConfigPath(),
    includeLocal: cfg.includeLocal !== false,
    orderFile: String(cfg.orderFile ?? "").trim() || process.env.GPU_MONITOR_ORDER_FILE || defaultOrderFile(),
    settingsFile: String(cfg.settingsFile ?? "").trim() || process.env.GPU_MONITOR_SETTINGS_FILE || defaultSettingsFile(),
  };
}
