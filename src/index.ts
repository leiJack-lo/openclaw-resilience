/**
 * OpenClaw Resilience Plugin — Entry Point
 *
 * Registers tools and hooks for LLM API error tracking, classification,
 * retry management, and task recovery.
 *
 * Uses the official OpenClaw Plugin SDK (2026.5.18).
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { classifyError, categoryLabel } from "./error-classifier.js";
import { ResilienceLogger } from "./logger.js";
import { StatsCollector } from "./stats-collector.js";
import { RetryEngine } from "./retry-engine.js";
import { TaskRecovery } from "./task-recovery.js";
import type {
  LogEntry,
  ErrorCategory,
  ResilienceConfig,
  ClassifiedError,
} from "./types.js";

// ─── Module State ───────────────────────────────────────────────────────────

let logger: ResilienceLogger;
let stats: StatsCollector;
let retryEngine: RetryEngine;
let taskRecovery: TaskRecovery;
let pluginConfig: ResilienceConfig = {};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatIntervals(intervals: number[], type: string): string {
  if (type === "fixed") return `${formatMs(intervals[0] ?? 0)} (fixed)`;
  return intervals.map(formatMs).join(", ");
}

function formatTimeStats(
  s: {
    period: string;
    totalCalls: number;
    failedCalls: number;
    successRate: number;
    errorsByType: Record<string, number>;
  },
  label: string
): string {
  let out = `### ${label}\n\n`;
  out += `- Total calls: ${s.totalCalls}\n`;
  out += `- Failed: ${s.failedCalls}\n`;
  out += `- Success rate: ${s.successRate}%\n\n`;

  const errors = Object.entries(s.errorsByType).filter(([, v]) => v > 0);
  if (errors.length > 0) {
    out += "Error breakdown:\n";
    for (const [type, count] of errors) {
      out += `  - ${categoryLabel(type as ErrorCategory)}: ${count}\n`;
    }
  }
  return out;
}

function formatModelStats(m: {
  model: string;
  totalCalls: number;
  failedCalls: number;
  successRate: number;
  avgDurationMs: number;
  errorsByType: Record<string, number>;
}): string {
  let out = `### ${m.model}\n\n`;
  out += `- Total calls: ${m.totalCalls}\n`;
  out += `- Failed: ${m.failedCalls}\n`;
  out += `- Success rate: ${m.successRate}%\n`;
  out += `- Avg duration: ${formatMs(m.avgDurationMs)}\n\n`;

  const errors = Object.entries(m.errorsByType).filter(([, v]) => v > 0);
  if (errors.length > 0) {
    out += "Error breakdown:\n";
    for (const [type, count] of errors) {
      out += `  - ${categoryLabel(type as ErrorCategory)}: ${count}\n`;
    }
  }
  return out;
}

function formatDailyReport(date: string, logs: LogEntry[]): string {
  const total = logs.length;
  const errors = logs.filter((l) => l.errorType !== "success");
  const successRate =
    total > 0 ? ((total - errors.length) / total) * 100 : 100;

  let out = `## Daily Error Report — ${date}\n\n`;
  out += `- Total API calls: ${total}\n`;
  out += `- Successful: ${total - errors.length}\n`;
  out += `- Failed: ${errors.length}\n`;
  out += `- Success rate: ${successRate.toFixed(1)}%\n\n`;

  if (errors.length === 0) {
    out += "✅ No errors recorded today!\n";
    return out;
  }

  // Group errors by type
  const byType: Record<string, number> = {};
  for (const e of errors) {
    byType[e.errorType] = (byType[e.errorType] ?? 0) + 1;
  }
  out += "### Errors by Type\n\n";
  for (const [type, count] of Object.entries(byType).sort(
    (a, b) => b[1] - a[1]
  )) {
    out += `- ${categoryLabel(type as ErrorCategory)}: ${count}\n`;
  }

  // Group by model
  const byModel: Record<string, number> = {};
  for (const e of errors) {
    const m = e.model ?? "unknown";
    byModel[m] = (byModel[m] ?? 0) + 1;
  }
  out += "\n### Errors by Model\n\n";
  for (const [model, count] of Object.entries(byModel).sort(
    (a, b) => b[1] - a[1]
  )) {
    out += `- ${model}: ${count}\n`;
  }

  // Recent errors
  out += "\n### Recent Errors (last 10)\n\n";
  const recent = errors.slice(-10).reverse();
  for (const e of recent) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    out += `- [${time}] ${categoryLabel(e.errorType as ErrorCategory)}: ${e.errorMessage ?? "no message"}\n`;
  }

  return out;
}

/**
 * Process an API call result: classify, log, record stats, check retry.
 */
