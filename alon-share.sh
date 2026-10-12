#!/bin/zsh
# Builds Zenith-share.zip for friends from the SAVED code on the alon branch
# only. It cannot contain .env (the API keys), caches, logs or node_modules,
# because git never stored them. Usage: ./alon-share.sh [where/to/put.zip]
set -e
cd "$(dirname "$0")"
OUT="${1:-$HOME/Desktop/Zenith-share.zip}"
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: unsaved changes are NOT in the zip. Only saved (committed) code is."
fi
rm -f "$OUT"
# Left out: the big demo videos, my own launcher, updater and check records.
git archive --format=zip --prefix=Zenith/ -o "$OUT" alon -- . \
  ':(exclude)docs/media' ':(exclude)COMPLIANCE.md' ':(exclude).code-armour' \
  ':(exclude)security-tests' ':(exclude)alon-app.sh' ':(exclude)alon-app.applescript' \
  ':(exclude)alon-share.sh' ':(exclude).github'
echo "Made $OUT ($(du -h "$OUT" | cut -f1))"
