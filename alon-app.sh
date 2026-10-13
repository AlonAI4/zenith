#!/bin/zsh
# Start, stop or update Zenith (Alon's build of God's Eye View). Zenith.app in ~/Applications
# calls this; it also works by hand: ./alon-app.sh start|stop|status|update|test|speed
cd "$(dirname "$0")"
# A Mac app starts with a bare PATH; use the same Node the project is run with.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
URL=http://localhost:4173
LOG=.gev-logs/alon-app.log

running() { curl -s -m 2 -o /dev/null "$URL"; }

start() {
  if ! running; then
    mkdir -p .gev-logs
    nohup npm run dev > "$LOG" 2>&1 < /dev/null &
    disown
    for i in {1..80}; do running && break; sleep 0.5; done
  fi
  if running; then
    open "$URL"
  else
    echo "Zenith did not start. The reason is in $PWD/$LOG"
    return 1
  fi
}

stop() {
  local pids=$(lsof -ti tcp:4173 -sTCP:LISTEN)
  [ -n "$pids" ] && kill ${=pids}
  for i in {1..20}; do running || break; sleep 0.25; done
  running && { echo "The server would not stop."; return 1; }
  echo "Stopped."
}

# Opens the running app in a test browser and checks every add-on.
browser_test() {
  if ! running; then start > /dev/null || return 1; fi
  echo "Checking every add-on in a test browser (about 5 minutes)..."
  node alon-browser-test.mjs | tail -6
  return ${pipestatus[1]}
}

case "$1" in
  start) start ;;
  test) browser_test ;;
  speed) running || start > /dev/null; node alon-speed-check.mjs ;;
  stop) stop ;;
  status) running && echo running || echo stopped ;;
  update)
    ./alon-update.sh 2>&1 | tail -5
    # Restart so the new code is the code that runs.
    running && stop > /dev/null
    start
    browser_test || echo "An add-on is not working after this update. Ask Claude."
    ;;
  *) echo "usage: $0 start|stop|status|update|test|speed"; exit 2 ;;
esac
