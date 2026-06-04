/**
 * Smoke-test dashboard server APIs without full OpenClaw gateway.
 */
import { StatsCollector } from "../dist/stats-collector.js";
import { RetryEngine } from "../dist/retry-engine.js";
import { ResilienceLogger } from "../dist/logger.js";
import { TaskRecovery } from "../dist/task-recovery.js";
import { DashboardServer } from "../dist/dashboard-server.js";

const port = 18766;
const logger = new ResilienceLogger();
const server = new DashboardServer(
  {
    stats: new StatsCollector(),
    retryEngine: new RetryEngine(),
    logger,
    taskRecovery: new TaskRecovery(),
  },
  port
);

await server.start();
const base = `http://127.0.0.1:${port}`;

const checks = [
  ["/", 200],
  ["/styles.css", 200],
  ["/app.js", 200],
  ["/api/overview", 200],
  ["/api/models", 200],
  ["/api/strategies", 200],
];

for (const [path, expect] of checks) {
  const res = await fetch(base + path);
  if (res.status !== expect) {
    throw new Error(`${path} expected ${expect}, got ${res.status}`);
  }
  console.log(`OK ${path}`);
}

const def = await fetch(base + "/api/strategies/default", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "rate-limit-fixed" }),
});
if (!def.ok) throw new Error("POST default failed");
console.log("OK POST /api/strategies/default");

await server.stop();
logger.destroy();
console.log("Dashboard verification passed.");
process.exit(0);