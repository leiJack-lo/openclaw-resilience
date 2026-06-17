# @leiJack-lo/resilience

LLM API 错误统计、分类、重试、任务恢复插件 — OpenClaw Plugin

这个项目以 MIT 协议开源，希望把 OpenClaw 使用中常见的 API 过载、超时、重试和任务恢复问题沉淀成一个大家都能直接使用、改进和分享的插件。

## 简介

当你使用大模型 API（无论是内网部署还是云端服务）时，经常会遇到：

- 🔴 **API 过载** — 503/429 错误频繁出现
- ⏱️ **请求超时** — 大量请求因超时失败
- 🔁 **任务中断** — 运行中的任务突然失败需要恢复
- ⚙️ **策略不一** — 不同模型、不同场景需要不同的重试策略

`@leiJack-lo/resilience` 插件为 OpenClaw 提供完整的 API 健康监控和自动重试能力。

## 功能

- 📊 **错误分类** — 自动将 API / 会话错误分为 11 种类型（rate_limit、server_overload、token_parse_error 等）
- 📝 **持久化日志** — 按日期记录每次 API 调用结果（JSONL 格式）
- 📈 **多维统计** — 按时间（小时/日/周）和模型统计错误率、耗时
- 🔁 **灵活重试** — 支持固定间隔、指数退避、自定义时间表三种策略
- 🔄 **任务恢复** — 任务中断时保存上下文，支持自动恢复
- 🧭 **会话恢复指令** — 会话运行错误后自动给下一轮注入“检查任务是否完成并继续”的恢复上下文，支持中英文和自定义话术
- 🛠️ **自然语言交互** — 通过 Skill 直接用自然语言查询和管理
- 🖥️ **Web 监控面板** — 浏览器实时查看错误统计、选择重试方案（5s/60s/5min/1h 刷新）
- 🔀 **多实例聚合** — 多个 OpenClaw Gateway / workspace 的数据统一在一个面板查看

## 安装

### 从 ClawHub 安装（推荐）

```bash
clawhub login

# 1. 先装插件（必须加 --dangerously-force-unsafe-install）
#    原因见下文 "为什么需要 dangerous 标志"
openclaw plugins install clawhub:@leiJack-lo/resilience --dangerously-force-unsafe-install

# 2. 再装配套 Skill（强烈推荐，提供中文自然语言话术）
openclaw skills install resilience-monitor

# 3. 重启 Gateway（插件的 hooks 和工具注册必须重启后才生效）
openclaw gateway restart
```

**重要顺序**：必须先插件 → 再 Skill → 再 restart。  
只装 Skill 不装插件的话，agent 拿到的只是描述，实际工具调用会失败，自动错误跟踪也不会工作。

在 `~/.openclaw/openclaw.json` 的 `plugins.entries.resilience` 下增加 `config`（面板端口等），见下方「配置」。

> 安装时若提示 dangerous code：插件会用 `open` 打开本机监控面板 + 启动本地 HTTP Dashboard + 注册 model_call_ended hook，属**完全预期行为**，不是恶意代码。ClawHub 因此把插件标为 suspicious（正常现象）。

### 作为 OpenClaw 插件（Git 源码）

```bash
# 1. 克隆到 OpenClaw 插件目录
cd ~/.openclaw/plugins/
git clone https://github.com/leiJack-lo/openclaw-resilience.git

# 2. 安装依赖
cd openclaw-resilience
npm install

# 3. 构建
npm run build

# 4. 重启 OpenClaw Gateway
openclaw gateway restart
```

### 手动安装

```bash
# 1. 克隆项目
git clone https://github.com/leiJack-lo/openclaw-resilience.git
cd openclaw-resilience

# 2. 安装依赖并构建
npm install
npm run build

# 3. 将 dist/ 目录链接或复制到 OpenClaw 插件目录
```

## 配置

插件通过 `openclaw.plugin.json` 支持以下配置项：

