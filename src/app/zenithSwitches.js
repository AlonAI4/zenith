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
    id: 'address-lookup-toggle',
    name: 'Map pin',
    what: 'Click the map for local time and coordinates, and in London the address.',
  },
  {
    id: 'hd-detail-toggle',
    name: 'HD buildings',
    what: 'Sharper 3D buildings. Heavier on data and graphics.',
  },
  {
    id: 'measure-toggle',
    name: 'Measure',
    what: 'Click two or more spots on the map to get the distance between them.',
  },
  {
    id: 'zenith-help-toggle',
    name: 'Help',
    what: 'Opens the card that explains the switches and map clicks.',
  },
]);
