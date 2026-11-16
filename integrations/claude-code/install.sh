#!/usr/bin/env bash
# Adds (or removes) the Agent Observatory hooks in your Claude Code settings.
#
#   ./install.sh https://your-app.vercel.app            install on this machine
#   ./install.sh https://your-app.vercel.app --dry-run  show what would change
#   ./install.sh --uninstall                            remove only these hooks
#
# Options:
#   --settings <file>   settings file to edit (default ~/.claude/settings.json;
#                       use <project>/.claude/settings.local.json for one project)
#
# Needs AO_INGEST_TOKEN and AO_DEVICE in your environment (see README.md), plus
# curl and node. Your existing hooks are kept. The file is backed up first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
HUB_URL=""
UNINSTALL=0
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY=1 ;;
    --settings) SETTINGS="${2:?--settings needs a file}"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) HUB_URL="$1" ;;
  esac
  shift
done

command -v node >/dev/null || { echo "node is required to edit the settings file." >&2; exit 1; }

if [ "$UNINSTALL" -eq 0 ]; then
  [ -n "$HUB_URL" ] || { echo "Usage: $0 <HUB_URL> [--dry-run] [--settings <file>]   (or --uninstall)" >&2; exit 2; }
  HUB_URL="${HUB_URL%/}"
  case "$HUB_URL" in http://*|https://*) ;; *) echo "HUB_URL must start with http:// or https://" >&2; exit 2 ;; esac
  : "${AO_INGEST_TOKEN:?Set AO_INGEST_TOKEN to the INGEST_TOKEN of your hub first (see README.md).}"
  : "${AO_DEVICE:?Set AO_DEVICE to a name for this machine, e.g. work-laptop (see README.md).}"
  case "$HUB_URL" in http://127.0.0.1*|http://localhost*|https://*) ;; *)
    echo "Warning: $HUB_URL is plain http. Events (prompts, commands) would travel unencrypted." >&2 ;;
  esac

  # An empty body is rejected with 400 only after the token has been accepted,
  # so this checks the address and token without storing anything.
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $AO_INGEST_TOKEN" -H "X-Device: $AO_DEVICE" -H 'Content-Type: application/json' \
    --data '{}' "$HUB_URL/ingest/claude" || true)"
  case "$code" in
    400|204) echo "Hub reachable and token accepted." ;;
    401) echo "The hub rejected AO_INGEST_TOKEN. It must equal the hub's INGEST_TOKEN." >&2; exit 1 ;;
    000) echo "Could not reach $HUB_URL. Check the address and your connection." >&2; exit 1 ;;
    *) echo "Unexpected answer $code from $HUB_URL/ingest/claude. Is that the Observatory address?" >&2; exit 1 ;;
  esac
fi

mkdir -p "$(dirname "$SETTINGS")"
NEW="$(mktemp)"
trap 'rm -f "$NEW"' EXIT

MODE=install; [ "$UNINSTALL" -eq 1 ] && MODE=uninstall
node - "$MODE" "$SETTINGS" "$HERE/hooks.example.json" "$HUB_URL" "$NEW" <<'NODE'
const fs = require("fs");
const [mode, settingsPath, examplePath, hubUrl, outPath] = process.argv.slice(2);
const MARK = "/ingest/claude";

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8");
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch (e) {
      console.error(`${settingsPath} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
      process.exit(1);
    }
  }
}
// One matcher group is ours if any of its hooks posts to the Observatory.
const ours = (group) =>
  (group.hooks || []).some((h) => String(h.url || "").includes(MARK) || String(h.command || "").includes(MARK));

const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
for (const [event, groups] of Object.entries(hooks)) {
  hooks[event] = (Array.isArray(groups) ? groups : []).filter((g) => !ours(g));
}
if (mode === "install") {
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8").split("HUB_URL").join(hubUrl));
  for (const [event, groups] of Object.entries(example.hooks)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
}
for (const event of Object.keys(hooks)) if (hooks[event].length === 0) delete hooks[event];
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
fs.writeFileSync(outPath, JSON.stringify(settings, null, 2) + "\n");
NODE

if [ -f "$SETTINGS" ] && cmp -s "$SETTINGS" "$NEW"; then
  echo "Nothing to change in $SETTINGS."
  exit 0
fi

if [ -f "$SETTINGS" ]; then diff -u "$SETTINGS" "$NEW" || true; else echo "Would create $SETTINGS"; fi
if [ "$DRY" -eq 1 ]; then echo "(dry run: nothing written)"; exit 0; fi

if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$SETTINGS" "$BACKUP"
  echo "Backed up to $BACKUP"
fi
cat "$NEW" > "$SETTINGS"
if [ "$UNINSTALL" -eq 1 ]; then
  echo "Removed the Agent Observatory hooks from $SETTINGS."
else
  echo "Installed. Start a new claude session; it should appear on the dashboard as \"$AO_DEVICE\"."
fi
