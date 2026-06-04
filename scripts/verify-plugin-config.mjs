import {
  resolveResilienceConfig,
  PLUGIN_ID,
} from "../dist/plugin-config.js";

const cfg = resolveResilienceConfig({
  openClawConfig: {
    plugins: {
      entries: {
        [PLUGIN_ID]: {
          config: {
            dashboardPort: 19999,
            instanceLabel: "test-ws",
          },
        },
      },
    },
  },
  workspaceDir: "/tmp/ws",
});

if (cfg.dashboardPort !== 19999) throw new Error("dashboardPort not merged");
if (cfg.instanceLabel !== "test-ws") throw new Error("instanceLabel not merged");
if (cfg.workspacePath !== "/tmp/ws") throw new Error("workspaceDir not applied");

console.log("plugin-config resolution OK");
process.exit(0);