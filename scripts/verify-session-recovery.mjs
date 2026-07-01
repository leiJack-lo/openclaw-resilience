import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plugin from "../dist/index.js";
import { getRuntime, shutdownResilience } from "../dist/bootstrap.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resilience-session-"));
const handlers = new Map();
const toolNames = [];
const injections = [];
const warnings = [];

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
            instanceId: "verify-session-recovery",
            instanceLabel: "Verify Session Recovery",
            dashboardEnabled: false,
            sessionRecoveryEnabled: true,
            sessionRecoveryCooldownMs: 0,
            sessionRecoveryMaxPerSession: 2,
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
    info: () => {},
    warn: (message) => warnings.push(String(message)),
    error: (message) => warnings.push(String(message)),
    debug: () => {},
  },
  registerTool: (tool) => toolNames.push(tool.name),
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
    {
      config: api.config,
      workspaceDir: tmp,
    }
  );

  const modelCallEvent = {
    outcome: "error",
    errorCategory: "rate_limit",
    durationMs: 250,
    runId: "model-run-1",
    provider: "xai",
    model: "grok-4.3",
    httpStatus: 429,
  };
  const modelCallContext = {
    sessionId: "session-id-1",
    sessionKey: "session-key-1",
  };
  await handlers.get("model_call_ended")(modelCallEvent, modelCallContext);
  await handlers.get("model_call_ended")(modelCallEvent, modelCallContext);

  await handlers.get("agent_end")(
    {
      success: false,
      error: "tokenizer token parse failure while reading model output",
      durationMs: 1234,
      runId: "run-1",
    },
    {
      sessionId: "session-id-1",
      sessionKey: "session-key-1",
      runId: "run-1",
      modelProviderId: "xai",
      modelId: "grok-4.3",
    }
  );

  await handlers.get("after_tool_call")(
    {
      toolName: "exec_command",
      toolCallId: "tool-call-1",
      runId: "run-2",
      result: {
        exitCode: 2,
        stderr: "zsh: parse error near `newline'",
      },
      durationMs: 20,
    },
    {
      sessionId: "session-id-1",
      sessionKey: "session-key-1",
      runId: "run-2",
      toolName: "exec_command",
      toolCallId: "tool-call-1",
    }
  );

  if (!toolNames.includes("resilience_recovery")) {
    throw new Error("resilience_recovery tool was not registered");
  }
  if (!toolNames.includes("resilience_sessions")) {
    throw new Error("resilience_sessions tool was not registered");
  }
  if (injections.length !== 1) {
    throw new Error(
      `expected one recovery injection for retryable agent_end, got ${injections.length}`
    );
  }
  if (injections[0].sessionKey !== "session-key-1") {
    throw new Error("recovery injection sessionKey mismatch");
  }
  if (!injections[0].text.includes("token_parse_error")) {
    throw new Error("recovery injection did not include classified error");
  }

  const statsPath = path.join(
    os.homedir(),
    ".openclaw",
    "plugins",
    "resilience",
    "instances",
    "verify-session-recovery",
    "stats.json"
  );
  const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
  const model = stats.models["grok-4.3"];
  if (!model || model.failedCalls !== 3) {
    throw new Error("session failure was not recorded in model stats");
  }
  if (model.errorsByType.rate_limit !== 2) {
    throw new Error("model_call_ended rate_limit errors were not classified");
  }
  if (model.errorsByType.token_parse_error !== 1) {
    throw new Error("agent_end failure was not classified as token_parse_error");
  }

  const sessionRetriesPath = path.join(
    os.homedir(),
    ".openclaw",
    "plugins",
    "resilience",
    "instances",
    "verify-session-recovery",
    "session-retries.json"
  );
  const sessionRetries = JSON.parse(fs.readFileSync(sessionRetriesPath, "utf-8"));
  if (sessionRetries.length !== 2) {
    throw new Error(`expected two session retry records, got ${sessionRetries.length}`);
  }
  const shellRecord = sessionRetries.find((r) => r.category === "shell_parse_error");
  if (!shellRecord || shellRecord.status !== "manual_required") {
    throw new Error("tool shell parse failure was not recorded as manual_required");
  }
  const injectedRecord = sessionRetries.find((r) => r.status === "injected");
  if (!injectedRecord) {
    throw new Error("agent_end retry record was not marked injected");
  }

  const activeRetries = getRuntime().retryEngine.getActiveRetries();
  if (activeRetries.size !== 1) {
    throw new Error(`expected one stable active retry, got ${activeRetries.size}`);
  }

  console.log("session recovery verification OK");
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
      "verify-session-recovery"
    ),
    { recursive: true, force: true }
  );
}
