/**
 * Error Classifier
 *
 * Classifies API errors into categories based on HTTP status codes,
 * error messages, and patterns. Determines if an error is retryable.
 */

import {
  type ErrorCategory,
  type ClassifiedError,
  STATUS_MAP,
  ERROR_PATTERNS,
} from "./types.js";

// Error categories that are always retryable
const RETRYABLE_CATEGORIES: Set<ErrorCategory> = new Set([
  "rate_limit",
  "server_overload",
  "timeout",
  "network_error",
]);

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
  const httpStatus = options?.httpStatus ?? extractHttpStatus(error);

  // 1. Try HTTP status code mapping first
  if (httpStatus !== undefined && httpStatus in STATUS_MAP) {
    const category = STATUS_MAP[httpStatus];
    return {
      category,
      rawError,
      httpStatus,
      provider: options?.provider,
      model: options?.model,
      retryable: RETRYABLE_CATEGORIES.has(category),
    };
  }

  // 2. Try pattern matching on the error message
  for (const { pattern, category } of ERROR_PATTERNS) {
    if (pattern.test(rawError)) {
      return {
        category,
        rawError,
        httpStatus,
        provider: options?.provider,
        model: options?.model,
        retryable: RETRYABLE_CATEGORIES.has(category),
      };
    }
  }

  // 3. Check for 5xx (server overload without specific mapping)
  if (httpStatus !== undefined && httpStatus >= 500) {
    return {
      category: "server_overload",
      rawError,
      httpStatus,
      provider: options?.provider,
      model: options?.model,
      retryable: true,
    };
  }

  // 4. Fallback to unknown
  return {
    category: "unknown",
    rawError,
    httpStatus,
    provider: options?.provider,
    model: options?.model,
    retryable: false,
  };
}

/**
 * Extract a human-readable error message from various error types.
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Extract HTTP status code from error objects (e.g., fetch response errors).
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === "number") return obj.status;
    if (typeof obj.statusCode === "number") return obj.statusCode;
    if (typeof obj.httpStatus === "number") return obj.httpStatus;

    // Check nested response object
    if (obj.response && typeof obj.response === "object") {
      const resp = obj.response as Record<string, unknown>;
      if (typeof resp.status === "number") return resp.status;
    }
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
    unknown: "Unknown Error",
  };
  return labels[category];
}
