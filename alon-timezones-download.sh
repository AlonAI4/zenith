#!/bin/zsh
# Downloads the world's time zone shapes (timezone-boundary-builder, made from
# OpenStreetMap, ODbL) and builds the small file the time zones layer reads.
# Safe to re-run: the download is skipped when the file is already there.
# For newer borders, change RELEASE to the latest one listed at
# https://github.com/evansiroky/timezone-boundary-builder/releases
set -e
cd "$(dirname "$0")"
RELEASE=2026e
WORK=.gev-cache/alon-timezones
mkdir -p "$WORK"
if [ ! -s "$WORK/combined-with-oceans-now.json" ]; then
  echo "Downloading the time zone shapes (about 27 MB)..."
  curl -fL --retry 3 -o "$WORK/zones.zip" "https://github.com/evansiroky/timezone-boundary-builder/releases/download/$RELEASE/timezones-with-oceans-now.geojson.zip"
  unzip -o -q "$WORK/zones.zip" -d "$WORK"
  rm -f "$WORK/zones.zip"
fi
node alon-timezones-build.mjs "$WORK/combined-with-oceans-now.json"
ls -lh public/alon/timezones.json
