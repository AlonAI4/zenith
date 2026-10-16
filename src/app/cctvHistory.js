import { guard } from './addOns.js';
import { closeOnEscape } from './escapeKey.js';

/**
 * Look back on a camera: under the camera picture, Live and a row of steps
 * back in time (a quarter of an hour up to a day) for the cameras whose
 * network keeps older pictures. The older picture is laid over the live one,
 * so the live refresh never replaces it, and its real time is shown.
 *
 * The list of older pictures and each picture come from this build's own
 * server route (server/alon/cctvExtras.js), which fetches them from the
 * camera network's own server.
 */

const ROUTE = '/api/alon/cctv/history/';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const STEPS = Object.freeze([
  { label: '15 min', ms: 15 * MINUTE },
  { label: '30 min', ms: 30 * MINUTE },
  { label: '1 h', ms: HOUR },
  { label: '2 h', ms: 2 * HOUR },
  { label: '3 h', ms: 3 * HOUR },
  { label: '6 h', ms: 6 * HOUR },
  { label: '12 h', ms: 12 * HOUR },
  { label: '1 day', ms: 24 * HOUR },
]);

/**
 * The steps this camera really has: for each, the older picture nearest to
 * that time back, if one is close enough. Two steps never share a picture.
 * @param {Array<{time: number, key: string}>} frames
 * @param {number} now
 */
export function pickSteps(frames, now) {
  const used = new Set();
  const steps = [];
  for (const step of STEPS) {
    const want = now - step.ms;
    const allowed = Math.min(40 * MINUTE, Math.max(8 * MINUTE, step.ms * 0.2));
    let best = null;
    for (const frame of frames) {
      const off = Math.abs(frame.time - want);
      if (off <= allowed && (!best || off < Math.abs(best.time - want)))
        best = frame;
    }
    if (best && !used.has(best.key)) {
      used.add(best.key);
      steps.push({ ...step, frame: best });
    }
  }
  return steps;
}

/** "3 h ago", "1 h 20 min ago", "12 min ago". */
export function agoWords(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest >= 5 && hours < 6
    ? `${hours} h ${rest} min ago`
    : `${hours} h ago`;
}

/** "Picture from 14:40, 3 h ago", in the viewer's own time unless a zone is given. */
export function pictureWords(time, now, timeZone) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(time);
  return `Picture from ${clock}, ${agoWords(now - time)}`;
}

const STYLE = `
#cctv-history { margin: 8px 0 2px; }
#cctv-history[hidden], #cctv-history-view[hidden] { display: none; }
#cctv-history .ch-row { display: flex; flex-wrap: wrap; gap: 4px; }
#cctv-history button {
  padding: 3px 7px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(0, 244, 255, 0.28); background: rgba(4, 12, 18, 0.7);
  color: #cfefff; font: 600 11px/1.3 var(--font-mono, monospace);
}
#cctv-history button[aria-checked='true'] { background: rgba(0, 212, 255, 0.85); color: #021018; border-color: transparent; }
#cctv-history button:focus-visible { outline: 2px solid #00f6ff; outline-offset: 1px; }
#cctv-history-time { margin: 6px 0 0; min-height: 1.3em; color: #9fc3d3; font: 500 11px/1.3 var(--font-mono, monospace); }
#cctv-history-view { position: absolute; inset: 0; z-index: 2; background: #000; }
#cctv-history-view img { width: 100%; height: 100%; object-fit: contain; display: block; }
#cctv-history-view .ch-tag {
  position: absolute; top: 6px; right: 6px; padding: 2px 6px; border-radius: 4px;
  background: rgba(0, 0, 0, 0.7); color: #ffd27a; font: 700 10px/1.3 var(--font-mono, monospace);
  letter-spacing: 0.08em;
}
`;

/**
 * @param {{ _cctvControls?: { cctv?: { subscribe?: Function, getUIState?: Function } } }} styleManager
 * @param {Document} [doc]
 * @param {{ fetchJson?: (url: string) => Promise<any>, now?: () => number }} [options]
 * @returns {() => void}
 */
