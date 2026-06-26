/**
 * Resolve Resilience plugin config from OpenClaw plugin API and gateway hook context.
 *
 * Typed hooks (`api.on`) do not populate `api.pluginConfig` at `gateway_start`.
 * Use `ctx.config.plugins.entries.resilience.config` (and `ctx.workspaceDir`) there.
 */

import type { ResilienceConfig } from "./types.js";

export const PLUGIN_ID = "resilience";

type ConfigCarrier = {
  plugins?: {
    entries?: Record<
      string,
      { config?: Record<string, unknown>; enabled?: boolean } | undefined
    >;
  };
};

export type PluginConfigSources = {
  /** From `api.pluginConfig` at register time */
  pluginConfig?: unknown;
  /** From `api.config` or `ctx.config` (full OpenClaw config) */
  openClawConfig?: unknown;
  /** From legacy/internal hook wrapper `event.context.pluginConfig` */
  hookContextConfig?: unknown;
  /** Gateway hook `ctx.workspaceDir` */
  workspaceDir?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntryConfig(openClawConfig: unknown): Record<string, unknown> {
  if (!isRecord(openClawConfig)) return {};
  const entries = (openClawConfig as ConfigCarrier).plugins?.entries;
  const entry = entries?.[PLUGIN_ID];
  if (!isRecord(entry?.config)) return {};
  return entry.config;
}

function pickResilienceFields(raw: Record<string, unknown>): ResilienceConfig {
  const cfg: ResilienceConfig = {};
  if (typeof raw.logDir === "string" && raw.logDir.trim()) {
    cfg.logDir = raw.logDir.trim();
  }
  if (typeof raw.statsRetentionDays === "number" && Number.isFinite(raw.statsRetentionDays)) {
    cfg.statsRetentionDays = raw.statsRetentionDays;
  }
  if (
    raw.defaultStrategy === "fixed" ||
    raw.defaultStrategy === "exponential" ||
    raw.defaultStrategy === "custom"
  ) {
    cfg.defaultStrategy = raw.defaultStrategy;
  }
  if (typeof raw.dashboardEnabled === "boolean") {
    cfg.dashboardEnabled = raw.dashboardEnabled;
  }
  if (typeof raw.dashboardPort === "number" && Number.isFinite(raw.dashboardPort)) {
    cfg.dashboardPort = Math.floor(raw.dashboardPort);
  }
  if (typeof raw.instanceId === "string" && raw.instanceId.trim()) {
    cfg.instanceId = raw.instanceId.trim();
  }
  if (typeof raw.instanceLabel === "string" && raw.instanceLabel.trim()) {
    cfg.instanceLabel = raw.instanceLabel.trim();
  }
  if (typeof raw.workspacePath === "string" && raw.workspacePath.trim()) {
    cfg.workspacePath = raw.workspacePath.trim();
  }
  if (typeof raw.sessionRecoveryEnabled === "boolean") {
    cfg.sessionRecoveryEnabled = raw.sessionRecoveryEnabled;
  }
  if (raw.sessionRecoveryLanguage === "zh" || raw.sessionRecoveryLanguage === "en") {
    cfg.sessionRecoveryLanguage = raw.sessionRecoveryLanguage;
  }
  if (typeof raw.sessionRecoveryPrompt === "string" && raw.sessionRecoveryPrompt.trim()) {
    cfg.sessionRecoveryPrompt = raw.sessionRecoveryPrompt.trim();
  }
  if (typeof raw.sessionRecoveryPromptZh === "string" && raw.sessionRecoveryPromptZh.trim()) {
    cfg.sessionRecoveryPromptZh = raw.sessionRecoveryPromptZh.trim();
  }
  if (typeof raw.sessionRecoveryPromptEn === "string" && raw.sessionRecoveryPromptEn.trim()) {
    cfg.sessionRecoveryPromptEn = raw.sessionRecoveryPromptEn.trim();
  }
  if (typeof raw.sessionRecoveryTtlMs === "number" && Number.isFinite(raw.sessionRecoveryTtlMs)) {
    cfg.sessionRecoveryTtlMs = Math.max(0, Math.floor(raw.sessionRecoveryTtlMs));
  }
  if (
    typeof raw.sessionRecoveryCooldownMs === "number" &&
    Number.isFinite(raw.sessionRecoveryCooldownMs)
  ) {
    cfg.sessionRecoveryCooldownMs = Math.max(0, Math.floor(raw.sessionRecoveryCooldownMs));
  }
  if (
    typeof raw.sessionRecoveryMaxPerSession === "number" &&
    Number.isFinite(raw.sessionRecoveryMaxPerSession)
  ) {
    cfg.sessionRecoveryMaxPerSession = Math.max(0, Math.floor(raw.sessionRecoveryMaxPerSession));
  }
  return cfg;
}

/**
 * Merge plugin config from all known OpenClaw surfaces (later sources win).
 */
export function resolveResilienceConfig(
  sources: PluginConfigSources
): ResilienceConfig {
  const merged: Record<string, unknown> = {
    ...readEntryConfig(sources.openClawConfig),
    ...(isRecord(sources.pluginConfig) ? sources.pluginConfig : {}),
    ...(isRecord(sources.hookContextConfig) ? sources.hookContextConfig : {}),
  };

  const cfg = pickResilienceFields(merged);

  if (!cfg.workspacePath && sources.workspaceDir?.trim()) {
    cfg.workspacePath = sources.workspaceDir.trim();
  }

  return cfg;
}

export function configFingerprint(cfg: ResilienceConfig): string {
  return JSON.stringify(cfg);
}
