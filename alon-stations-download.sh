#!/bin/zsh
# Downloads official OpenStreetMap country files (Geofabrik) one at a time,
# keeps only the rail stops, deletes each big file, then builds the small
# bundled file the train stations layer reads. Safe to re-run: a country that
# is already extracted is skipped. Add a line to REGIONS for more countries.
#
# One special case: the USA is only its largest city areas (listed in
# alon-stations-build.mjs), cut out of the files of the states they are in.
# The UK comes as one file, because Northern Ireland has no file of its own.
set -e
cd "$(dirname "$0")"
REGIONS=(
  "israel-and-palestine asia/israel-and-palestine"
  "portugal europe/portugal"
  "spain europe/spain"
  "united-kingdom europe/united-kingdom"
  "netherlands europe/netherlands"
  "italy europe/italy"
  "germany europe/germany"
)
US_STATES=(district-of-columbia new-jersey maryland connecticut massachusetts pennsylvania georgia illinois virginia new-york florida texas california)
WORK=.gev-cache/alon-stations
BASE=https://download.geofabrik.de
RAIL="n/railway=station,halt,tram_stop"
mkdir -p "$WORK"
command -v osmium >/dev/null || { echo "Installing osmium (the tool that reads these files)..."; brew install osmium-tool; }

# Download one file, after checking it fits with room to spare.
fetch() {
  local name="$1" region="$2" url="$BASE/$2-latest.osm.pbf"
  local size=$(curl -sIL --max-time 30 "$url" | awk 'tolower($1)=="content-length:"{s=$2} END{gsub("\r","",s); print s+0}')
  local free=$(( $(df -k "$WORK" | awk 'NR==2{print $4}') * 1024 ))
  if (( size > 0 && free < size + 1500000000 )); then
    echo "STOP: $name needs $(( size / 1048576 )) MB and only $(( free / 1048576 )) MB is free. Free some space and run this again."
    exit 1
  fi
  echo "$name: downloading $(( size / 1048576 )) MB..."
  curl -fL --retry 3 -C - -s -o "$WORK/$name.osm.pbf" "$url"
}

# Keep only the rail stops of a big file, as one stop per line.
stops() {
  osmium tags-filter "$1" $RAIL -o "$1.rail.osm.pbf" --overwrite
  osmium export "$1.rail.osm.pbf" -f geojsonseq --geometry-types=point -o "$2" --overwrite
  rm -f "$1.rail.osm.pbf"
}

for entry in $REGIONS; do
  name=${entry%% *}; region=${entry##* }
  if [ -s "$WORK/$name.geojsonseq" ]; then echo "$name: already extracted, skipping"; continue; fi
  fetch "$name" "$region"
  echo "$name: keeping only rail stops..."
  stops "$WORK/$name.osm.pbf" "$WORK/$name.geojsonseq"
  rm -f "$WORK/$name.osm.pbf"
  sleep 5
done

if [ -s "$WORK/usa-cities.geojsonseq" ]; then
  echo "usa-cities: already extracted, skipping"
else
  for state in $US_STATES; do
    # Kept under another ending until all are done, so a half-finished run
    # is never mistaken for a country.
    if [ -s "$WORK/us-$state.stops" ]; then echo "us-$state: already extracted, skipping"; continue; fi
    fetch "us-$state" "north-america/us/$state"
    echo "us-$state: keeping only rail stops..."
    stops "$WORK/us-$state.osm.pbf" "$WORK/us-$state.stops"
    rm -f "$WORK/us-$state.osm.pbf"
    sleep 5
  done
  echo "usa-cities: keeping only the largest city areas..."
  node alon-stations-build.mjs --us-cities "$WORK"/us-*.stops > "$WORK/usa-cities.tmp"
  mv "$WORK/usa-cities.tmp" "$WORK/usa-cities.geojsonseq"
  rm -f "$WORK"/us-*.stops
fi

node alon-stations-build.mjs "$WORK"
ls -lh public/alon/stations.json
