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
./alon-share.sh "$OUT/Zenith.zip" > /dev/null
# Refuse to build a site around a zip that fails the key check.
node security-tests/share-zip.mjs --zip "$OUT/Zenith.zip"
SIZE="$(du -h "$OUT/Zenith.zip" | cut -f1 | tr -d ' ')B"
SHA=$(shasum -a 256 "$OUT/Zenith.zip" | cut -d' ' -f1)
DAY=$(date "+%-d %B %Y")
sed -i '' -e "s/__SIZE__/$SIZE/" -e "s/__SHA__/$SHA/" -e "s/__DATE__/$DAY/" "$OUT/index.html"
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
