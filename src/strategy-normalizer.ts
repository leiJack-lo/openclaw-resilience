/**
 * Runtime normalization for retry strategy updates.
 *
 * Tool calls from skills can pass values as strings with units ("5m",
 * "30秒", "300000") instead of raw millisecond numbers. Normalize before
 * persisting so dashboard rendering and retry scheduling never see NaN.
 */

import type {
  ErrorCategory,
  RetryStrategy,
  RetryStrategyType,
} from "./types.js";

const STRATEGY_TYPES = new Set<RetryStrategyType>([
  "fixed",
  "exponential",
  "custom",
]);

const ERROR_CATEGORIES = new Set<ErrorCategory>([
  "rate_limit",
  "server_overload",
  "timeout",
  "auth_failed",
  "network_error",
  "model_unavailable",
  "context_too_long",
  "token_parse_error",
  "invalid_model_output",
  "session_runtime_error",
  "wrapped_api_error",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

function parseNonNegativeInteger(value: unknown, field: string): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Math.floor(n);
}

export function parseDurationMs(value: unknown, field = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative duration`);
    }
    return Math.floor(value);
  }

  if (isRecord(value)) {
    const amount = pick(value, ["value", "amount", "duration"]);
    const unit = pick(value, ["unit", "units"]);
    return parseDurationMs(`${amount ?? ""}${unit ?? ""}`, field);
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a number of milliseconds or a duration string`);
  }

  const raw = value.trim();
  if (!raw) throw new Error(`${field} cannot be empty`);

  const match = raw.match(
    /^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|毫秒|s|sec|secs|second|seconds|秒|m|min|mins|minute|minutes|分钟|分|h|hr|hrs|hour|hours|小时|d|day|days|天)?$/i
  );
  if (!match) {
    throw new Error(
      `${field} must use milliseconds or units like ms/s/m/h/d, 秒/分钟/小时`
    );
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier =
    unit === "ms" ||
    unit === "msec" ||
    unit === "millisecond" ||
    unit === "milliseconds" ||
    unit === "毫秒"
      ? 1
      : unit === "s" ||
          unit === "sec" ||
          unit === "secs" ||
          unit === "second" ||
          unit === "seconds" ||
          unit === "秒"
        ? 1_000
        : unit === "m" ||
            unit === "min" ||
            unit === "mins" ||
            unit === "minute" ||
            unit === "minutes" ||
            unit === "分钟" ||
            unit === "分"
          ? 60_000
          : unit === "h" ||
              unit === "hr" ||
              unit === "hrs" ||
              unit === "hour" ||
              unit === "hours" ||
              unit === "小时"
            ? 3_600_000
            : unit === "d" ||
                unit === "day" ||
                unit === "days" ||
                unit === "天"
              ? 86_400_000
              : NaN;

  if (!Number.isFinite(multiplier)) {
    throw new Error(`${field} has an unsupported unit`);
  }
  return Math.floor(amount * multiplier);
}

function parseDurationList(value: unknown, field = "intervals"): number[] {
  if (Array.isArray(value)) {
    const out = value.map((item, idx) => parseDurationMs(item, `${field}[${idx}]`));
    if (out.length === 0) throw new Error(`${field} cannot be empty`);
    return out;
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (raw.startsWith("[")) {
      return parseDurationList(JSON.parse(raw), field);
    }
    const parts = raw
      .split(/\s*(?:,|，|->|→)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new Error(`${field} cannot be empty`);
    return parts.map((part, idx) => parseDurationMs(part, `${field}[${idx}]`));
  }

  return [parseDurationMs(value, `${field}[0]`)];
}

function parseStringList(value: unknown, field: string): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\s*(?:,|，)\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  throw new Error(`${field} must be a string or string array`);
}

function parseRetryOn(value: unknown): ErrorCategory[] {
  const items = parseStringList(value, "retryOn");
  const out: ErrorCategory[] = [];
  for (const item of items) {
    if (!ERROR_CATEGORIES.has(item as ErrorCategory)) {
      throw new Error(`retryOn contains unsupported error category: ${item}`);
    }
    out.push(item as ErrorCategory);
  }
  if (out.length === 0) throw new Error("retryOn cannot be empty");
  return out;
}

export function normalizeRetryStrategyUpdate(
  updates: Record<string, unknown>
): Partial<RetryStrategy> {
  const out: Partial<RetryStrategy> = {};

  const type = pick(updates, ["type", "strategyType"]);
  if (type !== undefined) {
    if (!STRATEGY_TYPES.has(type as RetryStrategyType)) {
      throw new Error(`type must be fixed, exponential, or custom`);
    }
    out.type = type as RetryStrategyType;
  }

  const maxRetries = pick(updates, ["maxRetries", "maxRetry", "max_retries"]);
  if (maxRetries !== undefined) {
    out.maxRetries = parseNonNegativeInteger(maxRetries, "maxRetries");
  }

  const intervals = pick(updates, [
    "intervals",
    "interval",
    "intervalMs",
    "interval_ms",
    "retryInterval",
    "retryIntervals",
    "retryIntervalMs",
  ]);
  if (intervals !== undefined) {
    out.intervals = parseDurationList(intervals, "intervals");
  }

  const intervalSeconds = pick(updates, ["intervalSeconds", "retryIntervalSeconds"]);
  if (intervalSeconds !== undefined) {
    out.intervals = parseDurationList(intervalSeconds, "intervals").map(
      (n) => n * 1_000
    );
  }

  const cooldown = pick(updates, [
    "cooldownMs",
    "cooldown",
    "cooldown_ms",
    "cooldownInterval",
  ]);
  if (cooldown !== undefined) {
    out.cooldownMs = parseDurationMs(cooldown, "cooldownMs");
  }

  const cooldownSeconds = pick(updates, ["cooldownSeconds"]);
  if (cooldownSeconds !== undefined) {
    out.cooldownMs = parseDurationMs(cooldownSeconds, "cooldownMs") * 1_000;
  }

  const retryOn = pick(updates, ["retryOn", "retry_on", "errors", "errorTypes"]);
  if (retryOn !== undefined) {
    out.retryOn = parseRetryOn(retryOn);
  }

  const models = pick(updates, ["models", "model"]);
  if (models !== undefined) {
    const parsed = parseStringList(models, "models");
    if (parsed.length > 0) out.models = parsed;
  }

  if (typeof updates.isDefault === "boolean") {
    out.isDefault = updates.isDefault;
  }

  return out;
}

export function normalizeRetryStrategy(strategy: RetryStrategy): RetryStrategy {
  const normalized = normalizeRetryStrategyUpdate(
    strategy as unknown as Record<string, unknown>
  );
  if (!strategy.name?.trim()) throw new Error("strategy.name is required");
  if (!normalized.type) throw new Error("strategy.type is required");
  if (normalized.maxRetries === undefined) {
    throw new Error("strategy.maxRetries is required");
  }
  if (!normalized.intervals) throw new Error("strategy.intervals is required");
  if (!normalized.retryOn) throw new Error("strategy.retryOn is required");
  if (normalized.cooldownMs === undefined) {
    throw new Error("strategy.cooldownMs is required");
  }

  return {
    name: strategy.name.trim(),
    type: normalized.type,
    maxRetries: normalized.maxRetries,
    intervals: normalized.intervals,
    retryOn: normalized.retryOn,
    cooldownMs: normalized.cooldownMs,
    ...(normalized.models ? { models: normalized.models } : {}),
    ...(normalized.isDefault !== undefined
      ? { isDefault: normalized.isDefault }
      : {}),
  };
}
