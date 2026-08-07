/**
 * Error Classifier
 *
 * Classifies API errors into categories based on HTTP status codes,
 * error messages, and patterns. Determines if an error is retryable.
 *
 * Special handling for local / wrapped LLM gateways that return HTTP 200
 * (or other non-error statuses) while embedding the real failure in the body.
 */

import {
  type ErrorCategory,
  type ClassifiedError,
  type SessionErrorCategory,
  type SessionRecoveryMode,
  STATUS_MAP,
  ERROR_PATTERNS,
} from "./types.js";

// Error categories that are always retryable
const RETRYABLE_CATEGORIES: Set<ErrorCategory> = new Set([
  "rate_limit",
  "server_overload",
  "timeout",
  "network_error",
  "wrapped_api_error",
  "model_unavailable",
]);

const KNOWN_CATEGORIES: Set<ErrorCategory> = new Set([
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

/**
 * Map OpenClaw-native / provider failover category strings onto our taxonomy.
 * These often arrive as model_call_ended.errorCategory with no HTTP status.
 */
const CATEGORY_ALIASES: Record<string, ErrorCategory> = {
  rate_limit: "rate_limit",
  rate_limited: "rate_limit",
  too_many_requests: "rate_limit",
  throttled: "rate_limit",
  overloaded: "server_overload",
  server_overload: "server_overload",
  server_error: "server_overload",
  service_unavailable: "server_overload",
  internal_error: "server_overload",
  upstream_error: "wrapped_api_error",
  upstream_html: "wrapped_api_error",
  timeout: "timeout",
  timeout_error: "timeout",
  request_timeout: "timeout",
  aborted: "timeout",
  connection_closed: "network_error",
  connection_reset: "network_error",
  connection_error: "network_error",
  network: "network_error",
  network_error: "network_error",
  terminated: "network_error",
  auth: "auth_failed",
  auth_failed: "auth_failed",
  auth_error: "auth_failed",
  auth_scope: "auth_failed",
  unauthorized: "auth_failed",
  authentication: "auth_failed",
  authentication_error: "auth_failed",
  model_not_found: "model_unavailable",
  model_unavailable: "model_unavailable",
  not_found: "model_unavailable",
  context_overflow: "context_too_long",
  context_too_long: "context_too_long",
  context_length: "context_too_long",
  empty_response: "invalid_model_output",
  invalid_model_output: "invalid_model_output",
  token_parse_error: "token_parse_error",
  session_runtime_error: "session_runtime_error",
  wrapped_api_error: "wrapped_api_error",
  api_body_error: "wrapped_api_error",
  body_error: "wrapped_api_error",
  gateway_error: "wrapped_api_error",
  unknown: "unknown",
};

/** Status codes embedded in body text even when the outer HTTP status is 2xx. */
const EMBEDDED_STATUS_RE =
  /(?:\b(?:http(?:\s*status)?|status(?:\s*code)?|code|statusCode|httpStatus)\b\s*[:=]?\s*|\b)(429|503|502|500|504|408|529|401|403)(?:\b|[^\d])/i;

/**
 * Signals that a payload looks like a wrapped local gateway body error
 * rather than a clean model completion.
 */
const WRAPPED_BODY_SIGNAL_RE =
  /"error"\s*:|"success"\s*:\s*false|"ok"\s*:\s*false|error_code|error_msg|err_msg|biz_code|ret_code|errno\s*[:=]|系统繁忙|服务繁忙|上游|网关错误|请稍后重试|接口异常|调用失败/i;

/**
 * Classify a raw error into a structured error record.
 *
 * @param error - The raw error (Error object, string, or HTTP response)
 * @param options - Optional metadata (provider, model, httpStatus)
 * @returns A classified error with category and retryability
 */
export function classifyError(
  error: unknown,
  options?: { provider?: string; model?: string; httpStatus?: number }
): ClassifiedError {
  const rawError = extractMessage(error);
  const embeddedStatus = extractEmbeddedHttpStatus(error, rawError);
  const httpStatus =
    options?.httpStatus ?? extractHttpStatus(error) ?? embeddedStatus;
  const aliasKey = normalizeAliasKey(rawError);
  const misleadingSuccessStatus =
    httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300;

  // 1. Accept OpenClaw-native / alias category strings from hook events.
  if (aliasKey && CATEGORY_ALIASES[aliasKey]) {
    const category = CATEGORY_ALIASES[aliasKey];
    return buildClassified(category, rawError, httpStatus, options);
  }

  // 1b. Known category exact match (defensive).
  const normalized = rawError.trim().toLowerCase() as ErrorCategory;
  if (KNOWN_CATEGORIES.has(normalized)) {
    return buildClassified(normalized, rawError, httpStatus, options);
  }

  // 2. Pattern matching on the error message / body first when HTTP looks
  //    successful — local wrappers often return 200 with error JSON.
  if (misleadingSuccessStatus || httpStatus === undefined) {
    const fromBody = classifyFromMessage(rawError, httpStatus, options);
    if (fromBody) return fromBody;

    if (misleadingSuccessStatus && looksLikeWrappedBodyError(error, rawError)) {
      return buildClassified("wrapped_api_error", rawError, httpStatus, options);
    }
  }

  // 3. HTTP status code mapping (only trustworthy non-2xx statuses).
  if (httpStatus !== undefined && httpStatus in STATUS_MAP) {
    return buildClassified(STATUS_MAP[httpStatus], rawError, httpStatus, options);
  }

  // 4. Pattern matching (when status was non-2xx or absent).
  if (!misleadingSuccessStatus) {
    const fromMessage = classifyFromMessage(rawError, httpStatus, options);
    if (fromMessage) return fromMessage;
  }

  // 5. Check for 5xx (server overload without specific mapping).
  if (httpStatus !== undefined && httpStatus >= 500) {
    return buildClassified("server_overload", rawError, httpStatus, options);
  }

  // 6. Body-shaped errors with no usable HTTP status.
  if (looksLikeWrappedBodyError(error, rawError)) {
    return buildClassified("wrapped_api_error", rawError, httpStatus, options);
  }

  // 7. Fallback to unknown.
  return buildClassified("unknown", rawError, httpStatus, options);
}

/**
 * Classify an agent/session runtime failure. These are not necessarily model
 * API call failures, but they should still be counted and can trigger recovery
 * instructions for the next turn.
 *
 * When the failure text looks like a wrapped/local LLM API body error, reuse
 * API classification so retry strategies can pick it up.
 */
export function classifySessionError(
  error: unknown,
  options?: { provider?: string; model?: string }
): ClassifiedError {
  const rawError = extractMessage(error);
  const apiLike = classifyError(error, options);

  // Prefer API taxonomy when the payload is clearly provider/wrapper related.
  if (
    apiLike.category !== "unknown" &&
    apiLike.category !== "session_runtime_error"
  ) {
    return {
      ...apiLike,
      // Session path still records the category for stats; retryability follows API rules.
      retryable: RETRYABLE_CATEGORIES.has(apiLike.category),
    };
  }

  for (const { pattern, category } of ERROR_PATTERNS) {
    if (pattern.test(rawError)) {
      return {
        category,
        rawError,
        provider: options?.provider,
        model: options?.model,
        retryable: RETRYABLE_CATEGORIES.has(category),
      };
    }
  }

  return {
    category: "session_runtime_error",
    rawError,
    provider: options?.provider,
    model: options?.model,
    retryable: false,
  };
}

export interface ClassifiedSessionTaskError {
  category: SessionErrorCategory;
  rawError: string;
  retryable: boolean;
  recoveryMode: SessionRecoveryMode;
}

const SESSION_TASK_PATTERNS: Array<{
  pattern: RegExp;
  category: SessionErrorCategory;
  retryable: boolean;
  recoveryMode: SessionRecoveryMode;
}> = [
  {
    pattern: /this operation was aborted|openclawabort|operation aborted|aborted/i,
    category: "prompt_aborted",
    retryable: true,
    recoveryMode: "next_turn_injection",
  },
  {
    pattern: /session.*takeover|takeover|session file changed|lock.*released|EmbeddedAttemptSessionTakeoverError/i,
    category: "session_takeover",
    retryable: true,
    recoveryMode: "next_turn_injection",
  },
  {
    pattern: /timed?\s*out|timeout|deadline exceeded/i,
    category: "task_timeout",
    retryable: true,
    recoveryMode: "next_turn_injection",
  },
  {
    pattern: /parse error near|syntax error|unexpected token|zsh:|bash:|fish:|command not found/i,
    category: "shell_parse_error",
    retryable: false,
    recoveryMode: "manual",
  },
  {
    pattern: /permission denied|operation not permitted|eacces|eperm|not authorized|requires approval/i,
    category: "permission_denied",
    retryable: false,
    recoveryMode: "manual",
  },
  {
    pattern: /config(?:uration)?|invalid config|missing config|yaml|toml/i,
    category: "config_error",
    retryable: false,
    recoveryMode: "manual",
  },
  {
    pattern: /browser|playwright|locator|navigation|page\.|cdp|chrome/i,
    category: "browser_workflow_failed",
    retryable: true,
    recoveryMode: "next_turn_injection",
  },
  {
    pattern: /publish|delete|remove|credential|secret|api key|access token|bearer token|permission expansion|external send/i,
    category: "external_side_effect_risk",
    retryable: false,
    recoveryMode: "manual",
  },
  {
    pattern: /exit code [1-9]|non[- ]zero|tool.*failed|exec.*failed|failed/i,
    category: "tool_execution_failed",
    retryable: true,
    recoveryMode: "next_turn_injection",
  },
];

/**
 * Classify agent/session/tool failures into recovery policy buckets.
 */
export function classifySessionTaskError(error: unknown): ClassifiedSessionTaskError {
  const rawError = extractMessage(error);

  // API-shaped failures interrupting a session should be auto-retryable via
  // next-turn recovery so local wrapper body errors do not stall the task.
  const apiLike = classifyError(error);
  if (
    apiLike.retryable &&
    apiLike.category !== "unknown" &&
    apiLike.category !== "session_runtime_error"
  ) {
    return {
      category: "unknown_session_error",
      rawError,
      retryable: true,
      recoveryMode: "next_turn_injection",
    };
  }

  for (const item of SESSION_TASK_PATTERNS) {
    if (item.pattern.test(rawError)) {
      return {
        category: item.category,
        rawError,
        retryable: item.retryable,
        recoveryMode: item.recoveryMode,
      };
    }
  }

  return {
    category: "unknown_session_error",
    rawError,
    retryable: true,
    recoveryMode: "next_turn_injection",
  };
}

function buildClassified(
  category: ErrorCategory,
  rawError: string,
  httpStatus: number | undefined,
  options?: { provider?: string; model?: string }
): ClassifiedError {
  return {
    category,
    rawError,
    httpStatus,
    provider: options?.provider,
    model: options?.model,
    retryable: RETRYABLE_CATEGORIES.has(category),
  };
}

function classifyFromMessage(
  rawError: string,
  httpStatus: number | undefined,
  options?: { provider?: string; model?: string }
): ClassifiedError | null {
  for (const { pattern, category } of ERROR_PATTERNS) {
    if (pattern.test(rawError)) {
      return buildClassified(category, rawError, httpStatus, options);
    }
  }
  return null;
}

function normalizeAliasKey(raw: string): string | undefined {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return undefined;
  // Allow "Error: overloaded" style strings to still hit the alias map.
  if (CATEGORY_ALIASES[key]) return key;
  const lastToken = key.split(/[:|/]/).pop()?.trim();
  if (lastToken && CATEGORY_ALIASES[lastToken]) return lastToken;
  return undefined;
}

function looksLikeWrappedBodyError(
  error: unknown,
  rawError: string,
  depth = 0
): boolean {
  if (WRAPPED_BODY_SIGNAL_RE.test(rawError)) return true;
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const obj = error as Record<string, unknown>;
  if (obj.success === false || obj.ok === false) return true;
  if (obj.error != null && typeof obj.error === "object") return true;
  if (typeof obj.error === "string" && obj.error.trim()) return true;
  if (typeof obj.error_code === "string" || typeof obj.error_code === "number") {
    return true;
  }
  if (typeof obj.error_msg === "string" || typeof obj.err_msg === "string") {
    return true;
  }
  if (
    typeof obj.type === "string" &&
    /server_error|rate_limit|overloaded|api_error|internal_error/i.test(obj.type)
  ) {
    return true;
  }
  for (const key of ["body", "data", "response", "payload", "result", "cause"]) {
    if (obj[key] != null && looksLikeWrappedBodyError(obj[key], rawError, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract a human-readable error message from various error types,
 * including OpenAI-style and local-wrapper response bodies.
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    const base = error.message || error.name || "Unknown error";
    const extra = extractNestedMessage((error as Error & { cause?: unknown }).cause)
      ?? extractNestedMessage((error as unknown as Record<string, unknown>).body)
      ?? extractNestedMessage((error as unknown as Record<string, unknown>).response)
      ?? extractNestedMessage((error as unknown as Record<string, unknown>).data);
    return extra && !base.includes(extra) ? `${base} | ${extra}` : base;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const nested = extractNestedMessage(error);
    if (nested) return nested;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function extractNestedMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value !== "object") return undefined;

  const obj = value as Record<string, unknown>;
  const directKeys = [
    "message",
    "error_msg",
    "err_msg",
    "errorMessage",
    "msg",
    "detail",
    "details",
    "reason",
    "description",
  ];
  let message: string | undefined;
  for (const key of directKeys) {
    if (typeof obj[key] === "string" && obj[key].trim()) {
      message = String(obj[key]).trim();
      break;
    }
  }

  if (!message && typeof obj.error === "string" && obj.error.trim()) {
    message = obj.error.trim();
  }
  if (!message && obj.error && typeof obj.error === "object") {
    message = extractNestedMessage(obj.error, depth + 1);
  }

  // Preserve type/code so "The server had an error" + type server_error
  // still matches body-error patterns after message extraction.
  const metaParts: string[] = [];
  for (const key of ["type", "code", "error_code", "errno", "biz_code", "ret_code"]) {
    if (obj[key] != null && String(obj[key]).trim()) {
      metaParts.push(`${key}=${String(obj[key]).trim()}`);
    }
  }
  if (message && metaParts.length > 0) {
    return `${message} | ${metaParts.join(" ")}`;
  }
  if (message) return message;
  if (metaParts.length > 0) return metaParts.join(" ");

  for (const key of ["body", "data", "response", "payload", "result", "cause"]) {
    if (obj[key] != null) {
      const nested = extractNestedMessage(obj[key], depth + 1);
      if (nested) return nested;
    }
  }

  return undefined;
}

/**
 * Extract HTTP status code from error objects (e.g., fetch response errors).
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    for (const key of ["status", "statusCode", "httpStatus", "code"]) {
      const n = asStatusNumber(obj[key]);
      if (n !== undefined) return n;
    }

    // Check nested response / body objects (wrapper envelopes)
    for (const key of ["response", "body", "data", "error"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const nested = obj[key] as Record<string, unknown>;
        for (const nKey of ["status", "statusCode", "httpStatus", "code"]) {
          const n = asStatusNumber(nested[nKey]);
          if (n !== undefined) return n;
        }
      }
    }
  }
  return undefined;
}

function extractEmbeddedHttpStatus(
  error: unknown,
  rawError: string
): number | undefined {
  const fromObj = extractHttpStatus(error);
  if (fromObj !== undefined) return fromObj;
  const match = rawError.match(EMBEDDED_STATUS_RE);
  if (!match?.[1]) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function asStatusNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 100 && value < 600) {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const n = Number(value.trim());
    if (n >= 100 && n < 600) return n;
  }
  return undefined;
}

/**
 * Check if an error category should trigger a retry.
 */
export function isRetryable(category: ErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/**
 * List categories that strategies can target (for skill/agent guidance).
 */
export function listRetryableCategories(): ErrorCategory[] {
  return [...RETRYABLE_CATEGORIES];
}

/**
 * Get a human-readable label for an error category.
 */
export function categoryLabel(category: ErrorCategory): string {
  const labels: Record<ErrorCategory, string> = {
    rate_limit: "Rate Limited (429)",
    server_overload: "Server Overloaded (503)",
    timeout: "Request Timeout",
    auth_failed: "Authentication Failed",
    network_error: "Network Error",
    model_unavailable: "Model Unavailable",
    context_too_long: "Context Too Long",
    token_parse_error: "Token Parse Error",
    invalid_model_output: "Invalid Model Output",
    session_runtime_error: "Session Runtime Error",
    wrapped_api_error: "Wrapped API Body Error (HTTP misleading)",
    unknown: "Unknown Error",
  };
  return labels[category] ?? category;
}

export function sessionCategoryLabel(category: SessionErrorCategory): string {
  const labels: Record<SessionErrorCategory, string> = {
    prompt_aborted: "Prompt Aborted",
    tool_execution_failed: "Tool Execution Failed",
    shell_parse_error: "Shell Parse Error",
    session_takeover: "Session Takeover",
    task_timeout: "Task Timeout",
    browser_workflow_failed: "Browser Workflow Failed",
    permission_denied: "Permission Denied",
    config_error: "Config Error",
    external_side_effect_risk: "External Side Effect Risk",
    unknown_session_error: "Unknown Session Error",
  };
  return labels[category];
}
