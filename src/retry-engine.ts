/**
 * Retry Engine
 *
 * Manages retry strategies for failed API calls.
 * Supports fixed, exponential backoff, and custom interval strategies.
 * Strategies can be model-specific or global.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  RetryStrategy,
  RetryStrategyType,
  RetryState,
  ClassifiedError,
  ErrorCategory,
} from "./types.js";
import {
  normalizeRetryStrategy,
  normalizeRetryStrategyUpdate,
} from "./strategy-normalizer.js";

const DEFAULT_STRATEGIES_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "plugins",
  "resilience",
  "strategies.json"
);

/** Default retry strategies */
const DEFAULT_STRATEGIES: RetryStrategy[] = [
  {
    name: "default-exponential",
    type: "exponential",
    maxRetries: 5,
    intervals: [60_000, 180_000, 300_000, 600_000, 900_000], // 1m, 3m, 5m, 10m, 15m
    retryOn: [
      "rate_limit",
      "server_overload",
      "timeout",
      "network_error",
      "wrapped_api_error",
    ],
    cooldownMs: 10_000,
    isDefault: true,
  },
  {
    name: "rate-limit-fixed",
    type: "fixed",
    maxRetries: 3,
    intervals: [30_000], // 30s
    retryOn: ["rate_limit"],
    cooldownMs: 5_000,
  },
  {
    name: "model-backoff",
    type: "custom",
    maxRetries: 6,
    intervals: [60_000, 300_000, 600_000, 1800_000, 3600_000, 7200_000], // 1m, 5m, 10m, 30m, 1h, 2h
    retryOn: ["server_overload", "model_unavailable", "wrapped_api_error"],
    cooldownMs: 30_000,
    models: ["mimo-v2.5", "gpt-4o", "claude-3-opus"],
  },
  {
    name: "wrapped-api-body-retry",
    type: "exponential",
    maxRetries: 4,
    intervals: [15_000, 60_000, 180_000, 300_000], // 15s, 1m, 3m, 5m
    retryOn: ["wrapped_api_error"],
    cooldownMs: 5_000,
  },
];

/** Retry Engine class */
export class RetryEngine {
  private strategiesPath: string;
  private strategies: RetryStrategy[] = [];
  private activeRetries: Map<string, RetryState> = new Map();
  /** Called when active retry map changes (for multi-instance dashboard persistence). */
  onActiveRetriesChanged?: (states: Map<string, RetryState>) => void;

  constructor(strategiesPath?: string) {
    this.strategiesPath = strategiesPath ?? DEFAULT_STRATEGIES_PATH;
    this.strategies = this.loadStrategies();
  }

  /**
   * Load strategies from disk, falling back to defaults.
   * Also ensures newly introduced retryable categories (e.g. wrapped_api_error)
   * remain covered when an older strategies.json is present.
   */
  private loadStrategies(): RetryStrategy[] {
    try {
      if (fs.existsSync(this.strategiesPath)) {
        const raw = fs.readFileSync(this.strategiesPath, "utf-8");
        const loaded = JSON.parse(raw) as RetryStrategy[];
        if (Array.isArray(loaded) && loaded.length > 0) {
          return this.ensureCategoryCoverage(
            loaded.map(normalizeRetryStrategy)
          );
        }
      }
    } catch {
      // Corrupted — use defaults
    }
    return DEFAULT_STRATEGIES.map((s) => normalizeRetryStrategy({ ...s }));
  }

  /**
   * Patch older strategy files so new transient categories are not left without
   * any matching strategy (which would silently disable retries).
   */
  private ensureCategoryCoverage(strategies: RetryStrategy[]): RetryStrategy[] {
    const required: ErrorCategory[] = ["wrapped_api_error"];
    const missing = required.filter(
      (cat) => !strategies.some((s) => s.retryOn.includes(cat))
    );
    if (missing.length === 0) return strategies;

    const target =
      strategies.find((s) => s.isDefault) ??
      strategies.find((s) => s.name === "default-exponential") ??
      strategies[0];
    if (target) {
      target.retryOn = [...new Set([...target.retryOn, ...missing])];
    }

    const hasBodyStrategy = strategies.some(
      (s) => s.name === "wrapped-api-body-retry"
    );
    if (!hasBodyStrategy) {
      const bodyDefault = DEFAULT_STRATEGIES.find(
        (s) => s.name === "wrapped-api-body-retry"
      );
      if (bodyDefault) {
        strategies.push(normalizeRetryStrategy({ ...bodyDefault }));
      }
    }
    return strategies;
  }

  /**
   * Save strategies to disk.
   */
  saveStrategies(): void {
    const dir = path.dirname(this.strategiesPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      this.strategiesPath,
      JSON.stringify(this.strategies, null, 2),
      "utf-8"
    );
  }

