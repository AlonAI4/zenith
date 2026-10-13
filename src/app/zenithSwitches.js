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
    what: 'Writes place and road names over the map.',
  },
  {
    id: 'train-stations-toggle',
    name: 'Train stations',
    what: 'Marks train, metro and tram stops. Click one for its name.',
  },
  {
    id: 'time-zones-toggle',
    name: 'Time zones',
    what: 'Draws the time zone borders, each with its offset from UTC.',
  },
  {
    id: 'address-lookup-toggle',
    name: 'Map pin',
    what: 'When on, clicking the map shows the local time and coordinates there, and in London the address.',
  },
  {
    id: 'hd-detail-toggle',
    name: 'HD buildings',
    what: 'Sharper 3D buildings. Uses more data and more graphics power.',
  },
]);
