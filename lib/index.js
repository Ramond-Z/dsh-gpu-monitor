// dsh-gpu-monitor: 宿主半部。
// 周期查询 nvidia-smi（本地或经 SSH），在主 Web 服务注册同源路由 /gpu/status 输出 JSON。
// 空配置绝不弄崩启动（查询失败只记录 error 状态）。
import { queryGpus } from "./query.mjs";

export const name = "dsh-gpu-monitor";
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  const intervalMs = Number(config.intervalMs ?? 3000);
  const sshTarget = String(config.sshTarget ?? "").trim();
  const timeoutMs = Number(config.queryTimeoutMs ?? 8000);
  const log = (...a) => {
    try { ctx?.logger?.info?.("[dsh-gpu-monitor]", ...a); } catch {}
  };

  let cache = { ok: false, at: null, error: "初始化中…" };
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      cache = await queryGpus({ sshTarget, timeoutMs });
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

  // cordis dispose 契约：停止定时器与路由
  return () => {
    clearInterval(timer);
    try { removeRoute(); } catch {}
  };
}
