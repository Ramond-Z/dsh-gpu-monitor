# dsh-gpu-monitor

DeepSeek Harness 插件：利用 `nvidia-smi` 实时监控 **多台机器** 的 GPU 用量，以**方块图停靠左侧边栏底部**（页面布局的固定部分，不悬浮、不挡输入框）。支持：

- **本机** + **`~/.ssh/config` 中所有可用 GPU server**（自动探测，只列出当前可达且有 GPU 的机器；每台机器纵向堆叠成一个分组）
- 每 GPU 一个方块：
  - **填充百分比 = 显存占用**，方块上写 `已用/总量`（G）
  - **填充颜色 = 功率**（按 功率/功率上限 占比分级：绿 <40% < 黄 <70% < 橙 <90% < 红）
  - 方块上写实时功率（W）
- **鼠标悬停方块 ~0.5s** → 显示该卡上的**计算进程**：属主 / PID / 占用显存 / 命令行（触摸设备点按查看）
- 面板**顶部把手可上下拖动**调整面板高度（64px ~ 90vh，记忆在 localStorage；双击把手恢复默认 42vh 上限）

手机/电脑浏览器均可用，主题跟随系统深浅色。

## 架构

```
浏览器(侧边栏方块图)
  ├─ fetch 3s → /gpu-status.json  同源桥（sidecar 写入 dsh 前端 dist，无 CORS，远程浏览器也可用）
  ├─ 回退 → /gpu/status           主服务 3080 同源路由（本机/单机数据）
  └─ 可选 → ?gpuMonitorSidecar=…  绝对地址 sidecar（远程部署覆盖）
                                    │
                    sidecar（独立进程，可随时启停，不影响 dsh）
                                    └─ nvidia-smi + ps / ssh → 本机 + 各 GPU server
```

- **宿主半部** `lib/index.js`：周期查询 nvidia-smi（用量 + 计算进程 + ps 属主），通过 `ctx.webServer.register` 注册同源路由 `/gpu/status`。配置了 `useSshConfig` 时自动解析 `~/.ssh/config`、探测可用 GPU server 并全部纳入监控。
- **sidecar** `lib/sidecar.mjs`：独立 Node 进程（不依赖 dsh 重启）。当宿主半部还是旧代码（无法热加载、不能重启 dsh）时，由它提供多机数据；等宿主侧重启后 `/gpu/status` 原生返回多机数据，sidecar 可停可留。
- **浏览器半部** `lib/client.js`：`__ModuleLoader__` 模块，经 `sidebar.footer.action` 槽位停靠侧边栏底部，悬停提示为纯 DOM。数据源优先 sidecar，失败自动回退 `/gpu/status`；两者都兼容（`/gpu/status` 返回旧扁平结构时按单机“本机”分组渲染）。

## 安装与启动

### 1. 插件安装（宿主侧，重启后生效）

```bash
dsh plugin --profile <name> add <本仓库路径或 git 地址>
```

`dsh plugin add` 会把包名加入 profile 的 `dsh.profile.bundles`，然后**重启 `dsh <profile>`** 使宿主查询代码生效，并刷新页面。

> 注意：`file:` 依赖会被**复制**进 profile 的 node_modules。仓库改动后需同步：
> ```bash
> cp lib/*.js lib/*.mjs cordis.patch.yml package.json ~/.dsh/profiles/web/node_modules/dsh-gpu-monitor/lib/ 2>/dev/null
> cp cordis.patch.yml package.json ~/.dsh/profiles/web/node_modules/dsh-gpu-monitor/
> ```
> 浏览器半部（`lib/client.js`）同步后经 HMR 即时生效（刷新页面兜底）；宿主半部需重启。

### 2. 启动 sidecar（多机数据，无需重启 dsh）

```bash
node lib/sidecar.mjs            # 前台调试
setsid nohup node lib/sidecar.mjs >> /tmp/dsh-gpu-monitor-sidecar.log 2>&1 < /dev/null &   # 后台常驻
```

