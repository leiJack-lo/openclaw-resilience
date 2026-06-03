/**
 * Task Recovery
 *
 * Tracks recoverable tasks and provides save/restore capabilities
 * for interrupted operations. Tasks are persisted to disk for
 * crash recovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { RecoverableTask, TaskStatus, ClassifiedError } from "./types.js";

const DEFAULT_TASKS_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "plugins",
  "resilience",
  "tasks"
);

/** Task Recovery manager */
export class TaskRecovery {
  private tasksDir: string;
  private tasks: Map<string, RecoverableTask> = new Map();

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir ?? DEFAULT_TASKS_DIR;
    this.ensureDir();
    this.loadAll();
  }

  /**
   * Ensure the tasks directory exists.
   */
  private ensureDir(): void {
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  /**
   * Load all task files from disk.
   */
  private loadAll(): void {
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.tasksDir, file), "utf-8");
        const task = JSON.parse(content) as RecoverableTask;
        this.tasks.set(task.taskKey, task);
      } catch {
        // Skip corrupted files
      }
    }
  }

  /**
   * Save a single task to disk.
   */
  private saveTask(task: RecoverableTask): void {
    const filePath = path.join(this.tasksDir, `${this.sanitizeKey(task.taskKey)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
  }

  /**
   * Sanitize a task key for use as a filename.
   */
  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 128);
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /**
   * Create a new recoverable task.
   */
  createTask(
    taskKey: string,
    sessionKey: string,
    initialState: Record<string, unknown> = {}
  ): RecoverableTask {
    const now = new Date().toISOString();
    const task: RecoverableTask = {
      taskKey,
      sessionKey,
      status: "pending",
      lastState: initialState,
      completedSteps: [],
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
    };
    this.tasks.set(taskKey, task);
    this.saveTask(task);
    return task;
  }

  /**
   * Mark a task as in-progress.
   */
  startTask(taskKey: string): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    task.status = "in_progress";
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Record a completed step in a task.
   */
  completeStep(taskKey: string, stepName: string): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    if (!task.completedSteps.includes(stepName)) {
      task.completedSteps.push(stepName);
    }
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Update the last state of a task.
   */
  updateState(
    taskKey: string,
    state: Record<string, unknown>
  ): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    task.lastState = { ...task.lastState, ...state };
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Mark a task as failed (interrupted).
   */
  failTask(
    taskKey: string,
    error: ClassifiedError,
    failedStep?: string
  ): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    task.status = "failed";
    task.error = error;
    task.failedStep = failedStep;
    task.retryCount++;
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Mark a task as successfully completed.
   */
  completeTask(taskKey: string): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    task.status = "completed";
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Mark a task as recovering (in retry process).
   */
  setRecovering(taskKey: string): RecoverableTask | undefined {
    const task = this.tasks.get(taskKey);
    if (!task) return undefined;
    task.status = "recovering";
    task.updatedAt = new Date().toISOString();
    this.saveTask(task);
    return task;
  }

  /**
   * Get a specific task.
   */
  getTask(taskKey: string): RecoverableTask | undefined {
    return this.tasks.get(taskKey);
  }

  /**
   * Get all tasks with a given status.
   */
  getTasksByStatus(status: TaskStatus): RecoverableTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * Get all failed tasks that might need recovery.
   */
  getRecoverableTasks(): RecoverableTask[] {
    return this.getTasksByStatus("failed");
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): RecoverableTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Remove a completed or failed task.
   */
  removeTask(taskKey: string): boolean {
    const task = this.tasks.get(taskKey);
    if (!task) return false;
    this.tasks.delete(taskKey);
    const filePath = path.join(this.tasksDir, `${this.sanitizeKey(taskKey)}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  }

  /**
   * Cleanup old completed tasks.
   */
  cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [key, task] of this.tasks) {
      if (
        (task.status === "completed" || task.status === "failed") &&
        new Date(task.updatedAt).getTime() < cutoff
      ) {
        this.tasks.delete(key);
        const filePath = path.join(this.tasksDir, `${this.sanitizeKey(key)}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        removed++;
      }
    }
    return removed;
  }
}
