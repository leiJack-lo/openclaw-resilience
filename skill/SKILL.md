# Resilience Skill

LLM API error tracking, classification, retry, and task recovery for OpenClaw.

> **⚠️ 必须先安装配套插件，否则此 Skill 完全无法工作**  
> 此 Skill **仅提供自然语言描述、示例和触发话术**。  
> **核心实现（工具注册、model_call_ended 自动错误记录 hook、重试引擎、Dashboard HTTP 服务、JSONL 日志与统计持久化）全部来自插件 `@leiJack-lo/resilience`**。  
> 只装 Skill 不装插件 → 工具不存在、调用失败、不会自动收集数据、Dashboard 也不会启动。

## 安装（必须按顺序）

```bash
clawhub login

# 1. 安装插件（必须带 --dangerously-force-unsafe-install）
# 原因：插件会使用 open 包打开浏览器、启动本地 HTTP server (默认 18765)、
# 注册 model_call_ended / agent_end / after_tool_call 等敏感 hook、读写 ~/.openclaw/plugins/resilience/ 下的日志和配置。
# ClawHub 安全扫描因此标记为 "suspicious"（这是正常行为，不是恶意代码）。
openclaw plugins install clawhub:@leiJack-lo/resilience --dangerously-force-unsafe-install

# 2. 安装此 Skill（获得中文自然语言能力 + 工具描述）
openclaw skills install resilience-monitor

# 3. OpenClaw 2026.6.10+：允许 agent_end 会话恢复 hook 读取会话结束事件
# 不设置时，API 错误统计仍可用，但“会话失败统计 + 下一轮恢复指令”不会启用。
openclaw config set plugins.entries.resilience.hooks.allowConversationAccess true

# 4. 必须重启 Gateway，让插件的 hooks 和工具真正注册生效
openclaw gateway restart
```

安装成功后即可直接对 agent 说中文指令，例如：
- "查看今天报错统计"
- "打开 resilience 面板"
- "修改超时重试策略为指数退避"
- "生成今日错误日报"
- "本地包装 API 返回 200 但 body 有错误，帮我归类并配重试策略"
- "给 wrapped_api_error 加 4 次、15 秒起跳的指数重试"

**验证方法**：重启后问 agent "resilience 插件安装好了吗？" 或直接试一个工具调用。如果提示工具不存在，就说明插件没加载成功。

配置（面板端口、是否自动启动 Dashboard 等）放在 `~/.openclaw/openclaw.json` 的 `plugins.entries.resilience.config` 下；OpenClaw 2026.6.10+ 的会话恢复授权放在 `plugins.entries.resilience.hooks.allowConversationAccess` 下（见下方 dashboard 工具说明）。

## Overview

This skill adds natural language support and Chinese examples **on top of the Resilience plugin**. It lets your agent monitor API health, inspect per-model error patterns, adjust retry strategies, generate reports, and control the live dashboard using everyday language.

Use it to:

- Monitor API error rates and patterns
- View per-model performance statistics
- Configure retry strategies
- Generate error reports
- Track task recovery status
- Track agent session and tool failure recovery queues
- Configure automatic session recovery prompts in Chinese or English

## Tools

### resilience_dashboard

Open the live web dashboard in your browser for real-time error stats and retry strategy management.

**Parameters:**
- `action`: `"open"` (default) | `"status"` | `"stop"`

**Features:**
- Live error overview (today / hour / active retries)
- Model breakdown table
- Recent errors feed
- Session/tool recovery queue summary
- Retry strategy cards — set default, adjust max retries
- Auto-refresh: **5s**, **60s**, **5min**, **1h**, or off

**URL:** `http://127.0.0.1:18765/` (default port, configurable via `dashboardPort`)

**Voice / natural language examples:**
- "打开错误统计页面" → `resilience_dashboard({ action: "open" })`
- "打开监控面板" → `resilience_dashboard({ action: "open" })`
- "打开 resilience 面板" → `resilience_dashboard({ action: "open" })`

The dashboard starts automatically when OpenClaw Gateway starts (unless `dashboardEnabled: false`).

**重要**：这些配置只有在**插件已正确安装并加载**后才生效（见最上面的安装前提）。

**Configuration** lives in `~/.openclaw/openclaw.json` under `plugins.entries.resilience.config` (not only `api.pluginConfig` at hook time). Example:

```json
"resilience": {
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true
  },
  "config": {
    "dashboardPort": 18765,
    "dashboardEnabled": true,
    "instanceLabel": "my-workspace"
  }
}
```

At `gateway_start`, config is read from `ctx.config` + `ctx.workspaceDir`.

**Multi-instance:** Use the instance dropdown to view **all instances (aggregated)** or a single Gateway. Each instance stores data under `~/.openclaw/plugins/resilience/instances/<id>/`. Strategy edits apply only to the **local** Gateway instance.

### resilience_stats

View API error statistics by time period or model.

**Parameters:**
- `query` (optional): Natural language query
  - `"today"` or empty — today's full summary
  - `"hour"` — current hour stats
  - `"week"` — current week stats
  - Any model name (e.g., `"mimo-v2.5"`) — model-specific stats

