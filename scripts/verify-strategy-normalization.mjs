import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "../dist/index.js";
import { getRuntime, shutdownResilience } from "../dist/bootstrap.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resilience-strategy-"));
const handlers = new Map();
const tools = new Map();

const api = {
  id: "resilience",
  name: "Resilience",
  source: path.join(process.cwd(), "dist/index.js"),
  rootDir: process.cwd(),
  registrationMode: "native",
  config: {
    plugins: {
      entries: {
        resilience: {
          enabled: true,
          config: {
            instanceId: "verify-strategy-normalization",
            instanceLabel: "Verify Strategy Normalization",
            dashboardEnabled: false,
          },
        },
      },
    },
  },
  pluginConfig: {},
  runtime: {},
  session: { workflow: {} },
  agent: { events: {} },
  runContext: {},
  lifecycle: {},
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  registerTool: (tool) => tools.set(tool.name, tool),
  registerHook: (events, handler) => {
    for (const event of Array.isArray(events) ? events : [events]) {
      handlers.set(event, handler);
    }
  },
  on(events, handler) {
    this.registerHook(events, handler);
  },
  registerHttpRoute: () => {},
  registerHostedMediaResolver: () => {},
  registerChannel: () => {},
  registerGatewayMethod: () => {},
  registerCli: () => {},
  registerNodeCliFeature: () => {},
  registerReload: () => {},
};

function assertNumberArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error(`${label} length mismatch: ${JSON.stringify(actual)}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i] || !Number.isFinite(actual[i])) {
      throw new Error(`${label}[${i}] expected ${expected[i]}, got ${actual[i]}`);
    }
  }
}

try {
  plugin.register(api);
  await handlers.get("gateway_start")(
    {},
    {
      config: api.config,
      workspaceDir: tmp,
    }
  );

  const tool = tools.get("resilience_strategies");
  if (!tool) throw new Error("resilience_strategies tool was not registered");

  const updateResult = await tool.execute("tool-1", {
    action: "update",
    strategyName: "default-exponential",
    updates: {
      maxRetries: "7",
      intervals: ["30s", "2m", "5分钟"],
      cooldownMs: "5秒",
    },
  });
  if (!updateResult.details?.ok) {
    throw new Error(`string-unit update failed: ${JSON.stringify(updateResult)}`);
  }

  let strategy = getRuntime()
    .retryEngine.getStrategies()
    .find((s) => s.name === "default-exponential");
  if (!strategy) throw new Error("default-exponential strategy missing");
  if (strategy.maxRetries !== 7) throw new Error("maxRetries was not normalized");
  assertNumberArray(strategy.intervals, [30_000, 120_000, 300_000], "intervals");
  if (strategy.cooldownMs !== 5_000) {
    throw new Error(`cooldownMs expected 5000, got ${strategy.cooldownMs}`);
  }

  const addResult = await tool.execute("tool-2", {
    action: "add",
    strategyName: "string-units",
    updates: {
      type: "custom",
      maxRetries: "3",
      intervals: "1m, 5分钟, 1h",
      cooldown: "10s",
      retryOn: "rate_limit, timeout",
      models: "mimo-v2.5, gpt-4o",
    },
  });
  if (!addResult.details?.name) {
    throw new Error(`string-unit add failed: ${JSON.stringify(addResult)}`);
  }

  strategy = getRuntime()
    .retryEngine.getStrategies()
    .find((s) => s.name === "string-units");
  if (!strategy) throw new Error("string-units strategy missing");
  assertNumberArray(strategy.intervals, [60_000, 300_000, 3_600_000], "added intervals");
  if (strategy.cooldownMs !== 10_000) {
    throw new Error(`added cooldownMs expected 10000, got ${strategy.cooldownMs}`);
  }
  if (strategy.retryOn.join(",") !== "rate_limit,timeout") {
    throw new Error(`retryOn was not normalized: ${strategy.retryOn}`);
  }

  const invalidResult = await tool.execute("tool-3", {
    action: "update",
    strategyName: "default-exponential",
    updates: { intervals: "later" },
  });
  const invalidText = invalidResult.content?.[0]?.text ?? "";
  if (!invalidText.includes("invalid strategy updates")) {
    throw new Error("invalid interval update did not return a validation error");
  }

  const raw = fs.readFileSync(getRuntime().instancePaths.strategiesPath, "utf-8");
  if (/\bNaN\b/.test(raw)) throw new Error("strategies file contains NaN");
  const saved = JSON.parse(raw);
  for (const item of saved) {
    for (const interval of item.intervals ?? []) {
      if (!Number.isFinite(interval)) {
        throw new Error(`non-finite interval persisted: ${JSON.stringify(item)}`);
      }
    }
    if (!Number.isFinite(item.cooldownMs)) {
      throw new Error(`non-finite cooldown persisted: ${JSON.stringify(item)}`);
    }
  }

  console.log("strategy normalization verification OK");
} finally {
  await shutdownResilience();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(
    path.join(
      os.homedir(),
      ".openclaw",
      "plugins",
      "resilience",
      "instances",
      "verify-strategy-normalization"
    ),
    { recursive: true, force: true }
  );
}
