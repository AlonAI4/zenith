#!/bin/zsh
# Downloads official OpenStreetMap country files (Geofabrik) one at a time,
# keeps only the rail stops, deletes each big file, then builds the small
# bundled file the train stations layer reads. Safe to re-run: a country that
# is already extracted is skipped. Add a line to REGIONS for more countries.
set -e
cd "$(dirname "$0")"
REGIONS=(
  "israel-and-palestine asia/israel-and-palestine"
  "portugal europe/portugal"
  "spain europe/spain"
  "england europe/united-kingdom/england"
)
WORK=.gev-cache/alon-stations
mkdir -p "$WORK"
command -v osmium >/dev/null || { echo "Installing osmium (the tool that reads these files)..."; brew install osmium-tool; }
for entry in $REGIONS; do
  name=${entry%% *}; region=${entry##* }
  if [ -s "$WORK/$name.geojsonseq" ]; then echo "$name: already extracted, skipping"; continue; fi
  echo "$name: downloading..."
  curl -fL --retry 3 -C - -o "$WORK/$name.osm.pbf" "https://download.geofabrik.de/$region-latest.osm.pbf"
  echo "$name: keeping only rail stops..."
  osmium tags-filter "$WORK/$name.osm.pbf" n/railway=station,halt,tram_stop -o "$WORK/$name.rail.osm.pbf" --overwrite
  osmium export "$WORK/$name.rail.osm.pbf" -f geojsonseq --geometry-types=point -o "$WORK/$name.geojsonseq" --overwrite
  rm -f "$WORK/$name.osm.pbf" "$WORK/$name.rail.osm.pbf"
  sleep 5
done
node alon-stations-build.mjs "$WORK"
ls -lh public/alon/stations.json
