/**
 * Logger
 *
 * Persistent JSONL logging for API call results.
 * Logs are stored per-date in ~/.openclaw/plugins/resilience/logs/YYYY-MM-DD.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LogEntry, ErrorCategory } from "./types.js";

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".openclaw", "plugins", "resilience", "logs");

/** Logger class for persisting API call logs */
export class ResilienceLogger {
  private logDir: string;
  private writeBuffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logDir?: string) {
    this.logDir = logDir ?? DEFAULT_LOG_DIR;
    this.ensureLogDir();
    // Flush buffer every 5 seconds
    this.flushTimer = setInterval(() => this.flush(), 5000);
    this.flushTimer.unref?.();
  }

  /**
   * Ensure the log directory exists.
   */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Log a successful API call.
   */
  logSuccess(entry: Omit<LogEntry, "errorType">): void {
    this.append({ ...entry, errorType: "success" });
  }

  /**
   * Log a failed API call.
   */
  logError(
    entry: Omit<LogEntry, "errorType"> & {
      errorType: ErrorCategory;
      errorMessage?: string;
      httpStatus?: number;
    }
  ): void {
    this.append(entry);
  }

  /**
   * Append a log entry to the buffer.
   */
  private append(entry: LogEntry): void {
    this.writeBuffer.push(entry);
    // Flush if buffer is large
    if (this.writeBuffer.length >= 50) {
      this.flush();
    }
  }

  /**
   * Flush buffered entries to disk.
   */
  flush(): void {
    if (this.writeBuffer.length === 0) return;

    const entries = this.writeBuffer.splice(0);
    const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const filePath = path.join(this.logDir, `${dateStr}.jsonl`);

    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(filePath, lines, "utf-8");
  }

  /**
   * Read logs for a specific date.
   */
  readLogs(dateStr: string): LogEntry[] {
    const filePath = path.join(this.logDir, `${dateStr}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LogEntry);
  }

  /**
   * Read logs for today.
   */
  readTodayLogs(): LogEntry[] {
    return this.readLogs(new Date().toISOString().split("T")[0]);
  }

  /**
   * Read logs for the past N days.
   */
  readRecentLogs(days: number): LogEntry[] {
    const logs: LogEntry[] = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      logs.push(...this.readLogs(dateStr));
    }
    return logs;
  }

  /**
   * Cleanup: remove log files older than retention days.
   */
  cleanup(retentionDays: number = 90): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        fs.unlinkSync(path.join(this.logDir, file));
      }
    }
  }

  /**
   * Destroy the logger, flushing any remaining entries.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
