# Zenith smoothness: before and after

Measured with `node alon-smooth-check.mjs` (and the variant runs noted below) in
Chrome on this Mac (M1), 1440 x 900 at Retina sharpness, on the free satellite
map of London with the paid 3D map blocked. Each number is the better of two
runs. Other chats were busy on the Mac at the same time (load 5 to 16), so
compare rows measured together.

## What makes the map slow

| Setup (measured together, 17 Oct) | Frames a second while turning |
|---|---|
| Zenith, HD on (the default), before | 13.9 |
| Zenith, HD off | 50.1 |
| Zenith, HD on, normal (1x) sharpness | 54.7 |
| The original app alone (`?addons=off`) | 59.0 |

HD drew at full Retina resolution, four times the pixels, and the graphics chip
could not keep up: the page itself needed only about 2 ms of work a frame, and
70% of its time was spent waiting for the chip (`readPixels`). The add-ons cost
far less than HD.

## Change kept: adaptive HD (stage 3)

While the view moves, HD draws at the screen's normal sharpness; 250 ms after it
stops, it draws at full Retina sharpness again. The finer 3D building tiles stay.

| Setup (measured together) | Turning | Picture when still |
|---|---|---|
| HD on, adaptive | 42.3 | 2880 x 1800 (sharp) |
| HD off | 42.1 | 1440 x 900 |
| The original app alone | 46.1 | 1440 x 900 |

Full check, the same day:

| | Before (HD on) | After (adaptive HD) |
|---|---|---|
| Frames a second, turning | 18.9 | 53.6 |
| Frames a second, zooming | 19.3 | 56.1 |
| Work per frame (median) | 2.1 ms | 2.0 ms |
| Frames drawn while standing still | 0 a second | 0 a second |
| Page busy while standing still | 4.2% | 4.2% |

## Measured, not yet kept: a built Zenith instead of the dev server (stage 2)

| | Dev server | Built (`vite build`, then `vite preview`) |
|---|---|---|
| First start, ready to use | 7.9 s | 6.7 s |
| First start, map drawn | 9.3 s | 7.5 s |
| Reload, map drawn | 10.2 s | 7.0 s |
| Files loaded | 1,846 | 878 |
| Data loaded | 61 MB | 10 MB |
| Memory (JavaScript) | 87 MB | 58 MB |
| Frames a second, turning | 53.6 | 51.8 |

The built version starts about 1.5 s faster and uses a third less memory. The
catch: the browser-side keys (Google Maps, Cesium ion, Mapillary) are put into
the page when it is built, so the app would have to build Zenith on the user's
Mac, and again after every POWER UP change, and POWER UP only works on the dev
server today. Waiting for Alon's choice.

## Not measured

- Inside the app's own WebKit window: the measuring window built for it did not
  report back (with the paid 3D map blocked inside WebKit, the app waited on its
  loading screen). The cause of the slowness is pixels for the graphics chip,
  which WebKit draws the same way.
- Memory of the app's WebKit page.

## After the review (803c64e)

A fresh-context review found that Cesium's camera move events also fire when
the view's shape changes, which a change of resolution does at in-between
scalings, so HD could switch sharp and blurry again and again. HD now decides
from the camera's own place and direction. Checked in Chrome at 1.25, 1.5, 1.75
and 2 device pixels per point: no switches and no frames drawn in ten idle
seconds. Turning by hand: about 49 frames a second. Video mode and fly-through
stay at full sharpness (2880 wide) for recordings.
