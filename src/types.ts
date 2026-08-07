/**
 * Core type definitions for the Resilience plugin.
 * Defines error classification, retry strategies, stats, and task recovery types.
 */

// ─── Error Classification ───────────────────────────────────────────────────

/** Supported error categories */
export type ErrorCategory =
  | "rate_limit"
  | "server_overload"
  | "timeout"
  | "auth_failed"
  | "network_error"
  | "model_unavailable"
  | "context_too_long"
  | "token_parse_error"
  | "invalid_model_output"
  | "session_runtime_error"
  /** Local/wrapped gateway returned misleading HTTP status but body carries a transient API error */
  | "wrapped_api_error"
  | "unknown";

/** HTTP status code to error category mapping */
export const STATUS_MAP: Record<number, ErrorCategory> = {
  429: "rate_limit",
  503: "server_overload",
  502: "server_overload",
  500: "server_overload",
  504: "timeout",
  408: "timeout",
  529: "server_overload",
  401: "auth_failed",
  403: "auth_failed",
};

/**
 * Error patterns (regex) to error category mapping.
 * Order matters: more specific body/wrapper signals come first so that
 * HTTP-200-with-error-body cases still classify as retryable categories.
 */
export const ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  // Rate limits (HTTP body or text, including Chinese gateway wrappers)
  {
    pattern:
      /rate\s*limit|too many requests|requests per (?:minute|hour|day)|tokens? per (?:minute|hour|day)|\btpm\b|\brpm\b|throttl|quota|429\b|请求过于频繁|调用次数超|频率限制|限流|配额/i,
    category: "rate_limit",
  },
  // Server overload / busy (common for local wrappers that still return 200)
  {
    pattern:
      /server\s*overload|overloaded|service\s*unavailable|capacity|no\s*available\s*(?:instance|worker|slot)|upstream.*(?:busy|fail|error)|502\b|503\b|529\b|系统繁忙|服务繁忙|服务不可用|上游(?:繁忙|失败|错误|异常)|网关(?:错误|超时|异常)|请稍后重试|稍后再试/i,
    category: "server_overload",
  },
  // Timeouts
  {
    pattern: /timeout|timed?\s*out|ETIMEDOUT|deadline exceeded|504\b|408\b|请求超时|响应超时|连接超时/i,
    category: "timeout",
  },
  // Network / connection
  {
    pattern:
      /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|connection\s*(?:reset|closed|refused|error)|fetch failed|连接(?:重置|拒绝|失败|中断)|网络(?:错误|异常|中断)/i,
    category: "network_error",
  },
  // Auth
  {
    pattern:
      /unauthorized|forbidden|invalid\s*api\s*key|authentication|auth(?:_|\s*)fail|401\b|403\b|鉴权失败|未授权|密钥无效|api\s*key/i,
    category: "auth_failed",
  },
  // Model unavailable
  {
    pattern:
      /model\s+not\s+found|model(?:_is)?_deactivated|does not exist|model\s+unavailable|no such model|模型不存在|模型不可用|模型未找到/i,
    category: "model_unavailable",
  },
  // Context too long
  {
    pattern:
      /context\s+(length|too|exceed|long|overflow|window)|max\s+tokens|prompt\s+is\s+too\s+long|request_too_large|上下文过长|上下文超出|超出最大上下文|请压缩上下文/i,
    category: "context_too_long",
  },
  // Token / parse
  {
    pattern: /token(?:izer)?|parse token|invalid token|unexpected token/i,
    category: "token_parse_error",
  },
  // Invalid model output / empty body shapes
  {
    pattern:
      /invalid (?:model )?(?:response|output|format)|malformed|schema|json parse|parse json|empty[_ ]response|no (?:response )?body|null response/i,
    category: "invalid_model_output",
  },
  // OpenAI-style / local-wrapper body error envelopes (HTTP often still 200)
  {
    pattern:
      /"type"\s*:\s*"(?:server_error|rate_limit_error|overloaded_error|api_error)"|"code"\s*:\s*"(?:server_error|rate_limit|overloaded|internal_error)"|type\s*[=:]\s*(?:server_error|rate_limit_error|overloaded_error|api_error)|code\s*[=:]\s*(?:server_error|rate_limit|overloaded|internal_error)|"success"\s*:\s*false|"ok"\s*:\s*false|"status"\s*:\s*"(?:error|failed|fail)"|error_code|error_msg|err_msg|biz_code|ret_code|errno\s*[:=]\s*[1-9]/i,
    category: "wrapped_api_error",
  },
];

/** A classified error record */
export interface ClassifiedError {
  category: ErrorCategory;
  rawError: string;
  httpStatus?: number;
  provider?: string;
  model?: string;
  retryable: boolean;
}

// ─── Logging ────────────────────────────────────────────────────────────────

