/**
 * Resilience Dashboard HTTP Server
 *
 * Serves the skill/dashboard UI and JSON API for live stats & strategy management.
 * Supports multi-instance aggregation via ?instance=all|<id>.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceAggregator } from "./instance-aggregator.js";
import type { RetryStrategy } from "./types.js";

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

export class DashboardServer {
  private server: http.Server | null = null;
  private port: number;
  private aggregator: InstanceAggregator;

  constructor(aggregator: InstanceAggregator, port = 18765) {
    this.aggregator = aggregator;
    this.port = port;
  }

  getUrl(instance?: string): string {
    const q = instance && instance !== "all" ? `?instance=${encodeURIComponent(instance)}` : "";
    return `http://127.0.0.1:${this.port}/${q}`;
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

  private instanceParam(url: URL): string | undefined {
    return url.searchParams.get("instance") ?? undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const method = req.method ?? "GET";

    // Security hardening for local dashboard (to reduce ClawHub scan risk):
    // - Bind is already to 127.0.0.1 only.
    // - Add standard security headers.
    // - Restrict CORS to same-origin / null (no wildcard) since it's a local-only tool.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';");

    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "null");
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
    const instance = this.instanceParam(url);
    const agg = this.aggregator;

    if (method === "GET" && url.pathname === "/api/instances") {
      this.json(res, {
        instances: agg.listInstances().map((i) => ({
          id: i.id,
          label: i.label,
          hasStats: i.hasStats,
          isLegacy: i.isLegacy,
          lastSeenAt: i.lastSeenAt,
          workspacePath: i.workspacePath,
        })),
        localInstanceId: agg.localInstanceId,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/overview") {
      const overview = agg.getOverview(instance ?? "all");
      this.json(res, { ...overview, dashboardUrl: this.getUrl(instance ?? "all") });
      return;
    }

    if (method === "GET" && url.pathname === "/api/models") {
      this.json(res, { models: agg.getModels(instance ?? "all"), instance: instance ?? "all" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/strategies") {
      const targetInstance = instance ?? agg.localInstanceId;
      const data = agg.getStrategiesForEdit(targetInstance);
      this.json(res, data);
      return;
    }

    if (method === "PUT" && url.pathname.startsWith("/api/strategies/")) {
      const targetInstance = instance ?? agg.localInstanceId;
      const edit = agg.getStrategiesForEdit(targetInstance);
      if (!edit.editable) {
        this.json(res, { ok: false, error: "只读：请选择本机实例或在本 Gateway 上修改" }, 403);
        return;
      }
      const name = decodeURIComponent(url.pathname.replace("/api/strategies/", ""));
      const body = await this.readBody(req);
      const updates = JSON.parse(body || "{}") as Partial<RetryStrategy>;
      const engine = agg.getLocalRetryEngine();
      if (targetInstance !== agg.localInstanceId) {
        this.json(res, { ok: false, error: "只能修改当前 Gateway 实例的策略" }, 403);
        return;
      }
      const ok = engine.updateStrategy(name, updates);
      this.json(res, { ok, name, instanceId: agg.localInstanceId });
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategies/default") {
      const targetInstance = instance ?? agg.localInstanceId;
      const edit = agg.getStrategiesForEdit(targetInstance);
      if (!edit.editable) {
        this.json(res, { ok: false, error: "只读实例" }, 403);
        return;
      }
      const body = await this.readBody(req);
      const { name } = JSON.parse(body || "{}") as { name?: string };
      if (!name) {
        this.json(res, { ok: false, error: "name required" }, 400);
        return;
      }
      const engine = agg.getLocalRetryEngine();
      const strategies = engine.getStrategies();
      if (!strategies.some((s) => s.name === name)) {
        this.json(res, { ok: false, error: "strategy not found" }, 404);
        return;
      }
      for (const s of strategies) {
        engine.updateStrategy(s.name, { isDefault: s.name === name });
      }
      this.json(res, { ok: true, defaultStrategy: name, instanceId: agg.localInstanceId });
      return;
    }

    if (method === "POST" && url.pathname === "/api/strategies/reset") {
      if ((instance ?? agg.localInstanceId) !== agg.localInstanceId) {
        this.json(res, { ok: false, error: "只能重置当前实例" }, 403);
        return;
      }
      agg.getLocalRetryEngine().resetDefaults();
      this.json(res, { ok: true, instanceId: agg.localInstanceId });
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