/**
 * Aggregate stats/logs across multiple OpenClaw resilience instances.
 */

import * as fs from "node:fs";
import { categoryLabel } from "./error-classifier.js";
import { StatsCollector } from "./stats-collector.js";
import { RetryEngine } from "./retry-engine.js";
import { ResilienceLogger } from "./logger.js";
import { TaskRecovery } from "./task-recovery.js";
import { SessionRetryStore } from "./session-retry-store.js";
import {
  discoverInstances,
  getInstancePaths,
  type InstanceInfo,
  type InstancePaths,
} from "./instance-registry.js";
import type {
  ErrorCategory,
  LogEntry,
  ModelStats,
  RetryState,
  RetryStrategy,
  SessionRetryRecord,
  TimeStats,
} from "./types.js";

function emptyErrorCounts(): Record<ErrorCategory, number> {
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
    wrapped_api_error: 0,
    unknown: 0,
  };
}

function mergeTimeStats(a: TimeStats | undefined, b: TimeStats): TimeStats {
  if (!a) return { ...b, errorsByType: { ...b.errorsByType }, modelBreakdown: { ...b.modelBreakdown } };
  const errorsByType = emptyErrorCounts();
  for (const k of Object.keys(errorsByType) as ErrorCategory[]) {
    errorsByType[k] = (a.errorsByType[k] ?? 0) + (b.errorsByType[k] ?? 0);
  }
  const totalCalls = a.totalCalls + b.totalCalls;
  const failedCalls = a.failedCalls + b.failedCalls;
  const modelBreakdown = { ...a.modelBreakdown };
  for (const [model, ms] of Object.entries(b.modelBreakdown)) {
    const key = model;
    if (modelBreakdown[key]) {
      modelBreakdown[key] = mergeModelStats(modelBreakdown[key], ms);
    } else {
      modelBreakdown[key] = { ...ms };
    }
  }
  return {
    period: a.period,
    totalCalls,
    failedCalls,
    successRate:
      totalCalls > 0
        ? Math.round(((totalCalls - failedCalls) / totalCalls) * 10000) / 100
        : 100,
    errorsByType,
    modelBreakdown,
  };
}

function mergeModelStats(a: ModelStats, b: ModelStats): ModelStats {
  const totalCalls = a.totalCalls + b.totalCalls;
  const failedCalls = a.failedCalls + b.failedCalls;
  const errorsByType = emptyErrorCounts();
  for (const k of Object.keys(errorsByType) as ErrorCategory[]) {
    errorsByType[k] = (a.errorsByType[k] ?? 0) + (b.errorsByType[k] ?? 0);
  }
  return {
    model: a.model,
    totalCalls,
    failedCalls,
    successRate:
      totalCalls > 0
        ? Math.round(((totalCalls - failedCalls) / totalCalls) * 10000) / 100
        : 100,
    avgDurationMs:
      totalCalls > 0
        ? (a.avgDurationMs * a.totalCalls + b.avgDurationMs * b.totalCalls) / totalCalls
        : 0,
    errorsByType,
    lastUpdated:
      a.lastUpdated > b.lastUpdated ? a.lastUpdated : b.lastUpdated,
  };
}

function loadActiveRetries(paths: InstancePaths): Record<string, RetryState> {
  try {
    if (fs.existsSync(paths.activeRetriesPath)) {
      const raw = JSON.parse(
        fs.readFileSync(paths.activeRetriesPath, "utf-8")
      ) as Record<string, RetryState>;
      return raw ?? {};
    }
  } catch {
    /* ignore */
  }
  return {};
}

export class InstanceAggregator {
  readonly localInstanceId: string;
  readonly localPaths: InstancePaths;

  constructor(localPaths: InstancePaths) {
    this.localPaths = localPaths;
    this.localInstanceId = localPaths.id;
  }

  listInstances(): InstanceInfo[] {
    return discoverInstances();
  }

  resolveTarget(instanceParam?: string | null): string {
    const v = (instanceParam ?? "all").trim();
    if (!v || v === "all") return "all";
    const list = this.listInstances();
    const hit = list.find((i) => i.id === v || i.label === v);
    return hit?.id ?? v;
  }

  private collectorsFor(target: string): Array<{ info: InstanceInfo; stats: StatsCollector }> {
    const list = this.listInstances();
    if (target === "all") {
      return list
        .filter(
          (i) =>
            i.hasStats ||
            fs.existsSync(i.paths.logDir) ||
            fs.existsSync(i.paths.sessionRetriesPath)
        )
        .map((info) => ({
          info,
          stats: new StatsCollector(info.paths.statsPath),
        }));
    }
    const info = list.find((i) => i.id === target);
    if (!info) {
      const paths = getInstancePaths(target);
      const stub: InstanceInfo = {
        id: paths.id,
        label: paths.label,
        createdAt: "",
        lastSeenAt: "",
        paths,
        hasStats: fs.existsSync(paths.statsPath),
        isLegacy: false,
      };
      return [{ info: stub, stats: new StatsCollector(paths.statsPath) }];
    }
    return [{ info, stats: new StatsCollector(info.paths.statsPath) }];
  }

