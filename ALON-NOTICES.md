# Credits for what Zenith adds

Zenith is a renamed build of God's Eye View. The original project's licence is
in `LICENSE` (MIT, Copyright (c) 2026 Bilawal Sidhu) and its own third-party
credits are in `THIRD_PARTY_NOTICES.md` and `DATA_SOURCES.md`. This file only
covers what was added on top.

| What | Where it comes from | Licence or terms |
|---|---|---|
| Train, metro and tram stops (`public/alon/stations.json`) | © OpenStreetMap contributors, taken from Geofabrik extracts for the United Kingdom, Germany, Italy, the Netherlands, Spain, Portugal, Israel and Palestine, and twelve US states and Washington DC (cut down to eleven city areas) | Open Database Licence (ODbL) 1.0. Credit OpenStreetMap, and share any changed version of this data under the same licence |
| Time zone borders (`public/alon/timezones.json`) | © OpenStreetMap contributors, from the timezone-boundary-builder project (release 2026e, the "with oceans, now" file), simplified for this build by `alon-timezones-build.mjs` | Open Database Licence (ODbL) 1.0. Credit OpenStreetMap, and share any changed version of this data under the same licence. The simplified file here is shared under that same licence |
| City lights at night (`public/alon/night-lights.webp`) | NASA Earth Observatory, Black Marble 2016, from Suomi NPP VIIRS data, made smaller from NASA's 3 km picture. Fetched once by `alon-nightlights-download.sh` | NASA images are not under copyright. NASA asks to be acknowledged as the source and that no endorsement is implied |
| Earthquakes | U.S. Geological Survey, Earthquake Hazards Program real-time feed (past day, magnitude 2.5 and up), asked live every five minutes while the switch is on | A work of the US government, in the public domain. Credited on screen as the source |
| Older camera pictures (camera look-back) | Fintraffic's weather-camera history (digitraffic.fi), DriveBC's "replay the day" pictures and Caltrans's previous pictures, asked live and shown only, never saved | Fintraffic: CC BY 4.0. Caltrans: public domain unless marked otherwise. DriveBC: the Province of British Columbia's terms. Credited on screen with each camera, as the original project already does |
| Place and road labels | Esri reference map tiles (World Boundaries and Places, World Transportation), loaded live | Esri's terms of use; shown with the credit "Labels © Esri and its data providers". Personal, non-commercial use |
| Addresses on click | Photon (photon.komoot.io), which searches OpenStreetMap data, asked live | Address data © OpenStreetMap contributors, ODbL. Photon is a free courtesy service: light, hand-triggered use only |
| Well-known place names on click | Wikipedia's public search, asked live | Article titles from Wikipedia. Text on Wikipedia is under CC BY-SA 4.0 |
| Pictures on the download page (`alon-site/shots`, not in the zip) | Screen captures of this app on its satellite map: Esri World Imagery (Esri, Maxar, Earthstar Geographics, and the GIS User Community), drawn with Cesium, with the layers credited in each picture | Esri's terms of use for static maps allow screen captures on a website that promotes your own product, with attribution on or near the picture. No picture shows the Google 3D map: its rules do not clearly allow still pictures |
| The Zenith emblem, wordmark and icon (`public/alon/zenith-emblem.webp`, `zenith-wordmark.webp`, `zenith-z.webp`, `zenith-favicon.png`) | Made with ChatGPT image generation, from prompts written for this build | OpenAI's terms give the person who made them the rights in them, as far as the law allows. Pictures made by AI may not be protected by copyright |
| The Zenith logo drawing (`public/alon/zenith-logo.svg`) | Drawn in SVG code for this build | Belongs to this build's author |
| The added code: the files in `src/app` that the original project does not have, `src/ui/branding.js`, `buttonTooltips.js`, `customSelect.js`, `panelFullscreen.js`, `shortcutGuard.js`, `toggleLook.js`, the `security-tests` folder, the `alon-*` scripts and `Start Zenith.command` | Written for this build | MIT, the same as the project |
| Small changes to the original's files: `src/main.js` (starts the add-ons), `index.html` (the Zenith name and icon), the header and loading screen templates (the Zenith name and emblem), and the camera files `src/layers/cctv/cards.js`, `src/ui/cctvPresentation.js`, `src/data/cctvLod.js` (and its test) and `server/providers/cctv/sources.js` | Changed for this build | MIT, the same as the project |

The name "Zenith" is also used by other products. No trade mark search has
been done.