```json
{
  "logDir": "~/.openclaw/plugins/resilience/logs",
  "statsRetentionDays": 90,
  "defaultStrategy": "exponential"
}
```

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `logDir` | string | `~/.openclaw/plugins/resilience/logs` | 日志存储目录 |
| `statsRetentionDays` | number | `90` | 统计数据保留天数 |
| `defaultStrategy` | string | `"exponential"` | 默认重试策略类型 |
| `dashboardEnabled` | boolean | `true` | Gateway 启动时自动开启监控面板 |
| `dashboardPort` | number | `18765` | 面板 HTTP 端口（仅本机） |
| `instanceId` | string | gateway-instance-id | 实例 ID（数据隔离目录名） |
| `instanceLabel` | string | workspace 目录名 | 面板中显示的名称 |
| `workspacePath` | string | — | 用于自动推断 instanceLabel |
| `sessionRecoveryEnabled` | boolean | `true` | 会话失败时是否自动注入下一轮恢复指令 |
| `sessionRecoveryLanguage` | `"zh"` / `"en"` | `"zh"` | 默认恢复指令语言 |
| `sessionRecoveryPrompt` | string | — | 自定义恢复指令（覆盖中英文默认话术） |
| `sessionRecoveryPromptZh` | string | — | 自定义中文恢复指令 |
| `sessionRecoveryPromptEn` | string | — | 自定义英文恢复指令 |
| `sessionRecoveryTtlMs` | number | `600000` | 恢复指令在下一轮上下文中的有效期 |
| `sessionRecoveryCooldownMs` | number | `300000` | 同一会话自动注入恢复指令的最小间隔 |
| `sessionRecoveryMaxPerSession` | number | `3` | 同一会话每个 Gateway 进程最多自动注入次数 |

## 多实例

每个 OpenClaw Gateway 使用独立数据目录：

```
~/.openclaw/plugins/resilience/instances/<instance-id>/
  meta.json           # 标签、workspace、最后活跃时间
  stats.json
  strategies.json
  recovery-settings.json
  logs/
  tasks/
  active-retries.json
```

实例 ID 默认读取 `~/.openclaw/gateway-instance-id`，也可用 `instanceId` 配置或环境变量 `OPENCLAW_RESILIENCE_INSTANCE_ID` 覆盖。

监控面板顶部可选择 **「全部实例（聚合）」** 或单个实例；旧版平铺数据（`~/.openclaw/plugins/resilience/stats.json`）会自动作为 `default (legacy)` 显示。

## Web 监控面板

Gateway 启动后默认在 **http://127.0.0.1:18765/** 提供监控页面，也可通过自然语言打开：

```
打开错误统计页面
打开监控面板
打开 resilience 面板
```

面板功能：

- 今日/本小时错误概览、模型统计表、最近错误列表
- 活跃重试任务状态
- 重试策略卡片：设为默认、调整最大重试次数、恢复默认
- 自动刷新：**5 秒** / **60 秒** / **5 分钟** / **1 小时** / 关闭

## 使用

### 通过 Skill 自然语言交互（推荐）

**前提**：必须已经按上面的顺序装好插件 + Skill 并重启过 gateway。

安装插件后，以下 Skill 命令自动可用（Skill 只是话术层，底层还是插件提供的工具）：

```
# 查看今天报错统计
"查看今天报错统计"

# 查看特定模型的错误率
"查看 mimo-v2.5 的错误率"

# 修改重试策略
"修改超时重试策略为指数退避"

# 查看所有策略配置
"查看当前所有策略配置"

# 生成日报
"生成今日错误日报"

# 打开 Web 监控面板
"打开错误统计页面"
```

### 通过工具调用

插件注册了 4 个工具：

#### `resilience_stats`

```typescript
// 查看今日统计
resilience_stats({ query: "today" })

// 查看特定模型
resilience_stats({ query: "mimo-v2.5" })

// 查看本周
resilience_stats({ query: "week" })
```

#### `resilience_strategies`

```typescript
// 列出所有策略
resilience_strategies({ action: "list" })

// 添加新策略
resilience_strategies({
  action: "add",
  strategyName: "my-strategy",
  updates: {
    type: "custom",
    maxRetries: 3,
    intervals: [60000, 300000, 600000],
    retryOn: ["rate_limit", "server_overload"]
  }
})

// 更新策略
resilience_strategies({
  action: "update",
  strategyName: "default-exponential",
  updates: { maxRetries: 8 }
})

// 重置为默认
resilience_strategies({ action: "reset" })
```