**Examples:**
- "查看今天报错统计" → `resilience_stats({ query: "today" })`
- "查看 mimo-v2.5 的错误率" → `resilience_stats({ query: "mimo-v2.5" })`
- "查看本周错误率" → `resilience_stats({ query: "week" })`

### resilience_strategies

View, add, update, or reset retry strategies.

**Parameters:**
- `action`: `"list"` (default) | `"add"` | `"update"` | `"reset"`
- `strategyName`: Strategy name (required for add/update)
- `updates`: Fields to update (for add/update). Use these shapes:
  - `type`: `"fixed"` | `"exponential"` | `"custom"`
  - `maxRetries`: number or numeric string, e.g. `3` or `"3"`
  - `intervals`: millisecond numbers or duration strings, e.g. `[60000, 300000]`, `["30s", "2m"]`, or `"30s, 2m, 5分钟"`
  - `cooldownMs`: millisecond number or duration string, e.g. `10000`, `"10s"`, `"10秒"`
  - `retryOn`: array or comma-separated string of error categories
  - `models`: array or comma-separated string of model names

**Examples:**
- "查看当前所有策略配置" → `resilience_strategies({ action: "list" })`
- "修改超时重试策略为指数退避" → `resilience_strategies({ action: "update", strategyName: "default-exponential", updates: { type: "exponential" } })`
- "添加一个自定义重试策略" → `resilience_strategies({ action: "add", strategyName: "my-strategy", updates: { type: "custom", maxRetries: 3, intervals: ["1m", "5分钟", "10m"], cooldownMs: "10s" } })`
- "把默认策略间隔改成 30 秒、2 分钟、5 分钟" → `resilience_strategies({ action: "update", strategyName: "default-exponential", updates: { intervals: "30s, 2m, 5分钟" } })`
- "重置策略为默认" → `resilience_strategies({ action: "reset" })`

### resilience_report

Generate detailed error reports.

**Parameters:**
- `reportType`: `"daily"` (default) | `"model"` | `"recovery"` | `"full"`
- `target`: Model name or date (YYYY-MM-DD)

**Examples:**
- "生成今日错误日报" → `resilience_report({ reportType: "daily" })`
- "查看 mimo-v2.5 的详细报告" → `resilience_report({ reportType: "model", target: "mimo-v2.5" })`
- "查看任务恢复状态" → `resilience_report({ reportType: "recovery" })`
- "生成完整状态报告" → `resilience_report({ reportType: "full" })`

### resilience_recovery

View or update automatic session recovery settings. Use this when the user wants to change the "continue the task" wording after a session failure, switch Chinese/English recovery language, or disable/enable automatic recovery.

**Parameters:**
- `action`: `"show"` (default) | `"update"` | `"reset"`
- `enabled`: `true` / `false`
- `language`: `"zh"` | `"en"`
- `prompt`: custom prompt overriding localized defaults
- `promptZh`: custom Chinese prompt
- `promptEn`: custom English prompt
- `ttlMs`: queued recovery context TTL
- `cooldownMs`: minimum interval between recovery injections per session
- `maxPerSession`: maximum automatic injections per session

**Examples:**
- "查看会话自动恢复设置" → `resilience_recovery({ action: "show" })`
- "把继续任务话术改成中文" → `resilience_recovery({ action: "update", language: "zh" })`
- "把继续任务话术改成英文" → `resilience_recovery({ action: "update", language: "en" })`
- "修改继续任务话术为：任务完成了吗？如果没完成请继续完成任务" → `resilience_recovery({ action: "update", language: "zh", prompt: "任务完成了吗？如果没完成请继续完成任务。" })`
- "关闭会话自动恢复" → `resilience_recovery({ action: "update", enabled: false })`

### resilience_sessions

View agent session and tool failure recovery records. These are separate from LLM API errors and are stored per OpenClaw instance.

**Parameters:**
- `action`: `"summary"` (default) | `"list"`
- `limit`: maximum records to return

**Examples:**
- "查看会话和工具失败恢复队列" → `resilience_sessions({ action: "summary" })`
- "列出最近的会话恢复记录" → `resilience_sessions({ action: "list", limit: 20 })`

## 本地包装 API：Body 错误捕获与策略分配

很多**本地部署 / 二次包装**的 LLM 网关会这样返回：

- 外层 HTTP 状态是 `200`（或其它“看起来成功”的码）
- 真正的失败写在 body 里，例如：
  - `{"error":{"message":"系统繁忙","type":"server_error"}}`
  - `{"success":false,"error_msg":"上游繁忙，请稍后重试"}`
  - `"code":429` / `"status":"error"` 等字段

这会导致：

1. 会话任务直接中断（agent_end 失败）
2. 如果只按 HTTP 状态判断，插件以前**无法归类、也无法拉起 API 重试**

从 **0.5.2** 起，插件会：

