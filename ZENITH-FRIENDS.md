# Zenith: how to run it

Zenith is a live 3D globe: planes, ships, satellites, fires, public traffic
cameras, train stations and more. It is built on **God's Eye View** by Bilawal
Sidhu, an open-source project under the MIT licence (see `LICENSE`). The extra
features in this copy are listed in `ALON-NOTICES.md`.

**Ask a parent before you install it.** It runs programs on your Mac, and the
free keys below each need an account.

## What you need

- A Mac.
- Node.js version 24 or 26, from https://nodejs.org (the "LTS" download is fine
  if it says 24).

## Start it

1. Unzip the file. You get a folder called `Zenith`.
2. Open the Terminal app and type `cd ` (with a space), drag the `Zenith`
   folder onto the window, and press Return.
3. Run this once. It downloads the parts the app needs and takes a few minutes:

       npm install

4. Run this every time you want to use it:

       npm run dev

5. Open http://localhost:4173 in your browser. Leave the Terminal window open
   while you use it. Press Ctrl+C in the Terminal to stop it.

Your Mac may ask whether you trust something downloaded from the internet.
That is normal for software that does not come from the App Store. If you are
not sure, ask a parent.

## Keys: each person needs their own

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

## What other services can see

Zenith has no accounts and sends nothing to the person who gave it to you. But
to draw the map it asks other services for data, and they see your internet
address (your IP) and roughly which areas you look at: the map and 3D building
providers (Google through Cesium, Esri, OpenStreetMap), the camera networks,
and Google Fonts. If you switch on the pin button and click the map, the
coordinates of that spot go to Photon and Wikipedia to look up the address.

## Updates

This copy does not update itself. Ask for a new zip.
