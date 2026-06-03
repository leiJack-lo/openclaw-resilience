# Resilience Skill

LLM API error tracking, classification, retry, and task recovery for OpenClaw.

## Overview

This skill provides visibility into API call health and automated retry management. Use it to:

- Monitor API error rates and patterns
- View per-model performance statistics
- Configure retry strategies
- Generate error reports
- Track task recovery status

## Tools

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
- `updates`: Fields to update (for add/update)

**Examples:**
- "查看当前所有策略配置" → `resilience_strategies({ action: "list" })`
- "修改超时重试策略为指数退避" → `resilience_strategies({ action: "update", strategyName: "default-exponential", updates: { type: "exponential" } })`
- "添加一个自定义重试策略" → `resilience_strategies({ action: "add", strategyName: "my-strategy", updates: { type: "custom", maxRetries: 3, intervals: [60000, 300000, 600000] } })`
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

## Error Categories

| Category | Description | Retryable |
|----------|-------------|-----------|
| `rate_limit` | 429 Too Many Requests | ✅ |
| `server_overload` | 503 Service Unavailable | ✅ |
| `timeout` | Request timeout | ✅ |
| `auth_failed` | 401/403 Authentication failed | ❌ |
| `network_error` | Connection errors | ✅ |
| `model_unavailable` | Model not found or offline | ✅ |
| `context_too_long` | Context length exceeded | ❌ |
| `unknown` | Unclassified errors | ❌ |

## Retry Strategies

### Strategy Types

- **fixed**: Fixed interval between retries (e.g., every 30s)
- **exponential**: Exponential backoff (1min → 2min → 4min → 8min...)
- **custom**: User-defined interval schedule (e.g., [1min, 3min, 5min, 15min])

### Default Strategies

| Name | Type | Max Retries | Intervals | Error Types |
|------|------|-------------|-----------|-------------|
| default-exponential | exponential | 5 | 1m→15m | rate_limit, server_overload, timeout, network_error |
| rate-limit-fixed | fixed | 3 | 30s | rate_limit |
| model-backoff | custom | 6 | 1m→2h | server_overload, model_unavailable |
| network-retry | exponential | 4 | 5s→1m | network_error |

## Data Storage

All data is stored in `~/.openclaw/plugins/resilience/`:

```
~/.openclaw/plugins/resilience/
├── logs/           # JSONL daily log files
│   ├── 2026-06-01.jsonl
│   ├── 2026-06-02.jsonl
│   └── 2026-06-03.jsonl
├── stats.json      # Aggregated statistics
├── strategies.json # Retry strategy configurations
└── tasks/          # Recoverable task state files
```
