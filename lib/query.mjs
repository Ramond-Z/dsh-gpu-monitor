// dsh-gpu-monitor: nvidia-smi 查询模块（本地或经 SSH）。
// 独立可测：node -e "import('./lib/query.mjs').then(m=>m.queryGpus({}).then(r=>console.log(JSON.stringify(r,null,1))))"
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

/** 在目标机上执行 nvidia-smi（本地或经 SSH），返回 {code,out,err}。 */
function smi(sshTarget, args, timeoutMs) {
  if (sshTarget) {
    return run("ssh", [...SSH_OPTS, sshTarget, "nvidia-smi", ...args], timeoutMs);
  }
  return run("nvidia-smi", args, timeoutMs);
}

/** 在目标机上执行 ps（本地或经 SSH）。 */
function ps(sshTarget, args, timeoutMs) {
  if (sshTarget) {
    return run("ssh", [...SSH_OPTS, sshTarget, "ps", ...args], timeoutMs);
  }
  return run("ps", args, timeoutMs);
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
 * 查询各 GPU 上的计算进程（compute-apps + ps 取属主/命令行）。
 * @returns {{uuidToIndex: object, procsByIndex: object}} 失败时返回 null。
 */
async function queryProcesses(sshTarget, timeoutMs) {
  try {
    // GPU index <-> uuid 映射
    const gi = await smi(
      sshTarget,
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
      sshTarget,
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
        sshTarget,
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

/**
 * 查询所有 GPU 用量及每卡上的计算进程。
 * @param {{sshTarget?: string, timeoutMs?: number}} opts
 *   sshTarget 为空则查本机 nvidia-smi；否则 ssh <sshTarget> nvidia-smi …
 * @returns {{ok: boolean, at: string, gpus?: object[], error?: string}}
 */
export async function queryGpus(opts = {}) {
  const { sshTarget = "", timeoutMs = 8000 } = opts;
  const at = new Date().toISOString();
  const r = await smi(
    sshTarget,
    [`--query-gpu=${QUERY}`, "--format=csv,noheader,nounits"],
    timeoutMs
  );
  if (r.code !== 0)
    return {
      ok: false,
      at,
      error: sshTarget
        ? `ssh/nvidia-smi 失败: ${(r.err || r.out || "").trim().slice(0, 300)}`
        : `nvidia-smi 失败: ${(r.err || r.out || "").trim().slice(0, 300) || "无输出"}`,
    };
  const gpus = parseCsv(r.out);
  if (gpus.length === 0) return { ok: false, at, error: "nvidia-smi 无输出（无 GPU？）" };
  // 每卡进程（失败不致命，进程字段为空数组）
  const procs = await queryProcesses(sshTarget, timeoutMs);
  for (const g of gpus) {
    g.processes = procs && procs.procsByIndex[g.index] ? procs.procsByIndex[g.index] : [];
  }
  return { ok: true, at, gpus };
}
