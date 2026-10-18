/**
 * The toolbar switches this build adds, in the order they sit in the bar.
 *
 * One list so the two things that need it agree: the tray that holds the
 * switches on a narrow window, and the help card that explains them. A new
 * switch gets one line here. `panel: true` marks a switch that opens a panel
 * of its own: the tray closes when one is pressed, so the two do not stack.
 * `closesTray: true` marks a switch whose next step is a click on the map
 * (Map pin, Measure): the tray closes for it too, so it is not in the way.
 * `group: 'layers'` marks a map overlay: it sits in the LAYERS menu
 * (toolbarLayout.js) instead of the bar.
 */
export const ZENITH_SWITCHES = Object.freeze([
  {
    id: 'zenith-layers-toggle',
    panel: true,
    name: 'Layers',
    what: 'Opens the menu of map overlays: place names, train stations, earthquakes, time zones, day and night, and HD buildings. The number on it is how many are on.',
  },
  {
    id: 'map-labels-toggle',
    group: 'layers',
    name: 'Place names',
    what: 'Place and road names over the map.',
  },
  {
    id: 'train-stations-toggle',
    group: 'layers',
    name: 'Train stations',
    what: 'Train, metro and tram stops. Click one for its name.',
  },
  {
    id: 'earthquakes-toggle',
    group: 'layers',
    name: 'Earthquakes',
    what: 'Magnitude 2.5 and up from the last day, sized and coloured by strength (yellow, orange, red). Click one for details. Not the same as Earthquakes (24h) in Data layers.',
  },
  {
    id: 'time-zones-toggle',
    group: 'layers',
    name: 'Time zones',
    what: 'Time zone borders with their offsets from UTC.',
  },
  {
    id: 'day-night-toggle',
    group: 'layers',
    name: 'Day and night',
    what: 'Shades the night side of the Earth, with city lights and the line where night begins. Drag its slider to see another time of day.',
  },
  {
    id: 'address-lookup-toggle',
    name: 'Map pin',
    closesTray: true,
    what: 'Click the map for the local time, sunrise and sunset, the coordinates and the address there.',
  },
  {
    id: 'hd-detail-toggle',
    group: 'layers',
    name: 'HD buildings',
    what: 'Sharper 3D buildings, on from the start. Switch off to save data and graphics.',
  },
  {
    id: 'classified-toggle',
    name: 'Classified look',
    what: 'The spy look, on from the start: decrypting target boxes, redacted lines (hover to read), a lock-on when you follow something, FLIR and CCTV readouts, an AGENT line with a Zulu clock. Only a look: everything shown is public map data. Your codename and radio blips are set below.',
  },
  {
    id: 'measure-toggle',
    name: 'Measure',
    closesTray: true,
    what: 'Click two or more spots for the distance between them. Close the shape for its area, or press Profile for the heights along the path.',
  },
  {
    id: 'saved-places-toggle',
    panel: true,
    name: 'Saved places',
    what: 'Star the view on screen, name it, and fly back later, with its map, look and layers. Tick two or more places to fly through them for a recording.',
  },
  {
    id: 'video-mode-toggle',
    panel: true,
    name: 'Video mode',
    what: 'Hides the controls and circles the spot in the middle of the screen, for recording. Pick the speed and direction, then Start. Any key or click ends it.',
  },
  {
    id: 'zenith-help-toggle',
    panel: true,
    name: 'Help',
    what: 'Opens the card that explains the switches and map clicks.',
  },
]);
