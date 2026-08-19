# dsh-gpu-monitor

DeepSeek Harness 插件：利用 `nvidia-smi` 实时监控 GPU 用量，以**方块图停靠左侧边栏底部**（页面布局的固定部分，不悬浮、不挡输入框）。每 GPU 一个方块：

- **填充百分比 = 显存占用**，方块上写 `已用/总量`（G）
- **填充颜色 = 功率**（按 功率/功率上限 占比分级：绿 <40% < 黄 <70% < 橙 <90% < 红）
- 方块上写实时功率（W）
- **鼠标悬停方块 ~0.5s** → 显示该卡上的**计算进程**：属主 / PID / 占用显存 / 命令行（触摸设备点按查看）

手机/电脑浏览器均可用（数据走主服务**同源路由**，无需额外端口转发），主题跟随系统深浅色。

## 架构

```
浏览器(侧边栏方块图) ←fetch 3s→ /gpu/status (主服务 3080 同源路由) ←nvidia-smi + ps / ssh→ GPU 节点
```

- **宿主半部** `lib/index.js`：周期查询 nvidia-smi（用量 + 计算进程 + ps 属主），通过 `ctx.webServer.register` 注册同源路由 `/gpu/status`
- **浏览器半部** `lib/client.js`：`__ModuleLoader__` 模块，经 `sidebar.footer.action` 槽位停靠侧边栏底部，悬停提示为纯 DOM

## 配置（profile 的 cordis.patch.yml）

```yaml
- id: dsh-gpu-monitor
  config:
    intervalMs: 3000     # 查询间隔 ms（默认 3000）
    queryTimeoutMs: 8000 # nvidia-smi/ps 超时 ms（默认 8000）
    sshTarget: ""        # 留空=本机 nvidia-smi；填 "user@gpu-node" = 经 SSH 查询
```

## 安装

```bash
dsh plugin --profile <name> add <本仓库路径或 git 地址>
```

`dsh plugin add` 会自动把包名加入 profile 的 `dsh.profile.bundles`，然后**重启 `dsh <profile>`**（宿主查询代码在启动时加载）并刷新页面。

> 提示：浏览器半部的改动刷新页面即生效；宿主半部（查询逻辑）的改动需要重启。

## API

`GET /gpu/status` 返回：

```json
{
  "ok": true,
  "at": "ISO 时间",
  "gpus": [{
    "index": "0", "name": "NVIDIA GeForce RTX 3090",
    "memUsedMB": 15808, "memTotalMB": 24576,
    "utilPct": 64, "tempC": 45, "powerW": 215, "powerLimitW": 350,
    "processes": [{ "pid": "920434", "user": "yuzq", "name": "python", "memMB": 21800, "cmd": "uv run python main.py ..." }]
  }]
}
```

## 开发

```bash
npm test          # 运行解析单元测试（node:test）
```

- 查询经 `spawn` 数组参数执行，永不 `shell:true`；查询失败只记录错误状态，不搞崩启动
- SSH 模式需要本机到 GPU 节点已配密钥免密登录
- 侧边栏槽位注册失败时自动退回右下角悬浮模式（自动浮于输入框上方）

## License

MIT
