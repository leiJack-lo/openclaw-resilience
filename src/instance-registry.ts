/**
 * Multi-instance data layout under ~/.openclaw/plugins/resilience/instances/<id>/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResilienceConfig } from "./types.js";

export const RESILIENCE_ROOT = path.join(
  os.homedir(),
  ".openclaw",
  "plugins",
  "resilience"
);

export const INSTANCES_DIR = path.join(RESILIENCE_ROOT, "instances");

export interface InstanceMeta {
  id: string;
  label: string;
  workspacePath?: string;
  gatewayInstanceId?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface InstancePaths {
  id: string;
  label: string;
  root: string;
  statsPath: string;
  logDir: string;
  strategiesPath: string;
  tasksDir: string;
  metaPath: string;
  activeRetriesPath: string;
  recoverySettingsPath: string;
}

export interface InstanceInfo extends InstanceMeta {
  paths: InstancePaths;
  hasStats: boolean;
  isLegacy: boolean;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "default";
}

function readGatewayInstanceId(): string | undefined {
  const p = path.join(os.homedir(), ".openclaw", "gateway-instance-id");
  try {
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, "utf-8").trim();
      return v || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function workspaceLabel(workspacePath?: string): string | undefined {
  if (!workspacePath) return undefined;
  const base = path.basename(workspacePath);
  if (base && base !== "." && base !== "workspace") return base;
  const parent = path.basename(path.dirname(workspacePath));
  return parent || base;
}

/**
 * Resolve the instance id for this gateway/plugin process.
 */
export function resolveInstanceId(config?: ResilienceConfig): string {
  if (config?.instanceId) return sanitizeId(config.instanceId);
  const env =
    process.env.OPENCLAW_RESILIENCE_INSTANCE_ID ??
    process.env.OPENCLAW_INSTANCE_ID;
  if (env?.trim()) return sanitizeId(env.trim());

  const gatewayId = readGatewayInstanceId();
  if (gatewayId) return sanitizeId(gatewayId);

  return "default";
}

export function resolveInstanceLabel(
  instanceId: string,
  config?: ResilienceConfig
): string {
  if (config?.instanceLabel?.trim()) return config.instanceLabel.trim();
  const ws =
    config?.workspacePath ??
    process.env.OPENCLAW_WORKSPACE ??
    process.cwd();
  const fromWs = workspaceLabel(ws);
  if (fromWs) return fromWs;
  if (instanceId === "default") return "default";
  return instanceId.length > 12 ? `${instanceId.slice(0, 8)}…` : instanceId;
}

export function getInstancePaths(
  instanceId: string,
  label?: string
): InstancePaths {
  const id = sanitizeId(instanceId);
  const root = path.join(INSTANCES_DIR, id);
  return {
    id,
    label: label ?? id,
    root,
    statsPath: path.join(root, "stats.json"),
    logDir: path.join(root, "logs"),
    strategiesPath: path.join(root, "strategies.json"),
    tasksDir: path.join(root, "tasks"),
    metaPath: path.join(root, "meta.json"),
    activeRetriesPath: path.join(root, "active-retries.json"),
    recoverySettingsPath: path.join(root, "recovery-settings.json"),
  };
}

export function resolveInstanceContext(config?: ResilienceConfig): InstancePaths {
  const id = resolveInstanceId(config);
  const label = resolveInstanceLabel(id, config);
  const paths = getInstancePaths(id, label);
  ensureInstanceDir(paths);
  return paths;
}

