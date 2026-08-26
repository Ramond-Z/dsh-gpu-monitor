// dsh-gpu-monitor: 宿主半部（DSH cordis 插件，薄壳）。
// 共享监控引擎见 ./engine.mjs；本文件只负责：启动引擎 + 在主 Web 服务注册同源路由
// /gpu/status 与 /settings（处理器与 server.mjs 共享）。
// 空配置绝不弄崩启动（查询失败只记录 error 状态）。
import { createMonitorEngine } from "./engine.mjs";
import { resolveEngineConfigFromCordis } from "./config.mjs";
import { makeStateHandler, makeSettingsHandler } from "./server.mjs";

export const name = "dsh-gpu-monitor";
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  // cordis 配置 → 引擎选项（默认值与解析规则见 lib/config.mjs）
  const cfg = resolveEngineConfigFromCordis(config);
  const log = (...a) => {
    try { ctx?.logger?.info?.("[dsh-gpu-monitor]", ...a); } catch {}
  };

  const engine = createMonitorEngine({
    intervalMs: cfg.intervalMs,
    timeoutMs: cfg.timeoutMs,
    sshTarget: cfg.sshTarget,
    useSshConfig: cfg.useSshConfig,
    sshConfigPath: cfg.sshConfigPath,
    includeLocal: cfg.includeLocal,
    discoverIntervalMs: cfg.discoverIntervalMs,
    probeTimeoutMs: cfg.probeTimeoutMs,
    settingsFile: cfg.settingsFile,
    source: "host",
    log,
  });
  engine.start();

  // 与 sidecar/Electron 共用同一个状态/设置处理器（见 lib/server.mjs），线格式单一来源
  const handleStatus = makeStateHandler(engine);
  const removeStatusRoute = ctx.webServer.register({
    kind: "exact",
    path: "/gpu/status",
    handler: handleStatus,
  });
  const handleSettings = makeSettingsHandler(engine);
  const removeSettingsRoute = ctx.webServer.register({
    kind: "exact",
    path: "/settings",
    handler: handleSettings,
  });
  log("已注册路由 /gpu/status 与 /settings");

  // cordis dispose 契约：停止引擎与路由
  return () => {
    engine.stop();
    try { removeStatusRoute(); } catch {}
    try { removeSettingsRoute(); } catch {}
  };
}
