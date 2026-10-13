#!/bin/zsh
# Fetches NASA's "Black Marble" picture of the Earth at night (2016, from the
# Suomi NPP satellite) and builds public/alon/night-lights.webp from it, the
# picture the day-and-night switch shows on the dark side of the Earth.
# NASA pictures are not under copyright; NASA asks to be credited (the credit
# is in ALON-NOTICES.md and on screen). Run once; the result is saved in git.
set -e
cd "$(dirname "$0")"
SRC="https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg"
CACHE=.gev-cache/alon-nightlights
mkdir -p "$CACHE"
if [ ! -s "$CACHE/BlackMarble_2016_01deg.jpg" ]; then
  echo "Downloading the night-lights picture from NASA (about 0.8 MB)..."
  curl -fsSL --max-time 120 -o "$CACHE/BlackMarble_2016_01deg.jpg" "$SRC"
fi
node -e "
const sharp = require('sharp');
sharp('$CACHE/BlackMarble_2016_01deg.jpg')
  .webp({ quality: 82 })
  .toFile('public/alon/night-lights.webp')
  .then((info) => console.log('Built public/alon/night-lights.webp', info.width + 'x' + info.height, Math.round(info.size / 1024) + ' KB'));
"
