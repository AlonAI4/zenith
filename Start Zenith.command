#!/bin/zsh
# Start Zenith: double-click this file.
# It says what it will do and waits for you, then installs what Zenith needs
# (first time only), starts Zenith on this Mac and opens it in your browser.
# It never asks for a password and installs nothing system-wide.
# Closing its window stops Zenith. The full guide is ZENITH-GUIDE.md.

cd "$(dirname "$0")" || exit 1
# ZENITH_PORT is only for the tests of this script; leave it unset.
PORT="${ZENITH_PORT:-4173}"
URL="http://localhost:$PORT"

stop() {
  print
  print -- "$1"
  print
  print "Press Return to close."
  read -r
  exit 1
}

print "ZENITH"
print
# Something already answering on the port is Zenith only if its page says so.
if ANSWER="$(curl -s --max-time 2 "$URL")"; then
  if [[ "$ANSWER" == *"<title>Zenith</title>"* ]]; then
    print "Zenith is already running. Opening $URL"
    [ -z "$ZENITH_NO_BROWSER" ] && open "$URL"
    exit 0
  fi
  stop "Another program is already using port $PORT, so Zenith cannot start there.
Close that program, then double-click this file again."
fi

print "This will:"
if [ ! -d node_modules ]; then
  print "  - Download the packages Zenith needs into this folder."
  print "    About 350 MB and a few minutes, this first time only."
fi
print "  - Start Zenith on this Mac only, at $URL"
print "  - Open it in your browser."
print
print "Nothing is installed system-wide and no password is asked for."
print "Closing this window stops Zenith."
print
print "Press Return to go ahead, or close this window to cancel."
read -r

# Node.js: look in the usual places, in case this window has a short PATH.
if ! command -v node > /dev/null; then
  export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin"
fi
if ! command -v node > /dev/null || ! command -v npm > /dev/null; then
  stop "Zenith needs Node.js, and it is not installed on this Mac.
Get version 26, or 24.14 or newer, from https://nodejs.org, install it, then double-click this file again."
fi
# The same versions as "engines" in package.json (a test keeps the two in step).
if [ "$(node -p '((v) => v[0] === 26 || (v[0] === 24 && v[1] >= 14))(process.versions.node.split(".").map(Number))')" != "true" ]; then
  stop "Zenith needs Node.js 26, or version 24 at 24.14 or newer. This Mac has version $(node -v).
Get it from https://nodejs.org, install it, then double-click this file again."
fi

if [ ! -d node_modules ]; then
  print "Downloading the packages. This takes a few minutes..."
  # npm ci installs exactly the versions listed in package-lock.json.
  # The test browser one package would fetch is not needed to run Zenith.
  if ! PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund; then
    rm -rf node_modules
    stop "The download did not finish. Check your internet connection, then double-click this file again."
  fi
fi

print
print "Starting Zenith. Your browser opens when it is ready."
print "Keep this window open while you use it."
print
if [ -z "$ZENITH_NO_BROWSER" ]; then
  (
    for attempt in {1..120}; do
      curl -s -o /dev/null --max-time 2 "$URL" && { open "$URL"; break; }
      sleep 1
    done
  ) &
fi
npm run dev -- --port "$PORT" --strictPort
stop "Zenith has stopped. If the lines above say the port is in use, another program is using port $PORT: close it and try again."
