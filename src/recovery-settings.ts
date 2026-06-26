/**
 * Session recovery settings and prompt rendering.
 *
 * Settings are persisted per Resilience instance so skill/tool updates can take
 * effect without editing the main OpenClaw config file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassifiedError, ResilienceConfig } from "./types.js";

export type RecoveryLanguage = "zh" | "en";

export interface RecoverySettingsData {
  enabled: boolean;
  language: RecoveryLanguage;
  prompt?: string;
  promptZh?: string;
  promptEn?: string;
  ttlMs: number;
  cooldownMs: number;
  maxPerSession: number;
}

const DEFAULT_PROMPT_ZH =
  "刚才这轮会话因为运行时错误中断了。请先判断原任务是否已经完成；如果没有完成，请基于已有上下文继续完成任务。若需要恢复步骤，请简要说明你会从哪里接着做。";

const DEFAULT_PROMPT_EN =
  "The previous session turn was interrupted by a runtime error. First check whether the original task is already complete; if not, continue from the existing context and finish it. Briefly state where you are resuming if recovery steps are needed.";

const DEFAULT_SETTINGS: RecoverySettingsData = {
  enabled: true,
  language: "zh",
  ttlMs: 10 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
  maxPerSession: 3,
};

type RecoverySettingsUpdate = Partial<RecoverySettingsData>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickSettings(raw: Record<string, unknown>): RecoverySettingsUpdate {
  const out: RecoverySettingsUpdate = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (raw.language === "zh" || raw.language === "en") out.language = raw.language;
  if (typeof raw.prompt === "string") out.prompt = raw.prompt;
  if (typeof raw.promptZh === "string") out.promptZh = raw.promptZh;
  if (typeof raw.promptEn === "string") out.promptEn = raw.promptEn;
  if (typeof raw.ttlMs === "number" && Number.isFinite(raw.ttlMs)) {
    out.ttlMs = Math.max(0, Math.floor(raw.ttlMs));
  }
  if (typeof raw.cooldownMs === "number" && Number.isFinite(raw.cooldownMs)) {
    out.cooldownMs = Math.max(0, Math.floor(raw.cooldownMs));
  }
  if (typeof raw.maxPerSession === "number" && Number.isFinite(raw.maxPerSession)) {
    out.maxPerSession = Math.max(0, Math.floor(raw.maxPerSession));
  }
  return out;
}

function configToSettings(config: ResilienceConfig): RecoverySettingsUpdate {
  return pickSettings({
    enabled: config.sessionRecoveryEnabled,
    language: config.sessionRecoveryLanguage,
    prompt: config.sessionRecoveryPrompt,
    promptZh: config.sessionRecoveryPromptZh,
    promptEn: config.sessionRecoveryPromptEn,
    ttlMs: config.sessionRecoveryTtlMs,
    cooldownMs: config.sessionRecoveryCooldownMs,
    maxPerSession: config.sessionRecoveryMaxPerSession,
  });
}

export class RecoverySettings {
  private readonly settingsPath: string;
  private readonly configDefaults: RecoverySettingsUpdate;
  private persisted: RecoverySettingsUpdate = {};

  constructor(settingsPath: string, config: ResilienceConfig) {
    this.settingsPath = settingsPath;
    this.configDefaults = configToSettings(config);
    this.persisted = this.loadPersisted();
  }

  private loadPersisted(): RecoverySettingsUpdate {
    try {
      if (!fs.existsSync(this.settingsPath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
      return isRecord(parsed) ? pickSettings(parsed) : {};
    } catch {
      return {};
    }
  }

  private savePersisted(): void {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      this.settingsPath,
      JSON.stringify(this.persisted, null, 2),
      "utf-8"
    );
  }

  get(): RecoverySettingsData {
    return {
      ...DEFAULT_SETTINGS,
      ...this.configDefaults,
      ...this.persisted,
    };
  }

  update(updates: Record<string, unknown>): RecoverySettingsData {
    this.persisted = {
      ...this.persisted,
      ...pickSettings(updates),
    };
    this.savePersisted();
    return this.get();
  }

  reset(): RecoverySettingsData {
    this.persisted = {};
    if (fs.existsSync(this.settingsPath)) {
      fs.unlinkSync(this.settingsPath);
    }
    return this.get();
  }

  renderPrompt(error: ClassifiedError): string {
    const settings = this.get();
    const base =
      settings.prompt?.trim() ||
      (settings.language === "en"
        ? settings.promptEn?.trim() || DEFAULT_PROMPT_EN
        : settings.promptZh?.trim() || DEFAULT_PROMPT_ZH);

    const errorLine =
      settings.language === "en"
        ? `Detected error: ${error.category}. ${error.rawError}`
        : `检测到的错误：${error.category}。${error.rawError}`;

    return `${base}\n\n${errorLine}`;
  }
}

