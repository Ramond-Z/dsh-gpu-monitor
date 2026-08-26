// dsh-gpu-monitor: 宿主半部（DSH cordis 插件，薄壳）。
// 共享监控引擎见 ./engine.mjs；本文件只负责：启动引擎 + 在主 Web 服务注册同源路由 /gpu/status。
// 空配置绝不弄崩启动（查询失败只记录 error 状态）。
import { createMonitorEngine } from "./engine.mjs";
import { defaultSshConfigPath } from "./sshconfig.mjs";

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

  const engine = createMonitorEngine({
    intervalMs,
    timeoutMs,
    sshTarget,
    useSshConfig,
    sshConfigPath,
    includeLocal,
    discoverIntervalMs,
    probeTimeoutMs,
    source: "host",
    log,
  });
  engine.start();

  const removeRoute = ctx.webServer.register({
    kind: "exact",
    path: "/gpu/status",
    handler: async (req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(engine.getState()));
    },
  });
  log("已注册路由 /gpu/status");

  // cordis dispose 契约：停止引擎与路由
  return () => {
    engine.stop();
    try { removeRoute(); } catch {}
  };
}