export function installCctvHistory(
  styleManager,
  doc = document,
  {
    fetchJson = async (url) => {
      const answer = await fetch(url, { credentials: 'same-origin' });
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      return answer.json();
    },
    now = () => Date.now(),
  } = {},
) {
  const cctv = styleManager?._cctvControls?.cctv;
  const wrap = doc.getElementById('cctv-frame-wrap');
  if (!cctv?.subscribe || !wrap) return () => {};
  const win = doc.defaultView ?? window;

  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const box = doc.createElement('div');
  box.id = 'cctv-history';
  box.hidden = true;
  const row = doc.createElement('div');
  row.className = 'ch-row';
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Look back in time');
  const said = doc.createElement('p');
  said.id = 'cctv-history-time';
  said.setAttribute('role', 'status');
  box.append(row, said);
  wrap.after(box);

  const view = doc.createElement('div');
  view.id = 'cctv-history-view';
  view.hidden = true;
  const picture = doc.createElement('img');
  picture.alt = '';
  const tag = doc.createElement('span');
  tag.className = 'ch-tag';
  view.append(picture, tag);
  wrap.appendChild(view);

  let cameraId = null;
  let steps = [];
  let chosen = -1; // -1 is Live
  let asking = 0;

  const buttons = () => [...row.querySelectorAll('button')];

  const showLive = () => {
    chosen = -1;
    view.hidden = true;
    picture.removeAttribute('src');
    said.textContent = '';
    paint();
  };

  const choose = (index) => {
    if (index < 0) {
      showLive();
      return;
    }
    const step = steps[index];
    if (!step) return;
    chosen = index;
    const { time, key } = step.frame;
    const words = pictureWords(time, now());
    said.textContent = 'Loading the older picture…';
    picture.onload = () => {
      if (chosen !== index) return;
      view.hidden = false;
      tag.textContent = agoWords(now() - time).toUpperCase();
      picture.alt = `${words}.`;
      said.textContent = words;
    };
    picture.onerror = () => {
      if (chosen !== index) return;
      view.hidden = true;
      said.textContent = 'No picture from then';
    };
    picture.src = `${ROUTE}${encodeURIComponent(cameraId)}/frame?key=${encodeURIComponent(key)}`;
    paint();
  };

  function paint() {
    buttons().forEach((button, position) => {
      const selected = position - 1 === chosen;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  const render = () => {
    row.replaceChildren();
    const make = (label, index, title) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', () => choose(index));
      row.appendChild(button);
    };
    make('Live', -1, 'The live picture');
    steps.forEach((step, index) =>
      make(step.label, index, `About ${step.label} ago`),
    );
    box.hidden = steps.length === 0;
    paint();
  };

  // Arrow keys move between the times, as in any group of radio buttons.
  row.addEventListener('keydown', (event) => {
    const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End')
      return;
    event.preventDefault();
    const count = steps.length + 1;
    let position = chosen + 1;
    if (event.key === 'Home') position = 0;
    else if (event.key === 'End') position = count - 1;
    else position = (position + moves[event.key] + count) % count;
    choose(position - 1);
    buttons()[position]?.focus();
  });

  const follow = guard('CCTV history', (state) => {
    const id = state?.enabled ? (state.activeCameraId ?? null) : null;
    if (id === cameraId) return;
    cameraId = id;
    steps = [];
    showLive();
    render();
    if (!id || state.activeCamera?.isVideo) return;
    const mine = ++asking;
    fetchJson(`${ROUTE}${encodeURIComponent(id)}`)
      .then((answer) => {
        if (mine !== asking) return;
        steps = pickSteps(
          Array.isArray(answer?.frames) ? answer.frames : [],
          now(),
        );
        render();
      })
      .catch(() => {});
  });

  const unsubscribe = cctv.subscribe(follow);
  if (cctv.getUIState) follow(cctv.getUIState());
  const offEscape = closeOnEscape(win, () => chosen >= 0, showLive, {
    panel: box,
    opener: { focus: () => buttons()[0]?.focus() },
  });

  return () => {
    asking += 1;
    unsubscribe?.();
    offEscape();
    box.remove();
    view.remove();
    style.remove();
  };
}