  /**
   * Find the best matching strategy for a given error and optional model.
   */
  findStrategy(error: ClassifiedError): RetryStrategy | null {
    // 1. Find model-specific strategy first
    if (error.model) {
      const modelStrategy = this.strategies.find(
        (s) =>
          s.models?.includes(error.model!) &&
          s.retryOn.includes(error.category)
      );
      if (modelStrategy) return modelStrategy;
    }

    // 2. Find global strategy (no models specified)
    const globalStrategy = this.strategies.find(
      (s) => !s.models && s.retryOn.includes(error.category)
    );
    if (globalStrategy) return globalStrategy;

    // 3. Find any strategy that handles this error type (prefer isDefault)
    const matches = this.strategies.filter((s) =>
      s.retryOn.includes(error.category)
    );
    if (matches.length === 0) return null;
    return matches.find((s) => s.isDefault) ?? matches[0];
  }

  /**
   * Determine if a retry should be attempted.
   * Returns the delay in ms, or -1 if no retry should happen.
   */
  shouldRetry(
    operationKey: string,
    error: ClassifiedError
  ): { retry: boolean; delayMs: number; attempt: number } {
    const strategy = this.findStrategy(error);
    if (!strategy) {
      return { retry: false, delayMs: -1, attempt: 0 };
    }

    const existing = this.activeRetries.get(operationKey);
    const attempt = existing ? existing.attempt + 1 : 1;

    if (attempt > strategy.maxRetries) {
      this.activeRetries.delete(operationKey);
      this.onActiveRetriesChanged?.(this.activeRetries);
      return { retry: false, delayMs: -1, attempt };
    }

    // Check cooldown
    if (existing) {
      const nextRetryTime = new Date(existing.nextRetryAt).getTime();
      const now = Date.now();
      if (now < nextRetryTime) {
        const waitMs = nextRetryTime - now;
        // Still in cooldown — report the wait
        return { retry: true, delayMs: waitMs, attempt };
      }
    }

    // Calculate delay based on strategy type
    const delayMs = this.calculateDelay(strategy, attempt - 1);

    // Update active retry state
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.activeRetries.set(operationKey, {
      strategyName: strategy.name,
      attempt,
      nextRetryAt,
      lastError: error,
    });
    this.onActiveRetriesChanged?.(this.activeRetries);

    return { retry: true, delayMs, attempt };
  }

  /**
   * Calculate retry delay based on strategy type and attempt index.
   */
  private calculateDelay(strategy: RetryStrategy, attemptIndex: number): number {
    switch (strategy.type) {
      case "fixed":
        return strategy.intervals[0] ?? 30_000;

      case "exponential": {
        const base = strategy.intervals[0] ?? 60_000;
        // Exponential: base * 2^attemptIndex, capped at last interval
        const maxInterval = strategy.intervals[strategy.intervals.length - 1] ?? base * 32;
        const delay = base * Math.pow(2, attemptIndex);
        return Math.min(delay, maxInterval);
      }

      case "custom":
        return strategy.intervals[attemptIndex] ?? strategy.intervals[strategy.intervals.length - 1] ?? 60_000;

      default:
        return 60_000;
    }
  }

  /**
   * Mark an operation as successfully completed (clear retry state).
   */
  complete(operationKey: string): void {
    this.activeRetries.delete(operationKey);
    this.onActiveRetriesChanged?.(this.activeRetries);
  }

  /**
   * Get current retry state for an operation.
   */
  getState(operationKey: string): RetryState | undefined {
    return this.activeRetries.get(operationKey);
  }

  /**
   * Get all active retries.
   */
  getActiveRetries(): Map<string, RetryState> {
    return new Map(this.activeRetries);
  }

  /**
   * Get all configured strategies.
   */
  getStrategies(): RetryStrategy[] {
    return [...this.strategies];
  }

  /**
   * Add a new strategy.
   */
  addStrategy(strategy: RetryStrategy): void {
    this.strategies.push(normalizeRetryStrategy(strategy));
    this.saveStrategies();
  }

  /**
   * Update an existing strategy by name.
   */
  updateStrategy(name: string, updates: Partial<RetryStrategy>): boolean {
    const idx = this.strategies.findIndex((s) => s.name === name);
    if (idx === -1) return false;
    const normalized = normalizeRetryStrategyUpdate(
      updates as Record<string, unknown>
    );
    this.strategies[idx] = normalizeRetryStrategy({
      ...this.strategies[idx],
      ...normalized,
    });
    this.saveStrategies();
    return true;
  }

  /**
   * Remove a strategy by name.
   */
  removeStrategy(name: string): boolean {
    const idx = this.strategies.findIndex((s) => s.name === name);
    if (idx === -1) return false;
    this.strategies.splice(idx, 1);
    this.saveStrategies();
    return true;
  }

  /**
   * Reset strategies to defaults.
   */
  resetDefaults(): void {
    this.strategies = [...DEFAULT_STRATEGIES];
    this.saveStrategies();
  }
}
