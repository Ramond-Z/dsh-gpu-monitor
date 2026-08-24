// dsh-gpu-monitor: 宿主半部。
// 周期查询 nvidia-smi（本地、单机 SSH、或多台 ~/.ssh/config GPU server），
// 在主 Web 服务注册同源路由 /gpu/status 输出 JSON。
// 空配置绝不弄崩启动（查询失败只记录 error 状态）。
import { queryGpus, probeServer } from "./query.mjs";
import { parseSshConfig, defaultSshConfigPath } from "./sshconfig.mjs";

export const name = "dsh-gpu-monitor";
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  const intervalMs = Number(config.intervalMs ?? 3000);
  const timeoutMs = Number(config.queryTimeoutMs ?? 8000);
  const sshTarget = String(config.sshTarget ?? "").trim();
  const useSshConfig = config.useSshConfig === true || config.useSshConfig === "true";
  const sshConfigPath = String(config.sshConfigPath ?? "").trim() || defaultSshConfigPath();
  const includeLocal = config.includeLocal !== false;
  const discoverIntervalMs = Number(config.discoverIntervalMs ?? 60000);
  const probeTimeoutMs = Number(config.probeTimeoutMs ?? 4000);
  const log = (...a) => {
    try { ctx?.logger?.info?.("[dsh-gpu-monitor]", ...a); } catch {}
  };

  let cache = { ok: false, at: null, error: "初始化中…" };
  let running = false;
  let servers = []; // 已探测可用的 server 目标
  let discovered = false;

  /** 解析 ~/.ssh/config 并探测可用 GPU server（失败不清空已发现的列表）。 */
  async function discover() {
    try {
      const candidates = parseSshConfig(sshConfigPath);
      const results = await Promise.all(
        candidates.map(async (c) => {
          try {
            return (await probeServer(c, { timeoutMs: probeTimeoutMs })) ? c : null;
          } catch {
            return null;
          }
        })
      );
      const fresh = results.filter(Boolean);
      if (fresh.length > 0 || discovered) servers = fresh;
      discovered = true;
      log(`ssh config 发现 ${servers.length} 个可用 GPU server: ${servers.map((s) => s.alias).join(", ") || "（无）"}`);
    } catch (e) {
      log("ssh config 解析失败:", String(e));
      servers = [];
      discovered = true;
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (useSshConfig) {
        if (!discovered) await discover();
        cache = await queryGpus({ servers, includeLocal, timeoutMs });
      } else {
        cache = await queryGpus({ sshTarget, timeoutMs });
      }
    } catch (e) {
      cache = { ok: false, at: new Date().toISOString(), error: String(e) };
    } finally {
      running = false;
    }
  }

  const removeRoute = ctx.webServer.register({
    kind: "exact",
    path: "/gpu/status",
    handler: async (req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(cache));
    },
  });
  log("已注册路由 /gpu/status");

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  let discoverTimer = null;
  if (useSshConfig) {
    discoverTimer = setInterval(() => {
      discover().catch(() => {});
    }, discoverIntervalMs);
    discoverTimer.unref?.();
  }

  // cordis dispose 契约：停止定时器与路由
  return () => {
    clearInterval(timer);
    clearInterval(discoverTimer);
    try { removeRoute(); } catch {}
  };
}