/** A single log entry for an API call result */
export interface LogEntry {
  timestamp: string;           // ISO 8601
  instanceId?: string;
  provider?: string;
  model?: string;
  errorType: ErrorCategory | "success";
  errorMessage?: string;
  httpStatus?: number;
  durationMs: number;
  sessionId?: string;
  runId?: string;
  retryCount?: number;
  recovered?: boolean;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/** Time bucket for stats aggregation */
export type TimeBucket = "hour" | "day" | "week";

/** Stats for a single model */
export interface ModelStats {
  model: string;
  totalCalls: number;
  failedCalls: number;
  successRate: number;        // 0-100
  avgDurationMs: number;
  errorsByType: Record<ErrorCategory, number>;
  lastUpdated: string;        // ISO 8601
}

/** Aggregate stats for a time period */
export interface TimeStats {
  period: string;             // e.g. "2026-06-03" or "2026-W22"
  totalCalls: number;
  failedCalls: number;
  successRate: number;
  errorsByType: Record<ErrorCategory, number>;
  modelBreakdown: Record<string, ModelStats>;
}

/** The persisted stats.json structure */
export interface StatsData {
  lastUpdated: string;
  hourly: Record<string, TimeStats>;   // key: "YYYY-MM-DD HH"
  daily: Record<string, TimeStats>;    // key: "YYYY-MM-DD"
  weekly: Record<string, TimeStats>;   // key: "YYYY-Www"
  models: Record<string, ModelStats>;
}

// ─── Retry Engine ───────────────────────────────────────────────────────────

/** Retry strategy type */
export type RetryStrategyType = "fixed" | "exponential" | "custom";

/** A retry strategy configuration */
export interface RetryStrategy {
  name: string;
  type: RetryStrategyType;
  maxRetries: number;
  /** Retry intervals in ms. For 'fixed', only first value is used. For 'exponential', used as base. */
  intervals: number[];
  /** Which error types trigger retry */
  retryOn: ErrorCategory[];
  /** Minimum time between retries in ms */
  cooldownMs: number;
  /** Optional: model-specific override */
  models?: string[];
  /** Preferred default when multiple strategies match */
  isDefault?: boolean;
}

/** Active retry state for a pending operation */
export interface RetryState {
  strategyName: string;
  attempt: number;
  nextRetryAt: string;        // ISO 8601
  lastError: ClassifiedError;
  sessionId?: string;
  runId?: string;
}

// ─── Session / Task Recovery Queue ─────────────────────────────────────────

/** Agent/session level failure categories, separate from LLM API failures. */
export type SessionErrorCategory =
  | "prompt_aborted"
  | "tool_execution_failed"
  | "shell_parse_error"
  | "session_takeover"
  | "task_timeout"
  | "browser_workflow_failed"
  | "permission_denied"
  | "config_error"
  | "external_side_effect_risk"
  | "unknown_session_error";

/** Lifecycle status for a session/task recovery record. */
export type SessionRetryStatus =
  | "queued"
  | "injected"
  | "retrying"
  | "recovered"
  | "failed"
  | "manual_required"
  | "skipped";

/** How the plugin should recover a failed session/task. */
export type SessionRecoveryMode =
  | "next_turn_injection"
  | "rerun_task"
  | "manual";

/** Persisted queue record for agent/session/tool failures. */
export interface SessionRetryRecord {
  id: string;
  source:
    | "agent_end"
    | "after_tool_call"
    | "prompt_error"
    | "cron"
    | "manual";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  taskId?: string;
  cronJobId?: string;
  toolName?: string;
  category: SessionErrorCategory;
  errorMessage: string;
  fingerprint: string;
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: string;
  status: SessionRetryStatus;
  recoveryMode: SessionRecoveryMode;
  instanceId?: string;
  instanceLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRetrySummary {
  total: number;
  retryable: number;
  byStatus: Record<SessionRetryStatus, number>;
  byCategory: Record<SessionErrorCategory, number>;
  byMode: Record<SessionRecoveryMode, number>;
  pending: number;
  manualRequired: number;
}

// ─── Task Recovery ──────────────────────────────────────────────────────────

/** Status of a recoverable task */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "recovering";

/** A recoverable task */
export interface RecoverableTask {
  taskKey: string;
  sessionKey: string;
  status: TaskStatus;
  lastState: Record<string, unknown>;
  completedSteps: string[];
  failedStep?: string;
  error?: ClassifiedError;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
}

// ─── Plugin Config ──────────────────────────────────────────────────────────

/** Plugin configuration */
export interface ResilienceConfig {
  logDir?: string;
  statsRetentionDays?: number;
  defaultStrategy?: RetryStrategyType;
  /** Enable web dashboard on gateway start */
  dashboardEnabled?: boolean;
  /** Dashboard listen port (localhost only) */
  dashboardPort?: number;
  /** Instance id override (default: gateway-instance-id or "default") */
  instanceId?: string;
  /** Display label in multi-instance dashboard */
  instanceLabel?: string;
  /** Workspace path for instance label discovery */
  workspacePath?: string;
  /** Enable automatic next-turn recovery injection for failed agent sessions */
  sessionRecoveryEnabled?: boolean;
  /** Default recovery prompt language */
  sessionRecoveryLanguage?: "zh" | "en";
  /** Custom recovery prompt overriding the built-in localized prompt */
  sessionRecoveryPrompt?: string;
  /** Custom Chinese recovery prompt */
  sessionRecoveryPromptZh?: string;
  /** Custom English recovery prompt */
  sessionRecoveryPromptEn?: string;
  /** TTL for queued next-turn recovery context */
  sessionRecoveryTtlMs?: number;
  /** Minimum interval between automatic recovery injections for one session */
  sessionRecoveryCooldownMs?: number;
  /** Maximum automatic recovery injections per session while this gateway process runs */
  sessionRecoveryMaxPerSession?: number;
}
