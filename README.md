# dsh-gpu-monitor

DeepSeek Harness 插件：利用 `nvidia-smi` 实时监控 **多台机器** 的 GPU 用量，以**方块图停靠左侧边栏底部**（页面布局的固定部分，不悬浮、不挡输入框）。支持：

- **本机** + **`~/.ssh/config` 中所有可用 GPU server**（自动探测，只列出当前可达且有 GPU 的机器；每台机器纵向堆叠成一个分组）
- 每 GPU 一个方块：
  - **填充百分比 = 显存占用**，方块上写 `已用/总量`（G）
  - **填充颜色 = 功率**（按 功率/功率上限 占比分级：绿 <40% < 黄 <70% < 橙 <90% < 红）
  - 方块上写实时功率（W）
- **鼠标悬停方块 ~0.5s** → 显示该卡上的**计算进程**：属主 / PID / 占用显存 / 命令行（触摸设备点按查看）
- 面板**顶部把手可上下拖动**调整面板高度（64px ~ 90vh，记忆在 localStorage；双击把手恢复默认 42vh 上限）
- **拖动分组表头**可调整服务器上下顺序（⠿ 提示）。顺序**宿主侧持久化**（宿主插件与 sidecar 共用 `~/.dsh/gpu-monitor-order.json`，带时间戳），跨浏览器/设备共享"上次退出时的顺序"；本浏览器同时缓存于 localStorage（`dsh-gpu-monitor:order`），sidecar 短暂离线时仍生效，恢复后自动回同步。调和规则保留**含探测不可达机器**在内的全部已保存顺序——机器瞬时掉线不会把它的排序位挤掉，恢复后仍原位

手机/电脑浏览器均可用，主题跟随系统深浅色。

## 代码结构

DSH 插件与 MacBook 独立程序共享同一套核心，宿主/传输层只是薄壳：

```
lib/query.mjs     底层：nvidia-smi/ps 查询、CSV 解析、目标参数（宿主与 sidecar 共用）
lib/sshconfig.mjs 底层：~/.ssh/config 解析（Include 展开、Host * 默认、first-wins）
lib/orderstore.mjs 分组顺序持久化（{o, t} 文件存取，时间戳防旧覆盖）
lib/settings.mjs  运行时设置：设置页可调参数 + server 选取（校验、持久化，见下方"设置页"）
lib/config.mjs    引擎配置契约：三宿主壳（cordis 插件 / sidecar / Electron）共用的
                  默认值、环境变量解析与平台规则（macOS 默认不查本机）
lib/engine.mjs    共享监控引擎：ssh config 探测、周期并行查询、顺序调和、
                  状态快照与订阅（可注入 query 便于测试；refresh() 返回新快照；
                  setSettings() 让设置页的修改立即生效并持久化）
lib/server.mjs    共享 HTTP 传输层：状态/顺序/设置/独立网页 UI 路由（CLI 与 Electron 共用）
lib/index.js      DSH 宿主插件（薄壳：启动引擎 + 注册 /gpu/status、/settings 路由，
                  处理器与 server.mjs 共享）
lib/sidecar.mjs   独立进程 CLI（薄壳：引擎 + 传输层 + DSH 同源 JSON 桥）
electron/main.mjs Electron 原生应用入口（自包含窗口，无需浏览器）
lib/client.js     浏览器 UI（DSH 侧边栏与独立页面/原生应用共用同一份，零重复；
                  含设置弹窗）
lib/webui.mjs     独立页面资源（index.html + 顶栏状态条 + ⚙ 设置按钮 + DSH shim）
```

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

