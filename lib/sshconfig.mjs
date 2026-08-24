// dsh-gpu-monitor: ~/.ssh/config 解析（含 Include 展开、Host * 默认值、first-wins 语义）。
// 只关心探测/查询需要的字段：HostName / User / Port / IdentityFile。
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_DEPTH = 8;

export function defaultSshConfigPath() {
  return process.env.GPU_MONITOR_SSH_CONFIG || join(homedir(), ".ssh", "config");
}

function expandTilde(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** 单个 glob 片段（仅支持 * 与 ?）→ 正则。 */
function globToRe(part) {
  let out = "";
  for (const ch of part) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

/** 展开 glob 绝对路径，把命中文件写入 out。 */
function expandGlob(absPattern, out) {
  const parts = absPattern.split("/").filter(Boolean);
  walk(parts, 0, "/", out);
}

function walk(parts, i, base, out) {
  if (i === parts.length) {
    out.push(base);
    return;
  }
  const part = parts[i];
  if (/[*?]/.test(part)) {
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      return;
    }
    const re = globToRe(part);
    for (const e of entries) if (re.test(e)) walk(parts, i + 1, join(base, e), out);
  } else {
    walk(parts, i + 1, join(base, part), out);
  }
}

function resolveIncludePattern(pattern, configDir) {
  const p = expandTilde(pattern);
  if (isAbsolute(p)) return p;
  return join(configDir, p);
}

function applyOption(entry, key, value) {
  switch (key) {
    case "hostname":
      entry.hostName = value;
      break;
    case "user":
      entry.user = value;
      break;
    case "port": {
      const n = Number(value);
      if (Number.isFinite(n)) entry.port = n;
      break;
    }
    case "identityfile":
      entry.identityFiles.push(expandTilde(value));
      break;
    default:
      break;
  }
}

/**
 * 解析一份 ssh config 文本（可递归处理 Include，深度限制 MAX_DEPTH）。
 * 显式 Host 别名（不含通配符）收集进 state.hosts（Map<alias, entry>，first-wins）；
 * `Host *` 块与文件顶层选项写入 state.defaults 作为后续主机的默认值。
 * @param {string} text 配置文本
 * @param {string} baseDir 相对 Include 的基准目录
 * @param {{hosts: Map, defaults: object, depth?: number}} state 跨文件共享状态
 */
export function parseSshConfigText(text, baseDir = process.cwd(), state = { hosts: new Map(), defaults: { hostName: null, user: null, port: null, identityFiles: [] }, depth: 0 }) {
  if (state.depth > MAX_DEPTH) return state.hosts;
  let currentAliases = null; // 当前显式 Host 块的所有别名
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/\s+#.*$/, "").trim(); // 行内注释（保守）
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*)[\t ]+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      const explicit = value.split(/\s+/).filter((p) => p && !/[*?]/.test(p));
      currentAliases = explicit.length ? explicit : null;
      for (const a of explicit) {
        if (!state.hosts.has(a)) {
          state.hosts.set(a, {
            alias: a,
            hostName: state.defaults.hostName,
            user: state.defaults.user,
            port: state.defaults.port,
            identityFiles: [...state.defaults.identityFiles],
            seen: new Set(),
          });
        }
      }
      continue;
    }
    if (key === "include") {
      for (const pat of value.split(/\s+/).filter(Boolean)) {
        const files = [];
        expandGlob(resolveIncludePattern(pat, baseDir), files);
        for (const f of files) {
          try {
            const sub = readFileSync(f, "utf8");
            parseSshConfigText(sub, dirname(f), { ...state, depth: state.depth + 1 });
          } catch {
            /* 缺失的 include 静默跳过（与 ssh 行为一致） */
          }
        }
      }
      continue;
    }
    if (currentAliases) {
      for (const a of currentAliases) {
        const e = state.hosts.get(a);
        if (!e || e.seen.has(key)) continue;
        applyOption(e, key, value);
        e.seen.add(key);
      }
    } else {
      applyOption(state.defaults, key, value);
    }
  }
  return state.hosts;
}

/**
 * 解析 ~/.ssh/config（或指定路径），返回候选主机列表。
 * @param {string} [configPath] 为空则用默认路径（可被 GPU_MONITOR_SSH_CONFIG 覆盖）
 * @returns {Array<{alias: string, hostName: string, user: string|null, port: number, identityFiles: string[]}>}
 */
export function parseSshConfig(configPath = "") {
  const p = configPath ? expandTilde(configPath) : defaultSshConfigPath();
  if (!p) return [];
  const text = readFileSync(p, "utf8");
  const hosts = parseSshConfigText(text, dirname(p));
  const out = [];
  for (const e of hosts.values()) {
    out.push({
      alias: e.alias,
      hostName: e.hostName || e.alias,
      user: e.user || process.env.USER || process.env.USERNAME || null,
      port: e.port || 22,
      identityFiles: e.identityFiles,
    });
  }
  return out;
}
