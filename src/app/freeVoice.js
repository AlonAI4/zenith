import { voiceLayerAliasMap } from '../voice/layerManifest.js';
import { cinemaRunning } from './cinema.js';
import { showNotice } from './notice.js';
import { ZENITH_SWITCHES } from './zenithSwitches.js';

/**
 * Free voice control, for when no OpenAI key is set: hold V and speak, let go
 * to stop. In the Mac app, Apple's speech recognition turns the words into
 * text on the Mac itself (alon-app/ZenithApp.swift, SpeechBridge); in a
 * browser, the browser's own speech recognition is used where there is one.
 * A tap of V still does what it did before (hides the controls).
 *
 * The words are matched against a short list of commands in code, with no
 * AI: go to <place>, zoom in, zoom out, CCTV on or off, take photo, FLIR on
 * or off, classified on or off, watch zones on or off, space view, go to
 * the Moon, back to Earth, and a layer's name with on or off. What was
 * heard is shown on screen; anything else is "Not understood".
 */

/** Holding V this long starts listening; a shorter tap is the old V. */
export const HOLD_MS = 250;

const ON = '(?:on|show|start|open)';
const OFF = '(?:off|hide|stop|close)';

/** Lower case, no punctuation, single spaces. */
const tidy = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * "turn on X", "show X", "X on", "switch X off" → { name: 'x', on: true }.
 * @returns {{ name: string, on: boolean } | null}
 */
export function onOff(text) {
  const words = tidy(text);
  let found =
    new RegExp(`^(?:turn |switch )?${ON} (?:the )?(.+?)(?: layer)?$`).exec(
      words,
    ) ||
    new RegExp(`^(?:turn |switch )?(?:the )?(.+?)(?: layer)? ${ON}$`).exec(
      words,
    );
  if (found) return { name: found[1], on: true };
  found =
    new RegExp(`^(?:turn |switch )?${OFF} (?:the )?(.+?)(?: layer)?$`).exec(
      words,
    ) ||
    new RegExp(`^(?:turn |switch )?(?:the )?(.+?)(?: layer)? ${OFF}$`).exec(
      words,
    );
  if (found) return { name: found[1], on: false };
  return null;
}

/**
 * What a spoken sentence asks for.
 * @param {string} heard
 * @param {{ layers?: Map<string, string>, switches?: Map<string, string> }} [names]
 *   layer and Zenith switch names (lower case) to their ids.
 * @returns {{ do: string, [key: string]: unknown } | null}
 */
export function matchCommand(
  heard,
  { layers = new Map(), switches = new Map() } = {},
) {
  const words = tidy(heard);
  if (!words) return null;
  const go = /^(?:go to|fly to|take me to|show me|find) (.+)$/.exec(words);
  if (go) return { do: 'go', place: go[1] };
  if (/^zoom in( more)?$/.test(words)) return { do: 'zoom', in: true };
  if (/^zoom out( more)?$/.test(words)) return { do: 'zoom', in: false };
  if (/^(take|save) (a )?(photo|picture|snapshot)$/.test(words))
    return { do: 'photo' };
  if (/^(go )?back to (the )?earth$/.test(words)) return { do: 'earth' };
  if (/^space view$/.test(words))
    return { do: 'switch', id: 'space-view-toggle', on: true };
  const toggle = onOff(words);
  if (!toggle) return null;
  const name = toggle.name;
  if (/^(cctv|cameras?|cctv cameras?)$/.test(name))
    return { do: 'cctv', on: toggle.on };
  if (/^(flir|thermal|heat vision)$/.test(name))
    return { do: 'flir', on: toggle.on };
  if (/^(classified|classified look|spy look)$/.test(name))
    return { do: 'classified', on: toggle.on };
  if (/^(watch zones?|zones?|watching)$/.test(name))
    return { do: 'watching', on: toggle.on };
  if (switches.has(name))
    return { do: 'switch', id: switches.get(name), on: toggle.on };
  if (layers.has(name))
    return { do: 'layer', id: layers.get(name), on: toggle.on };
  return null;
}

/** Zenith's own switches by spoken name: "place names", "earthquakes", "map pin". */
export function switchNames() {
  const names = new Map();
  for (const entry of ZENITH_SWITCHES) {
    if (entry.panel) continue;
    names.set(entry.name.toLowerCase(), entry.id);
  }
  return names;
}