- **宿主半部** `lib/index.js`：周期查询 nvidia-smi（用量 + 计算进程 + ps 属主），通过 `ctx.webServer.register` 注册同源路由 `/gpu/status` 与 `/settings`。配置了 `useSshConfig` 时自动解析 `~/.ssh/config`、探测可用 GPU server 并全部纳入监控。
- **sidecar** `lib/sidecar.mjs`：独立 Node 进程（不依赖 dsh 重启）。当宿主半部还是旧代码（无法热加载、不能重启 dsh）时，由它提供多机数据；等宿主侧重启后 `/gpu/status` 原生返回多机数据，sidecar 可停可留。
- **浏览器半部** `lib/client.js`：`__ModuleLoader__` 模块，经 `sidebar.footer.action` 槽位停靠侧边栏底部，悬停提示为纯 DOM。数据源优先 sidecar，失败自动回退 `/gpu/status`；两者都兼容（`/gpu/status` 返回旧扁平结构时按单机“本机”分组渲染）。
- **设置页**（见下方）：面板 ⚙ 按钮（停靠模式）或顶栏 ⚙（独立页/Electron）打开设置弹窗，调整参数并勾选要监控的 server；修改写入 `~/.dsh/gpu-monitor-settings.json` 立即生效、重启保留。

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
| `GPU_MONITOR_ORDER_FILE` | `~/.dsh/gpu-monitor-order.json` | 分组顺序持久化文件 |
| `GPU_MONITOR_SETTINGS_FILE` | `~/.dsh/gpu-monitor-settings.json` | 运行时设置文件（设置页修改的持久化位置） |

浏览器数据源优先级：**同源 `/gpu-status.json`**（sidecar 写入，无 CORS）→ `/gpu/status`（宿主）→ 可选绝对地址。拉取失败时**沿用上次数据**并显示小黄条提示，不会清空/报红；仅首次加载完全失败才显示红色错误。绝对地址覆盖：URL 加 `?gpuMonitorSidecar=http://host:port/status`，或页面里 `window.__DSH_GPU_MONITOR__ = { sidecarUrl: "…" }`（空串 = 禁用）。

## 设置页（⚙）

面板 ⚙（停靠模式，位于方块区上方）或顶栏 ⚙（独立网页 / Electron）打开设置弹窗，可调整：

| 项 | 说明 | 默认 |
|---|---|---|
| 查询间隔 (ms) | 两次查询之间的间隔 | 3000 |
| 查询超时 (ms) | 每台机器单轮查询超时；单台超时不影响其它机器 | 8000 |
| 探测超时 (ms) | 判定一台机器是否可用的超时 | 4000 |
| 重新探测间隔 (ms) | 重新扫描 ssh config 并探测 server 的间隔 | 60000 |
| 同时监控本机 | 是否查询本机 nvidia-smi（macOS 无 nvidia-smi 时建议关闭） | 平台默认 |
| SSH 配置路径 | 留空 = `~/.ssh/config` | 平台默认 |
| 监控的 server | 勾选要监控的机器（**候选含探测不可达的主机**，勾选后恢复可达即自动纳入；不勾选 = 不监控该机器） | 全部 |

保存后写入 `~/.dsh/gpu-monitor-settings.json`（可被 `GPU_MONITOR_SETTINGS_FILE` 覆盖），**立即生效**且重启保留。

- **优先级**：设置文件里存在的键优先于启动配置（环境变量 / cordis.patch.yml）——启动配置只作初始值。
- **`enabledServers` 语义**：`null` = 全部 server；数组 = 只监控列出的 server。首次保存后即为显式列表：之后在 ssh config 新增的主机默认不监控，需在设置页勾选。
- **宿主与 sidecar 共用同一设置文件**：DSH 侧边栏与 sidecar/Electron 的修改彼此可见（同一台机器上）。
- 设置弹窗按数据源候选链读写 `/settings`（同源宿主 → 显式 sidecar → 默认 127.0.0.1:3499），任一可达即生效。

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

> 这些配置只是**初始值**：设置页保存的值（`~/.dsh/gpu-monitor-settings.json`）优先，重启后仍保留（见"设置页"一节）。

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

`GET /settings`（宿主同源路由 / sidecar / Electron 都有）—— 当前生效设置 + 候选 server 列表：

```json
{
  "ok": true,
  "settings": {
    "intervalMs": 3000, "timeoutMs": 8000, "probeTimeoutMs": 4000, "discoverIntervalMs": 60000,
    "includeLocal": true, "sshConfigPath": "/home/u/.ssh/config",
    "enabledServers": null, "useSshConfig": true
  },
  "candidates": [{ "id": "gpu01", "label": "gpu01", "ok": true, "error": "", "enabled": true }]
}
```

`POST /settings`（部分字段即可；非法值返回 400 并给出具体原因）：

```json
{ "intervalMs": 2000, "enabledServers": ["gpu01", "gpu02"] }
```

