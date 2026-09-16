import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSystemSample, cpuUsagePct } from "../lib/query.mjs";

/** /proc/stat 聚合行（8 项计数器 + guest/guest_nice，后者已含在 user/nice 中不应重复计）。 */
function procStat(user, nice, system, idle, iowait, irq, softirq, steal, cores = 2) {
  const lines = [`cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0`];
  for (let i = 0; i < cores; i++) lines.push(`cpu${i} ${user / 2} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0`);
  lines.push("intr 12345 0 0", "ctxt 999", "btime 1700000000", "processes 42", "procs_running 3", "procs_blocked 0");
  return lines.join("\n");
}

const MEMINFO = [
  "MemTotal:       131072000 kB", // 128000 MB
  "MemFree:         5000000 kB",
  "MemAvailable:   65536000 kB", // 64000 MB → 用掉 50%
  "Buffers:         1000000 kB",
  "Cached:         20000000 kB",
  "SwapTotal:       1000000 kB",
].join("\n");

const LOADAVG = "0.52 0.58 0.59 1/234 5678";

/** 一台 2 核机器的一次完整采样（/proc/stat + /proc/meminfo + /proc/loadavg 拼接）。 */
const SAMPLE = [procStat(1000, 20, 300, 8000, 50, 0, 10, 5), MEMINFO, LOADAVG].join("\n");

test("parseSystemSample: 解析 /proc/stat 聚合行、核数、内存与 load1", () => {
  const s = parseSystemSample(SAMPLE);
  assert.ok(s, "应能解析出采样");
  // total = user+nice+system+idle+iowait+irq+softirq+steal（guest 不重复计）
  assert.equal(s.cpuTicks.total, 1000 + 20 + 300 + 8000 + 50 + 0 + 10 + 5);
  assert.equal(s.cpuTicks.idle, 8000 + 50, "空闲 = idle + iowait");
  assert.equal(s.cores, 2);
  assert.equal(s.memTotalMB, 128000);
  assert.equal(s.memUsedMB, 64000, "已用 = MemTotal - MemAvailable");
  assert.equal(s.load1, 0.52);
});

test("parseSystemSample: 老内核无 MemAvailable 时退回 MemFree+Buffers+Cached", () => {
  const old = [
    procStat(1000, 20, 300, 8000, 50, 0, 10, 5),
    "MemTotal:       131072000 kB",
    "MemFree:         5000000 kB",
    "Buffers:         1000000 kB",
    "Cached:         20000000 kB",
    LOADAVG,
  ].join("\n");
  const s = parseSystemSample(old);
  assert.equal(s.memTotalMB, 128000);
  assert.equal(s.memUsedMB, 128000 - Math.round((5000000 + 1000000 + 20000000) / 1024));
});

test("parseSystemSample: 无 loadavg 行时不报错（load1 = null）", () => {
  const s = parseSystemSample([procStat(1, 0, 1, 100, 0, 0, 0, 0), MEMINFO].join("\n"));
  assert.equal(s.load1, null);
  assert.equal(s.cpuTicks.total, 102);
});

test("parseSystemSample: 非 Linux 输出（空/垃圾）返回 null", () => {
  assert.equal(parseSystemSample(""), null);
  assert.equal(parseSystemSample(null), null);
  assert.equal(parseSystemSample("total        used\nMem:  1234  567\n"), null);
  assert.equal(parseSystemSample("cat: /proc/stat: No such file or directory"), null);
});

test("parseSystemSample: 只有 meminfo 没有 /proc/stat 时仍给出内存（CPU 为 null）", () => {
  const s = parseSystemSample(MEMINFO);
  assert.equal(s.cpuTicks, null);
  assert.equal(s.memTotalMB, 128000);
});

test("cpuUsagePct: 差值算占用（busy/总差值）", () => {
  const a = parseSystemSample(SAMPLE);
  // 第二个采样：user/system 各 +50（忙 100），idle/iowait 共 +100（闲 100）→ 50%
  const b = parseSystemSample([procStat(1050, 20, 350, 8100, 50, 0, 10, 5), MEMINFO, LOADAVG].join("\n"));
  assert.equal(cpuUsagePct(a.cpuTicks, b.cpuTicks), 50);
});

test("cpuUsagePct: 全忙 = 100%，全闲 = 0%", () => {
  const base = { total: 1000, idle: 500 };
  assert.equal(cpuUsagePct(base, { total: 1100, idle: 500 }), 100);
  assert.equal(cpuUsagePct(base, { total: 1100, idle: 600 }), 0);
});

test("cpuUsagePct: 首次采样 / 计数器未前进（重启）返回 null", () => {
  assert.equal(cpuUsagePct(null, { total: 100, idle: 50 }), null);
  assert.equal(cpuUsagePct({ total: 100, idle: 50 }, null), null);
  assert.equal(cpuUsagePct({ total: 100, idle: 50 }, { total: 100, idle: 50 }), null);
  assert.equal(cpuUsagePct({ total: 100, idle: 50 }, { total: 90, idle: 40 }), null, "计数器回退（机器重启）不应给出负数占用");
});
