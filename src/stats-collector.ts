/**
 * Stats Collector
 *
 * Collects and aggregates API call statistics by time dimension (hour/day/week)
 * and by model. Persists stats to ~/.openclaw/plugins/resilience/stats.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  LogEntry,
  StatsData,
  TimeStats,
  ModelStats,
  TimeBucket,
  ErrorCategory,
} from "./types.js";

const DEFAULT_STATS_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "plugins",
  "resilience",
  "stats.json"
);

/** Empty error counts */
function emptyErrors(): Record<ErrorCategory, number> {
  return {
    rate_limit: 0,
    server_overload: 0,
    timeout: 0,
    auth_failed: 0,
    network_error: 0,
    model_unavailable: 0,
    context_too_long: 0,
    token_parse_error: 0,
    invalid_model_output: 0,
    session_runtime_error: 0,
    unknown: 0,
  };
}

function incrementErrorCount(
  counts: Record<ErrorCategory, number>,
  category: ErrorCategory
): void {
  counts[category] = (counts[category] ?? 0) + 1;
}

/** Create empty stats data */
function emptyStats(): StatsData {
  return {
    lastUpdated: new Date().toISOString(),
    hourly: {},
    daily: {},
    weekly: {},
    models: {},
  };
}

/** Stats Collector class */
export class StatsCollector {
  private statsPath: string;
  private data: StatsData;

  constructor(statsPath?: string) {
    this.statsPath = statsPath ?? DEFAULT_STATS_PATH;
    this.data = this.load();
  }

  /**
   * Load stats from disk, or create empty stats.
   */
  private load(): StatsData {
    try {
      if (fs.existsSync(this.statsPath)) {
        const raw = fs.readFileSync(this.statsPath, "utf-8");
        return JSON.parse(raw) as StatsData;
      }
    } catch {
      // Corrupted file — start fresh
    }
    return emptyStats();
  }