环境变量（均有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GPU_MONITOR_PORT` | `3499` | 监听端口 |
| `GPU_MONITOR_HOST` | `127.0.0.1` | 监听地址；远程浏览器访问时改 `0.0.0.0` |
| `GPU_MONITOR_SSH_CONFIG` | `~/.ssh/config` | ssh config 路径 |
| `GPU_MONITOR_INCLUDE_LOCAL` | `1` | 是否同时查询本机 nvidia-smi（`0` 关闭） |
| `GPU_MONITOR_JSON_PATH` | 自动探测 | 同源桥 JSON 写入路径（dsh 前端 dist 下 `gpu-status.json`） |
| `GPU_MONITOR_INTERVAL_MS` | `3000` | 查询间隔 |
| `GPU_MONITOR_DISCOVER_INTERVAL_MS` | `60000` | 重新探测 server 列表间隔 |
| `GPU_MONITOR_QUERY_TIMEOUT_MS` | `8000` | 每台机器查询超时 |
| `GPU_MONITOR_PROBE_TIMEOUT_MS` | `4000` | 探测超时 |

浏览器数据源优先级：**同源 `/gpu-status.json`**（sidecar 写入，无 CORS）→ `/gpu/status`（宿主）→ 可选绝对地址。拉取失败时**沿用上次数据**并显示小黄条提示，不会清空/报红；仅首次加载完全失败才显示红色错误。绝对地址覆盖：URL 加 `?gpuMonitorSidecar=http://host:port/status`，或页面里 `window.__DSH_GPU_MONITOR__ = { sidecarUrl: "…" }`（空串 = 禁用）。

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: dsh-gpu-monitor
  config:
    intervalMs: 3000       # 查询间隔 ms（默认 3000）
    queryTimeoutMs: 8000   # nvidia-smi/ps 超时 ms（默认 8000）
    sshTarget: ""          # 留空=本机；填 "user@gpu-node" = 经 SSH 查询单台
    useSshConfig: true     # 解析 ~/.ssh/config，探测其中可用的 GPU server 一并监控
    sshConfigPath: ""      # 留空 = ~/.ssh/config
    includeLocal: true     # useSshConfig 时是否同时监控本机
    discoverIntervalMs: 60000  # 重新探测 server 列表间隔
    probeTimeoutMs: 4000   # 探测超时
```

## API

`GET /gpu/status`（宿主侧；多机模式返回 `servers` 数组）：

```json
{
  "ok": true,
  "at": "ISO 时间",
  "source": "host",
  "servers": [{
    "host": "local", "label": "本机", "ok": true, "at": "ISO 时间",
    "gpus": [{
      "index": "0", "name": "NVIDIA GeForce RTX 3090",
      "memUsedMB": 15808, "memTotalMB": 24576,
      "utilPct": 64, "tempC": 45, "powerW": 215, "powerLimitW": 350,
      "processes": [{ "pid": "920434", "user": "yuzq", "name": "python", "memMB": 21800, "cmd": "uv run python main.py ..." }]
    }]
  }]
}
```

`GET http://127.0.0.1:3499/status`（sidecar）返回同样的 `servers` 结构（`source: "sidecar"`，带 CORS）。

## 开发

```bash
npm test          # 运行解析单元测试（node:test，16 个用例）
npm run sidecar   # 前台运行 sidecar
```

- 查询经 `spawn` 数组参数执行，永不 `shell:true`；查询失败只记录错误状态，不搞崩启动
- 探测语义：“可用”= 能 SSH 免密登录且 `nvidia-smi` 至少报 1 张 GPU；不可达/无 GPU 的主机（如 `github.com`）自动排除，失败不致命
- 多机查询并行执行，单台超时只影响该台
- SSH 模式需要本机到 GPU 节点已配密钥免密登录
- 侧边栏槽位注册失败时自动退回右下角悬浮模式（自动浮于输入框上方）

## License

MIT
