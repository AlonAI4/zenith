#!/bin/zsh
# Builds Zenith.zip, the copy for sharing, from the SAVED code on the alon branch
# only. It cannot contain .env (the API keys), caches, logs or node_modules,
# because git never stored them. Usage: ./alon-share.sh [where/to/put.zip]
set -e
cd "$(dirname "$0")"
OUT="${1:-$HOME/Desktop/Zenith.zip}"
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: unsaved changes are NOT in the zip. Only saved (committed) code is."
fi
rm -f "$OUT"
# Left out: the big demo videos, my own launcher, publisher and check records.
git archive --format=zip --prefix=Zenith/ -o "$OUT" alon -- . \
  ':(exclude)docs/media' ':(exclude)COMPLIANCE.md' ':(exclude).code-armour' \
  ':(exclude)security-tests' ':(exclude)alon-app.sh' ':(exclude)alon-app.applescript' \
  ':(exclude)alon-share.sh' ':(exclude).github' \
  ':(exclude)alon-site' ':(exclude)alon-site-build.sh' ':(exclude)alon-site-publish.sh' \
  ':(exclude)alon-backup.sh' ':(exclude)alon-browser-test.mjs' \
  ':(exclude)alon-browser.mjs' ':(exclude)alon-speed-check.mjs' \
  ':(exclude)alon-site-shots.mjs'
echo "Made $OUT ($(du -h "$OUT" | cut -f1))"
