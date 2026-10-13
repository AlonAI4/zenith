# Zenith: installation guide

Zenith is a live 3D globe for the Mac: aircraft, ships, satellites, fires,
public traffic cameras, train stations and more on one map. It is built on
**God's Eye View** by Bilawal Sidhu, an open-source project under the MIT
licence (see `LICENSE`). The data and code this build adds are credited in
`ALON-NOTICES.md`.

**If you are under 18, ask a parent or guardian before installing.** Zenith
runs programs on your Mac, and each of the free keys below needs an account.

## Requirements

- A Mac.
- Node.js version 24 or 26, from https://nodejs.org (the "LTS" download is fine
  if it says 24).

## Install and start

1. Unzip the download. You get a folder called `Zenith`.
2. Open the Terminal app, type `cd ` (with a space), drag the `Zenith` folder
   onto the window, and press Return.
3. Run this once. It downloads the parts the app needs and takes a few minutes:

       npm install

4. Run this every time you want to use Zenith:

       npm run dev

5. Open http://localhost:4173 in your browser. Leave the Terminal window open
   while you use it. Press Ctrl+C in the Terminal to stop it.

macOS may ask whether you trust software downloaded from the internet. That is
expected for software distributed outside the App Store. If you are not sure,
ask a parent or guardian before you allow it.

## What this build adds

These sit on top of everything God's Eye View already does. Each one has a
switch in the top bar; on a narrow window the switches fold into a "more" tray.

| Feature | What it does |
|---|---|
| Compass dial | Drag the ring to turn the view, click N for north up, drag the side arc to tilt. |
| Distance scale | A ruler on the left edge with a round number, such as 500 m. |
| Time zones | Zone borders with their offsets from UTC, and a ticking local time for any spot you click. |
| Tracking marker | A pulsing ring on whatever you are following when you zoom far out. Click it to fly back. |
| HD buildings | A switch for sharper 3D buildings. It uses more data and graphics power. |
| Train stations | Train, metro and tram stops in four countries. |
| Place names | Place and road names over the map. |
| Map pin | Click the map for the local time and coordinates there, and in London the address. |
| Help card | The "?" switch explains every switch and what clicking the map does. |

## API keys: bring your own

A key is a password a data service gives you so the app can use its data.
This copy has **no keys in it**. Most of the globe works without any. To switch
on more, click **POWER UP** in the app and paste your own keys there:

| Key | What it adds | Where |
|---|---|---|
| Cesium ion | 3D buildings | https://cesium.com/ion |
| NASA FIRMS | Live fires | https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| AISStream | Live ships | https://aisstream.io |
| TomTom | Real traffic | https://my.tomtom.com/keys |
| Mapillary | Street photos | https://www.mapillary.com/dashboard/developers |

Never send your keys to anyone, and never post a screenshot that shows them.
Some of these services have age rules: a parent should read their terms and may
need to own the account.

## Privacy: what other services can see

Zenith has no accounts and sends nothing to its author or to whoever shared it
with you. But to draw the map it asks other services for data, and they see
your internet address (your IP) and roughly which areas you look at: the map
and 3D building providers (Google through Cesium, Esri, OpenStreetMap), the
camera networks, and Google Fonts. If you switch on the map pin and click the
map, the coordinates of that spot go to Photon and Wikipedia to look up the
address.

## Updates

This copy does not update itself. Download the newest version from the page
you got it from.
