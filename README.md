# @openclaw/resilience

LLM API 错误统计、分类、重试、任务恢复插件 — OpenClaw Plugin

这个项目以 Apache-2.0 协议开源，希望把 OpenClaw 使用中常见的 API 过载、超时、重试和任务恢复问题沉淀成一个大家都能直接使用、改进和分享的插件。

## 简介

当你使用大模型 API（无论是内网部署还是云端服务）时，经常会遇到：

- 🔴 **API 过载** — 503/429 错误频繁出现
- ⏱️ **请求超时** — 大量请求因超时失败
- 🔁 **任务中断** — 运行中的任务突然失败需要恢复
- ⚙️ **策略不一** — 不同模型、不同场景需要不同的重试策略

`@openclaw/resilience` 插件为 OpenClaw 提供完整的 API 健康监控和自动重试能力。

## 功能

- 📊 **错误分类** — 自动将 API 错误分为 8 种类型（rate_limit、server_overload、timeout 等）
- 📝 **持久化日志** — 按日期记录每次 API 调用结果（JSONL 格式）
- 📈 **多维统计** — 按时间（小时/日/周）和模型统计错误率、耗时
- 🔁 **灵活重试** — 支持固定间隔、指数退避、自定义时间表三种策略
- 🔄 **任务恢复** — 任务中断时保存上下文，支持自动恢复
- 🛠️ **自然语言交互** — 通过 Skill 直接用自然语言查询和管理
- 🖥️ **Web 监控面板** — 浏览器实时查看错误统计、选择重试方案（5s/60s/5min/1h 刷新）

## 安装

### 作为 OpenClaw 插件

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

### 通过 Skill 自然语言交互

安装插件后，以下 Skill 命令自动可用：

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
- **`agent_end`** — Agent 运行结束时检测中断任务

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
| `unknown` | — | 未知错误 | ❌ |

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

所有数据持久化在 `~/.openclaw/plugins/resilience/` 目录：

```
~/.openclaw/plugins/resilience/
├── logs/                    # 按日期的 JSONL 日志
│   ├── 2026-06-01.jsonl
│   ├── 2026-06-02.jsonl
│   └── 2026-06-03.jsonl
├── stats.json               # 聚合统计数据
├── strategies.json          # 重试策略配置
└── tasks/                   # 可恢复任务状态
    ├── task-001.json
    └── task-002.json
```

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

Apache License 2.0. 详见 [LICENSE](./LICENSE)。

## 相关

- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 平台
- [OpenClaw Plugin SDK](https://docs.openclaw.dev/plugins) — 插件开发文档
