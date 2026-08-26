// dsh-gpu-monitor: nvidia-smi 查询模块（本地或经 SSH，单机或多机）。
// 独立可测：node -e "import('./lib/query.mjs').then(m=>console.log(m.parseCsv('0, A100, 1000, 40000, N/A, 40, N/A, N/A')))"
import { spawn } from "node:child_process";

const QUERY = [
  "index",
  "name",
  "memory.used",
  "memory.total",
  "utilization.gpu",
  "temperature.gpu",
  "power.draw",
  "power.limit",
].join(",");

const HEADERS = [
  "index",
  "name",
  "memUsedMB",
  "memTotalMB",
  "utilPct",
  "tempC",
  "powerW",
  "powerLimitW",
];

const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, out, err: (err || "") + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out, err: String(e) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * 把目标描述转成 ssh 命令行参数段。
 * @param {null|string|object} target
 *   null/空串 = 本机（返回 null）；字符串 "user@host" 原样使用；
 *   {alias, hostName, host, user, port, identityFiles} 组装的 ssh 参数。
 * @returns {{ssh: string[]}|null}
 */
export function targetArgs(target) {
  if (!target) return null;
  if (typeof target === "string") return { ssh: [target] };
  const h = target.hostName || target.host || target.alias;
  if (!h) return null;
  const at = h.includes("@") ? h : target.user ? `${target.user}@${h}` : h;
  const ssh = [];
  if (target.port && Number(target.port) !== 22) ssh.push("-p", String(target.port));
  for (const idf of target.identityFiles || []) if (idf) ssh.push("-i", idf);
  ssh.push(at);
  return { ssh };
}

/** 在目标机上执行 nvidia-smi（本地或经 SSH），返回 {code,out,err}。 */
function smi(target, args, timeoutMs) {
  const t = targetArgs(target);
  if (!t) return run("nvidia-smi", args, timeoutMs);
  return run("ssh", [...SSH_OPTS, ...t.ssh, "nvidia-smi", ...args], timeoutMs);
}

/** 在目标机上执行 ps（本地或经 SSH）。 */
function ps(target, args, timeoutMs) {
  const t = targetArgs(target);
  if (!t) return run("ps", args, timeoutMs);
  return run("ssh", [...SSH_OPTS, ...t.ssh, "ps", ...args], timeoutMs);
}

/** 解析 nvidia-smi CSV 输出（导出以支持单元测试）。 */
export function parseCsv(text) {
  const gpus = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < HEADERS.length) continue;
    const row = {};
    HEADERS.forEach((h, i) => (row[h] = cells[i]));
    row.memUsedMB = Number(row.memUsedMB);
    row.memTotalMB = Number(row.memTotalMB);
    row.utilPct = Number(row.utilPct);
    row.tempC = Number(row.tempC);
    row.powerW = Number(row.powerW);
    row.powerLimitW = Number(row.powerLimitW);
    if (!Number.isFinite(row.utilPct)) row.utilPct = 0;
    gpus.push(row);
  }
  return gpus;
}

/**
 * 查询某台机器上各 GPU 的计算进程（compute-apps + ps 取属主/命令行）。
 * @returns {{uuidToIndex: object, procsByIndex: object}} 失败时返回 null。
 */
async function queryProcesses(target, timeoutMs) {
  try {
    // GPU index <-> uuid 映射
    const gi = await smi(
      target,
      ["--query-gpu=index,uuid", "--format=csv,noheader,nounits"],
      timeoutMs
    );
    const uuidToIndex = {};
    if (gi.code === 0) {
      for (const line of gi.out.split("\n")) {
        const cells = line.split(",").map((c) => c.trim());
        if (cells.length >= 2 && cells[1]) uuidToIndex[cells[1]] = cells[0];
      }
    }
    // 计算进程
    const apps = await smi(
      target,
      ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"],
      timeoutMs
    );
    const procsByIndex = {};
    const pids = [];
    const rows = []; // {gpuUuid,pid,name,memMB}
    if (apps.code === 0) {
      for (const line of apps.out.split("\n")) {
        if (!line.trim()) continue;
        const cells = line.split(",").map((c) => c.trim());
        if (cells.length < 4) continue;
        const gpuUuid = cells[0];
        const pid = cells[1];
        const idx = uuidToIndex[gpuUuid];
        if (idx === undefined) continue;
        rows.push({ idx, pid, name: cells[2], memMB: Number(cells[3]) || 0 });
        if (pid && !pids.includes(pid)) pids.push(pid);
      }
    }
    // 属主 + 命令行（ps 输出: pid user args…）
    const pidInfo = {};
    if (pids.length > 0) {
      const r = await ps(
        target,
        ["-o", "pid=,user=,args=", "-p", pids.join(",")],
        timeoutMs
      );
      if (r.code === 0) {
        for (const line of r.out.split("\n")) {
          const m = line.match(/^\s*(\S+)\s+(\S+)\s+(.*)$/);
          if (m) pidInfo[m[1]] = { user: m[2], cmd: m[3] || "" };
        }
      }
    }
    for (const row of rows) {
      (procsByIndex[row.idx] = procsByIndex[row.idx] || []).push({
        pid: row.pid,
        name: row.name,
        memMB: row.memMB,
        user: pidInfo[row.pid] ? pidInfo[row.pid].user : "?",
        cmd: pidInfo[row.pid] ? pidInfo[row.pid].cmd : "",
      });
    }
    return { uuidToIndex, procsByIndex };
  } catch (e) {
    return null;
  }
}

