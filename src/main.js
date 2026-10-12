import { install3dMapWatchdog } from './app/map3dWatchdog.js';
import { installMapLabels } from './app/mapLabels.js';
import { installRotateGestures } from './app/rotateGestures.js';
import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initButtonTooltips } from './ui/buttonTooltips.js';
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

initButtonTooltips();
initPanelFullscreen();
// start() hands back the same promise; its failure is reported above.
application
  .start()
  .then(() => {
    const { scene } = application.getComponents();
    installRotateGestures(scene.viewer);
    installMapLabels(scene);
    install3dMapWatchdog(scene);
  })
  .catch(() => {});

export { application };
