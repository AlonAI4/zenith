/**
 * Hover tooltips for buttons that ship without a `title`.
 *
 * A button that has its own non-empty `title` is never touched. Text comes
 * from, in order: the button's id, a rule for its kind, its `aria-label`.
 * Buttons created later, and ones whose `aria-label` changes, are picked up
 * by a debounced observer.
 */

const MARK = 'data-auto-title';
const PASS_DELAY_MS = 250;

const BY_ID = {
  'control-panel-toggle': 'Show or hide the visual presets',
  'key-setup-chip': 'Add or change API keys',
  'global-context-missions-btn':
    'Show space missions you can select and inspect',
  'cockpit-entry': 'Enter the cockpit of the tracked aircraft',
  'installations-search-btn': 'Search for mapped installations nearby',
  'radio-enable-btn': 'Turn the radio layer on or off',
  'context-radio-mini-enable-btn': 'Turn the radio layer on or off',
  'cockpit-radio-enable-btn': 'Turn the radio layer on or off',
  'sdr-connect-btn': 'Connect a local RTL-SDR radio receiver over USB',
  'sdr-mode-fm-btn': 'Use the receiver for FM radio',
  'sdr-mode-adsb-btn': 'Use the receiver for aircraft signals on 1090 MHz',
  'sdr-tune-btn': 'Tune to the FM frequency entered',
  'sdr-seek-back-btn': 'Seek down to the previous FM station',
  'sdr-seek-forward-btn': 'Seek up to the next FM station',
  'detection-allocation-elastic':
    'Split detection labels elastically between layers',
  'detection-allocation-weighted':
    'Split detection labels between layers by weight',
  'models3d-mode-proximity': 'Show 3D models for the nearest aircraft only',
  'models3d-mode-all': 'Show 3D models for every aircraft in view',
  'cctv-enable-btn': 'Turn the CCTV camera layer on or off',
  'cctv-nearest-btn': 'Select the nearest camera and fly to it',
  'cctv-prev-btn': 'Go to the previous camera',
  'cctv-next-btn': 'Go to the next camera',
  'cctv-focus-btn': 'Fly to the selected camera',
  'cctv-coverage-btn': 'Cycle camera coverage: off, outlines, viewshed',
  'cctv-auto-hop-btn': 'Turn automatic hopping between cameras on or off',
  'cctv-projection-btn':
    'Turn the camera picture projected into the scene on or off',
  'cctv-calib-save-btn': "Save this camera's calibration",
  'cctv-calib-reset-btn': "Reset this camera's calibration",
  'scene-new-btn': 'Create a new scene',
  'scene-delete-btn': 'Delete the selected scene',
  'scene-capture-btn': 'Capture the current view as a shot',
  'scene-update-shot-btn': 'Update the selected shot with the current view',
  'scene-start-btn': 'Start playing the selected scene',
  'scene-stop-btn': 'Stop the scene',
  'scene-next-btn': 'Go to the next shot',
  'scene-export-btn': 'Export scene presets to a file',
  'scene-import-btn': 'Import scene presets from a JSON file',
  'scene-download-btn': 'Download the scene run log',
};

const BY_FIRST_RUN_CHOICE = {
  contacts: 'Start with live aircraft and vessels',
  'space-missions': 'Start with space missions',
  environmental: 'Start with earthquakes and active fires',
  explore: 'Start with a clean globe',
};

const BY_SHAPE = {
  area: 'Draw an area outline',
  line: 'Draw a line',
  pin: 'Drop a pin',
};

const BY_STREET_LEVEL_KIND = {
  all: 'Show all street-level images',
  pano: 'Show only 360° panoramas',
  flat: 'Show only flat photos',
};

// Buttons with no id, told apart by their own label inside a known group.
const BY_CLASS_AND_LABEL = {
  'scene-shot-btn': {
    LOAD: 'Load this shot',
    DEL: 'Delete this shot',
  },
  'scene-btn': {
    'EDIT DETAILS': "Edit this scene's details",
    'SHARE SCENE': 'Share this scene',
  },
  'ri-mode-btn': {
    IMAGE: "Show one day's satellite image",
    'VS BASEMAP': 'Swipe that image against the basemap',
    'A / B': "Swipe one day's image against another day's",
  },
  'key-setup-apply': { 'SAVE KEYS': 'Save keys and restart the server' },
  'gev-voice-error-dismiss': { DISMISS: 'Dismiss this voice error' },
};

function labelOf(button) {
  return String(button.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The tooltip a title-less button should get, or '' when nothing accurate is
 * known about it.
 * @param {Element} button
 * @returns {string}
 */
export function tooltipFor(button) {
  if (BY_ID[button.id]) return BY_ID[button.id];

  const data = button.dataset || {};
  if (BY_FIRST_RUN_CHOICE[data.firstRunChoice])
    return BY_FIRST_RUN_CHOICE[data.firstRunChoice];
  if (BY_SHAPE[data.shape]) return BY_SHAPE[data.shape];
  if (BY_STREET_LEVEL_KIND[data.slPano])
    return BY_STREET_LEVEL_KIND[data.slPano];

  const label = labelOf(button);
  const aria = String(button.getAttribute('aria-label') || '').trim();
  const has = (name) => !!button.classList?.contains(name);

  if (has('location-pill') && label) return `Fly to ${label}`;
  // Layer rows label themselves "Satellites: OFF"; the tooltip names the
  // action instead of repeating the state.
  if (has('data-toggle-btn') && aria.includes(':'))
    return `Turn ${aria.slice(0, aria.lastIndexOf(':')).trim()} on or off`;
  if (has('rail-card-header')) return 'Show or hide these details';
  for (const [className, byLabel] of Object.entries(BY_CLASS_AND_LABEL)) {
    if (has(className) && byLabel[label]) return byLabel[label];
  }
  return aria;
}

/**
 * Title every button under `root` that has no `title` of its own, and keep
 * them current as the page changes.
 * @param {Document} [root]
 * @returns {() => void} Stops watching.
 */
export function initButtonTooltips(root = document) {
  let timer = null;

  const pass = () => {
    timer = null;
    for (const button of root.querySelectorAll('button')) {
      const current = button.getAttribute('title') || '';
      // A title this module did not write belongs to the button's own code.
      if (current && current !== button.getAttribute(MARK)) continue;
      const text = tooltipFor(button);
      if (!text || text === current) continue;
      button.setAttribute('title', text);
      button.setAttribute(MARK, text);
    }
  };

  const observer = new MutationObserver((records) => {
    if (timer !== null) return;
    const relevant = records.some(
      (record) =>
        record.type === 'attributes' ||
        Array.from(record.addedNodes).some((node) => node.nodeType === 1),
    );
    if (relevant) timer = setTimeout(pass, PASS_DELAY_MS);
  });
  observer.observe(root.body || root, {
    childList: true,
    subtree: true,
    attributes: true,
    // 'title' too: some controls blank their own title on every render.
    attributeFilter: ['aria-label', 'title'],
  });
  pass();

  return () => {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
}
