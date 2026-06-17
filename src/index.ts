/**
 * OpenClaw Resilience Plugin — Entry Point
 *
 * Registers tools and hooks for LLM API error tracking, classification,
 * retry management, and task recovery.
 *
 * Uses the official OpenClaw Plugin SDK (2026.5.18).
 */

import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import open from "open";
import {
  classifyError,
  classifySessionError,
  categoryLabel,
} from "./error-classifier.js";
import {
  bootstrapResilience,
  getRuntime,
  requireRuntime,
  runGatewayStartup,
  shutdownResilience,
} from "./bootstrap.js";
import type {
  LogEntry,
  ErrorCategory,
  ClassifiedError,
} from "./types.js";

/**
 * Open URL in the user's default browser.
 * Uses the 'open' package (safer, cross-platform, well-audited) instead of raw
 * child_process.exec. This helps with ClawHub security scans by avoiding
 * direct shell command execution for a common, benign operation (opening the
 * local monitoring dashboard).
 */
async function openInBrowser(url: string): Promise<void> {
  try {
    // wait: false so we don't block on the browser process
    await open(url, { wait: false });
  } catch (err) {
    // Non-fatal: user can copy the URL manually from the tool response
    console.warn("[resilience] Could not auto-open browser for", url, err);
  }
}

