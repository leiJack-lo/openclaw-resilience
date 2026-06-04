/**
 * Smoke-test dashboard server APIs (multi-instance).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StatsCollector } from "../dist/stats-collector.js";
import { InstanceAggregator } from "../dist/instance-aggregator.js";
import { DashboardServer } from "../dist/dashboard-server.js";
import { getInstancePaths, INSTANCES_DIR } from "../dist/instance-registry.js";

const port = 18766;

// Seed two fake instances
const a = getInstancePaths("test-instance-a", "Agent A");
const b = getInstancePaths("test-instance-b", "Agent B");
for (const p of [a, b]) {
  fs.mkdirSync(p.logDir, { recursive: true });
  const stats = new StatsCollector(p.statsPath);
  stats.record({
    timestamp: new Date().toISOString(),
    model: "test-model",
    errorType: "rate_limit",
    errorMessage: "429",
    durationMs: 100,
  });
  fs.writeFileSync(
    p.metaPath,
    JSON.stringify({
      id: p.id,
      label: p.label,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }),
    "utf-8"
  );
}

const local = a;
const aggregator = new InstanceAggregator(local);
const server = new DashboardServer(aggregator, port);

await server.start();
const base = `http://127.0.0.1:${port}`;

const checks = [
  ["/", 200],
  ["/api/instances", 200],
  ["/api/overview", 200],
  ["/api/overview?instance=all", 200],
  ["/api/overview?instance=test-instance-a", 200],
  ["/api/models?instance=all", 200],
  ["/api/strategies?instance=test-instance-a", 200],
];

for (const [path, expect] of checks) {
  const res = await fetch(base + path);
  if (res.status !== expect) {
    throw new Error(`${path} expected ${expect}, got ${res.status}`);
  }
  console.log(`OK ${path}`);
}

const inst = await fetch(base + "/api/instances").then((r) => r.json());
if ((inst.instances?.length ?? 0) < 2) {
  throw new Error("expected at least 2 instances in registry");
}
console.log(`OK instances count: ${inst.instances.length}`);

const overview = await fetch(base + "/api/overview?instance=all").then((r) =>
  r.json()
);
if (!overview.today?.totalCalls) {
  throw new Error("aggregated overview missing today stats");
}
console.log("OK aggregated overview");

await server.stop();

// cleanup test dirs
for (const id of ["test-instance-a", "test-instance-b"]) {
  const dir = path.join(INSTANCES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

console.log("Multi-instance dashboard verification passed.");
process.exit(0);