# Zenith: installation guide

Zenith is a live 3D globe for the Mac: aircraft, ships, satellites, fires,
public traffic cameras, train stations and more on one map. It is built on
**God's Eye View** by Bilawal Sidhu, an open-source project under the MIT
licence (see `LICENSE`). The data and code this build adds are credited in
`ALON-NOTICES.md`.

**If you are under 18, ask a parent or guardian before installing.** Zenith
runs programs on your Mac, and each key below needs an account. Two of them
cost money for every use.

## Requirements

- A Mac.
- Node.js 26, or version 24 at 24.14 or newer, from https://nodejs.org. Type
  `node -v` in Terminal to see yours.

## Install and start

**The quick way.** Unzip the download, open the `Zenith` folder and
double-click `Start Zenith.command`. A Terminal window opens, lists what it is
about to do and waits for you to press Return. The first run downloads the
packages Zenith needs (about 350 MB, a few minutes). After that it starts in
seconds and opens Zenith in your browser. Closing that window stops Zenith.

The first time, macOS will ask you to confirm the file, or block it until you
allow it, because it was downloaded from the internet and does not come from
the App Store. To allow it, open System Settings, choose Privacy & Security,
scroll down and click **Open Anyway** next to its name. On older versions of
macOS, right-click the file and choose Open instead. If you are not sure, ask
a parent or guardian before you allow it.

**By hand**, if you would rather type the commands yourself:

1. Unzip the download. You get a folder called `Zenith`.
2. Open the Terminal app, type `cd ` (with a space), drag the `Zenith` folder
   onto the window, and press Return.
3. Run this once. It downloads the parts the app needs and takes a few minutes:

       npm install

4. Run this every time you want to use Zenith:

       npm run dev

5. Open http://localhost:4173 in your browser. Leave the Terminal window open
   while you use it. Press Ctrl+C in the Terminal to stop it.

## What this build adds

These sit on top of everything God's Eye View already does. Most have a
switch in the top bar (on a narrow window the switches fold into a "more"
tray, and the help card lists them all). The compass dial, distance scale,
tracking marker, Earth centring, 3D map recovery and full-screen buttons are
always there; the height profile is inside the measure tool, fly-through is
inside saved places, and the settings file and version are at the bottom of
the help card.

| Feature | What it does |
|---|---|
| Compass dial | Drag the ring to turn the view, click N for north up, drag the side arc to tilt. |
| Distance scale | A ruler on the left edge with a round number, such as 500 m. |
| Time zones | Zone borders with their offsets from UTC. |
| Tracking marker | A pulsing ring on whatever you are following when you zoom far out. Click it to fly back. |
| HD buildings | Sharper 3D buildings. On from the start; switch it off to use less data and graphics power. |
| Train stations | Train, metro and tram stops across the UK, Germany, Italy, the Netherlands, Spain, Portugal and Israel, and in eleven big city areas of the USA. |
| Earthquakes | The last day's earthquakes of magnitude 2.5 and up, from the U.S. Geological Survey, as circles sized by strength. Colours show strength: yellow under 4, orange 4 to 5.5, red 5.5 and up. Click one for its strength, place, time and depth. This is separate from the original project's Earthquakes (24h) layer in Data layers > Events, which uses the same magnitude 2.5 and up feed, refreshes every minute, adds magnitude labels and colours by depth (red shallow, yellow deep). |
| Place names | Place and road names over the map. |
| Map pin | Switch it on, then click the map for the local time there (ticking, with its UTC offset), whether it is day or night, the next sunrise and sunset, the coordinates and the address. From very high up it gives everything but the address. |
| Day and night | Shades the night side of the Earth, shows city lights there, and draws the line where night begins. Its slider moves the shading up to half a day either way; Now puts it back on the real time. |
| Measure tool | Click two or more spots on the map to get the distance between them. Undo removes the last point. Close the shape, or click the first point again, to get its area. |
| Height profile | In the measure tool, Profile draws a chart of the height along the path, with its highest and lowest points. The 3D map measures the scanned surface (roofs and treetops count); the satellite map measures bare ground and needs the Cesium key. Heights are shown above the lowest point on the path, not above sea level. |
| Saved places | Star the view on screen, name it, and fly back with one click. A place also remembers which map, visual preset and data layers were on. The list stays on your computer. |
| Fly-through | In saved places, tick two or more places and press Fly through: the controls hide and the view travels from one to the next, for recording. Any key or click ends it. |
| Video mode | Hides the controls and circles the spot in the middle of the screen, for recording. Choose slow, normal or fast and which way round, then Start. Any key or click ends it. The map credits stay on screen: keep them in frame in anything you post. |
| Help card | The "?" switch explains every switch and what clicking the map does. |
| Settings file | At the bottom of the help card: save your switches and saved places to a file, and load that file in another browser or on another Mac. The file never holds a key. |
| Version | The bottom of the help card says which build this is and lists what is new in it. |
| Earth stays centred | Zooming far out slowly turns the view to look straight down at the Earth, and the tilt comes back as you zoom in. You can still tilt by hand at any height, and there is no zoom limit. |
| 3D map recovery | If the 3D map stops loading, Zenith switches to the satellite map by itself and says so, then tries the 3D map again later. |
| Full screen | Camera pictures and Street Level have a button that fills the screen with them. Escape goes back. |

## API keys: bring your own

A key is a password a data service gives you so the app can use its data.
This copy has **no keys in it**. Most of the globe works without any. To switch
on more, click **POWER UP** in the app and paste your own keys there:

| Key | What it adds | Where |
|---|---|---|
| Google Maps (paid) | Street View, place search, and 3D buildings straight from Google. Google bills this key for every use, so it needs a payment card: a parent must own it and set a spending limit first | https://developers.google.com/maps/documentation/tile/get-api-key |
| OpenAI (paid) | Voice control. OpenAI bills this key for every use: a parent must own it | https://platform.openai.com/api-keys |
| Cesium ion | 3D buildings through Cesium, world terrain (the satellite map's height profile) and more satellite maps | https://ion.cesium.com/tokens |
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
camera networks, and Google Fonts. With the earthquakes switch on, the
U.S. Geological Survey's feed is asked every five minutes. If you switch on the map pin and click the
map, the coordinates of that spot go to Photon and Wikipedia to look up the
address. If you switch on Street View, Google Maps sees the places you open.

## Updates

This copy does not update itself. Download the newest version from the page
you got it from.
