#!/bin/zsh
# The Zenith Mac app's launcher. It sits inside Zenith.app/Contents/Resources,
# and the app's window (ZenithApp.swift) calls it with ZENITH_NO_BROWSER=1:
#   start | stop | status | open | restart | check-bg | note
# Everything Zenith writes goes in ~/Library/Application Support/Zenith,
# never inside the app: the code (app/, with the keys in app/.env), the Node
# it runs on (runtime/), photos, logs, and updates (see server/alon/appUpdate.mjs).
set -u
HERE="${0:A:h}"
DATA="$HOME/Library/Application Support/Zenith"
APP="$DATA/app"
LOGS="$DATA/logs"
PORT=4173
URL="http://localhost:$PORT"
VERSION="$(cat "$HERE/version.txt")"
NODE_VERSION="$(cat "$HERE/node/version.txt")"
RUNTIME="$DATA/runtime/$NODE_VERSION"
NODE="$RUNTIME/bin/node"
# ZENITH_UPDATE_URL is only for testing an update from this computer.
MANIFEST_URL="${ZENITH_UPDATE_URL:-https://github.com/AlonAI4/zenith/releases/latest/download/update.json}"
mkdir -p "$DATA" "$LOGS"

# The app shows Zenith in its own window; by hand, it opens in the browser.
open_page() { [ -n "${ZENITH_NO_BROWSER:-}" ] || open "$URL"; }
is_zenith() { curl -s -m 2 "$URL" 2>/dev/null | grep -q '<title>Zenith</title>'; }
port_busy() { lsof -ti "tcp:$PORT" -sTCP:LISTEN > /dev/null 2>&1; }
# Ours only if the process in server.pid is the one serving the port: after a
# crash or a restart that number can belong to another program.
ours() {
  local pid
  pid=$(cat "$DATA/server.pid" 2> /dev/null)
  [ -n "$pid" ] && [ "$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2> /dev/null)" = "$pid" ]
}

# The Node inside the app, copied out once so it runs from Zenith's own folder.
runtime() {
  [ -x "$NODE" ] && return 0
  rm -rf "$DATA/runtime"
  mkdir -p "$DATA/runtime"
  /bin/cp -cR "$HERE/node" "$RUNTIME"
  /usr/bin/xattr -dr com.apple.quarantine "$RUNTIME" 2> /dev/null
  return 0
}
tool() { "$NODE" "$HERE/appUpdate.mjs" "$@" --data "$DATA"; }

serve() {
  (
    cd "$APP" || exit 1
    # 127.0.0.1 only: Zenith is never reachable from the network.
    ZENITH_PHOTOS_DIR="$DATA/photos" PUPPETEER_SKIP_DOWNLOAD=1 \
      nohup "$NODE" node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort \
      > "$LOGS/zenith.log" 2>&1 < /dev/null &
    echo $! > "$DATA/server.pid"
  )
  for i in {1..240}; do
    is_zenith && return 0
    sleep 0.5
  done
  return 1
}

stop_server() {
  ours && kill "$(cat "$DATA/server.pid")" 2> /dev/null
  for i in {1..40}; do
    port_busy || break
    sleep 0.25
  done
  rm -f "$DATA/server.pid"
}

start() {
  if is_zenith; then
    open_page
    ours && echo "started" || echo "elsewhere"
    return 0
  fi
  if port_busy; then
    echo "Something else is using port $PORT on this Mac, so Zenith cannot start. Close it and try again."
    return 1
  fi
  runtime
  local changed=""
  [[ "$(tool install --bundle-code "$HERE/zenith" --bundle-version "$VERSION")" == *'"applied"'* ]] && changed=1
  [ -f "$HERE/alon-private.env" ] && tool keys --keys "$HERE/alon-private.env" > /dev/null
  local applied
  applied="$(tool apply)"
  [[ "$applied" == *'"applied"'* ]] && changed=1
  if serve; then
    if [ -n "$changed" ]; then
      tool confirm > /dev/null
      [[ "$applied" == *'"applied"'* ]] && echo "updated $(cat "$APP/.zenith-version")" > "$DATA/just-updated"
    fi
    open_page
    echo "started"
    return 0
  fi
  stop_server
  if [ -n "$changed" ] && [[ "$(tool rollback)" == *'"rolled-back"'* ]] && serve; then
    echo "The new version did not start, so Zenith went back to the one before. Details: $LOGS/zenith.log" > "$DATA/just-updated"
    open_page
    echo "started"
    return 0
  fi
  echo "Zenith did not start. The reason is in $LOGS/zenith.log"
  return 1
}

# Looks for an update without holding up the window, and says when one is ready.
check_bg() {
  runtime
  local said
  said="$(tool check --app-version "$VERSION" --manifest-url "$MANIFEST_URL" \
    --public-key "$HERE/update-public-key.pem" --npm "$RUNTIME/lib/node_modules/npm/bin/npm-cli.js")"
  echo "$said" > "$DATA/update-state.json"
  if [[ "$said" == *'"ready"'* ]]; then
    /usr/bin/osascript -e 'display notification "A new version is ready. It starts by itself next time you open Zenith." with title "Zenith"' 2> /dev/null
  fi
}

# One line for the Zenith window about updates, or nothing.
note() {
  if [ -f "$DATA/just-updated" ]; then
    local said
    said="$(cat "$DATA/just-updated")"
    rm -f "$DATA/just-updated"
    if [[ "$said" == updated* ]]; then
      echo "Zenith was updated to ${said#updated }. What is new is at the bottom of the help card (the ? switch)."
    else
      echo "$said"
    fi
  fi
  if [ -f "$DATA/app.new/.zenith-version" ]; then
    echo "READY Zenith $(cat "$DATA/app.new/.zenith-version") is ready: Restart now to use it, or it starts by itself next time."
  elif grep -q '"new-app"' "$DATA/update-state.json" 2> /dev/null; then
    echo "A new version of Zenith needs the new app: download it from the Zenith page."
  fi
  return 0
}

case "${1:-}" in
  start) start ;;
  stop) ours && stop_server; echo "stopped" ;;
  status) is_zenith && echo "running" || echo "stopped" ;;
  open) open "$URL" ;;
  restart) stop_server; start ;;
  check-bg) check_bg ;;
  note) note ;;
  *) echo "usage: launcher.sh start|stop|status|open|restart|check-bg|note"; exit 2 ;;
esac
