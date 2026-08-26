#!/usr/bin/env bash
# dsh-gpu-monitor 独立运行（MacBook / 无 nvidia-smi 的机器）：
#   node 自带 + 系统 ssh 即可，无需 DSH；浏览器打开 http://127.0.0.1:3499 监控
#   ~/.ssh/config 中所有可用 GPU server。
# 环境变量：GPU_MONITOR_PORT / GPU_MONITOR_INCLUDE_LOCAL / GPU_MONITOR_SSH_CONFIG … 同 sidecar。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${GPU_MONITOR_PORT:-3499}"

# macOS 无 nvidia-smi：默认不查本机（sidecar 已按平台默认；这里显式兜底）
if [ -z "${GPU_MONITOR_INCLUDE_LOCAL:-}" ]; then
  export GPU_MONITOR_INCLUDE_LOCAL=0
fi

URL="http://127.0.0.1:${PORT}"
echo "GPU 监控：$URL （Ctrl-C 退出）"
node "$DIR/lib/sidecar.mjs" &
SIDECAR_PID=$!
trap 'kill "$SIDECAR_PID" 2>/dev/null || true' EXIT INT TERM
sleep 1
if command -v open >/dev/null 2>&1; then
  open "$URL" || true
fi
wait "$SIDECAR_PID"