const STYLE = `
#zenith-heard { position: fixed; left: 50%; bottom: 120px; transform: translateX(-50%); z-index: 190;
  display: none; max-width: min(560px, 90vw); padding: 8px 14px; border-radius: 8px;
  border: 1px solid rgba(0,246,255,.5); background: rgba(2,10,16,.92); color: #dff8ff;
  font: 600 13px/1.4 var(--font-mono, monospace); text-align: center; }
#zenith-heard .zv-say { color: #00f6ff; letter-spacing: .14em; font-size: 10px; display: block; }
`;

/**
 * @param {{ viewer: import('cesium').Viewer }} scene
 * @param {{ styleManager?: object, dataManager?: object }} [options]
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function installFreeVoice(
  { viewer },
  { styleManager, dataManager } = {},
  doc = document,
) {
  const win = doc.defaultView ?? window;
  const native = Boolean(
    win.__zenithNativeSpeech && win.webkit?.messageHandlers?.zenithSpeech,
  );
  const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (!native && !Recognition) return () => {};

  let ready = false;
  let holdTimer = null;
  let listening = false;
  // Started from the mic button rather than by holding V.
  let byMic = false;
  let passing = false;
  let browserRecognition = null;
  let lastHeard = '';

  // Only when no OpenAI key is set: with one, the original voice control is the voice.
  fetch('/api/setup/status', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => {
      const openai = status?.keys?.find?.((key) => key.id === 'openai');
      ready = Boolean(status) && !openai?.set;
    })
    .catch(() => {});

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const box = doc.createElement('div');
  box.id = 'zenith-heard';
  box.setAttribute('role', 'status');
  const label = doc.createElement('span');
  label.className = 'zv-say';
  const words = doc.createElement('span');
  box.append(label, words);
  doc.body.appendChild(box);
  let hideTimer = null;
  const say = (title, text, ms = 0) => {
    win.clearTimeout(hideTimer);
    label.textContent = title;
    words.textContent = text;
    box.style.display = 'block';
    if (ms) hideTimer = win.setTimeout(() => (box.style.display = 'none'), ms);
  };

  const layers = voiceLayerAliasMap();
  const switches = switchNames();

  const run = async (heard) => {
    const command = matchCommand(heard, { layers, switches });
    if (!command) {
      say('NOT UNDERSTOOD', heard || '(nothing heard)', 4000);
      return;
    }
    say('HEARD', heard, 3000);
    const { camera } = viewer;
    if (command.do === 'go') {
      const input = doc.getElementById('location-search');
      if (!input) return;
      input.value = command.place;
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    } else if (command.do === 'zoom') {
      const height = camera.positionCartographic?.height ?? 1000;
      if (command.in) camera.zoomIn(height * 0.5);
      else camera.zoomOut(height);
      viewer.scene.requestRender();
    } else if (command.do === 'cctv') {
      await dataManager?.setEnabled?.('cctv', command.on, { origin: 'voice' });
    } else if (command.do === 'flir') {
      styleManager?.setStyle?.(command.on ? 'thermal' : 'normal', {
        userInitiated: true,
      });
    } else if (command.do === 'classified') {
      win.dispatchEvent(
        new CustomEvent('zenith:set-classified', {
          detail: { set: command.on },
        }),
      );
    } else if (command.do === 'earth') {
      win.dispatchEvent(
        new CustomEvent('zenith:space', { detail: { to: 'earth' } }),
      );
    } else if (command.do === 'watching') {
      win.dispatchEvent(
        new CustomEvent('zenith:set-watching', {
          detail: { set: command.on },
        }),
      );
    } else if (command.do === 'switch') {
      const button = doc.getElementById(command.id);
      if (
        button &&
        (button.getAttribute('aria-pressed') === 'true') !== command.on
      )
        button.click();
    } else if (command.do === 'layer') {
      await dataManager?.setEnabled?.(command.id, command.on, {
        origin: 'voice',
      });
    } else if (command.do === 'photo') {
      // A camera's picture card first; otherwise a picture of the map.
      const cameraPhoto = doc.getElementById('cctv-photo-take');
      if (cameraPhoto?.offsetParent && !cameraPhoto.disabled)
        cameraPhoto.click();
      else win.dispatchEvent(new CustomEvent('zenith:save-view'));
    }
  };

  // The words, from the Mac app or from the browser.
  const onSpeech = (event) => {
    const { kind, text } = event.detail || {};
    if (kind === 'listening')
      say(
        'LISTENING',
        byMic ? 'Speak, then click the mic again' : 'Speak, then let go of V',
      );
    else if (kind === 'partial') {
      lastHeard = text;
      say('LISTENING', text);
    } else if (kind === 'final') {
      lastHeard = '';
      run(text);
    } else if (kind === 'done') {
      listening = false;
      if (lastHeard) {
        const heard = lastHeard;
        lastHeard = '';
        run(heard);
      } else if (label.textContent === 'LISTENING') {
        say('NOTHING HEARD', 'Hold V and speak', 2500);
      }
    } else if (kind === 'error') say('VOICE OFF', text, 8000);
  };
  win.addEventListener('zenith:speech', onSpeech);
  const onSaved = (event) => say('PHOTO', event.detail?.said || '', 4000);
  win.addEventListener('zenith:saved-view', onSaved);

  const startListening = () => {
    listening = true;
    lastHeard = '';
    if (native) {
      win.webkit.messageHandlers.zenithSpeech.postMessage('start');
      return;
    }
    const recognition = new Recognition();
    browserRecognition = recognition;
    // An older recognition still finishing must not speak for this one.
    const current = () => recognition === browserRecognition;
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    recognition.onresult = (result) => {
      if (!current()) return;
      const last = result.results[result.results.length - 1];
      onSpeech({
        detail: {
          kind: last.isFinal ? 'final' : 'partial',
          text: last[0].transcript,
        },
      });
    };
    recognition.onerror = (error) =>
      current() &&
      error.error !== 'aborted' &&
      onSpeech({
        detail: { kind: 'error', text: `Voice did not work (${error.error}).` },
      });
    recognition.onend = () =>
      current() && onSpeech({ detail: { kind: 'done' } });
    recognition.start();
    onSpeech({ detail: { kind: 'listening' } });
  };
  const stopListening = () => {
    listening = false;
    if (native) win.webkit.messageHandlers.zenithSpeech.postMessage('stop');
    else browserRecognition?.stop();
  };

  const typing = (target) =>
    Boolean(
      target?.closest?.('input, textarea, select, [contenteditable="true"]'),
    );
  const isV = (event) =>
    (event.key === 'v' || event.key === 'V') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey;

  const onDown = (event) => {
    if (!ready || passing || !isV(event) || typing(event.target)) return;
    // In video mode any key ends the recording: V is left to do that.
    if (cinemaRunning()) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.repeat || holdTimer || listening) return;
    holdTimer = win.setTimeout(() => {
      holdTimer = null;
      byMic = false;
      startListening();
    }, HOLD_MS);
  };
  const onUp = (event) => {
    // Letting go of V always stops listening, whatever else is held.
    if (listening && event.code === 'KeyV') {
      stopListening();
      return;
    }
    if (!ready || !isV(event)) return;
    if (holdTimer) {
      // A tap: hand the V back to what it did before.
      win.clearTimeout(holdTimer);
      holdTimer = null;
      passing = true;
      try {
        (event.target || doc).dispatchEvent(
          new KeyboardEvent('keydown', { key: event.key, bubbles: true }),
        );
      } finally {
        passing = false;
      }
      return;
    }
    if (listening) stopListening();
  };
  // The window lost the keyboard (another app, a dialog, a reload): the
  // microphone goes off, as the key's release will never arrive.
  const letGo = () => {
    win.clearTimeout(holdTimer);
    holdTimer = null;
    if (listening) stopListening();
  };
  win.addEventListener('keydown', onDown, true);
  win.addEventListener('keyup', onUp, true);

  // The mic button starts the paid voice, which with no key only shows
  // "VOICE SYSTEM ERROR": with no key, a click starts or stops this one.
  const onMic = (event) => {
    const target = event.target;
    const mic =
      target?.id === 'gev-voice-button' ||
      Boolean(target?.closest?.('#gev-voice-button'));
    if (!ready || !mic) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (listening) {
      stopListening();
      return;
    }
    byMic = true;
    startListening();
  };
  doc.addEventListener('click', onMic, true);
  win.addEventListener('blur', letGo);
  win.addEventListener('pagehide', letGo);

  if (native)
    win.setTimeout(
      () =>
        ready &&
        showNotice(
          doc,
          'Free voice control: hold V and say a command, such as "go to Paris" or "CCTV on"',
          {
            id: 'zenith-voice-notice',
            ms: 9000,
          },
        ),
      4000,
    );

  return () => {
    win.removeEventListener('zenith:speech', onSpeech);
    win.removeEventListener('zenith:saved-view', onSaved);
    win.removeEventListener('keydown', onDown, true);
    win.removeEventListener('keyup', onUp, true);
    doc.removeEventListener('click', onMic, true);
    win.removeEventListener('blur', letGo);
    win.removeEventListener('pagehide', letGo);
    if (listening) stopListening();
    box.remove();
    style.remove();
  };
}