#### `resilience_report`

```typescript
// 生成日报
resilience_report({ reportType: "daily" })

// 生成指定日期报告
resilience_report({ reportType: "daily", target: "2026-06-03" })

// 查看模型报告
resilience_report({ reportType: "model", target: "mimo-v2.5" })

// 查看任务恢复状态
resilience_report({ reportType: "recovery" })

// 完整报告
resilience_report({ reportType: "full" })
```

#### `resilience_dashboard`

```typescript
// 启动面板并在浏览器打开
resilience_dashboard({ action: "open" })

// 查看运行状态
resilience_dashboard({ action: "status" })

// 停止面板服务
resilience_dashboard({ action: "stop" })
```

### Hook 自动拦截

插件自动注册了以下 Hook：

- **`model_call_ended`** — 每次 API 调用结束后自动记录错误、更新统计、检查重试
- **`agent_end`** — Agent 运行结束时检测会话中断，记录会话错误统计，并在下一轮注入恢复指令

## 错误分类

| 类别 | HTTP 状态 | 描述 | 可重试 |
|------|-----------|------|--------|
| `rate_limit` | 429 | 请求频率超限 | ✅ |
| `server_overload` | 503 | 服务过载 | ✅ |
| `timeout` | — | 请求超时 | ✅ |
| `auth_failed` | 401/403 | 认证失败 | ❌ |
| `network_error` | — | 网络连接错误 | ✅ |
| `model_unavailable` | — | 模型不存在或下线 | ✅ |
| `context_too_long` | — | 上下文超长 | ❌ |
| `token_parse_error` | — | token / tokenizer / token 解析相关错误 | ❌ |
| `invalid_model_output` | — | 模型返回内容格式异常、JSON/schema 解析失败等 | ❌ |
| `session_runtime_error` | — | 非模型 API 调用层面的会话运行错误 | ❌ |
| `unknown` | — | 未知错误 | ❌ |

## 会话恢复设置

当 `agent_end` 报告会话失败时，插件会：

1. 将错误分类并写入日志/统计。
2. 为当前 session 创建一条恢复任务记录。
3. 通过 OpenClaw `enqueueNextTurnInjection` 给下一轮注入恢复指令，例如“任务完成了吗？如果没有，请继续完成任务”。

可直接通过 Skill / 工具修改继续任务话术：

```js
// 查看当前恢复设置
resilience_recovery({ action: "show" })

// 改成中文默认话术
resilience_recovery({ action: "update", language: "zh" })

// 改成英文默认话术
resilience_recovery({ action: "update", language: "en" })

// 自定义继续任务话术
resilience_recovery({
  action: "update",
  language: "zh",
  prompt: "刚才任务中断了。请先判断原任务是否完成；如果没完成，请继续把它做完。"
})
```

## 重试策略

### 策略类型

- **`fixed`** — 固定间隔重试（如每 30 秒）
- **`exponential`** — 指数退避（1min → 2min → 4min → 8min...）
- **`custom`** — 自定义时间表（如 [1min, 3min, 5min, 15min, 30min]）

### 默认策略

| 名称 | 类型 | 最大重试 | 间隔 | 适用错误 |
|------|------|----------|------|----------|
| `default-exponential` | exponential | 5 | 1m → 15m | rate_limit, server_overload, timeout, network_error |
| `rate-limit-fixed` | fixed | 3 | 30s | rate_limit |
| `model-backoff` | custom | 6 | 1m → 2h | server_overload, model_unavailable |
| `network-retry` | exponential | 4 | 5s → 1m | network_error |

### 策略配置

每个策略支持：

```json
{
  "name": "strategy-name",
  "type": "exponential",
  "maxRetries": 5,
  "intervals": [60000, 180000, 300000],
  "retryOn": ["rate_limit", "server_overload"],
  "cooldownMs": 10000,
  "models": ["mimo-v2.5", "gpt-4o"]
}
```

## 数据存储

每个实例的数据在 `~/.openclaw/plugins/resilience/instances/<instance-id>/`（见「多实例」章节）。旧版单目录布局仍可读。

### 日志格式

每条日志（JSONL）：

