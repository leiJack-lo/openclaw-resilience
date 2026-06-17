/**
 * Idempotent subsystem bootstrap from resolved plugin config.
 */

import { ResilienceLogger } from "./logger.js";
import { StatsCollector } from "./stats-collector.js";
import { RetryEngine } from "./retry-engine.js";
import { TaskRecovery } from "./task-recovery.js";
import { DashboardServer } from "./dashboard-server.js";
import { InstanceAggregator } from "./instance-aggregator.js";
import { RecoverySettings } from "./recovery-settings.js";
import {
  resolveInstanceContext,
  touchInstanceMeta,
  migrateLegacyToDefault,
} from "./instance-registry.js";
import type { InstancePaths } from "./instance-registry.js";
import {
  configFingerprint,
  resolveResilienceConfig,
  type PluginConfigSources,
} from "./plugin-config.js";
import type { ResilienceConfig } from "./types.js";

export interface ResilienceRuntime {
  pluginConfig: ResilienceConfig;
  instancePaths: InstancePaths;
  logger: ResilienceLogger;
  stats: StatsCollector;
  retryEngine: RetryEngine;
  taskRecovery: TaskRecovery;
  recoverySettings: RecoverySettings;
  instanceAggregator: InstanceAggregator;
  dashboardServer: DashboardServer | null;
}

let runtime: ResilienceRuntime | null = null;
let appliedFingerprint = "";

export function getRuntime(): ResilienceRuntime | null {
  return runtime;
}

export function requireRuntime(): ResilienceRuntime {
  if (!runtime) {
    throw new Error(
      "[resilience] Plugin not bootstrapped yet (wait for gateway_start or check plugins.entries.resilience.config)"
    );
  }
  return runtime;
}

async function stopDashboardIfNeeded(nextPort: number): Promise<void> {
  if (!runtime?.dashboardServer?.isRunning()) return;
  const currentUrl = runtime.dashboardServer.getUrl();
  const currentPort = Number(new URL(currentUrl).port);
  if (currentPort === nextPort) return;
  await runtime.dashboardServer.stop();
  runtime.dashboardServer = null;
}

/**
 * Apply config and (re)initialize collectors. Safe to call from register and gateway_start.
 */
export async function bootstrapResilience(
  sources: PluginConfigSources,
  options?: { startDashboard?: boolean; logger?: { info: (m: string) => void; warn: (m: string) => void } }
): Promise<ResilienceRuntime> {
  const cfg = resolveResilienceConfig(sources);
  const fp = configFingerprint(cfg);

  if (runtime && fp === appliedFingerprint) {
    return runtime;
  }

  appliedFingerprint = fp;

  const instancePaths = resolveInstanceContext(cfg);
  const logDir = cfg.logDir ?? instancePaths.logDir;

  const prevLogger = runtime?.logger;
  if (prevLogger) prevLogger.destroy();

  const logger = new ResilienceLogger(logDir);
  const stats = new StatsCollector(instancePaths.statsPath);
  const retryEngine = new RetryEngine(instancePaths.strategiesPath);
  const taskRecovery = new TaskRecovery(instancePaths.tasksDir);
  const recoverySettings = new RecoverySettings(
    instancePaths.recoverySettingsPath,
    cfg
  );
  const instanceAggregator = new InstanceAggregator(instancePaths);

  retryEngine.onActiveRetriesChanged = (states) => {
    instanceAggregator.persistActiveRetries(states);
  };

  touchInstanceMeta(instancePaths, {
    workspacePath: cfg.workspacePath,
  });

  runtime = {
    pluginConfig: cfg,
    instancePaths,
    logger,
    stats,
    retryEngine,
    taskRecovery,
    recoverySettings,
    instanceAggregator,
    dashboardServer: runtime?.dashboardServer ?? null,
  };

  options?.logger?.info(
    `[resilience] Bootstrapped instance "${instancePaths.label}" (${instancePaths.id})`
  );

  if (options?.startDashboard && cfg.dashboardEnabled !== false) {
    const port = cfg.dashboardPort ?? 18765;
    await stopDashboardIfNeeded(port);
    if (!runtime.dashboardServer) {
      runtime.dashboardServer = new DashboardServer(instanceAggregator, port);
    }
    if (!runtime.dashboardServer.isRunning()) {
      try {
        await runtime.dashboardServer.start();
        options?.logger?.info(
          `[resilience] Dashboard at ${runtime.dashboardServer.getUrl()}`
        );
      } catch (err) {
        options?.logger?.warn(`[resilience] Dashboard failed to start: ${err}`);
      }
    }
  }

  return runtime;
}

export async function runGatewayStartup(
  sources: PluginConfigSources,
  logger?: { info: (m: string) => void; warn: (m: string) => void }
): Promise<void> {
  migrateLegacyToDefault();
  const rt = await bootstrapResilience(sources, {
    startDashboard: true,
    logger,
  });

  rt.logger.cleanup(rt.pluginConfig.statsRetentionDays ?? 90);
  rt.stats.cleanup(7);
  rt.taskRecovery.cleanup(7 * 24 * 60 * 60 * 1000);
  logger?.info("[resilience] Gateway startup complete");
}

export async function shutdownResilience(): Promise<void> {
  if (runtime?.dashboardServer?.isRunning()) {
    await runtime.dashboardServer.stop();
  }
  runtime?.logger.destroy();
  runtime = null;
  appliedFingerprint = "";
}