  /**
   * Persist stats to disk.
   */
  save(): void {
    const dir = path.dirname(this.statsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.statsPath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  /**
   * Process a log entry and update stats.
   */
  record(entry: LogEntry): void {
    const now = new Date(entry.timestamp);
    const hourKey = formatHour(now);
    const dayKey = formatDay(now);
    const weekKey = formatWeek(now);
    const isError = entry.errorType !== "success";

    // Update hourly stats
    this.updateTimeStats(hourKey, "hourly", entry, isError);
    // Update daily stats
    this.updateTimeStats(dayKey, "daily", entry, isError);
    // Update weekly stats
    this.updateTimeStats(weekKey, "weekly", entry, isError);
    // Update model stats
    if (entry.model) {
      this.updateModelStats(entry.model, entry, isError);
    }

    this.save();
  }

  /**
   * Record a batch of log entries.
   */
  recordBatch(entries: LogEntry[]): void {
    for (const entry of entries) {
      const now = new Date(entry.timestamp);
      const hourKey = formatHour(now);
      const dayKey = formatDay(now);
      const weekKey = formatWeek(now);
      const isError = entry.errorType !== "success";

      this.updateTimeStats(hourKey, "hourly", entry, isError);
      this.updateTimeStats(dayKey, "daily", entry, isError);
      this.updateTimeStats(weekKey, "weekly", entry, isError);
      if (entry.model) {
        this.updateModelStats(entry.model, entry, isError);
      }
    }
    this.save();
  }

  /**
   * Update time-bucketed stats.
   */
  private updateTimeStats(
    key: string,
    bucket: "hourly" | "daily" | "weekly",
    entry: LogEntry,
    isError: boolean
  ): void {
    if (!this.data[bucket][key]) {
      this.data[bucket][key] = {
        period: key,
        totalCalls: 0,
        failedCalls: 0,
        successRate: 100,
        errorsByType: emptyErrors(),
        modelBreakdown: {},
      };
    }
    const stats = this.data[bucket][key];
    stats.totalCalls++;
    if (isError) {
      stats.failedCalls++;
      incrementErrorCount(stats.errorsByType, entry.errorType as ErrorCategory);
    }
    stats.successRate =
      stats.totalCalls > 0
        ? Math.round(((stats.totalCalls - stats.failedCalls) / stats.totalCalls) * 10000) / 100
        : 100;

    // Update model breakdown within time stats
    if (entry.model) {
      if (!stats.modelBreakdown[entry.model]) {
        stats.modelBreakdown[entry.model] = this.createModelStats(entry.model);
      }
      this.updateModelStatsInner(stats.modelBreakdown[entry.model], entry, isError);
    }
  }

  /**
   * Update per-model stats.
   */
  private updateModelStats(model: string, entry: LogEntry, isError: boolean): void {
    if (!this.data.models[model]) {
      this.data.models[model] = this.createModelStats(model);
    }
    this.updateModelStatsInner(this.data.models[model], entry, isError);
  }

  /**
   * Inner model stats update (shared between global and time-bucketed).
   */
  private updateModelStatsInner(
    stats: ModelStats,
    entry: LogEntry,
    isError: boolean
  ): void {
    const prevTotal = stats.totalCalls;
    stats.totalCalls++;
    // Running average for duration
    stats.avgDurationMs =
      (stats.avgDurationMs * prevTotal + entry.durationMs) / stats.totalCalls;

    if (isError) {
      stats.failedCalls++;
      incrementErrorCount(stats.errorsByType, entry.errorType as ErrorCategory);
    }
    stats.successRate =
      stats.totalCalls > 0
        ? Math.round(((stats.totalCalls - stats.failedCalls) / stats.totalCalls) * 10000) / 100
        : 100;
    stats.lastUpdated = entry.timestamp;
  }

  /**
   * Create an empty ModelStats object.
   */
  private createModelStats(model: string): ModelStats {
    return {
      model,
      totalCalls: 0,
      failedCalls: 0,
      successRate: 100,
      avgDurationMs: 0,
      errorsByType: emptyErrors(),
      lastUpdated: new Date().toISOString(),
    };
  }

  // ─── Query Methods ──────────────────────────────────────────────────────

  private getTimeBucket(key: TimeBucket): Record<string, TimeStats> {
    switch (key) {
      case "hour": return this.data.hourly;
      case "day": return this.data.daily;
      case "week": return this.data.weekly;
    }
  }

  /**
   * Get stats for a specific time bucket.
   */
  getStats(bucket: TimeBucket, key: string): TimeStats | undefined {
    return this.getTimeBucket(bucket)[key];
  }

  /**
   * Get stats for a specific model.
   */
  getModelStats(model: string): ModelStats | undefined {
    return this.data.models[model];
  }

  /**
   * Get all model stats.
   */
  getAllModelStats(): Record<string, ModelStats> {
    return this.data.models;
  }

  /**
   * Get summary stats for today.
   */
  getTodaySummary(): TimeStats | undefined {
    const today = formatDay(new Date());
    return this.data.daily[today];
  }

  /**
   * Get summary for the current hour.
   */
  getCurrentHourSummary(): TimeStats | undefined {
    const hour = formatHour(new Date());
    return this.data.hourly[hour];
  }

  /**
   * Get summary for the current week.
   */
  getWeekSummary(): TimeStats | undefined {
    const week = formatWeek(new Date());
    return this.data.weekly[week];
  }

  /**
   * Get the raw stats data.
   */
  getRawData(): StatsData {
    return this.data;
  }

  /**
   * Cleanup old hourly stats (keep last 7 days).
   */
  cleanup(keepDays: number = 7): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffHour = formatHour(cutoff);

    for (const key of Object.keys(this.data.hourly)) {
      if (key < cutoffHour) {
        delete this.data.hourly[key];
      }
    }
    this.save();
  }
}

// ─── Formatting Helpers ───────────────────────────────────────────────────

function formatHour(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}`;
}

function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatWeek(d: Date): string {
  const y = d.getFullYear();
  // ISO week number
  const jan1 = new Date(y, 0, 1);
  const days = Math.floor(
    (d.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000)
  );
  const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${y}-W${String(weekNum).padStart(2, "0")}`;
}
