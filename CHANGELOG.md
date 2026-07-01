# Changelog

## 0.5.1

- Changed retry duration display in the dashboard and tool reports from raw milliseconds to human-readable units such as `30s`, `2分钟`, and `1小时`.
- Kept strategy persistence in milliseconds so retry scheduling remains precise while the UI stays readable.

## 0.5.0

- Fixed retry strategy updates from skills/dashboard when time fields are passed as strings or unit-bearing values.
- Normalized `maxRetries`, `intervals`, `cooldownMs`, `retryOn`, and `models` before persisting strategies so the dashboard no longer renders `NaN`.
- Added support for duration inputs such as `300000`, `"300000"`, `"30s"`, `"5m"`, `"5分钟"`, `"1h"`, and comma-separated interval strings.
- Hardened strategy loading so existing string-based strategy files are normalized back to millisecond numbers on load.
- Added `verify:strategies` regression coverage for the NaN strategy update bug.

## 0.4.0

- Added a persistent session/tool recovery queue (`session-retries.json`) for agent-level failures that are not LLM API errors.
- Added `after_tool_call` failure capture with conservative recovery policy: retryable failures can receive next-turn recovery instructions, while permission/config/shell-parse/external-side-effect risks are marked `manual_required`.
- Added `resilience_sessions` tool for querying recent session/tool recovery records.
- Extended the dashboard with session recovery summary metrics and a recovery queue panel.
- Added dashboard API `/api/session-retries` and verification coverage for session retry aggregation.

## 0.3.6

- Updated OpenClaw SDK and compatibility metadata for OpenClaw 2026.6.10.
- Fixed TypeScript declaration generation under the 6.10 SDK by explicitly typing the plugin entry export.
- Hardened session recovery injection: failed sessions are still classified, logged, and counted when the host does not expose the next-turn injection API, instead of throwing from the hook.
- Fixed retry tracking to use a stable per-session/run operation key instead of a timestamp key, so repeated failures update one active retry record.
- Classified OpenClaw-native hook categories such as `rate_limit` directly instead of falling through to `unknown`.
- Documented the OpenClaw 2026.6.10+ `plugins.entries.resilience.hooks.allowConversationAccess=true` requirement for the `agent_end` recovery hook.
- Added a focused session recovery verification script that registers the plugin with a fake 6.10 API, triggers an `agent_end` failure, and checks the logged stats plus queued recovery injection.

## 0.3.5

- Added session runtime error tracking beyond model API calls:
  - `agent_end` failures are now classified, logged, and included in stats.
  - Added `token_parse_error`, `invalid_model_output`, and `session_runtime_error` categories.
- Added automatic next-turn recovery injection for failed sessions using OpenClaw's plugin session workflow API.
- Added configurable recovery settings:
  - enable/disable automatic recovery
  - choose Chinese or English continuation wording
  - customize recovery prompts
  - tune TTL, cooldown, and per-session injection limits
- Added `resilience_recovery` tool and skill examples for viewing/updating recovery settings.

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
