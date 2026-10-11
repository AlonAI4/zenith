/**
 * A full-screen button for the CCTV picture and for the street-level viewer.
 * It fills the screen with that one picture, not the whole app. Esc, or the
 * button again, returns.
 */

const TIP = 'Fill the screen with this picture (Esc returns)';
const HOST_IDS = ['cctv-frame-wrap', 'sl-viewer-wrap'];

const STYLE = `
.gev-fs-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font: 600 13px/1.3 var(--font-mono, monospace);
  cursor: pointer;
}
#cctv-frame-wrap:fullscreen {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0;
  background: #000;
}
#cctv-frame-wrap:fullscreen #cctv-frame,
#cctv-frame-wrap:fullscreen #cctv-video {
  width: 100vw;
  height: 100vh;
  aspect-ratio: auto;
}
#sl-viewer-wrap:fullscreen {
  border: 0;
  border-radius: 0;
}
#sl-viewer-wrap:fullscreen .sl-viewer-stage {
  flex: 1 1 auto;
  min-height: 0;
}
#sl-viewer-wrap:fullscreen .sl-viewer {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
  aspect-ratio: auto;
}
`;

function addButton(host, parent, className, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.title = TIP;
  button.setAttribute('aria-label', 'Full screen');
  button.addEventListener('click', () => {
    const change =
      document.fullscreenElement === host
        ? document.exitFullscreen()
        : host.requestFullscreen();
    // A refused request (no permission, embedded page) leaves the panel as is.
    change.catch(() => {});
  });
  parent.appendChild(button);
}

/**
 * Add the buttons once their panels exist.
 * @param {Document} [root]
 */
export function initPanelFullscreen(root = document) {
  if (!root.fullscreenEnabled) return;
  const style = root.createElement('style');
  style.textContent = STYLE;
  root.head.appendChild(style);

  // Esc leaves full screen and nothing else: without this the app's own Esc
  // handling also closes the panel behind the picture.
  root.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (!HOST_IDS.includes(root.fullscreenElement?.id)) return;
      event.stopPropagation();
      root.exitFullscreen().catch(() => {});
    },
    true,
  );

  const pending = new Map([
    ['cctv-frame-wrap', (host) => addButton(host, host, 'gev-fs-btn', '⛶')],
    [
      'sl-viewer-wrap',
      (host) => {
        const tools = host.querySelector('.sl-viewer-tools');
        if (tools) addButton(host, tools, 'scene-btn', '⛶ FULL SCREEN');
      },
    ],
  ]);
  const mount = () => {
    for (const [id, add] of pending) {
      const host = root.getElementById(id);
      if (!host) continue;
      add(host);
      pending.delete(id);
    }
    return pending.size === 0;
  };
  if (mount()) return;
  const observer = new MutationObserver(() => {
    if (mount()) observer.disconnect();
  });
  observer.observe(root.body, { childList: true, subtree: true });
}