function processCallResult(params: {
  provider?: string;
  model?: string;
  error?: unknown;
  httpStatus?: number;
  durationMs: number;
  sessionId?: string;
  runId?: string;
}): ClassifiedError | null {
  const { provider, model, error, httpStatus, durationMs, sessionId, runId } =
    params;

  if (error) {
    const classified = classifyError(error, { provider, model, httpStatus });

    logger.logError({
      timestamp: new Date().toISOString(),
      provider,
      model,
      errorType: classified.category,
      errorMessage: classified.rawError,
      httpStatus: classified.httpStatus,
      durationMs,
      sessionId,
      runId,
    });

    stats.record({
      timestamp: new Date().toISOString(),
      provider,
      model,
      errorType: classified.category,
      errorMessage: classified.rawError,
      httpStatus: classified.httpStatus,
      durationMs,
      sessionId,
      runId,
    });

    return classified;
  }

  // Success path
  logger.logSuccess({
    timestamp: new Date().toISOString(),
    provider,
    model,
    durationMs,
    sessionId,
    runId,
  });

  stats.record({
    timestamp: new Date().toISOString(),
    provider,
    model,
    errorType: "success",
    durationMs,
    sessionId,
    runId,
  });

  return null;
}

// ─── Plugin Definition ─────────────────────────────────────────────────────

