#!/bin/zsh
# Builds the Zenith download website into .gev-cache/zenith-site (not saved in
# git): the two pages and the pictures. The Mac app is too big for the site:
# it is downloaded from the GitHub Release, and this page shows its size and
# SHA-256, taken from the release built by ./alon-release.sh. It does NOT
# publish anything.
set -e
cd "$(dirname "$0")"
OUT=.gev-cache/zenith-site
rm -rf "$OUT"
mkdir -p "$OUT"
cp alon-site/index.html alon-site/mc.html alon-site/404.html alon-site/style.css alon-site/_headers alon-site/robots.txt "$OUT"/
cp public/alon/zenith-wordmark.webp public/alon/zenith-favicon.png "$OUT"/
cp -R alon-site/shots "$OUT"/
VERSION=$(node --input-type=module -e 'import { ZENITH_VERSION } from "./src/app/zenithVersion.js"; console.log(ZENITH_VERSION.number)')
APP_ZIP="${ZENITH_RELEASE:-$HOME/Library/Caches/Zenith-release/$VERSION/out/Zenith-mac.zip}"
if [ ! -f "$APP_ZIP" ]; then
  echo "No Mac app for version $VERSION at $APP_ZIP: run ./alon-release.sh first." >&2
  exit 1
fi
# Zenith MC (the Minecraft mod) is a separate download: one jar per Minecraft version, next to
# the pages, never inside the Mac app. Build both first in ~/tools/zenith-mc:
# ./gradlew build and ./gradlew build -Pmc=26.3.
MC_LIBS="${ZENITH_MC_DIR:-$HOME/tools/zenith-mc}/build/libs"
MC_VERSIONS=(26.2 26.3)
# Sizes from the real byte count: du counts whole disk blocks, so a 253 KB jar showed as 256KB.
size_of() {
  stat -f %z "$1" | awk '{ s = $1 / 1024; u = "KB"; if (s >= 1024) { s /= 1024; u = "MB" } printf(s < 10 ? "%.1f%s" : "%.0f%s", s, u) }'
}
for MC in $MC_VERSIONS; do
  MC_JAR=$(ls -t "$MC_LIBS"/zenith-mc-*+"$MC".jar 2>/dev/null | head -1 || true)
  if [ -z "$MC_JAR" ]; then
    echo "No Zenith MC jar for Minecraft $MC in $MC_LIBS: run ./gradlew build -Pmc=$MC in ~/tools/zenith-mc first." >&2
    exit 1
  fi
  MC_NAME=$(basename "$MC_JAR" | tr + -) # zenith-mc-0.3.0-26.2.jar: some servers read a + in an address as a space
  cp "$MC_JAR" "$OUT/$MC_NAME"
  MC_SIZE=$(size_of "$OUT/$MC_NAME")
  MC_SHA=$(shasum -a 256 "$OUT/$MC_NAME" | cut -d' ' -f1)
  MC_KEY=$(echo "$MC" | tr . _)
  sed -i '' -e "s/__MC_JAR_${MC_KEY}__/$MC_NAME/g" -e "s/__MC_SIZE_${MC_KEY}__/$MC_SIZE/" -e "s/__MC_SHA_${MC_KEY}__/$MC_SHA/" \
    "$OUT/index.html" "$OUT/mc.html"
done
SIZE=$(size_of "$APP_ZIP")
SHA=$(shasum -a 256 "$APP_ZIP" | cut -d' ' -f1)
sed -i '' -e "s/__SIZE__/$SIZE/" -e "s/__SHA__/$SHA/" "$OUT/index.html" "$OUT/mc.html"
# The version number, its date and the list of what is new come from the one
# file the app itself reads, so the page and the app cannot disagree.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { ZENITH_VERSION, changesAsHtml } from "./src/app/zenithVersion.js";
  for (const file of process.argv.slice(1)) {
    const page = readFileSync(file, "utf8")
      .replaceAll("__VERSION__", () => ZENITH_VERSION.number)
      .replaceAll("__DATE__", () => ZENITH_VERSION.date)
      .replaceAll("__WHATS_NEW__", () => changesAsHtml());
    if (/__[A-Z_]+__/.test(page)) throw new Error(`${file} still has an unfilled blank`);
    writeFileSync(file, page);
  }
' "$OUT/index.html" "$OUT/mc.html"
echo "Built $OUT ($(du -sh "$OUT" | cut -f1)). Nothing was published."
