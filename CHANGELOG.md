# Changelog

## 0.3.4

- chore: switch license from Apache-2.0 to MIT (more permissive for community adoption)
- Published 0.3.4 to ClawHub (plugin + skill) to sync with GitHub

## 0.3.3

- Further risk optimization for ClawHub scan:
  - Hardened local DashboardServer: added security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP), restricted CORS to origin or "null" (no wildcard *).
  - Updated openclaw.plugin.json with explicit `activation.onCapabilities: ["hook", "tool"]` and comments declaring hook usage for transparency (model_call_ended / agent_end are read-only observers only).
  - Expanded "安全与信任" / "Known Risks and Mitigations" table in README with specific risks (local data exposure, strategy edits, model hooks, local HTTP server, executes code) and mitigations. Matches style of the companion skill's risk disclosure.
- Rebuilt and prepared for republish. Goal: provide even more evidence of safe design to help move from "suspicious" to "benign".

## 0.3.2

- **scanStatus improvement push**: Replaced raw `child_process.exec` (for browser open) with the well-audited `open` npm package. Added `files` whitelist + `.npmignore` to produce a cleaner published artifact (excludes local state, dev scripts, extra md). This directly targets common ClawHub "suspicious" triggers (direct shell exec, unnecessary files).
- Added prominent "安全与信任" (Security & Trust) section to README explaining minimal privileges, why local server/exec is needed, what the suspicious flag means, and how to get help. Increases transparency and user confidence.
- Synced and enhanced skill docs (already strong prerequisite warnings) and package metadata.
- Goal: move toward "benign" scan result so `--dangerously-force-unsafe-install` is no longer required, making the plugin easier/safer for everyone to adopt and increasing adoption + influence in the OpenClaw ecosystem.

## 0.3.1

- **Skill guidance fix (critical for discoverability)**: Added prominent "必须先安装配套插件" warning + exact install commands + explanation of the `--dangerously-force-unsafe-install` flag + verification tip directly into the published `SKILL.md` (the one users get via `openclaw skills install resilience-monitor`). This addresses the problem where the skill had 61+ downloads but the plugin had 0 because users were landing on the skill first.
- Updated skill.json description to explicitly state the plugin requirement.
- Strengthened root README install section and "通过 Skill" section with clearer ordering and warnings.
- Goal: make sure people who find the skill via search immediately understand they must install the plugin first, in the right order, and restart the gateway.

## 0.3.0

- Web monitoring dashboard (`http://127.0.0.1:18765/`) with live stats and retry strategy UI
- Multi-instance aggregation (legacy + per-gateway data dirs)
- Fix plugin config resolution on `gateway_start` (`ctx.config` + `plugins.entries.resilience.config`)
- Skill natural-language examples for opening the dashboard
- ClawHub package name: `@leiJack-lo/resilience`