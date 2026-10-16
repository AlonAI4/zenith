# Zenith

A live 3D globe of the whole world in your browser: aircraft, ships,
satellites, fires, public traffic cameras, train stations, earthquakes and more
on one map, over photorealistic 3D cities or a satellite map.

**Zenith is built on
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by
[Bilawal Sidhu](https://github.com/bilawalsidhu).** The globe, the 3D cities,
the live data layers and the visual presets all come from his open-source
project, shared under the MIT licence. Zenith adds its own tools on top and
keeps taking in updates from the original. The original project's own README is
kept unchanged in
[README.md](https://github.com/AlonAI4/zenith/blob/alon/README.md).

## What Zenith adds

- **Map pin**: switch it on, then click anywhere for the local time, day or night, sunrise and
  sunset, the coordinates and the address.
- **Train stations**: train, metro and tram stops across the UK, Germany,
  Italy, the Netherlands, Spain, Portugal and Israel, and eleven big US city
  areas.
- **Earthquakes switch**: the last day's earthquakes of magnitude 2.5 and up
  from the U.S. Geological Survey, sized and coloured by strength (the
  original project's own Earthquakes (24h) layer colours by depth).
- **Time zones** and **day and night**: zone borders with their UTC offsets,
  and the night side of the Earth with its city lights, at any time of day.
- **Measure tool** with a **height profile** along the path.
- **Compass dial**, **distance scale**, **place names**, **HD buildings** and a
  **tracking marker** for whatever you follow.
- **Camera look-back**: older pictures from the camera networks that keep
  them (Finland, British Columbia and three parts of California).
- **Saved places**, **fly-through** and **video mode** for recording.
- A **help card** that explains every switch, and a **settings file** to move
  your setup to another computer.

What each one does is in
[ZENITH-GUIDE.md](https://github.com/AlonAI4/zenith/blob/alon/ZENITH-GUIDE.md).

## Run it

You need [Node.js](https://nodejs.org) 26, or version 24 at 24.14 or newer. Zenith is built and tested on
macOS.

```bash
git clone https://github.com/AlonAI4/zenith.git
cd zenith
npm install
npm run dev
```

Then open http://localhost:4173.

Most of the globe works without any keys. For 3D buildings and the extra live
layers, click **POWER UP** in the app and paste your own keys (most are free; the Google Maps and
OpenAI keys are charged for every use); the guide lists where to get each one. Never commit a `.env` file or post a screenshot
that shows a key.

## Credits

- **God's Eye View** by Bilawal Sidhu: the app Zenith is built on. Its own
  credits for code and data are in
  [THIRD_PARTY_NOTICES.md](https://github.com/AlonAI4/zenith/blob/alon/THIRD_PARTY_NOTICES.md)
  and
  [DATA_SOURCES.md](https://github.com/AlonAI4/zenith/blob/alon/DATA_SOURCES.md).
- **What Zenith adds** uses data from OpenStreetMap contributors, the
  timezone-boundary-builder project, NASA Earth Observatory, the U.S.
  Geological Survey, Esri, Photon by Komoot and Wikipedia. Each source and its
  terms are in
  [ALON-NOTICES.md](https://github.com/AlonAI4/zenith/blob/alon/ALON-NOTICES.md).
- **Map credits** are shown live in the app, the way each map provider asks.
- Built with the help of **Claude Code** by Anthropic.

## Licence

MIT, see [LICENSE](https://github.com/AlonAI4/zenith/blob/alon/LICENSE). God's
Eye View is Copyright (c) 2026 Bilawal Sidhu. Zenith's own changes are by
AlonAI4 and shared under the same MIT licence. The train station and time zone
data are under the Open Database Licence (ODbL) instead, as
[ALON-NOTICES.md](https://github.com/AlonAI4/zenith/blob/alon/ALON-NOTICES.md)
explains.
