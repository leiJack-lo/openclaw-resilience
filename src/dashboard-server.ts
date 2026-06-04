/**
 * Resilience Dashboard HTTP Server
 *
 * Serves the skill/dashboard UI and JSON API for live stats & strategy management.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { categoryLabel } from "./error-classifier.js";
import type { StatsCollector } from "./stats-collector.js";
import type { RetryEngine } from "./retry-engine.js";
import type { ResilienceLogger } from "./logger.js";
import type { TaskRecovery } from "./task-recovery.js";
import type { ErrorCategory, RetryStrategy } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.join(__dirname, "..", "skill", "dashboard");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface DashboardServerDeps {
  stats: StatsCollector;
  retryEngine: RetryEngine;
  logger: ResilienceLogger;
  taskRecovery: TaskRecovery;
}

export class DashboardServer {
  private server: http.Server | null = null;
  private port: number;
  private deps: DashboardServerDeps;

  constructor(deps: DashboardServerDeps, port = 18765) {
    this.deps = deps;
    this.port = port;
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  start(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  stop(): Promise<void> {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const method = req.method ?? "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await this.handleApi(method, url, req, res);
      return;
    }

    this.serveStatic(url.pathname, res);
  }

  private async handleApi(
    method: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const { stats, retryEngine, logger, taskRecovery } = this.deps;

    if (method === "GET" && url.pathname === "/api/overview") {
      const today = stats.getTodaySummary();
      const hour = stats.getCurrentHourSummary();
      const week = stats.getWeekSummary();
      const activeRetries = Object.fromEntries(retryEngine.getActiveRetries());
      const failedTasks = taskRecovery.getRecoverableTasks().length;
      const recentErrors = logger
        .readTodayLogs()
        .filter((l) => l.errorType !== "success")
        .slice(-20)
        .reverse();

      this.json(res, {
        lastUpdated: stats.getRawData().lastUpdated,
        today,
        hour,
        week,
        activeRetries,
        failedTasks,
        recentErrors: recentErrors.map((e) => ({
          ...e,
          errorLabel: categoryLabel(e.errorType as ErrorCategory),
        })),
        dashboardUrl: this.getUrl(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/models") {
      this.json(res, { models: stats.getAllModelStats() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/strategies") {
      const strategies = retryEngine.getStrategies();
      const defaultStrategy =
        strategies.find((s) => s.isDefault)?.name ?? strategies[0]?.name ?? null;
      this.json(res, { strategies, defaultStrategy });
      return;
    }

    if (method === "PUT" && url.pathname.startsWith("/api/strategies/")) {
      const name = decodeURIComponent(url.pathname.replace("/api/strategies/", ""));
      const body = await this.readBody(req);
      const updates = JSON.parse(body || "{}") as Partial<RetryStrategy>;
      const ok = retryEngine.updateStrategy(name, updates);
      this.json(res, { ok, name });
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategies/default") {
      const body = await this.readBody(req);
      const { name } = JSON.parse(body || "{}") as { name?: string };
      if (!name) {
        this.json(res, { ok: false, error: "name required" }, 400);
        return;
      }
      const strategies = retryEngine.getStrategies();
      if (!strategies.some((s) => s.name === name)) {
        this.json(res, { ok: false, error: "strategy not found" }, 404);
        return;
      }
      for (const s of strategies) {
        retryEngine.updateStrategy(s.name, { isDefault: s.name === name });
      }
      this.json(res, { ok: true, defaultStrategy: name });
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategies/reset") {
      retryEngine.resetDefaults();
      this.json(res, { ok: true });
      return;
    }

    this.json(res, { error: "Not found" }, 404);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(DASHBOARD_ROOT, filePath);

    if (!full.startsWith(DASHBOARD_ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(full);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
}