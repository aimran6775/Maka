#!/bin/bash
# The park as a real service (D193).
#
#   scripts/park-service.sh install   write the LaunchAgent and start it
#   scripts/park-service.sh start | stop | restart | status | logs | uninstall
#
# The park is meant to run unwatched: departments have duties at 06:45 and 07:30, mail is
# polled every minute, and the reflection runs daily. None of that happens if the sidecar is
# a child of whatever terminal happened to start it — a closed window, a reaped background
# job or a logout takes the whole park down, which is what kept happening.
#
# launchd is the answer on macOS. `KeepAlive` restarts the park if it dies, `RunAtLoad`
# starts it at login, and the environment is written into the plist so the park finds its
# home, its workspace and the model weights on the external drive without a shell.
#
# Node comes from wherever `node` resolves now, because a LaunchAgent gets almost no PATH:
# an nvm install lives under ~/.nvm and launchd would never find it.

set -euo pipefail

LABEL="com.makapark.sidecar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKA_HOME_DIR="${MAKA_HOME:-$HOME/Maka/home}"
MAKA_WORKSPACE_DIR="${MAKA_WORKSPACE:-/Volumes/LaCie/Maka/workspace}"
OLLAMA_MODELS_DIR="${OLLAMA_MODELS:-/Volumes/LaCie/Maka/ollama}"
LOG_DIR="$MAKA_HOME_DIR/logs"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

die() { echo "park-service: $1" >&2; exit 1; }

write_plist() {
  [ -n "$NODE_BIN" ] || die "node is not on the PATH; set NODE_BIN=/path/to/node"
  [ -x "$NODE_BIN" ] || die "$NODE_BIN is not executable"
  [ -f "$REPO/sidecar/index.js" ] || die "$REPO does not look like the Maka repo"
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

  # The park runs from the repo so relative paths (recipes/starter, frontend) resolve.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/sidecar/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAKA_HOME</key><string>$MAKA_HOME_DIR</string>
    <key>MAKA_WORKSPACE</key><string>$MAKA_WORKSPACE_DIR</string>
    <key>OLLAMA_MODELS</key><string>$OLLAMA_MODELS_DIR</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <!-- Restart it if it dies, but not in a tight loop if it cannot start at all. -->
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/park.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/park.err.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST_EOF
  echo "park-service: wrote $PLIST"
  echo "  node       $NODE_BIN"
  echo "  repo       $REPO"
  echo "  home       $MAKA_HOME_DIR"
  echo "  workspace  $MAKA_WORKSPACE_DIR"
  echo "  models     $OLLAMA_MODELS_DIR"
  echo "  logs       $LOG_DIR/park.log"
}

# `bootstrap`/`bootout` are the current verbs; `load`/`unload` are kept as the fallback for
# older macOS, where bootstrap does not exist.
load_it() {
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
}
unload_it() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
}

case "${1:-status}" in
  install)
    write_plist
    unload_it
    load_it
    echo "park-service: started. It will come back on its own, and at login."
    ;;
  start) load_it; echo "park-service: started";;
  stop) unload_it; echo "park-service: stopped (it will not come back until you start it)";;
  restart)
    unload_it
    sleep 1
    load_it
    echo "park-service: restarted"
    ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s+(state|pid|last exit (status|code))' || true
    else
      echo "park-service: not loaded (run: scripts/park-service.sh install)"
    fi
    if curl -sf http://127.0.0.1:8790/api/state >/dev/null 2>&1; then
      echo "park: answering on http://127.0.0.1:8790"
    else
      echo "park: not answering yet"
    fi
    ;;
  logs) tail -n "${2:-40}" "$LOG_DIR/park.log" "$LOG_DIR/park.err.log" 2>/dev/null || echo "no logs yet";;
  uninstall)
    unload_it
    rm -f "$PLIST"
    echo "park-service: removed $PLIST (nothing in the park's home or workspace was touched)"
    ;;
  *) die "unknown command \"$1\"; try install, start, stop, restart, status, logs, uninstall";;
esac