function ensureInstanceDir(paths: InstancePaths): void {
  for (const dir of [paths.root, paths.logDir, paths.tasksDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function touchInstanceMeta(
  paths: InstancePaths,
  extra?: Partial<Pick<InstanceMeta, "workspacePath" | "gatewayInstanceId">>
): void {
  const now = new Date().toISOString();
  let meta: InstanceMeta;

  try {
    if (fs.existsSync(paths.metaPath)) {
      meta = JSON.parse(fs.readFileSync(paths.metaPath, "utf-8")) as InstanceMeta;
      meta.lastSeenAt = now;
      if (extra?.workspacePath) meta.workspacePath = extra.workspacePath;
      if (extra?.gatewayInstanceId) meta.gatewayInstanceId = extra.gatewayInstanceId;
    } else {
      meta = {
        id: paths.id,
        label: paths.label,
        workspacePath: extra?.workspacePath,
        gatewayInstanceId: extra?.gatewayInstanceId ?? readGatewayInstanceId(),
        createdAt: now,
        lastSeenAt: now,
      };
    }
  } catch {
    meta = {
      id: paths.id,
      label: paths.label,
      createdAt: now,
      lastSeenAt: now,
      ...extra,
    };
  }

  fs.writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Discover all instance directories plus legacy root data as "default".
 */
export function discoverInstances(): InstanceInfo[] {
  const found = new Map<string, InstanceInfo>();

  const add = (paths: InstancePaths, isLegacy: boolean) => {
    let meta: InstanceMeta | null = null;
    try {
      if (fs.existsSync(paths.metaPath)) {
        meta = JSON.parse(fs.readFileSync(paths.metaPath, "utf-8")) as InstanceMeta;
      }
    } catch {
      meta = null;
    }

    const info: InstanceInfo = {
      id: paths.id,
      label: meta?.label ?? paths.label,
      workspacePath: meta?.workspacePath,
      gatewayInstanceId: meta?.gatewayInstanceId,
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      lastSeenAt: meta?.lastSeenAt ?? new Date(0).toISOString(),
      paths,
      hasStats: fs.existsSync(paths.statsPath),
      isLegacy,
    };
    found.set(paths.id, info);
  };

  if (fs.existsSync(INSTANCES_DIR)) {
    for (const name of fs.readdirSync(INSTANCES_DIR)) {
      const root = path.join(INSTANCES_DIR, name);
      if (!fs.statSync(root).isDirectory()) continue;
      add(getInstancePaths(name), false);
    }
  }

  // Legacy flat layout at RESILIENCE_ROOT
  const legacyStats = path.join(RESILIENCE_ROOT, "stats.json");
  if (fs.existsSync(legacyStats)) {
    const legacy = getInstancePaths("default", "default (legacy)");
    legacy.statsPath = legacyStats;
    legacy.logDir = path.join(RESILIENCE_ROOT, "logs");
    legacy.strategiesPath = path.join(RESILIENCE_ROOT, "strategies.json");
    legacy.tasksDir = path.join(RESILIENCE_ROOT, "tasks");
    legacy.recoverySettingsPath = path.join(RESILIENCE_ROOT, "recovery-settings.json");
    legacy.root = RESILIENCE_ROOT;
    add(legacy, true);
  }

  return [...found.values()].sort(
    (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)
  );
}

/**
 * One-time migration: copy legacy root files into instances/default/.
 */
export function migrateLegacyToDefault(): boolean {
  const legacyStats = path.join(RESILIENCE_ROOT, "stats.json");
  const target = getInstancePaths("default", "default");
  if (!fs.existsSync(legacyStats)) return false;
  if (fs.existsSync(target.statsPath)) return false;

  ensureInstanceDir(target);
  const copyFile = (src: string, dest: string) => {
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  };

  copyFile(legacyStats, target.statsPath);
  copyFile(
    path.join(RESILIENCE_ROOT, "strategies.json"),
    target.strategiesPath
  );

  const legacyLogs = path.join(RESILIENCE_ROOT, "logs");
  if (fs.existsSync(legacyLogs)) {
    for (const f of fs.readdirSync(legacyLogs)) {
      copyFile(path.join(legacyLogs, f), path.join(target.logDir, f));
    }
  }

  touchInstanceMeta(target, { gatewayInstanceId: readGatewayInstanceId() });
  return true;
}