  getOverview(target: string) {
    const resolved = this.resolveTarget(target);
    const collectors = this.collectorsFor(resolved);

    let today: TimeStats | undefined;
    let hour: TimeStats | undefined;
    let week: TimeStats | undefined;
    let lastUpdated = "";
    const activeRetries: Record<string, RetryState & { instanceId: string; instanceLabel: string }> = {};
    let failedTasks = 0;
    const sessionRetryRecords: SessionRetryRecord[] = [];
    const recentErrors: Array<LogEntry & { instanceId: string; instanceLabel: string; errorLabel: string }> = [];

    for (const { info, stats } of collectors) {
      const raw = stats.getRawData();
      if (raw.lastUpdated > lastUpdated) lastUpdated = raw.lastUpdated;

      const t = stats.getTodaySummary();
      const h = stats.getCurrentHourSummary();
      const w = stats.getWeekSummary();
      if (t) today = mergeTimeStats(today, t);
      if (h) hour = mergeTimeStats(hour, h);
      if (w) week = mergeTimeStats(week, w);

      const logger = new ResilienceLogger(info.paths.logDir);
      const errors = logger
        .readTodayLogs()
        .filter((l) => l.errorType !== "success")
        .slice(-10);
      for (const e of errors) {
        recentErrors.push({
          ...e,
          instanceId: info.id,
          instanceLabel: info.label,
          errorLabel: categoryLabel(e.errorType as ErrorCategory),
        });
      }

      const tasks = new TaskRecovery(info.paths.tasksDir);
      failedTasks += tasks.getRecoverableTasks().length;

      const sessionRetries = new SessionRetryStore(info.paths.sessionRetriesPath, {
        id: info.id,
        label: info.label,
      });
      sessionRetryRecords.push(
        ...sessionRetries.list(100).map((record) => ({
          ...record,
          instanceId: record.instanceId ?? info.id,
          instanceLabel: record.instanceLabel ?? info.label,
        }))
      );

      for (const [key, state] of Object.entries(loadActiveRetries(info.paths))) {
        activeRetries[`${info.id}:${key}`] = {
          ...state,
          instanceId: info.id,
          instanceLabel: info.label,
        };
      }
    }

    recentErrors.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    sessionRetryRecords.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      instance: resolved,
      instances: this.listInstances().map((i) => ({
        id: i.id,
        label: i.label,
        hasStats: i.hasStats,
        isLegacy: i.isLegacy,
        lastSeenAt: i.lastSeenAt,
        workspacePath: i.workspacePath,
      })),
      localInstanceId: this.localInstanceId,
      lastUpdated,
      today,
      hour,
      week,
      activeRetries,
      failedTasks,
      sessionRetriesSummary: this.summarizeSessionRetries(sessionRetryRecords),
      sessionRetries: sessionRetryRecords.slice(0, 50),
      recentErrors: recentErrors.slice(0, 30),
    };
  }

  getSessionRetries(target: string, limit = 100) {
    const resolved = this.resolveTarget(target);
    const records: SessionRetryRecord[] = [];

    for (const { info } of this.collectorsFor(resolved)) {
      const store = new SessionRetryStore(info.paths.sessionRetriesPath, {
        id: info.id,
        label: info.label,
      });
      records.push(
        ...store.list(limit).map((record) => ({
          ...record,
          instanceId: record.instanceId ?? info.id,
          instanceLabel: record.instanceLabel ?? info.label,
        }))
      );
    }

    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      instance: resolved,
      summary: this.summarizeSessionRetries(records),
      records: records.slice(0, limit),
    };
  }

  getModels(target: string): Record<string, ModelStats & { instanceId: string; instanceLabel: string }> {
    const resolved = this.resolveTarget(target);
    const out: Record<string, ModelStats & { instanceId: string; instanceLabel: string }> = {};

    for (const { info, stats } of this.collectorsFor(resolved)) {
      for (const [model, m] of Object.entries(stats.getAllModelStats())) {
        const key = resolved === "all" ? `${info.label} / ${model}` : model;
        out[key] = { ...m, instanceId: info.id, instanceLabel: info.label };
      }
    }
    return out;
  }

  getStrategiesForEdit(instanceId?: string): {
    instanceId: string;
    strategies: RetryStrategy[];
    defaultStrategy: string | null;
    editable: boolean;
  } {
    const id = instanceId && instanceId !== "all" ? this.resolveTarget(instanceId) : this.localInstanceId;
    const list = this.listInstances();
    const info = list.find((i) => i.id === id) ?? { paths: this.localPaths } as InstanceInfo;
    const engine = new RetryEngine(info.paths.strategiesPath);
    const strategies = engine.getStrategies();
    const defaultStrategy =
      strategies.find((s) => s.isDefault)?.name ?? strategies[0]?.name ?? null;
    return {
      instanceId: id,
      strategies,
      defaultStrategy,
      editable: id === this.localInstanceId,
    };
  }

  getLocalRetryEngine(): RetryEngine {
    return new RetryEngine(this.localPaths.strategiesPath);
  }

  persistActiveRetries(states: Map<string, RetryState>): void {
    const obj = Object.fromEntries(states);
    fs.writeFileSync(
      this.localPaths.activeRetriesPath,
      JSON.stringify(obj, null, 2),
      "utf-8"
    );
  }

  private summarizeSessionRetries(records: SessionRetryRecord[]) {
    return new SessionRetryStore(this.localPaths.sessionRetriesPath, {
      id: this.localInstanceId,
      label: this.localPaths.label,
    }).getSummary(records);
  }
}
