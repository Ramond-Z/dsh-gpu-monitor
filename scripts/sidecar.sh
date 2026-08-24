#!/usr/bin/env bash
# dsh-gpu-monitor sidecar 启动/停止脚本（常驻后台，不影响 dsh 进程）。
set -euo pipefail
LOG=/tmp/dsh-gpu-monitor-sidecar.log
PIDFILE=/tmp/dsh-gpu-monitor-sidecar.pid
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "sidecar 已在运行 (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    setsid nohup node "$DIR/lib/sidecar.mjs" >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    echo "sidecar 已启动 (pid $(cat "$PIDFILE"))，日志: $LOG"
    sleep 1
    curl -s "http://127.0.0.1:${GPU_MONITOR_PORT:-3499}/health" || echo "（health 检查失败，看日志）"
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "已停止" || echo "未在运行"
      rm -f "$PIDFILE"
    else
      echo "没有 pidfile"
    fi
    ;;
  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;
  *)
    echo "用法: $0 {start|stop|restart}" >&2
    exit 1
    ;;
esac
