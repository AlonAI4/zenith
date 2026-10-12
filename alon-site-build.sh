#!/bin/zsh
# Builds the Zenith download website into .gev-cache/zenith-site (not saved in
# git): the page, the pictures and a fresh share zip that has passed the
# no-keys check. It does NOT publish anything.
set -e
cd "$(dirname "$0")"
OUT=.gev-cache/zenith-site
rm -rf "$OUT"
mkdir -p "$OUT"
cp alon-site/index.html alon-site/style.css alon-site/_headers alon-site/robots.txt "$OUT"/
cp public/alon/zenith-wordmark.webp public/alon/zenith-favicon.png "$OUT"/
./alon-share.sh "$OUT/Zenith-share.zip" > /dev/null
# Refuse to build a site around a zip that fails the key check.
node security-tests/share-zip.mjs --zip "$OUT/Zenith-share.zip"
SIZE="$(du -h "$OUT/Zenith-share.zip" | cut -f1 | tr -d ' ')B"
SHA=$(shasum -a 256 "$OUT/Zenith-share.zip" | cut -d' ' -f1)
DAY=$(date "+%-d %B %Y")
sed -i '' -e "s/__SIZE__/$SIZE/" -e "s/__SHA__/$SHA/" -e "s/__DATE__/$DAY/" "$OUT/index.html"
echo "Built $OUT ($(du -sh "$OUT" | cut -f1)). Nothing was published."