async function ensureDashboardRunning() {
  const rt = getRuntime();
  const cfg = rt?.pluginConfig ?? {};
  const sources = { pluginConfig: cfg };
  await bootstrapResilience(sources, { startDashboard: true });
  const dash = requireRuntime().dashboardServer;
  if (!dash?.isRunning()) {
    throw new Error("[resilience] Dashboard failed to start");
  }
  return dash;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const sessionRecoveryState = new Map<
  string,
  { lastInjectedAt: number; count: number }
>();

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

function formatRecoverySettings(settings: {
  enabled: boolean;
  language: string;
  prompt?: string;
  promptZh?: string;
  promptEn?: string;
  ttlMs: number;
  cooldownMs: number;
  maxPerSession: number;
}): string {
  const prompt =
    settings.prompt ??
    (settings.language === "en" ? settings.promptEn : settings.promptZh) ??
    "(built-in default)";

  return [
    "## Session Recovery Settings",
    "",
    `- Enabled: ${settings.enabled}`,
    `- Language: ${settings.language}`,
    `- TTL: ${formatMs(settings.ttlMs)}`,
    `- Cooldown: ${formatMs(settings.cooldownMs)}`,
    `- Max per session: ${settings.maxPerSession}`,
    "",
    "### Prompt",
    "",
    prompt,
  ].join("\n");
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
  const rt = getRuntime();
  if (!rt) return null;

  const { provider, model, error, httpStatus, durationMs, sessionId, runId } =
    params;
  const { logger, stats, retryEngine, instancePaths } = rt;

  if (error) {
    const classified = classifyError(error, { provider, model, httpStatus });

    logger.logError({
      timestamp: new Date().toISOString(),
      instanceId: instancePaths.id,
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
    instanceId: instancePaths.id,
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

function recordSessionError(params: {
  error: unknown;
  durationMs: number;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  provider?: string;
  model?: string;
}): ClassifiedError | null {
  const rt = getRuntime();
  if (!rt) return null;

  const classified = classifySessionError(params.error, {
    provider: params.provider,
    model: params.model,
  });
  const timestamp = new Date().toISOString();

  const entry: Omit<LogEntry, "errorType"> & { errorType: ErrorCategory } = {
    timestamp,
    instanceId: rt.instancePaths.id,
    provider: params.provider,
    model: params.model,
    errorType: classified.category,
    errorMessage: classified.rawError,
    durationMs: params.durationMs,
    sessionId: params.sessionId ?? params.sessionKey,
    runId: params.runId,
  };

  rt.logger.logError(entry);
  rt.stats.record(entry);

  if (params.sessionKey) {
    const taskKey = `session-recovery-${params.sessionKey}-${params.runId ?? Date.now()}`;
    const existing = rt.taskRecovery.getTask(taskKey);
    const task =
      existing ??
      rt.taskRecovery.createTask(taskKey, params.sessionKey, {
        source: "agent_end",
        runId: params.runId,
      });
    if (task.status === "pending") {
      rt.taskRecovery.startTask(taskKey);
    }
    rt.taskRecovery.failTask(taskKey, classified, "agent_end");
  }

  return classified;
}

async function enqueueSessionRecovery(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  runId?: string;
  error: ClassifiedError;
}): Promise<boolean> {
  const rt = getRuntime();
  if (!rt) return false;

  const settings = rt.recoverySettings.get();
  if (!settings.enabled || settings.maxPerSession <= 0) return false;

  const now = Date.now();
  const current = sessionRecoveryState.get(params.sessionKey) ?? {
    lastInjectedAt: 0,
    count: 0,
  };

  if (current.count >= settings.maxPerSession) return false;
  if (
    settings.cooldownMs > 0 &&
    now - current.lastInjectedAt < settings.cooldownMs
  ) {
    return false;
  }

  const result = await params.api.session.workflow.enqueueNextTurnInjection({
    sessionKey: params.sessionKey,
    text: rt.recoverySettings.renderPrompt(params.error),
    placement: "prepend_context",
    ttlMs: settings.ttlMs,
    idempotencyKey: `resilience-recovery-${params.runId ?? now}`,
    metadata: {
      source: "resilience",
      kind: "session_recovery",
      errorCategory: params.error.category,
      ...(params.runId ? { runId: params.runId } : {}),
    },
  });

  if (result.enqueued) {
    sessionRecoveryState.set(params.sessionKey, {
      lastInjectedAt: now,
      count: current.count + 1,
    });
  }
  return result.enqueued;
}

// ─── Plugin Definition ─────────────────────────────────────────────────────

export default definePluginEntry({
  id: "resilience",
  name: "Resilience",
  description:
    "LLM API error tracking, classification, retry, and task recovery",

  register(api) {
    // Config: api.pluginConfig + plugins.entries.resilience.config from api.config
    void bootstrapResilience(
      {
        pluginConfig: api.pluginConfig,
        openClawConfig: api.config,
      },
      { logger: api.logger }
    ).catch((err) => {
      api.logger.warn(`[resilience] Register bootstrap failed: ${err}`);
    });

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
        const { stats } = requireRuntime();
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
        const { retryEngine } = requireRuntime();
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

    // ─── Tool: resilience_dashboard ─────────────────────────────────

    api.registerTool({
      name: "resilience_dashboard",
      label: "Resilience Dashboard",
      description:
        "Open or manage the Resilience web dashboard for live error stats " +
        "and retry strategy selection. Use when the user asks to open the " +
        "monitoring page or view stats in a browser.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.String({
            description: '"open" (default) — start server and open browser; "status"; "stop"',
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const action =
          ((params as Record<string, unknown>).action as string) ?? "open";

        switch (action) {
          case "open": {
            const dash = await ensureDashboardRunning();
            const url = dash.getUrl();
            await openInBrowser(url);
            return {
              content: [
                {
                  type: "text",
                  text: `已打开 Resilience 监控面板：${url}\n可在页面中选择自动刷新间隔（5s / 60s / 5min / 1h）并管理重试策略。`,
                },
              ],
              details: { url, running: true },
            };
          }
          case "status": {
            const rt = getRuntime();
            const port = rt?.pluginConfig.dashboardPort ?? 18765;
            const running = rt?.dashboardServer?.isRunning() ?? false;
            const url = `http://127.0.0.1:${port}/`;
            return {
              content: [
                {
                  type: "text",
                  text: running
                    ? `监控面板运行中：${url}`
                    : "监控面板未启动。可说「打开错误统计页面」启动。",
                },
              ],
              details: { url, running },
            };
          }
          case "stop": {
            const dash = getRuntime()?.dashboardServer;
            if (dash?.isRunning()) {
              await dash.stop();
            }
            return {
              content: [{ type: "text", text: "监控面板已停止。" }],
              details: { running: false },
            };
          }
          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${action}` }],
              details: null,
            };
        }
      },
    });

    // ─── Tool: resilience_recovery ──────────────────────────────────

    api.registerTool({
      name: "resilience_recovery",
      label: "Resilience Recovery",
      description:
        "View or update automatic session recovery settings, including " +
        "whether failed sessions receive a next-turn recovery instruction, " +
        "the prompt language, and custom continuation wording.",
      parameters: Type.Object({
        action: Type.Optional(
          Type.String({
            description: 'Action: "show" (default), "update", or "reset"',
          })
        ),
        enabled: Type.Optional(
          Type.Boolean({ description: "Enable automatic session recovery" })
        ),
        language: Type.Optional(
          Type.String({ description: 'Recovery prompt language: "zh" or "en"' })
        ),
        prompt: Type.Optional(
          Type.String({
            description:
              "Custom recovery prompt overriding localized built-in prompts",
          })
        ),
        promptZh: Type.Optional(
          Type.String({ description: "Custom Chinese recovery prompt" })
        ),
        promptEn: Type.Optional(
          Type.String({ description: "Custom English recovery prompt" })
        ),
        ttlMs: Type.Optional(
          Type.Number({ description: "Queued recovery context TTL in ms" })
        ),
        cooldownMs: Type.Optional(
          Type.Number({
            description: "Minimum interval between injections per session in ms",
          })
        ),
        maxPerSession: Type.Optional(
          Type.Number({
            description: "Maximum automatic recovery injections per session",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const { recoverySettings } = requireRuntime();
        const p = params as Record<string, unknown>;
        const action = (p.action as string | undefined) ?? "show";

        switch (action) {
          case "show": {
            const settings = recoverySettings.get();
            return {
              content: [{ type: "text", text: formatRecoverySettings(settings) }],
              details: settings,
            };
          }

          case "update": {
            const settings = recoverySettings.update(p);
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Session recovery settings updated.\n\n" +
                    formatRecoverySettings(settings),
                },
              ],
              details: settings,
            };
          }

          case "reset": {
            const settings = recoverySettings.reset();
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Session recovery settings reset to plugin/config defaults.\n\n" +
                    formatRecoverySettings(settings),
                },
              ],
              details: settings,
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
        const { logger, stats, retryEngine, taskRecovery } = requireRuntime();
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
        const retryResult = getRuntime()!.retryEngine.shouldRetry(opKey, classified);
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
      const runId = event.runId ?? ctx.runId;

      if (success === false) {
        api.logger.info(
          `[resilience] Agent ended with error (session: ${ctx.sessionKey}, run: ${runId})`
        );

        const classified = recordSessionError({
          error: event.error ?? "agent ended without success",
          durationMs: event.durationMs ?? 0,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId,
          provider: ctx.modelProviderId,
          model: ctx.modelId,
        });

        // Check for recoverable tasks in this session
        if (ctx.sessionKey) {
          const failedTasks = getRuntime()?.taskRecovery.getRecoverableTasks() ?? [];
          for (const task of failedTasks) {
            if (task.sessionKey === ctx.sessionKey) {
              api.logger.info(
                `[resilience] Found recoverable task: ${task.taskKey}`
              );
            }
          }

          if (classified) {
            try {
              const enqueued = await enqueueSessionRecovery({
                api,
                sessionKey: ctx.sessionKey,
                runId,
                error: classified,
              });
              api.logger.info(
                enqueued
                  ? `[resilience] Queued session recovery instruction for ${ctx.sessionKey}`
                  : `[resilience] Session recovery instruction skipped for ${ctx.sessionKey}`
              );
            } catch (err) {
              api.logger.warn(
                `[resilience] Failed to queue session recovery instruction: ${err}`
              );
            }
          }
        }
      }
    });

    /**
     * Hook: gateway_start
     * Authoritative config from ctx.config (api.pluginConfig is not refreshed here).
     */
    api.on("gateway_start", async (event, ctx) => {
      const hookCtx = (event as { context?: { pluginConfig?: unknown } }).context;
      await runGatewayStartup(
        {
          pluginConfig: api.pluginConfig,
          openClawConfig: ctx.config ?? api.config,
          hookContextConfig: hookCtx?.pluginConfig,
          workspaceDir: ctx.workspaceDir,
        },
        api.logger
      );
    });

    /**
     * Hook: gateway_stop
     * Flush and cleanup on gateway shutdown.
     */
    api.on("gateway_stop", async () => {
      await shutdownResilience();
      api.logger.info("[resilience] Plugin stopped, logs flushed");
    });

    api.logger.info("[resilience] Plugin registered successfully");
  },
});