```json
{
  "timestamp": "2026-06-03T10:30:00.000Z",
  "provider": "openai",
  "model": "gpt-4o",
  "errorType": "rate_limit",
  "errorMessage": "429 Too Many Requests",
  "httpStatus": 429,
  "durationMs": 1523,
  "sessionId": "sess_abc123",
  "runId": "run_xyz789",
  "retryCount": 2,
  "recovered": true
}
```

## 项目结构

```
openclaw-resilience/
├── README.md                 # 本文档
├── package.json              # NPM 包配置
├── tsconfig.json             # TypeScript 配置
├── openclaw.plugin.json      # OpenClaw 插件清单
├── src/
│   ├── index.ts              # 插件入口（注册工具和 Hook）
│   ├── error-classifier.ts   # 错误分类器
│   ├── retry-engine.ts       # 重试策略引擎
│   ├── task-recovery.ts      # 任务恢复管理
│   ├── stats-collector.ts    # 统计收集器
│   ├── logger.ts             # 日志管理器
│   └── types.ts              # 类型定义
├── skill/
│   ├── SKILL.md              # Skill 描述文档
│   └── skill.json            # Skill 元数据
├── config/
│   └── default-strategies.json  # 默认重试策略
└── tests/                    # 测试文件（后续补充）
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（watch）
npm run dev

# 构建
npm run build

# 清理
npm run clean
```

## 贡献

欢迎提交 Issue 和 Pull Request。这个插件的目标很朴素：把实际使用 OpenClaw 时遇到的模型 API 报错、过载、超时和任务中断问题，变成可复用的解决方案。

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

MIT License. 详见 [LICENSE](./LICENSE)。

## 安全与信任

本插件设计为**最小权限、本地只读监控**工具：

- 使用经过审计的 `open` 包（而非原始 `child_process.exec`）打开本地浏览器查看面板。
- 本地 HTTP Dashboard（默认 127.0.0.1:18765）仅服务静态文件 + 只读 JSON API，无外部访问、无写权限到系统。
- 所有持久化数据仅在 `~/.openclaw/plugins/resilience/instances/<id>/` 下（用户可随时删除）。
- Hooks 只观察 `model_call_ended` 和 `agent_end` 用于错误分类/重试/恢复，不修改请求内容。
- 源码完全开源 + ClawHub source-linked 验证。
- 发布时通过 ClawHub 自动化安全扫描（VirusTotal + agentic risk checks）。当前因需要本地执行（浏览器 + 服务器）标记为 suspicious（这是监控类插件的常见情况，非恶意）。我们持续优化以争取 benign 状态。

如果扫描仍提示，请查看 [ClawHub 安全指南](https://clawhub.ai) 或联系 security@openclaw.ai 提供本项目链接说明用途。

安装时 `--dangerously-force-unsafe-install` 是因为插件声明 "executes code"（用于安全打开本地 URL），属于预期。

### Known Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Local dashboard can display operational error, retry, and model performance details. | Open the dashboard only when needed, avoid using it during screen sharing or on shared machines, and close or stop it when monitoring is complete. All data is stored locally under user-controlled `~/.openclaw/plugins/resilience/`. |
| Retry strategy edits can change local Gateway retry behavior. | Review strategy changes before applying them and scope edits to the intended local Gateway instance. Changes are persisted only in user-writable directories. |
| Hooks observe `model_call_ended` (LLM API results). | Hooks are read-only observers for classification/recovery only. No request modification, no external network calls from the plugin (except local browser open via audited `open` package). |
| Runs a local HTTP server (for dashboard). | Server binds exclusively to 127.0.0.1 (localhost). Hardened with security headers (no wide CORS, nosniff, frame deny, CSP). Serves only bundled static files + controlled JSON API. No authentication needed because local-only. |
| "executes code" / child process for browser open. | We use the well-audited `open` npm package (not raw exec/shell). This is a standard, benign pattern for local monitoring UIs. |

We have proactively optimized for ClawHub scans (cleaner packaging, safer browser launch, explicit declarations in manifest, detailed transparency docs). Current scan is "suspicious" (common for plugins with local servers + model hooks); we are requesting review for "benign".

## 相关

- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 平台
- [OpenClaw Plugin SDK](https://docs.openclaw.dev/plugins) — 插件开发文档
