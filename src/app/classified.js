import * as Cesium from 'cesium';
import { guard } from './addOns.js';
import { cinemaRunning } from './cinema.js';
import { shortName } from './trackingMarker.js';

/**
 * The CLASSIFIED switch: a spy look over the map, all on one switch, on from
 * the start. It is a look only. Everything it shows is public map data; it
 * never tracks, names or watches real people.
 *
 * With it on:
 * - target boxes decrypt (scrambled letters settle into the address), and
 *   their coordinates and source lines sit under black REDACTED bars that
 *   lift on hover or keyboard focus;
 * - following a plane, ship or satellite shows a lock-on reticle that closes
 *   in on it, with TRACKING and its callsign;
 * - the FLIR style (thermal) gets readouts: WHT HOT or BLK HOT, a crosshair,
 *   the heading and the range; the black and white style (noir) gets a CCTV
 *   camera's: a camera ID, a REC dot and a running timestamp;
 * - video mode gets film grain, scanlines and an UPLINK signal meter;
 * - the title shows AGENT and a codename, with a Zulu (UTC) clock;
 * - a short secure-link sequence plays when Zenith starts, at most once a day.
 * Radio blips (soft beeps) are off unless switched on in the help card.
 * With reduced motion, nothing scrambles, flickers or closes in.
 */

const KEY = 'gev.classified';
const BLIPS_KEY = 'gev.radioBlips';
const CODENAME_KEY = 'gev.codename';
const BOOT_KEY = 'gev.secureLinkDay';
export const CLASSIFIED_EVENT = 'zenith:classified';
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$';
const CYAN = '#00f6ff';

const read = (key) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the setting still works this visit.
  }
};

let on = read(KEY) !== '0';
/** Whether the classified look is on. */
export function classifiedOn() {
  return on;
}

/** Whether the person asked their computer for less motion. */
export function reducedMotion(win = globalThis) {
  try {
    return Boolean(
      win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    );
  } catch {
    return false;
  }
}

/**
 * The frames of a decrypting text: each starts scrambled and settles from
 * left to right, and the last frame is the real text. Spaces and punctuation
 * stay put, so the shape of an address shows from the start.
 */
export function scrambleFrames(text, count = 18, random = Math.random) {
  const chars = [...String(text ?? '')];
  const frames = [];
  for (let frame = 1; frame <= count; frame++) {
    const settled = Math.round((chars.length * frame) / count);
    frames.push(
      chars
        .map((char, i) =>
          i < settled || !/[A-Za-z0-9]/.test(char)
            ? char
            : GLYPHS[Math.floor(random() * GLYPHS.length)],
        )
        .join(''),
    );
  }
  return frames;
}

/**
 * Show `text` in `element`, decrypting over about `ms` when the look is on
 * and motion is welcome; otherwise at once. The screen reader label always
 * has the real text.
 * @returns {() => void} Stops the animation and shows the real text.
 */
export function decrypt(element, text, { win = globalThis, ms = 900 } = {}) {
  element.textContent = text;
  if (!on || reducedMotion(win) || !text) return () => {};
  const doc = element.ownerDocument;
  if (!doc) return () => {};
  // Screen readers get the real text only, never the scrambled letters.
  const shown = doc.createElement('span');
  shown.setAttribute('aria-hidden', 'true');
  const heard = doc.createElement('span');
  heard.className = 'zenith-sr-only';
  heard.textContent = text;
  const frames = scrambleFrames(text);
  shown.textContent = frames[0];
  element.replaceChildren(shown, heard);
  let frame = 0;
  const timer = win.setInterval(() => {
    shown.textContent = frames[frame];
    frame += 1;
    if (frame >= frames.length) stop();
  }, ms / frames.length);
  const stop = () => {
    win.clearInterval(timer);
    element.textContent = text;
  };
  return stop;
}

/** A soft radio blip, if blips are switched on: a short beep with a click of static. */
export function blip(kind = 'open', win = globalThis) {
  if (!on || read(BLIPS_KEY) !== '1') return;
  try {
    const Context = win.AudioContext || win.webkitAudioContext;
    if (!Context) return;
    blip.context ||= new Context();
    const audio = blip.context;
    const tone = audio.createOscillator();
    const level = audio.createGain();
    const start = audio.currentTime;
    tone.type = 'sine';
    tone.frequency.setValueAtTime(kind === 'lock' ? 1320 : 980, start);
    level.gain.setValueAtTime(0.0001, start);
    level.gain.exponentialRampToValueAtTime(0.05, start + 0.01);
    level.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
    tone.connect(level).connect(audio.destination);
    tone.start(start);
    tone.stop(start + 0.13);
  } catch {
    // No sound is fine.
  }
}

