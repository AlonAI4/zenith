#!/bin/zsh
# Builds the Zenith download website into .gev-cache/zenith-site (not saved in
# git): the page, the pictures and a fresh share zip that has passed the
# no-keys check. It does NOT publish anything.
set -e
cd "$(dirname "$0")"
OUT=.gev-cache/zenith-site
rm -rf "$OUT"
mkdir -p "$OUT"
cp alon-site/index.html alon-site/404.html alon-site/style.css alon-site/_headers alon-site/robots.txt "$OUT"/
cp public/alon/zenith-wordmark.webp public/alon/zenith-favicon.png "$OUT"/
cp -R alon-site/shots "$OUT"/
# ZENITH_ZIP=<file> reuses a share zip that was already published, so a page-only
# update leaves the app download exactly as it was. It still gets the key check.
if [ -n "${ZENITH_ZIP:-}" ]; then
  cp "$ZENITH_ZIP" "$OUT/Zenith.zip"
else
  ./alon-share.sh "$OUT/Zenith.zip" > /dev/null
fi
# Refuse to build a site around a zip that fails the key check.
node security-tests/share-zip.mjs --zip "$OUT/Zenith.zip"
# Zenith MC (the Minecraft mod) is a separate download: its jar goes next to
# the zip, never inside it. Build it first in ~/tools/zenith-mc (./gradlew build).
MC_LIBS="${ZENITH_MC_DIR:-$HOME/tools/zenith-mc}/build/libs"
MC_JAR=$(ls -t "$MC_LIBS"/zenith-mc-*.jar 2>/dev/null | grep -v -- '-sources\.jar$' | head -1 || true)
if [ -z "$MC_JAR" ]; then
  echo "No Zenith MC jar in $MC_LIBS: run ./gradlew build in ~/tools/zenith-mc first." >&2
  exit 1
fi
if unzip -l "$OUT/Zenith.zip" | grep -qi '\.jar$'; then
  echo "The Zenith zip must not contain a jar." >&2
  exit 1
fi
MC_NAME=$(basename "$MC_JAR")
cp "$MC_JAR" "$OUT/$MC_NAME"
MC_SIZE="$(du -h "$OUT/$MC_NAME" | cut -f1 | tr -d ' ')B"
MC_SHA=$(shasum -a 256 "$OUT/$MC_NAME" | cut -d' ' -f1)
SIZE="$(du -h "$OUT/Zenith.zip" | cut -f1 | tr -d ' ')B"
SHA=$(shasum -a 256 "$OUT/Zenith.zip" | cut -d' ' -f1)
DAY=$(date "+%-d %B %Y")
sed -i '' -e "s/__SIZE__/$SIZE/" -e "s/__SHA__/$SHA/" -e "s/__DATE__/$DAY/" \
  -e "s/__MC_JAR__/$MC_NAME/g" -e "s/__MC_SIZE__/$MC_SIZE/" -e "s/__MC_SHA__/$MC_SHA/" "$OUT/index.html"
# The version number and the list of what is new come from the one file the
# app itself reads, so the page and the app cannot disagree.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { ZENITH_VERSION, changesAsHtml } from "./src/app/zenithVersion.js";
  const file = process.argv[1];
  const page = readFileSync(file, "utf8")
    .replaceAll("__VERSION__", () => ZENITH_VERSION.number)
    .replaceAll("__WHATS_NEW__", () => changesAsHtml());
  if (/__[A-Z_]+__/.test(page)) throw new Error("the page still has an unfilled blank");
  writeFileSync(file, page);
' "$OUT/index.html"
echo "Built $OUT ($(du -sh "$OUT" | cut -f1)). Nothing was published."
