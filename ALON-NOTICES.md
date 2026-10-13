# Credits for what Zenith adds

Zenith is a renamed build of God's Eye View. The original project's licence is
in `LICENSE` (MIT, Copyright (c) 2026 Bilawal Sidhu) and its own third-party
credits are in `THIRD_PARTY_NOTICES.md` and `DATA_SOURCES.md`. This file only
covers what was added on top.

| What | Where it comes from | Licence or terms |
|---|---|---|
| Train, metro and tram stops (`public/alon/stations.json`) | © OpenStreetMap contributors, taken from Geofabrik country extracts for England, Spain, Portugal, and Israel and Palestine | Open Database Licence (ODbL) 1.0. Credit OpenStreetMap, and share any changed version of this data under the same licence |
| Time zone borders (`public/alon/timezones.json`) | © OpenStreetMap contributors, from the timezone-boundary-builder project (release 2026e, the "with oceans, now" file), simplified for this build by `alon-timezones-build.mjs` | Open Database Licence (ODbL) 1.0. Credit OpenStreetMap, and share any changed version of this data under the same licence. The simplified file here is shared under that same licence |
| City lights at night (`public/alon/night-lights.webp`) | NASA Earth Observatory, Black Marble 2016, from Suomi NPP VIIRS data, made smaller from NASA's 3 km picture. Fetched once by `alon-nightlights-download.sh` | NASA images are not under copyright. NASA asks to be acknowledged as the source and that no endorsement is implied |
| Place and road labels | Esri reference map tiles (World Boundaries and Places, World Transportation), loaded live | Esri's terms of use; shown with the credit "Labels © Esri and its data providers". Personal, non-commercial use |
| Addresses on click | Photon (photon.komoot.io), which searches OpenStreetMap data, asked live | Address data © OpenStreetMap contributors, ODbL. Photon is a free courtesy service: light, hand-triggered use only |
| Well-known place names on click | Wikipedia's public search, asked live | Article titles from Wikipedia. Text on Wikipedia is under CC BY-SA 4.0 |
| The Zenith logo (`public/alon/zenith-logo.svg`) | Drawn for this build | Belongs to this build's author |
| The added code (`src/app/*`, `src/ui/buttonTooltips.js`, `panelFullscreen.js`, `customSelect.js`, `branding.js`) | Written for this build | MIT, the same as the project |

The name "Zenith" is also used by other products. No trade mark search has
been done.