export default definePluginEntry({
  id: "resilience",
  name: "Resilience",
  description:
    "LLM API error tracking, classification, retry, and task recovery",

  register(api) {
    // Read plugin config
    pluginConfig = (api.pluginConfig as ResilienceConfig) ?? {};

    // ─── Initialize Subsystems ────────────────────────────────────────

    logger = new ResilienceLogger(pluginConfig.logDir);
    stats = new StatsCollector();
    retryEngine = new RetryEngine();
    taskRecovery = new TaskRecovery();

    api.logger.info("[resilience] Subsystems initialized");

    // ─── Tool: resilience_stats ───────────────────────────────────────

    api.registerTool({
      name: "resilience_stats",
      label: "Resilience Stats",
      description:
        "View API error statistics. Query by time period (today, hour, week), " +
        "by model, or get a full summary.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description:
              'Natural language query, e.g. "today", "mimo-v2.5", "hour", "week", "all models"',
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const query = ((params as Record<string, unknown>).query as string ?? "").toLowerCase();

        // Model-specific query
        if (
          query &&
          !["today", "hour", "week", "all", "all models", ""].includes(query)
        ) {
          const modelStats = stats.getModelStats(query);
          if (modelStats) {
            return {
              content: [{ type: "text", text: formatModelStats(modelStats) }],
              details: modelStats,
            };
          }

          // Try today's model breakdown
          const today = stats.getTodaySummary();
          if (today?.modelBreakdown[query]) {
            return {
              content: [
                { type: "text", text: formatModelStats(today.modelBreakdown[query]) },
              ],
              details: today.modelBreakdown[query],
            };
          }
        }

        // Time-based queries
        if (query.includes("hour")) {
          const hourStats = stats.getCurrentHourSummary();
          return {
            content: [
              {
                type: "text",
                text: hourStats
                  ? formatTimeStats(hourStats, "Current Hour")
                  : "No data for current hour.",
              },
            ],
            details: hourStats ?? null,
          };
        }

        if (query.includes("week")) {
          const weekStats = stats.getWeekSummary();
          return {
            content: [
              {
                type: "text",
                text: weekStats
                  ? formatTimeStats(weekStats, "This Week")
                  : "No data for this week.",
              },
            ],
            details: weekStats ?? null,
          };
        }

        // Default: today + all models
        const todayStats = stats.getTodaySummary();
        const allModels = stats.getAllModelStats();

        let output = "";
        if (todayStats) {
          output += formatTimeStats(todayStats, "Today") + "\n\n";
        } else {
          output += "No data for today.\n\n";
        }

        const modelEntries = Object.values(allModels);
        if (modelEntries.length > 0) {
          output += "## Model Breakdown\n\n";
          for (const m of modelEntries) {
            output += formatModelStats(m) + "\n";
          }
        } else {
          output += "No model data recorded yet.";
        }

        return {
          content: [{ type: "text", text: output }],
          details: { today: todayStats, models: allModels },
        };
      },
    });

    // ─── Tool: resilience_strategies ──────────────────────────────────

    api.registerTool({
      name: "resilience_strategies",
      label: "Resilience Strategies",
      description:
        "View or modify retry strategies. Supports listing, adding, " +
        "updating, and resetting strategies.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.String({
            description: 'Action: "list" (default), "add", "update", "reset"',
          })
        ),
        strategyName: Type.Optional(
          Type.String({ description: "Strategy name (for update/add)" })
        ),
        updates: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Fields to update (for update action)",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const action = (p.action as string) ?? "list";

        switch (action) {
          case "list": {
            const strategies = retryEngine.getStrategies();
            if (strategies.length === 0) {
              return {
                content: [
                  { type: "text", text: "No strategies configured." },
                ],
                details: [],
              };
            }
            let output = "## Retry Strategies\n\n";
            for (const s of strategies) {
              output += `### ${s.name}\n`;
              output += `- Type: ${s.type}\n`;
              output += `- Max Retries: ${s.maxRetries}\n`;
              output += `- Intervals: ${formatIntervals(s.intervals, s.type)}\n`;
              output += `- Retry On: ${s.retryOn.map(categoryLabel).join(", ")}\n`;
              output += `- Cooldown: ${formatMs(s.cooldownMs)}\n`;
              if (s.models) {
                output += `- Models: ${s.models.join(", ")}\n`;
              }
              output += "\n";
            }
            return {
              content: [{ type: "text", text: output }],
              details: strategies,
            };
          }

          case "add": {
            const name = p.strategyName as string | undefined;
            if (!name) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: strategyName is required for add.",
                  },
                ],
                details: null,
              };
            }
            const updates = (p.updates as Record<string, unknown>) ?? {};
            const newStrategy = {
              name,
              type: (updates.type as "fixed" | "exponential" | "custom") ?? "exponential",
              maxRetries: (updates.maxRetries as number) ?? 5,
              intervals: (updates.intervals as number[]) ?? [60_000],
              retryOn: (updates.retryOn as ErrorCategory[]) ?? [
                "rate_limit",
                "server_overload",
              ],
              cooldownMs: (updates.cooldownMs as number) ?? 10_000,
              models: updates.models as string[] | undefined,
            };
            retryEngine.addStrategy(newStrategy);
            return {
              content: [
                {
                  type: "text",
                  text: `Strategy "${newStrategy.name}" added successfully.`,
                },
              ],
              details: newStrategy,
            };
          }

          case "update": {
            const sName = p.strategyName as string | undefined;
            const u = p.updates as Record<string, unknown> | undefined;
            if (!sName || !u) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: strategyName and updates are required.",
                  },
                ],
                details: null,
              };
            }
            const ok = retryEngine.updateStrategy(sName, u);
            return {
              content: [
                {
                  type: "text",
                  text: ok
                    ? `Strategy "${sName}" updated.`
                    : `Strategy "${sName}" not found.`,
                },
              ],
              details: ok,
            };
          }

          case "reset": {
            retryEngine.resetDefaults();
            return {
              content: [
                { type: "text", text: "Strategies reset to defaults." },
              ],
              details: null,
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown action: ${action}` },
              ],
              details: null,
            };
        }
      },
    });

    // ─── Tool: resilience_report ──────────────────────────────────────

    api.registerTool({
      name: "resilience_report",
      label: "Resilience Report",
      description:
        "Generate a detailed error report. Supports daily reports, " +
        "model-specific reports, or full status overview.",
      parameters: Type.Object({
        reportType: Type.Optional(
          Type.String({
            description:
              'Report type: "daily" (default), "model", "recovery", "full"',
          })
        ),
        target: Type.Optional(
          Type.String({ description: "Target model or date (YYYY-MM-DD)" })
        ),
      }),
      async execute(_toolCallId, params) {
        const p = params as Record<string, unknown>;
        const reportType = (p.reportType as string) ?? "daily";
        const target = p.target as string | undefined;

        switch (reportType) {
          case "daily": {
            const date = target ?? new Date().toISOString().split("T")[0];
            const logs = logger.readLogs(date);
            return {
              content: [{ type: "text", text: formatDailyReport(date, logs) }],
              details: { date, totalLogs: logs.length },
            };
          }

          case "model": {
            if (!target) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: target model name is required.",
                  },
                ],
                details: null,
              };
            }
            const modelStat = stats.getModelStats(target);
            if (!modelStat) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No data found for model: ${target}`,
                  },
                ],
                details: null,
              };
            }
            return {
              content: [{ type: "text", text: formatModelStats(modelStat) }],
              details: modelStat,
            };
          }

          case "recovery": {
            const tasks = taskRecovery.getAllTasks();
            const failed = tasks.filter((t) => t.status === "failed");
            const recovering = tasks.filter((t) => t.status === "recovering");

            let output = "## Task Recovery Status\n\n";
            output += `- Total tasks: ${tasks.length}\n`;
            output += `- Failed (recoverable): ${failed.length}\n`;
            output += `- Currently recovering: ${recovering.length}\n\n`;

            if (failed.length > 0) {
              output += "### Failed Tasks\n\n";
              for (const t of failed) {
                output += `- **${t.taskKey}**: ${t.error?.category ?? "unknown"} (attempt ${t.retryCount})\n`;
              }
            }

            return {
              content: [{ type: "text", text: output }],
              details: { tasks, failed, recovering },
            };
          }

          case "full": {
            const todayStats = stats.getTodaySummary();
            const allModels = stats.getAllModelStats();
            const strategies = retryEngine.getStrategies();
            const failedTasks = taskRecovery.getRecoverableTasks();
            const activeRetries = retryEngine.getActiveRetries();

            let output = "## Resilience Full Report\n\n";
            output += `**Generated:** ${new Date().toISOString()}\n\n`;

            output += "### Today's Summary\n\n";
            if (todayStats) {
              output += formatTimeStats(todayStats, "Today");
            } else {
              output += "No data yet.\n";
            }

            output += "\n### Active Retries\n\n";
            if (activeRetries.size > 0) {
              for (const [key, state] of activeRetries) {
                output += `- **${key}**: attempt ${state.attempt}, next retry at ${state.nextRetryAt}\n`;
              }
            } else {
              output += "No active retries.\n";
            }

            output += "\n### Failed Tasks\n\n";
            if (failedTasks.length > 0) {
              for (const t of failedTasks) {
                output += `- **${t.taskKey}**: ${t.error?.category ?? "unknown"} (attempts: ${t.retryCount})\n`;
              }
            } else {
              output += "No failed tasks.\n";
            }

            output += `\n### Configured Strategies (${strategies.length})\n\n`;
            for (const s of strategies) {
              output += `- ${s.name} (${s.type}, max ${s.maxRetries} retries)\n`;
            }

            return {
              content: [{ type: "text", text: output }],
              details: {
                today: todayStats,
                models: allModels,
                strategies,
                failedTasks,
                activeRetries: Object.fromEntries(activeRetries),
              },
            };
          }

          default:
            return {
              content: [
                { type: "text", text: `Unknown report type: ${reportType}` },
              ],
              details: null,
            };
        }
      },
    });

    // ─── Hooks ────────────────────────────────────────────────────────
    //
    // The registerHook API uses InternalHookHandler:
    //   (event: InternalHookEvent) => Promise<void> | void
    //
    // InternalHookEvent has: type, action, sessionKey, context, timestamp, messages
    // Hooks receive (event, ctx) per OpenClaw SDK.
    // event has the hook-specific fields; ctx has agent/session metadata.

    /**
     * Hook: model_call_ended
     * Observe every API call result and record it.
     */
    api.on("model_call_ended", async (event, ctx) => {
      const durationMs = event.durationMs ?? 0;
      const provider = event.provider;
      const model = event.model;
      const outcome = event.outcome;
      const errorCategory = event.errorCategory;
      const failureKind = event.failureKind;
      const sessionId = ctx.sessionId;
      const runId = event.runId;

      // Build an error object if the call failed
      let errorObj: unknown = undefined;
      if (outcome === "error") {
        errorObj = new Error(errorCategory ?? failureKind ?? "unknown error");
      }

      const classified = processCallResult({
        provider,
        model,
        error: errorObj,
        durationMs,
        sessionId,
        runId,
      });

      // If error is retryable, check retry strategy
      if (classified?.retryable) {
        const opKey = `${ctx.sessionKey ?? "unknown"}-${runId ?? "unknown"}-${Date.now()}`;
        const retryResult = retryEngine.shouldRetry(opKey, classified);
        if (retryResult.retry) {
          api.logger.info(
            `[resilience] Scheduling retry #${retryResult.attempt} for ${classified.category} in ${formatMs(retryResult.delayMs)}`
          );
        }
      }
    });

    /**
     * Hook: agent_end
     * Check for interrupted tasks that might need recovery.
     */
    api.on("agent_end", async (event, ctx) => {
      const success = event.success;
      const runId = event.runId;

      if (success === false) {
        api.logger.info(
          `[resilience] Agent ended with error (session: ${ctx.sessionKey}, run: ${runId})`
        );

        // Check for recoverable tasks in this session
        if (ctx.sessionKey) {
          const failedTasks = taskRecovery.getRecoverableTasks();
          for (const task of failedTasks) {
            if (task.sessionKey === ctx.sessionKey) {
              api.logger.info(
                `[resilience] Found recoverable task: ${task.taskKey}`
              );
            }
          }
        }
      }
    });

    /**
     * Hook: gateway_start
     * Initialize on gateway startup.
     */
    api.on("gateway_start", async () => {
      // Cleanup old data
      logger.cleanup(pluginConfig.statsRetentionDays ?? 90);
      stats.cleanup(7);
      taskRecovery.cleanup(7 * 24 * 60 * 60 * 1000);
      api.logger.info("[resilience] Plugin started, data cleaned up");
    });

    /**
     * Hook: gateway_stop
     * Flush and cleanup on gateway shutdown.
     */
    api.on("gateway_stop", async () => {
      logger.destroy();
      api.logger.info("[resilience] Plugin stopped, logs flushed");
    });

    api.logger.info("[resilience] Plugin registered successfully");
  },
});
