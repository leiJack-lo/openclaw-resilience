/**
 * Persistent queue for agent/session/tool recovery records.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  classifySessionTaskError,
  sessionCategoryLabel,
} from "./error-classifier.js";
import type {
  SessionErrorCategory,
  SessionRecoveryMode,
  SessionRetryRecord,
  SessionRetryStatus,
  SessionRetrySummary,
} from "./types.js";

const TERMINAL_STATUSES = new Set<SessionRetryStatus>([
  "recovered",
  "failed",
  "manual_required",
  "skipped",
]);

function emptyStatusCounts(): Record<SessionRetryStatus, number> {
  return {
    queued: 0,
    injected: 0,
    retrying: 0,
    recovered: 0,
    failed: 0,
    manual_required: 0,
    skipped: 0,
  };
}

function emptyCategoryCounts(): Record<SessionErrorCategory, number> {
  return {
    prompt_aborted: 0,
    tool_execution_failed: 0,
    shell_parse_error: 0,
    session_takeover: 0,
    task_timeout: 0,
    browser_workflow_failed: 0,
    permission_denied: 0,
    config_error: 0,
    external_side_effect_risk: 0,
    unknown_session_error: 0,
  };
}

function emptyModeCounts(): Record<SessionRecoveryMode, number> {
  return {
    next_turn_injection: 0,
    rerun_task: 0,
    manual: 0,
  };
}

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function parseRecords(raw: unknown): SessionRetryRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is SessionRetryRecord =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as SessionRetryRecord).id === "string" &&
      typeof (item as SessionRetryRecord).category === "string"
  );
}

export class SessionRetryStore {
  constructor(
    private readonly filePath: string,
    private readonly instance?: { id?: string; label?: string }
  ) {}

  list(limit = 100): SessionRetryRecord[] {
    return this.load()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  recordFailure(params: {
    source: SessionRetryRecord["source"];
    error: unknown;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    taskId?: string;
    cronJobId?: string;
    toolName?: string;
    maxAttempts?: number;
  }): SessionRetryRecord {
    const classified = classifySessionTaskError(params.error);
    const now = new Date().toISOString();
    const maxAttempts = params.maxAttempts ?? 3;
    const fingerprint = shortHash(
      [
        params.source,
        params.sessionKey,
        params.runId,
        params.taskId,
        params.cronJobId,
        params.toolName,
        classified.category,
        normalizeMessage(classified.rawError),
      ]
        .filter(Boolean)
        .join("|")
    );

    const records = this.load();
    const existing = records.find(
      (r) => r.fingerprint === fingerprint && !TERMINAL_STATUSES.has(r.status)
    );

    if (existing) {
      existing.attempt += 1;
      existing.updatedAt = now;
      existing.errorMessage = classified.rawError;
      existing.retryable = classified.retryable && existing.attempt <= maxAttempts;
      existing.maxAttempts = maxAttempts;
      existing.status = existing.retryable ? "queued" : "manual_required";
      existing.recoveryMode = classified.recoveryMode;
      existing.nextRetryAt = this.nextRetryAt(existing.attempt, classified.retryable);
      this.save(records);
      return existing;
    }

    const retryable = classified.retryable && maxAttempts > 0;
    const record: SessionRetryRecord = {
      id: `session-retry-${Date.now()}-${shortHash(fingerprint)}`,
      source: params.source,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      taskId: params.taskId,
      cronJobId: params.cronJobId,
      toolName: params.toolName,
      category: classified.category,
      errorMessage: classified.rawError,
      fingerprint,
      retryable,
      attempt: 1,
      maxAttempts,
      nextRetryAt: this.nextRetryAt(1, retryable),
      status: retryable ? "queued" : "manual_required",
      recoveryMode: classified.recoveryMode,
      instanceId: this.instance?.id,
      instanceLabel: this.instance?.label,
      createdAt: now,
      updatedAt: now,
    };
    records.push(record);
    this.save(records);
    return record;
  }

  markInjected(id: string): SessionRetryRecord | null {
    return this.update(id, (record) => {
      record.status = "injected";
      record.updatedAt = new Date().toISOString();
    });
  }

  markSkipped(id: string): SessionRetryRecord | null {
    return this.update(id, (record) => {
      record.status = "skipped";
      record.updatedAt = new Date().toISOString();
    });
  }

  getSummary(records = this.load()): SessionRetrySummary {
    const byStatus = emptyStatusCounts();
    const byCategory = emptyCategoryCounts();
    const byMode = emptyModeCounts();
    let retryable = 0;

    for (const record of records) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
      byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
      byMode[record.recoveryMode] = (byMode[record.recoveryMode] ?? 0) + 1;
      if (record.retryable) retryable += 1;
    }

    return {
      total: records.length,
      retryable,
      byStatus,
      byCategory,
      byMode,
      pending: byStatus.queued + byStatus.retrying + byStatus.injected,
      manualRequired: byStatus.manual_required,
    };
  }

  formatRecord(record: SessionRetryRecord): string {
    const label = sessionCategoryLabel(record.category);
    const target = record.toolName ?? record.taskId ?? record.sessionKey ?? "session";
    return `- ${label}: ${target} · ${record.status} · attempt ${record.attempt}/${record.maxAttempts}`;
  }

  cleanup(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    const records = this.load().filter((record) => {
      if (!TERMINAL_STATUSES.has(record.status)) return true;
      return new Date(record.updatedAt).getTime() >= cutoff;
    });
    this.save(records);
  }

  private nextRetryAt(attempt: number, retryable: boolean): string | undefined {
    if (!retryable) return undefined;
    const delayMs = Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
    return new Date(Date.now() + delayMs).toISOString();
  }

  private update(
    id: string,
    mutate: (record: SessionRetryRecord) => void
  ): SessionRetryRecord | null {
    const records = this.load();
    const record = records.find((r) => r.id === id);
    if (!record) return null;
    mutate(record);
    this.save(records);
    return record;
  }

  private load(): SessionRetryRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return parseRecords(JSON.parse(fs.readFileSync(this.filePath, "utf-8")));
    } catch {
      return [];
    }
  }

  private save(records: SessionRetryRecord[]): void {
    const dir = path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }
}
