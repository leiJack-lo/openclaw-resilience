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
}
