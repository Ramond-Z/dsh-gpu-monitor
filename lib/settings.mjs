// dsh-gpu-monitor: 运行时设置 —— 设置页可调整的参数契约 + 持久化。
// 与分组顺序（orderstore.mjs）对称：引擎在启动配置（env / cordis）之上叠加
// 一个运行时设置文件（~/.dsh/gpu-monitor-settings.json），设置页的修改写入该文件、
// 立即生效，重启后仍保留。文件里存在的键优先于启动配置（启动配置只作初始值）。
// 可设置的键与取值范围（sanitizeSettings）是唯一的校验权威：设置页的 POST 必须过这里。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 设置页可调整的全部键。新增旋钮只需在这里 + sanitizeSettings 各加一处。 */
export const SETTINGS_KEYS = [
  "intervalMs", // 查询间隔（ms）
  "timeoutMs", // 每台机器查询超时（ms）
  "probeTimeoutMs", // 探测超时（ms）
  "discoverIntervalMs", // 重新探测 server 列表间隔（ms）
  "includeLocal", // 是否同时监控本机
  "sshConfigPath", // ssh config 路径（空 = 默认 ~/.ssh/config）
  "enabledServers", // 启用哪些 server（host 键数组；null = 全部）
];

const NUMERIC = [
  ["intervalMs", 100, 600000],
  ["timeoutMs", 500, 300000],
  ["probeTimeoutMs", 500, 60000],
  ["discoverIntervalMs", 5000, 600000],
];

function intInRange(v, lo, hi, key) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`${key} 必须是 ${lo}–${hi} 之间的整数`);
  }
  return n;
}

/**
 * 校验并清洗设置补丁：只保留已知键，未知键忽略；非法值抛 Error（HTTP 层转 400）。
 * @param {object} patch 客户端提交的部分设置
 * @returns {object} 清洗后的补丁（仅含本补丁出现的键）
 */
export function sanitizeSettings(patch = {}) {
  if (!patch || typeof patch !== "object") throw new Error("设置必须是对象");
  const out = {};
  for (const [key, lo, hi] of NUMERIC) {
    if (patch[key] !== undefined) out[key] = intInRange(patch[key], lo, hi, key);
  }
  if (patch.includeLocal !== undefined) {
    if (typeof patch.includeLocal !== "boolean") throw new Error("includeLocal 必须是布尔值");
    out.includeLocal = patch.includeLocal;
  }
  if (patch.sshConfigPath !== undefined) {
    if (typeof patch.sshConfigPath !== "string") throw new Error("sshConfigPath 必须是字符串");
    out.sshConfigPath = patch.sshConfigPath.trim();
  }
  if (patch.enabledServers !== undefined) {
    if (patch.enabledServers === null) {
      out.enabledServers = null; // null = 全部 server
    } else if (Array.isArray(patch.enabledServers)) {
      out.enabledServers = [...new Set(patch.enabledServers.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))];
    } else {
      throw new Error("enabledServers 必须是字符串数组或 null");
    }
  }
  return out;
}

/** 运行时设置文件的默认路径（可被 GPU_MONITOR_SETTINGS_FILE 覆盖）。 */
export function defaultSettingsFile() {
  return process.env.GPU_MONITOR_SETTINGS_FILE || join(homedir(), ".dsh", "gpu-monitor-settings.json");
}

/**
 * 运行时设置持久化：{key: value} 的 JSON 文件，原子写盘（tmp + rename）。
 * file 为空 = 仅内存（不落盘）；与 OrderStore 同一套约定。
 */
export class SettingsStore {
  /**
   * @param {string} file 持久化文件路径；空串 = 仅内存
   * @param {(...a: any[]) => void} [log]
   */
  constructor(file = "", log = () => {}) {
    this.file = file;
    this.log = log;
    this.state = {};
    if (file) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.state = sanitizeSettings(raw);
      }
    } catch (e) {
      // 文件缺失/损坏：从空状态开始（损坏文件不致命，后续保存会覆盖）
      if (e && e.code !== "ENOENT") this.log("读取设置文件失败（已忽略）:", String(e));
    }
  }

  /** 原子写盘。失败返回 false 并记录日志。 */
  save() {
    if (!this.file) return true;
    try {
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log("保存设置文件失败:", String(e));
      return false;
    }
  }

  /**
   * 合并一份（已清洗的）补丁并落盘。
   * @param {object} patch 见 sanitizeSettings
   * @returns {object} 合并后的完整设置
   */
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.save();
    return this.state;
  }

  get() {
    return this.state;
  }
}
