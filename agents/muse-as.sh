#!/bin/sh
# Start one RAISE Muse as its own Muse Code session on this Mac, signed in to RAISE as itself.
#
#   agents/muse-as.sh atlas login   # once per Muse: browser opens the RAISE Allow page
#   agents/muse-as.sh atlas         # every time after: start Atlas's session
#
# Each Muse gets its own Muse Code config folder (~/.config/raise-agents/<slug>), so its settings hold exactly one
# MCP server named "raise" and its own OAuth tokens. Nothing here stores a RAISE key.
set -eu
slug="${1:-}"
case "$slug" in forge|atlas|nova|sol|echo|pixel|bob) ;; *) echo "usage: $0 <forge|atlas|nova|sol|echo|pixel|bob> [login]" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
export XDG_CONFIG_HOME="$HOME/.config/raise-agents/$slug"
mkdir -p "$XDG_CONFIG_HOME/muse" "$here/$slug/proposals"
settings="$XDG_CONFIG_HOME/muse/settings.json"
[ -f "$settings" ] || cat > "$settings" <<JSON
{ "schema_version": 1,
  "mcp_servers": { "raise": { "transport": "streamable_http", "url": "https://raise.commonworld.one/mcp", "enabled": true } } }
JSON
cd "$here/$slug"
if [ "${2:-}" = "login" ]; then exec muse mcp login raise; fi
exec muse --model muse-spark-1.3-contributor