1. **捕获** body / 错误文案中的包装错误信号（中英文、OpenAI 风格 envelope、`success:false` 等）
2. **归类** 到可策略化的类别（优先 `rate_limit` / `server_overload` / `timeout` / `network_error`，否则 `wrapped_api_error`）
3. **拉起重试**：写入 active retry + 默认策略覆盖 `wrapped_api_error`
4. **会话恢复**：同时可排队下一轮“继续任务”指令

### Agent 推荐工作流（给用户做策略分配）

当用户说「帮我处理包装 API 报错重试」或「body 里有错误但 HTTP 是 200」时，按下面做：

```text
1) resilience_stats({ query: "today" })
   → 看是否出现 wrapped_api_error / server_overload / rate_limit

2) resilience_report({ reportType: "daily" }) 或 resilience_sessions({ action: "list" })
   → 拿出具体错误原文，确认归类是否正确

3) resilience_strategies({ action: "list" })
   → 看现有策略的 retryOn 是否覆盖该类别

4) 按用户意图分配策略（示例见下）
```

### 策略分配话术 → 工具调用

| 用户意图 | 工具调用 |
|----------|----------|
| 给包装 body 错误单独做快速重试 | `resilience_strategies({ action: "add", strategyName: "local-wrapper-retry", updates: { type: "exponential", maxRetries: 4, intervals: ["15s","1m","3m","5m"], cooldownMs: "5s", retryOn: ["wrapped_api_error"] } })` |
| 把包装错误并进默认指数退避 | `resilience_strategies({ action: "update", strategyName: "default-exponential", updates: { retryOn: ["rate_limit","server_overload","timeout","network_error","wrapped_api_error"] } })` |
| 本地模型繁忙：更长退避 | `resilience_strategies({ action: "add", strategyName: "local-busy-backoff", updates: { type: "custom", maxRetries: 6, intervals: ["30s","2m","5m","10m","20m","30m"], retryOn: ["server_overload","wrapped_api_error"] } })` |
| 只对限流固定 30 秒重试 | `resilience_strategies({ action: "update", strategyName: "rate-limit-fixed", updates: { intervals: ["30s"], maxRetries: 5, retryOn: ["rate_limit"] } })` |
| 某本地模型单独策略 | `resilience_strategies({ action: "add", strategyName: "mimo-local-body", updates: { type: "exponential", maxRetries: 5, intervals: ["20s","1m","3m","8m","15m"], retryOn: ["wrapped_api_error","server_overload"], models: ["mimo-v2.5"] } })` |

**归类后向用户汇报模板**（agent 输出建议）：

```text
已捕获并归类：
- 类别：wrapped_api_error（HTTP 状态不可信，body 含错误）
- 是否默认可重试：是
- 命中策略：wrapped-api-body-retry / default-exponential
- 建议：若本地网关经常 15s 内恢复，可把间隔改成 15s → 1m → 3m

需要我帮你改策略吗？可以说：
「给 wrapped_api_error 加 4 次、15 秒起跳的指数重试」
```

## Error Categories

| Category | Description | Retryable |
|----------|-------------|-----------|
| `rate_limit` | 429 / body 限流文案 | ✅ |
| `server_overload` | 503/502/500/529 或 body「系统繁忙/上游失败」 | ✅ |
| `timeout` | Request timeout / 504/408 | ✅ |
| `auth_failed` | 401/403 Authentication failed | ❌ |
| `network_error` | Connection errors | ✅ |
| `model_unavailable` | Model not found or offline | ✅ |
| `context_too_long` | Context length exceeded | ❌ |
| `token_parse_error` | Tokenizer/token parsing failure | ❌ |
| `invalid_model_output` | Malformed model output / response format failure | ❌ |
| `session_runtime_error` | Non-API session runtime failure | ❌ |
| `wrapped_api_error` | **本地包装网关**：HTTP 看似成功但 body 含错误 envelope | ✅ |
| `unknown` | Unclassified errors | ❌ |

## Retry Strategies

### Strategy Types

- **fixed**: Fixed interval between retries (e.g., every 30s)
- **exponential**: Exponential backoff (1min → 2min → 4min → 8min...)
- **custom**: User-defined interval schedule (e.g., [1min, 3min, 5min, 15min])

### Default Strategies

| Name | Type | Max Retries | Intervals | Error Types |
|------|------|-------------|-----------|-------------|
| default-exponential | exponential | 5 | 1m→15m | rate_limit, server_overload, timeout, network_error, **wrapped_api_error** |
| rate-limit-fixed | fixed | 3 | 30s | rate_limit |
| model-backoff | custom | 6 | 1m→2h | server_overload, model_unavailable, wrapped_api_error |
| wrapped-api-body-retry | exponential | 4 | 15s→5m | **wrapped_api_error**（专打本地包装 body 错误） |

## Data Storage

Per-instance data: `~/.openclaw/plugins/resilience/instances/<instance-id>/` (stats, logs, strategies, tasks). Legacy root layout is still read as `default`.

```
~/.openclaw/plugins/resilience/instances/<instance-id>/
├── meta.json
├── stats.json
├── strategies.json
├── recovery-settings.json
├── active-retries.json
├── session-retries.json
├── logs/YYYY-MM-DD.jsonl
└── tasks/
```