/** 目标的人类可读标识（用于 label/日志）。 */
export function targetHost(target) {
  if (typeof target === "string") return target;
  return target?.alias || target?.hostName || target?.host || "local";
}

/**
 * 轻量探测：目标机上 nvidia-smi 是否可执行且至少 1 张 GPU。
 * @returns {Promise<{ok: boolean, error: string}>} error 为探测失败的具体原因（ssh/命令错误摘要）
 */
export async function probeServer(target, opts = {}) {
  const { timeoutMs = 4000 } = opts;
  const r = await smi(target, ["--query-gpu=count", "--format=csv,noheader,nounits"], timeoutMs);
  if (r.code !== 0) {
    const detail = ((r.err || r.out || "").trim().split("\n").pop() || "无输出").slice(0, 200);
    return { ok: false, error: detail };
  }
  const count = Number((r.out || "").trim().split("\n")[0]);
  if (!(Number.isFinite(count) && count > 0)) {
    return { ok: false, error: "nvidia-smi 无输出（无 GPU？）" };
  }
  return { ok: true, error: "" };
}

/**
 * 查询一台机器（本机或经 SSH）的 GPU 用量与计算进程。
 * @param {null|string|object} target 见 targetArgs
 * @param {{timeoutMs?: number, label?: string}} opts
 * @returns {{host: string, label: string, ok: boolean, at: string, gpus?: object[], error?: string}}
 */
export async function queryServer(target, opts = {}) {
  const { timeoutMs = 8000, label } = opts;
  const host = targetHost(target);
  const at = new Date().toISOString();
  const r = await smi(
    target,
    [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"],
    timeoutMs
  );
  if (r.code !== 0) {
    const prefix = target ? "ssh/nvidia-smi 失败: " : "nvidia-smi 失败: ";
    return {
      host,
      label: label || host,
      ok: false,
      at,
      error: prefix + ((r.err || r.out || "").trim().slice(0, 300) || "无输出"),
    };
  }
  const gpus = parseCsv(r.out);
  if (gpus.length === 0)
    return { host, label: label || host, ok: false, at, error: "nvidia-smi 无输出（无 GPU？）" };
  // 每卡进程（失败不致命，进程字段为空数组）
  const procs = await queryProcesses(target, timeoutMs);
  for (const g of gpus) {
    g.processes = procs && procs.procsByIndex[g.index] ? procs.procsByIndex[g.index] : [];
  }
  return { host, label: label || host, ok: true, at, gpus };
}

/**
 * 并行查询多台机器的 GPU 用量（可含本机）。
 * @param {{servers?: Array<null|string|object>, timeoutMs?: number,
 *          includeLocal?: boolean, localLabel?: string}} opts
 *   `servers` 为要查询的目标列表（可含本机，见 targetArgs）；引擎始终传入可用 server 列表。
 * @returns {Promise<{ok: boolean, at: string, source: string, servers: object[]}>}
 */
export async function queryGpus(opts = {}) {
  const { timeoutMs = 8000, servers = [], includeLocal = true, localLabel = "本机" } = opts;
  const jobs = [];
  if (includeLocal) jobs.push(queryServer(null, { timeoutMs, label: localLabel }));
  for (const s of servers) {
    jobs.push(
      queryServer(s, {
        timeoutMs,
        label: typeof s === "string" ? s : s.alias || s.hostName || s.host,
      })
    );
  }
  const results = await Promise.all(jobs);
  return {
    ok: results.some((r) => r.ok),
    at: new Date().toISOString(),
    source: "host",
    servers: results,
  };
}
