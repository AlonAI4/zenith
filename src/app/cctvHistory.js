import { guard } from './addOns.js';
import { closeOnEscape } from './escapeKey.js';
import { createMyPhotos, PHOTOS_ROUTE } from './myPhotos.js';

/**
 * Look back on a camera: under the camera picture, Live and a row of steps
 * back in time (a quarter of an hour up to a day) for the cameras whose
 * network keeps older pictures, then any photos taken of this camera, with
 * Take photo and My photos buttons. The older picture is laid over the live one,
 * so the live refresh never replaces it, and its real time is shown.
 *
 * The list of older pictures and each picture come from this build's own
 * server route (server/alon/cctvExtras.js), which fetches them from the
 * camera network's own server.
 */

const ROUTE = '/api/alon/cctv/history/';
const CHECK_ROUTE = '/api/alon/cctv/photo-check/';
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
#cctv-history button:disabled { opacity: 0.45; cursor: not-allowed; }
#cctv-history .ch-row[hidden] { display: none; }
#cctv-history .ch-tools { display: flex; gap: 6px; margin-top: 6px; }
#cctv-history .ch-tools button { display: inline-flex; align-items: center; gap: 5px; }
#cctv-photo-note { margin: 4px 0 0; color: #9fc3d3; font: 500 11px/1.3 var(--font-mono, monospace); }
#cctv-photo-note:empty { display: none; }
#cctv-history-time { margin: 6px 0 0; min-height: 1.3em; color: #9fc3d3; font: 500 11px/1.3 var(--font-mono, monospace); }
#cctv-history-view { position: absolute; inset: 0; z-index: 2; background: #000; }
#cctv-history-view img { width: 100%; height: 100%; object-fit: contain; display: block; }
#cctv-history-view .ch-tag {
  position: absolute; top: 6px; right: 6px; padding: 2px 6px; border-radius: 4px;
  background: rgba(0, 0, 0, 0.7); color: #ffd27a; font: 700 10px/1.3 var(--font-mono, monospace);
  letter-spacing: 0.08em;
}
`;

const CAMERA_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

/** Photos of this camera shown in its time control; the rest are in My photos. */
const PHOTOS_IN_ROW = 6;

/**
 * @param {{ _cctvControls?: { cctv?: { subscribe?: Function, getUIState?: Function } } }} styleManager
 * @param {Document} [doc]
 * @param {{ fetchJson?: (url: string, init?: object) => Promise<any>, now?: () => number }} [options]
 * @returns {() => void}
 */
export function installCctvHistory(
  styleManager,
  doc = document,
  {
    fetchJson = async (url, init = {}) => {
      const answer = await fetch(url, { credentials: 'same-origin', ...init });
      const body = await answer.json().catch(() => ({}));
      if (!answer.ok) {
        throw Object.assign(new Error(body?.error || `HTTP ${answer.status}`), {
          said: body?.error,
        });
      }
      return body;
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
  const tools = doc.createElement('div');
  tools.className = 'ch-tools';
  const take = doc.createElement('button');
  take.id = 'cctv-photo-take';
  take.type = 'button';
  take.innerHTML = CAMERA_ICON;
  take.append(' Take photo');
  const mine = doc.createElement('button');
  mine.id = 'cctv-photos-open';
  mine.type = 'button';
  mine.textContent = 'My photos';
  tools.append(take, mine);
  const note = doc.createElement('p');
  note.id = 'cctv-photo-note';
  const said = doc.createElement('p');
  said.id = 'cctv-history-time';
  said.setAttribute('role', 'status');
  box.append(row, tools, note, said);
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
  /** The times in the control: steps back, then this camera's photos. */
  let entries = [];
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
    const entry = entries[index];
    if (!entry) return;
    chosen = index;
    const words = entry.photo
      ? pictureWords(entry.time, now()).replace(/^Picture/, 'Your photo')
      : pictureWords(entry.time, now());
    said.textContent = 'Loading the older picture…';
    picture.onload = () => {
      if (chosen !== index) return;
      view.hidden = false;
      const ago = agoWords(now() - entry.time).toUpperCase();
      tag.textContent = entry.photo ? `YOUR PHOTO · ${ago}` : ago;
      picture.alt = `${words}.`;
      said.textContent = words;
    };
    picture.onerror = () => {
      if (chosen !== index) return;
      view.hidden = true;
      said.textContent = 'No picture from then';
    };
    picture.src = entry.src;
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
    entries.forEach((entry, index) => make(entry.label, index, entry.title));
    row.hidden = entries.length === 0;
    box.hidden = !cameraId;
    paint();
  };

  let steps = [];
  let photos = [];
  const rebuild = () => {
    const ownPhotos = photos
      .filter((photo) => photo.cameraId === cameraId)
      .sort((a, b) => b.time - a.time)
      .slice(0, PHOTOS_IN_ROW);
    entries = [
      ...steps.map((step) => ({
        label: step.label,
        title: `About ${step.label} ago`,
        time: step.frame.time,
        src: `${ROUTE}${encodeURIComponent(cameraId)}/frame?key=${encodeURIComponent(step.frame.key)}`,
      })),
      ...ownPhotos.map((photo) => {
        const clock = pictureWords(photo.time, now())
          .slice('Picture from '.length)
          .split(',')[0];
        return {
          label: `Photo ${clock}`,
          title: 'Your photo',
          time: photo.time,
          photo: true,
          src: `${PHOTOS_ROUTE}/${encodeURIComponent(photo.file)}`,
        };
      }),
    ];
    if (chosen >= entries.length) chosen = -1;
    render();
  };

  const loadPhotos = async () => {
    try {
      const answer = await fetchJson(PHOTOS_ROUTE);
      photos = Array.isArray(answer?.photos) ? answer.photos : [];
    } catch {
      photos = [];
    }
    rebuild();
  };

  const myPhotos = createMyPhotos(doc, { fetchJson, onChange: loadPhotos });
  mine.addEventListener('click', () => myPhotos.open(mine));

  const allowPhotos = (allowed, why) => {
    take.disabled = !allowed;
    take.title = allowed
      ? 'Save the picture on screen now, on this computer'
      : why;
    note.textContent = allowed ? '' : why;
  };

  take.addEventListener('click', async () => {
    if (!cameraId || take.disabled) return;
    const camera = cameraId;
    take.disabled = true;
    said.textContent = 'Taking a photo…';
    try {
      await fetchJson(PHOTOS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraId: camera }),
      });
      if (camera !== cameraId) return;
      await loadPhotos();
      said.textContent =
        'Photo saved on this computer. It is in My photos and in the times above.';
    } catch (error) {
      if (camera === cameraId)
        said.textContent = error?.said || 'Could not take the photo.';
    } finally {
      if (camera === cameraId) take.disabled = false;
    }
  });

  // Arrow keys move between the times, as in any group of radio buttons.
  row.addEventListener('keydown', (event) => {
    const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End')
      return;
    event.preventDefault();
    const count = entries.length + 1;
    let position = chosen + 1;
    if (event.key === 'Home') position = 0;
    else if (event.key === 'End') position = count - 1;
    else position = (position + moves[event.key] + count) % count;
    choose(position - 1);
    buttons()[position]?.focus();
  });

  const follow = guard('CCTV history', (state) => {
    const camera = state?.enabled ? (state.activeCamera ?? null) : null;
    const id =
      camera && !camera.isVideo ? (state.activeCameraId ?? null) : null;
    if (id === cameraId) return;
    cameraId = id;
    steps = [];
    showLive();
    allowPhotos(false, 'Checking whether this camera allows photos…');
    rebuild();
    if (!id) return;
    const ask = ++asking;
    fetchJson(`${ROUTE}${encodeURIComponent(id)}`)
      .then((answer) => {
        if (ask !== asking) return;
        steps = pickSteps(
          Array.isArray(answer?.frames) ? answer.frames : [],
          now(),
        );
        rebuild();
      })
      .catch(() => {});
    fetchJson(`${CHECK_ROUTE}${encodeURIComponent(id)}`)
      .then((answer) => {
        if (ask === asking)
          allowPhotos(
            answer?.allowed === true,
            answer?.why || 'Photos are off for this camera.',
          );
      })
      .catch(() => {
        if (ask === asking) allowPhotos(false, 'Could not check this camera.');
      });
    loadPhotos();
  });

  const unsubscribe = cctv.subscribe(follow);
  if (cctv.getUIState) follow(cctv.getUIState());
  // Registered after My photos, so with that panel open Escape closes it first.
  const offEscape = closeOnEscape(win, () => chosen >= 0, showLive, {
    panel: box,
    opener: { focus: () => buttons()[0]?.focus() },
  });

  return () => {
    asking += 1;
    unsubscribe?.();
    offEscape();
    myPhotos.remove();
    box.remove();
    view.remove();
    style.remove();
  };
}
