/**
 * Verify classification + retry scheduling for local/wrapped LLM APIs that
 * return HTTP 200 (or other misleading statuses) with error payloads in body.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyError,
  classifySessionError,
  classifySessionTaskError,
} from "../dist/error-classifier.js";
import plugin from "../dist/index.js";
import { getRuntime, shutdownResilience } from "../dist/bootstrap.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Unit: classifier ────────────────────────────────────────────────────────

const cases = [
  {
    name: "HTTP 200 + OpenAI-style server_error body",
    error: {
      status: 200,
      body: {
        error: { message: "The server had an error", type: "server_error" },
      },
    },
    httpStatus: 200,
    expectCategory: "wrapped_api_error",
    expectRetryable: true,
  },
  {
    name: "HTTP 200 + Chinese busy body",
    error: { status: 200, message: "系统繁忙，请稍后重试" },
    httpStatus: 200,
    expectCategory: "server_overload",
    expectRetryable: true,
  },
  {
    name: "HTTP 200 + success:false envelope",
    error: { success: false, error_msg: "上游失败", code: 0 },
    httpStatus: 200,
    expectCategory: "server_overload",
    expectRetryable: true,
  },
  {
    name: "HTTP 200 + embedded 429 in body text",
    error: 'HTTP 200 OK body: {"status":429,"message":"rate limit exceeded"}',
    httpStatus: 200,
    expectCategory: "rate_limit",
    expectRetryable: true,
  },
  {
    name: "OpenClaw native overloaded alias",
    error: "overloaded",
    expectCategory: "server_overload",
    expectRetryable: true,
  },
  {
    name: "OpenClaw failureKind connection_reset alias",
    error: "connection_reset",
    expectCategory: "network_error",
    expectRetryable: true,
  },
  {
    name: "Nested error object without status",
    error: {
      error: { message: "网关错误：上游繁忙", code: "server_error" },
    },
    expectCategory: "server_overload",
    expectRetryable: true,
  },
];

for (const c of cases) {
  const classified = classifyError(c.error, {
    httpStatus: c.httpStatus,
    provider: "local-wrapper",
    model: "local-model",
  });
  assert(
    classified.category === c.expectCategory,
    `${c.name}: expected category ${c.expectCategory}, got ${classified.category} (${classified.rawError})`
  );
  assert(
    classified.retryable === c.expectRetryable,
    `${c.name}: expected retryable=${c.expectRetryable}, got ${classified.retryable}`
  );
}

// Session path should keep API taxonomy for body errors
const sessionClassified = classifySessionError({
  status: 200,
  message: "系统繁忙，请稍后重试",
});
assert(
  sessionClassified.category === "server_overload" && sessionClassified.retryable,
  "classifySessionError should treat Chinese busy body as retryable server_overload"
);

const taskClassified = classifySessionTaskError({
  success: false,
  error_msg: "上游失败",
});
assert(
  taskClassified.retryable &&
    taskClassified.recoveryMode === "next_turn_injection",
  "classifySessionTaskError should allow next-turn recovery for wrapped body errors"
);

// ── Integration: hooks schedule retries ─────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resilience-body-"));
const handlers = new Map();
const injections = [];
const logs = [];

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
            logDir: path.join(tmp, "logs"),
            instanceId: "verify-body-error",
            instanceLabel: "Verify Body Error",
            dashboardEnabled: false,
            sessionRecoveryEnabled: true,
            sessionRecoveryCooldownMs: 0,
            sessionRecoveryMaxPerSession: 3,
          },
        },
      },
    },
  },
  pluginConfig: {},
  runtime: {},
  session: {
    workflow: {
      enqueueNextTurnInjection: async (injection) => {
        injections.push(injection);
        return { enqueued: true, id: injection.idempotencyKey };
      },
    },
  },
  agent: { events: {} },
  runContext: {},
  lifecycle: {},
  logger: {
    info: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
    debug: () => {},
  },
  registerTool: () => {},
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

try {
  plugin.register(api);
  await handlers.get("gateway_start")(
    {},
    { config: api.config, workspaceDir: tmp }
  );

  // Case A: model_call_ended with OpenClaw "overloaded" category (no HTTP)
  await handlers.get("model_call_ended")(
    {
      outcome: "error",
      errorCategory: "overloaded",
      durationMs: 100,
      runId: "run-body-1",
      provider: "local",
      model: "local-llm",
    },
    { sessionId: "s1", sessionKey: "sk-1" }
  );

  // Case B: agent_end only — body error text (wrapper returned 200; host
  // may not emit a clean model_call error category)
  await handlers.get("agent_end")(
    {
      success: false,
      error: {
        status: 200,
        body: {
          success: false,
          error_msg: "系统繁忙，请稍后重试",
        },
      },
      durationMs: 50,
      runId: "run-body-2",
    },
    {
      sessionId: "s2",
      sessionKey: "sk-2",
      runId: "run-body-2",
      modelProviderId: "local",
      modelId: "local-llm",
    }
  );

  const rt = getRuntime();
  assert(rt, "runtime missing");

  const active = rt.retryEngine.getActiveRetries();
  assert(
    active.size >= 2,
    `expected at least 2 active retries for body/alias errors, got ${active.size}`
  );

  const strategies = rt.retryEngine.getStrategies();
  assert(
    strategies.some((s) => s.retryOn.includes("wrapped_api_error")),
    "strategies should cover wrapped_api_error"
  );

  // agent_end body error should enqueue recovery
  assert(
    injections.length >= 1,
    `expected recovery injection for agent_end body error, got ${injections.length}`
  );

  // Stats should show retryable API categories, not only session_runtime_error
  const statsPath = path.join(
    os.homedir(),
    ".openclaw",
    "plugins",
    "resilience",
    "instances",
    "verify-body-error",
    "stats.json"
  );
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
  const model = stats.models["local-llm"];
  assert(model && model.failedCalls >= 2, "failed calls not recorded for local-llm");
  const byType = model.errorsByType ?? {};
  const retryableCount =
    (byType.server_overload ?? 0) +
    (byType.wrapped_api_error ?? 0) +
    (byType.rate_limit ?? 0) +
    (byType.network_error ?? 0) +
    (byType.timeout ?? 0);
  assert(
    retryableCount >= 2,
    `expected retryable categories in stats, got ${JSON.stringify(byType)}`
  );

  console.log("body-error classification verification OK");
  console.log(
    JSON.stringify(
      {
        activeRetries: active.size,
        injections: injections.length,
        errorsByType: byType,
        strategiesCoveringWrapped: strategies
          .filter((s) => s.retryOn.includes("wrapped_api_error"))
          .map((s) => s.name),
      },
      null,
      2
    )
  );
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
      "verify-body-error"
    ),
    { recursive: true, force: true }
  );
}
