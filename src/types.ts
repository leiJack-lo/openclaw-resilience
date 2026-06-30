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
  | "unknown";

/** HTTP status code to error category mapping */
export const STATUS_MAP: Record<number, ErrorCategory> = {
  429: "rate_limit",
  503: "server_overload",
  401: "auth_failed",
  403: "auth_failed",
};

/** Error patterns (regex) to error category mapping */
export const ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /timeout|timed?\s*out|ETIMEDOUT/i, category: "timeout" },
  { pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|network/i, category: "network_error" },
  { pattern: /model\s+not\s+found|does not exist|unavailable/i, category: "model_unavailable" },
  { pattern: /context\s+(length|too|exceed|long)|max\s+tokens/i, category: "context_too_long" },
  { pattern: /token(?:izer)?|parse token|invalid token|unexpected token/i, category: "token_parse_error" },
  { pattern: /invalid (?:model )?(?:response|output|format)|malformed|schema|json parse|parse json/i, category: "invalid_model_output" },
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
