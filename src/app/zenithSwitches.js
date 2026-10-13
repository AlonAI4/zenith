/**
 * The toolbar switches this build adds, in the order they sit in the bar.
 *
 * One list so the two things that need it agree: the tray that holds the
 * switches on a narrow window, and the help card that explains them. A new
 * switch gets one line here.
 */
export const ZENITH_SWITCHES = Object.freeze([
  {
    id: 'map-labels-toggle',
    name: 'Place names',
    what: 'Place and road names over the map.',
  },
  {
    id: 'train-stations-toggle',
    name: 'Train stations',
    what: 'Train, metro and tram stops. Click one for its name.',
  },
  {
    id: 'time-zones-toggle',
    name: 'Time zones',
    what: 'Time zone borders with their offsets from UTC.',
  },
  {
    id: 'day-night-toggle',
    name: 'Day and night',
    what: 'Shades the night side of the Earth, with city lights and the line where night begins.',
  },
  {
    id: 'address-lookup-toggle',
    name: 'Map pin',
    what: 'Click the map for the local time, sunrise and sunset, the coordinates, and in London the address.',
  },
  {
    id: 'hd-detail-toggle',
    name: 'HD buildings',
    what: 'Sharper 3D buildings. Heavier on data and graphics.',
  },
  {
    id: 'measure-toggle',
    name: 'Measure',
    what: 'Click two or more spots for the distance between them. Close the shape to get its area.',
  },
  {
    id: 'saved-places-toggle',
    name: 'Saved places',
    what: 'Star the view on screen, name it, and fly back later. It remembers the map, the look and the layers too. Kept on this computer only.',
  },
  {
    id: 'video-mode-toggle',
    name: 'Video mode',
    what: 'Hides the controls and slowly circles the spot in the middle of the screen, for recording. Any key or click ends it.',
  },
  {
    id: 'zenith-help-toggle',
    name: 'Help',
    what: 'Opens the card that explains the switches and map clicks.',
  },
]);
