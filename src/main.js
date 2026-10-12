import { installAddressLookup } from './app/addressLookup.js';
import { installCompassDial } from './app/compassDial.js';
import { installHdDetail } from './app/hdDetail.js';
import { install3dMapWatchdog } from './app/map3dWatchdog.js';
import { installMapLabels } from './app/mapLabels.js';
import { installRotateGestures } from './app/rotateGestures.js';
import { installTimeZones } from './app/timeZones.js';
import { installTrackingMarker } from './app/trackingMarker.js';
import { installTrainStations } from './app/trainStations.js';
import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initBranding } from './ui/branding.js';
import { initButtonTooltips } from './ui/buttonTooltips.js';
import { initCustomSelects } from './ui/customSelect.js';
import { initPanelFullscreen } from './ui/panelFullscreen.js';

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

initBranding();
initButtonTooltips();
initCustomSelects();
initPanelFullscreen();
// start() hands back the same promise; its failure is reported above.
application
  .start()
  .then(() => {
    const { scene } = application.getComponents();
    installRotateGestures(scene.viewer);
    installCompassDial(scene.viewer);
    installTrackingMarker(scene.viewer);
    installMapLabels(scene);
    install3dMapWatchdog(scene);
    installTrainStations(scene);
    installTimeZones(scene);
    installAddressLookup(scene);
    installHdDetail(scene);
  })
  .catch(() => {});

export { application };