## 在 MacBook 上独立运行

无需 DSH、无需本机 `nvidia-smi`（macOS 也没有）：把仓库拷到 MacBook，装好 Node ≥ 22，**两种运行方式**：

### 方式 A：原生应用（推荐，菜单栏常驻）

```bash
npm install            # 首次：拉取 electron（仅开发依赖，不影响 dsh 插件安装）
npm run app            # 菜单栏常驻：Dock 图标隐藏，点菜单栏 🔮 图标弹出监控面板
```

- **左键菜单栏图标**：弹出监控面板（面板左边缘与图标左边缘对齐、跟随图标下方、不抢焦点；**点击面板外任意处自动收起**）
- **右键菜单栏图标**：显示/隐藏、退出
- 引擎常驻后台持续刷新，面板随时弹出即最新数据；默认宽度按 8 卡 4×2 两排刚好放下（252px），面板可手动拉大
- 想要独立大窗口（非常驻）：`npm run app:window`
- 打包成可双击的 `.app`/`.dmg`：`npm run dist`（`dist/GPU Monitor-*.dmg`）

> **安装很慢？** 仓库自带 `.npmrc`（electron 二进制走 npmmirror 镜像）。若已卡住，先 Ctrl-C，
> 然后 `npm install --no-audit --no-fund` 重试；若只是二进制没下完，可单独补：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。
> 海外用户可删除 `.npmrc` 或改用官方源。

可选：打包成可双击的 `.app`/`.dmg`：

```bash
npm run dist           # electron-builder 打包 → dist/GPU Monitor-*.dmg
```

### 方式 B：网页模式

```bash
npm run macbook        # 等价: bash scripts/macbook.sh
```

浏览器自动打开 `http://127.0.0.1:3499`。Ctrl-C 退出。

两种方式都解析 MacBook 的 `~/.ssh/config`，探测其中可用的 GPU server 并实时监控（方块图、悬停看进程、拖动排序、高度调整、顶栏状态条全部可用）。

- **主题自动跟随 macOS 系统深浅色**（原生应用与网页模式一致；菜单栏图标为 template 图片同样随系统变色）
- 默认**不查询本机**（macOS 无 nvidia-smi，按平台自动关闭）；`GPU_MONITOR_INCLUDE_LOCAL=1` 可强制开启
- 需 MacBook 到各 GPU server 已配 SSH 免密登录（与 Linux 上一致）
- 分组顺序同样持久化在 `~/.dsh/gpu-monitor-order.json`，跨浏览器/设备共享
- 任何有 node + ssh 的电脑同样适用：`node lib/sidecar.mjs` 后访问该端口
- 远程访问（网页模式）改 `GPU_MONITOR_HOST=0.0.0.0`，浏览器访问 `http://<机器IP>:3499`；排序回同步走同源 POST，无需额外配置
- 技术说明：独立页面/原生应用通过 `lib/webui.mjs` 里一个 ~60 行的 shim（模拟 `__ModuleLoader__`/React/slots）让 `lib/client.js` **原样**运行，UI 零重复维护；HTTP 路由（`/`、`/dsh-shim.js`、`/plugins/dsh-gpu-monitor/client.js`、`/gpu-status.json`、`/gpu/status`、`GET/POST /settings`、`POST /order`）由 `lib/server.mjs` 提供，CLI 与 Electron 共用；DSH 宿主插件注册同源 `/gpu/status`、`/settings`、`/order`（处理器共享，顺序与设置与 sidecar 共用同一持久化文件）

## 开发

```bash
npm test          # 运行单元测试（node:test，52 个用例）
npm run sidecar   # 前台运行 sidecar
```

- 查询经 `spawn` 数组参数执行，永不 `shell:true`；查询失败只记录错误状态，不搞崩启动
- 探测语义：“可用”= 能 SSH 免密登录且 `nvidia-smi` 至少报 1 张 GPU；不可达/无 GPU 的主机（如 `github.com`）自动排除，失败不致命
- 多机查询并行执行，单台超时只影响该台
- SSH 模式需要本机到 GPU 节点已配密钥免密登录
- 侧边栏槽位注册失败时自动退回右下角悬浮模式（自动浮于输入框上方）

## License

MIT
