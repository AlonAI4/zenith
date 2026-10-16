import { startAddOns } from './app/addOns.js';
import { installAddressLookup } from './app/addressLookup.js';
import { installCctvHistory } from './app/cctvHistory.js';
import { installCompassDial } from './app/compassDial.js';
import { installDayNight } from './app/dayNight.js';
import { installEarthquakes } from './app/earthquakes.js';
import { installFocusTips } from './app/focusTips.js';
import { installGlobeCentring } from './app/globeCentring.js';
import { installHdDetail } from './app/hdDetail.js';
import { installHelpCard } from './app/helpCard.js';
import { install3dMapWatchdog } from './app/map3dWatchdog.js';
import { installMapLabels } from './app/mapLabels.js';
import { installMeasureTool } from './app/measureTool.js';
import { installPanelGuard } from './app/panelGuard.js';
import { installRotateGestures } from './app/rotateGestures.js';
import { installSavedPlaces } from './app/savedPlaces.js';
import { installScaleBar } from './app/scaleBar.js';
import { installTimeZones } from './app/timeZones.js';
import { installToolbarFit } from './app/toolbarFit.js';
import { installTrackingMarker } from './app/trackingMarker.js';
import { installTrainStations } from './app/trainStations.js';
import { installVideoMode } from './app/videoMode.js';
import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initBranding } from './ui/branding.js';
import { initButtonTooltips } from './ui/buttonTooltips.js';
import { initCustomSelects } from './ui/customSelect.js';
import { initPanelFullscreen } from './ui/panelFullscreen.js';
import { initShortcutGuard } from './ui/shortcutGuard.js';
import { initToggleLook } from './ui/toggleLook.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

// Adding ?addons=off to the address starts the original app alone. It tells
// whether a problem, or a slow map, comes from this build's add-ons.
const addOnsOff =
  new URLSearchParams(globalThis.location?.search ?? '').get('addons') ===
  'off';

// Each add-on starts on its own: one that fails is named in a notice and the
// rest still start (see app/addOns.js).
const startMine = (list) => (addOnsOff ? [] : startAddOns(list));
startMine([
  ['Branding', () => initBranding()],
  ['Button tooltips', () => initButtonTooltips()],
  ['Menus', () => initCustomSelects()],
  ['Full-screen panels', () => initPanelFullscreen()],
  ['Blue switches', () => initToggleLook()],
  ['Shortcut guard', () => initShortcutGuard()],
]);
application
  .start()
  .then(
    () => {
      const { scene, controls, data } = application.getComponents();
      const styleManager = controls?.styleManager;
      // The app's own clean view, for the two add-ons that hide the controls.
      const setCleanView = styleManager?.setCleanView
        ? (on) => styleManager.setCleanView(on)
        : undefined;
      startMine([
        ['Panel guard', () => installPanelGuard(styleManager)],
        ['Rotate gestures', () => installRotateGestures(scene.viewer)],
        [
          'Compass',
          () =>
            installCompassDial(scene.viewer, document, {
              onTilted: () =>
                styleManager?._cameraOrientationControls?.refreshTilt?.(),
            }),
        ],
        ['Earth centring', () => installGlobeCentring(scene.viewer)],
        ['Tracking marker', () => installTrackingMarker(scene.viewer)],
        ['Scale', () => installScaleBar(scene.viewer)],
        ['Place names', () => installMapLabels(scene)],
        ['3D map recovery', () => install3dMapWatchdog(scene)],
        ['Train stations', () => installTrainStations(scene)],
        ['Earthquakes', () => installEarthquakes(scene)],
        ['Time zones', () => installTimeZones(scene)],
        ['Day and night', () => installDayNight(scene)],
        ['Map pin', () => installAddressLookup(scene)],
        ['Measure', () => installMeasureTool(scene)],
        [
          'Saved places',
          () =>
            installSavedPlaces(scene, document, {
              look: {
                styleManager,
                mapStackController: scene.mapStackController,
                dataManager: data?.dataManager,
              },
              setCleanView,
            }),
        ],
        [
          'Video mode',
          () =>
            installVideoMode(scene.viewer, {
              setCleanView,
            }),
        ],
        ['HD buildings', () => installHdDetail(scene)],
        ['Help card', () => installHelpCard()],
        ['Narrow-window tray', () => installToolbarFit()],
        ['Focus tips', () => installFocusTips()],
        ['CCTV history', () => installCctvHistory(styleManager)],
      ]);
    },
    // start() hands back the same promise; its failure is reported above.
    () => {},
  )
  .catch((error) => {
    console.error("Zenith's add-ons could not be started:", error);
  });

export { application };