/** "AGENT FALCON · 21:04:09Z": the codename and the time in UTC. */
export function agentLine(codename, date = new Date()) {
  const name = String(codename || '').trim() || 'UNASSIGNED';
  return `AGENT ${name.toUpperCase()} · ${date.toISOString().slice(11, 19)}Z`;
}

/** A codename as typed, cut to letters, digits, spaces and dashes. */
export function cleanCodename(text) {
  return String(text ?? '')
    .replace(/[^A-Za-z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

/** The secure-link lines, for the codename. */
export function bootLines(codename) {
  return [
    'ESTABLISHING SECURE LINK…',
    'HANDSHAKE  ZNT-7 / AES-256 ………… OK',
    'UPLINK  SAT-3 ………… LOCKED',
    `CLEARANCE  ${agentLine(codename).split(' · ')[0]} ………… GRANTED`,
    'ZENITH ONLINE',
  ];
}

const STYLE = `
.zenith-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
#classified-toggle { font: 700 9px/1 var(--font-mono, monospace); letter-spacing: .06em; }
#zenith-agent-line { margin-top: 6px; font: 600 10px/1.2 var(--font-mono, monospace); letter-spacing: .18em; color: ${CYAN}; text-shadow: 0 0 6px rgba(0,0,0,.9); }
body:not(.zenith-classified) #zenith-agent-line { display: none; }
.zenith-classified #target-box-panel .tb-redact { position: relative; outline: none; cursor: help; }
.zenith-classified #target-box-panel .tb-redact::after {
  content: 'REDACTED'; position: absolute; inset: 1px 0; display: flex; align-items: center;
  padding-left: 6px; background: #000; color: #555; font-size: 9px; letter-spacing: .2em;
}
.zenith-classified #target-box-panel .tb-redact:hover::after,
.zenith-classified #target-box-panel .tb-redact:focus::after { display: none; }
#zenith-lock { position: fixed; z-index: 140; pointer-events: none; display: none; }
#zenith-lock svg { position: absolute; left: -32px; top: -32px; overflow: visible; }
#zenith-lock path { fill: none; stroke: ${CYAN}; stroke-width: 2; filter: drop-shadow(0 0 4px rgba(0,246,255,.8)); }
#zenith-lock .zl-tag { position: absolute; left: 40px; top: -30px; white-space: nowrap; padding: 2px 6px;
  background: rgba(2,10,16,.85); border: 1px solid rgba(0,246,255,.5); color: ${CYAN};
  font: 700 10px/1.3 var(--font-mono, monospace); letter-spacing: .12em; }
#zenith-lock.closing svg { animation: zl-close .6s ease-out; }
@keyframes zl-close { from { transform: scale(2.4) rotate(45deg); opacity: 0; } to { transform: none; opacity: 1; } }
#zenith-hud { position: fixed; inset: 0; z-index: 130; pointer-events: none; display: none;
  font: 700 12px/1.4 var(--font-mono, monospace); letter-spacing: .14em; color: #fff; text-shadow: 0 0 4px #000; }
#zenith-hud .zh-line { position: absolute; left: 50%; top: calc(50% + 46px); transform: translateX(-50%);
  white-space: nowrap; padding: 3px 10px; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.25); }
#zenith-hud .zh-cross { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; }
#zenith-hud .zh-cross path { stroke: #fff; stroke-width: 1.5; fill: none; opacity: .85; }
#zenith-hud .zh-rec { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; background: #ff3040; vertical-align: -1px; }
#zenith-hud.motion .zh-rec { animation: zh-blink 1s steps(2) infinite; }
@keyframes zh-blink { 50% { opacity: 0; } }
#zenith-grain { position: fixed; inset: 0; z-index: 125; pointer-events: none; display: none; }
#zenith-grain .zg-lines { position: absolute; inset: 0;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,.18) 0 1px, transparent 1px 3px); }
#zenith-grain .zg-noise { position: absolute; inset: -15%; opacity: .09; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
  animation: zg-move .5s steps(5) infinite; }
@keyframes zg-move { 20% { transform: translate(-6%, 4%); } 40% { transform: translate(5%, -7%); } 60% { transform: translate(-3%, 8%); } 80% { transform: translate(7%, 2%); } }
#zenith-grain .zg-uplink { position: absolute; right: 24px; top: 24px; display: flex; align-items: flex-end; gap: 3px;
  padding: 6px 8px; background: rgba(0,0,0,.55); border: 1px solid rgba(0,246,255,.4); color: ${CYAN};
  font: 700 10px/1 var(--font-mono, monospace); letter-spacing: .14em; }
#zenith-grain .zg-uplink i { display: block; width: 4px; background: ${CYAN}; }
#zenith-boot { position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center;
  background: rgba(1,6,10,.94); color: ${CYAN}; font: 600 13px/1.9 var(--font-mono, monospace); letter-spacing: .12em; cursor: pointer; }
#zenith-boot pre { margin: 0; font: inherit; white-space: pre; }
#zenith-boot .zb-skip { position: absolute; bottom: 32px; left: 0; right: 0; text-align: center; opacity: .5; font-size: 11px; }
`;

const svg = (doc, markup) => {
  const holder = doc.createElement('div');
  holder.innerHTML = markup;
  return holder.firstElementChild;
};

/**
 * @param {{ viewer: Cesium.Viewer }} scene
 * @param {{ styleManager?: { activeStyle?: string } }} [options]
 * @param {Document} [doc]
 * @returns {() => void}
 */
export function installClassified(
  { viewer },
  { styleManager } = {},
  doc = document,
) {
  const win = doc.defaultView ?? window;
  const { scene, camera } = viewer;
  const style = doc.createElement('style');
  style.id = 'zenith-classified-style';
  style.textContent = STYLE;
  doc.head.appendChild(style);
  const motion = () => !reducedMotion(win);
  const cleanups = [];

  // ── The switch ───────────────────────────────────────────────
  const button = doc.createElement('button');
  button.id = 'classified-toggle';
  button.type = 'button';
  button.textContent = 'TS';
  button.setAttribute('aria-label', 'Classified look');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'Classified look is on: decrypting text, redacted labels, lock-on and readouts. Click to switch off'
      : 'Turn on the classified look (a look only: all public map data)';
    doc.body.classList.toggle('zenith-classified', on);
  };
  button.addEventListener('click', () => {
    setClassified(!on);
  });
  const setClassified = (value) => {
    on = Boolean(value);
    write(KEY, on ? '1' : '0');
    paint();
    sync();
    win.dispatchEvent(new CustomEvent(CLASSIFIED_EVENT, { detail: { on } }));
  };
  const hd = doc.getElementById('hd-detail-toggle');
  if (hd) hd.after(button);
  else doc.getElementById('top-center-actions')?.appendChild(button);
  // Voice control and other add-ons can switch the look too.
  const onSet = (event) => {
    if (typeof event.detail?.set === 'boolean') setClassified(event.detail.set);
  };
  win.addEventListener('zenith:set-classified', onSet);
  cleanups.push(() => win.removeEventListener('zenith:set-classified', onSet));

  // ── AGENT and the Zulu clock, under the title ────────────────
  const agent = doc.createElement('div');
  agent.id = 'zenith-agent-line';
  agent.setAttribute('aria-hidden', 'true');
  doc.querySelector('#title-bar .subtitle')?.after(agent);
  const tickAgent = () => {
    if (on) agent.textContent = agentLine(read(CODENAME_KEY));
  };
  tickAgent();
  const agentTimer = win.setInterval(tickAgent, 1000);
  cleanups.push(
    () => win.clearInterval(agentTimer),
    () => agent.remove(),
  );

  // ── Lock-on reticle on whatever is followed ──────────────────
  const lock = doc.createElement('div');
  lock.id = 'zenith-lock';
  lock.append(
    svg(
      doc,
      '<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><path d="M0 16V0H16M48 0H64V16M64 48V64H48M16 64H0V48M32 22V28M32 36V42M22 32H28M36 32H42"/></svg>',
    ),
  );
  const lockTag = doc.createElement('div');
  lockTag.className = 'zl-tag';
  lock.append(lockTag);
  doc.body.appendChild(lock);
  let lockedOn = null;

  // ── FLIR and CCTV readouts ───────────────────────────────────
  const hud = doc.createElement('div');
  hud.id = 'zenith-hud';
  hud.setAttribute('aria-hidden', 'true');
  // One line under the middle of the view: the corners belong to the
  // original's own tactical readouts.
  const hudLine = doc.createElement('div');
  hudLine.className = 'zh-line';
  hud.append(hudLine);
  // The CCTV REC dot is made once, so its blink is never restarted.
  const recDot = doc.createElement('span');
  recDot.className = 'zh-rec';
  const recText = doc.createTextNode('');
  const cross = svg(
    doc,
    '<svg class="zh-cross" viewBox="0 0 64 64"><path d="M32 0V24M32 40V64M0 32H24M40 32H64M26 32H38M32 26V38"/></svg>',
  );
  hud.append(cross);
  doc.body.appendChild(hud);
  const cameraId = `CAM-${String(Math.floor(Math.random() * 900) + 100)}`;
  let rangeText = '';
  let lastRange = 0;

  // ── Grain, scanlines and the uplink meter in video mode ──────
  const grain = doc.createElement('div');
  grain.id = 'zenith-grain';
  grain.setAttribute('aria-hidden', 'true');
  const lines = doc.createElement('div');
  lines.className = 'zg-lines';
  const noise = doc.createElement('div');
  noise.className = 'zg-noise';
  const uplink = doc.createElement('div');
  uplink.className = 'zg-uplink';
  const bars = [6, 9, 12, 15, 18].map((height) => {
    const bar = doc.createElement('i');
    bar.style.height = `${height}px`;
    return bar;
  });
  const uplinkWord = doc.createElement('span');
  uplinkWord.textContent = 'UPLINK';
  uplink.append(uplinkWord, ...bars);
  grain.append(lines, noise, uplink);
  doc.body.appendChild(grain);

  const styleNow = () => String(styleManager?.activeStyle || 'normal');
  const thermalMode = () =>
    styleManager?._visualEffects?.stages?.thermal?.uniforms?.mode;

  const sync = () => {
    const look = on ? styleNow() : 'normal';
    const flir = look === 'thermal';
    const cctv = look === 'noir';
    hud.style.display = flir || cctv ? 'block' : 'none';
    hud.classList.toggle('motion', motion());
    cross.style.display = flir ? '' : 'none';
    if (flir) {
      const heading =
        Math.round(Cesium.Math.toDegrees(camera.heading) + 360) % 360;
      const said = [
        Number(thermalMode()) >= 0.5 ? 'BLK HOT' : 'WHT HOT',
        `HDG ${String(heading).padStart(3, '0')}°`,
        rangeText,
      ]
        .filter(Boolean)
        .join('   ');
      // Written only when it changes: this runs with every frame drawn.
      if (hudLine.textContent !== said) hudLine.textContent = said;
    } else if (cctv) {
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const said = `${cameraId}   ${stamp} UTC`;
      if (recText.data !== said) recText.data = said;
      if (hudLine.firstChild !== recDot)
        hudLine.replaceChildren(recDot, recText);
    }
    const video = on && cinemaRunning();
    grain.style.display = video ? 'block' : 'none';
    noise.style.display = video && motion() ? '' : 'none';
  };

  // The range to the middle of the view, worked out at most four times a second.
  const measureRange = (now) => {
    if (now - lastRange < 250) return;
    lastRange = now;
    const middle = new Cesium.Cartesian2(
      scene.canvas.clientWidth / 2,
      scene.canvas.clientHeight / 2,
    );
    const spot =
      (scene.pickPositionSupported && scene.pickPosition(middle)) ||
      camera.pickEllipsoid(middle, scene.ellipsoid);
    const metres = spot
      ? Cesium.Cartesian3.distance(camera.positionWC, spot)
      : NaN;
    rangeText = Number.isFinite(metres)
      ? `RNG ${metres >= 10_000 ? `${(metres / 1000).toFixed(1)} KM` : `${Math.round(metres)} M`}`
      : 'RNG ----';
  };

  const onFrame = () => {
    if (on && styleNow() === 'thermal')
      measureRange(win.performance?.now?.() ?? Date.now());
    // The lock-on follows the tracked thing across the screen.
    const entity = on ? viewer.trackedEntity : null;
    const where =
      entity &&
      (entity.gevDisplayPosition?.() ||
        entity.position?.getValue(viewer.clock.currentTime));
    const at =
      where && Cesium.SceneTransforms.worldToWindowCoordinates(scene, where);
    if (!at) {
      lock.style.display = 'none';
      lockedOn = null;
    } else {
      if (entity !== lockedOn) {
        lockedOn = entity;
        lockTag.textContent = `TRACKING  ${shortName(entity.gevLabelModel?.title || entity.name)}`;
        lock.classList.remove('closing');
        if (motion()) {
          void lock.offsetWidth;
          lock.classList.add('closing');
        }
        blip('lock', win);
      }
      lock.style.display = 'block';
      lock.style.left = `${at.x}px`;
      lock.style.top = `${at.y}px`;
    }
  };
  const offFrame = scene.postRender.addEventListener(
    guard('Classified look', onFrame),
  );
  cleanups.push(offFrame);
  // Readouts that change with time (the clock, the style) once a second;
  // the heading and range with every frame drawn.
  const hudTimer = win.setInterval(guard('Classified look', sync), 500);
  cleanups.push(() => win.clearInterval(hudTimer));
  const offHudFrame = scene.postRender.addEventListener(
    guard('Classified look', () => {
      if (hud.style.display === 'block' && styleNow() === 'thermal') sync();
    }),
  );
  cleanups.push(offHudFrame);
  // The uplink meter's bars come and go like a weak signal.
  const uplinkTimer = win.setInterval(() => {
    if (grain.style.display !== 'block') return;
    const strength = motion() ? 2 + Math.floor(Math.random() * 4) : 4;
    bars.forEach((bar, i) => {
      bar.style.opacity = i < strength ? '1' : '.2';
    });
  }, 700);
  cleanups.push(() => win.clearInterval(uplinkTimer));

  // ── Codename and radio blips, in the help card ───────────────
  const settings = doc.createElement('div');
  settings.id = 'zenith-classified-settings';
  settings.style.cssText = 'display:grid;gap:6px;margin-top:10px';
  const nameLabel = doc.createElement('label');
  nameLabel.textContent = 'Codename ';
  const nameInput = doc.createElement('input');
  nameInput.id = 'zenith-codename';
  nameInput.type = 'text';
  nameInput.maxLength = 16;
  nameInput.placeholder = 'FALCON';
  nameInput.value = read(CODENAME_KEY) || '';
  nameInput.style.cssText =
    'width:140px;padding:3px 6px;border:1px solid rgba(0,246,255,.4);border-radius:4px;background:rgba(0,0,0,.4);color:inherit;font:inherit';
  nameInput.addEventListener('input', () => {
    write(CODENAME_KEY, cleanCodename(nameInput.value));
    tickAgent();
  });
  nameLabel.append(nameInput);
  const blipLabel = doc.createElement('label');
  const blipBox = doc.createElement('input');
  blipBox.type = 'checkbox';
  blipBox.id = 'zenith-radio-blips';
  blipBox.checked = read(BLIPS_KEY) === '1';
  blipBox.addEventListener('change', () => {
    write(BLIPS_KEY, blipBox.checked ? '1' : '0');
    blip('open', win);
  });
  blipLabel.append(
    blipBox,
    ' Radio blips (soft beeps with the classified look)',
  );
  settings.append(nameLabel, blipLabel);
  // The help card is made a moment later.
  queueMicrotask(() =>
    doc.getElementById('zenith-help')?.appendChild(settings),
  );
  cleanups.push(() => settings.remove());

  // ── The secure-link sequence, at most once a day ─────────────
  const today = new Date().toISOString().slice(0, 10);
  if (on && read(BOOT_KEY) !== today) {
    write(BOOT_KEY, today);
    const boot = doc.createElement('div');
    boot.id = 'zenith-boot';
    boot.setAttribute('role', 'status');
    const text = doc.createElement('pre');
    const skip = doc.createElement('div');
    skip.className = 'zb-skip';
    skip.textContent = 'PRESS ANY KEY';
    boot.append(text, skip);
    doc.body.appendChild(boot);
    const all = bootLines(read(CODENAME_KEY));
    let shown = motion() ? 0 : all.length;
    text.textContent = all.slice(0, shown).join('\n');
    // The key that skips the screen is only for that, not also a shortcut.
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      end();
    };
    const end = () => {
      win.clearInterval(typing);
      win.clearTimeout(done);
      win.removeEventListener('keydown', onKey, true);
      boot.remove();
    };
    const typing = win.setInterval(() => {
      shown += 1;
      text.textContent = all.slice(0, shown).join('\n');
      if (shown >= all.length) win.clearInterval(typing);
    }, 360);
    const done = win.setTimeout(end, 2400);
    boot.addEventListener('click', end);
    win.addEventListener('keydown', onKey, true);
    cleanups.push(end);
  }

  paint();
  sync();
  return () => {
    for (const cleanup of cleanups) cleanup();
    lock.remove();
    hud.remove();
    grain.remove();
    button.remove();
    style.remove();
    doc.body.classList.remove('zenith-classified');
  };
}
