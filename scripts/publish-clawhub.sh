#!/usr/bin/env bash
# Publish @leiJack-lo/resilience plugin + skill to ClawHub.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-0.3.3}"
CHANGELOG="${2:-scanStatus improvement: replaced raw child_process.exec with audited 'open' package + files whitelist + .npmignore for cleaner artifact; added Security & Trust section to README explaining privileges and scan flag; version 0.3.2 with synced docs. Goal: reach benign scan for easier adoption.}"

if ! clawhub whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: clawhub login"
  exit 1
fi

echo "Building..."
npm run build

SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
echo "Publishing plugin @leiJack-lo/resilience@${VERSION} (commit ${SOURCE_COMMIT:0:7})..."
clawhub --workdir "$ROOT" package publish "$ROOT" \
  --family code-plugin \
  --name @leiJack-lo/resilience \
  --display-name "Resilience" \
  --version "$VERSION" \
  --changelog "$CHANGELOG" \
  --source-repo leiJack-lo/openclaw-resilience \
  --source-commit "$SOURCE_COMMIT" \
  --source-path "."

echo "Publishing skill leiJack-lo/resilience-monitor..."
clawhub --workdir "$ROOT" publish "$ROOT/skill" \
  --slug resilience-monitor \
  --name "Resilience Monitor" \
  --version "$VERSION" \
  --changelog "$CHANGELOG"

echo "Done. Install with:"
echo "  openclaw plugins install clawhub:@leiJack-lo/resilience --dangerously-force-unsafe-install"
echo "  openclaw skills install leiJack-lo/resilience-monitor"