/**
 * Keeps this build's add-ons from breaking each other.
 *
 * Two ways one add-on could take others down with it:
 * - at the start, they were started one after another in a single run, so
 *   the first one to fail stopped every one after it, without a word;
 * - while running, some hand the map a function to call on every frame, and
 *   an error inside one of those stops the whole map from drawing.
 *
 * So each add-on is started on its own (startAddOns), and each function
 * given to the map is wrapped (guard). Either way a failure is caught, named
 * in a notice and in the console, and only that add-on is switched off.
 */

const NOTICE_ID = 'zenith-addon-notice';
const failedNames = [];

/** The notice text for these add-on names. */
export function failureMessage(names) {
  if (names.length === 0) return '';
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const verb =
    names.length === 1 ? 'has a problem and was' : 'have a problem and were';
  return `${list} ${verb} switched off. The rest of Zenith is working. Reload the page to try again.`;
}

function showNotice(doc, text) {
  doc.getElementById(NOTICE_ID)?.remove();
  const notice = doc.createElement('div');
  notice.id = NOTICE_ID;
  notice.setAttribute('role', 'alert');
  notice.textContent = text;
  notice.title = 'Click to dismiss';
  notice.style.cssText =
    'position:fixed;top:184px;left:50%;transform:translateX(-50%);z-index:210;' +
    'max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;cursor:pointer;' +
    'border:1px solid rgba(255,120,120,.65);background:rgba(24,6,6,.94);color:#ffc9c9;' +
    'font:600 13px/1.4 var(--font-mono,monospace);text-align:center';
  notice.addEventListener('click', () => notice.remove());
  doc.body.appendChild(notice);
}

/**
 * Record that an add-on failed: once in the console with the real error, and
 * in a notice that names every add-on that has failed so far.
 */
export function reportFailure(name, error) {
  console.error(`Zenith add-on "${name}" failed:`, error);
  if (!failedNames.includes(name)) failedNames.push(name);
  const doc = globalThis.document;
  if (doc?.body) showNotice(doc, failureMessage(failedNames));
}

/**
 * Start each add-on on its own. One that throws, or whose promise fails, is
 * reported and the rest still start.
 * @param {[string, () => unknown][]} addOns Name and start function.
 * @param {{ onError?: (name: string, error: unknown) => void }} [options]
 * @returns {string[]} The names that failed straight away.
 */
export function startAddOns(addOns, { onError = reportFailure } = {}) {
  const failed = [];
  for (const [name, start] of addOns) {
    try {
      const result = start();
      if (typeof result?.then === 'function') {
        result.then(undefined, (error) => onError(name, error));
      }
    } catch (error) {
      failed.push(name);
      onError(name, error);
    }
  }
  return failed;
}

/**
 * Wrap a function an add-on hands to the map (a frame or camera listener).
 * If it ever throws, the error is reported once and the function does
 * nothing from then on, so the map keeps drawing.
 * @template {(...args: any[]) => unknown} T
 * @param {string} name The add-on's name, for the notice.
 * @param {T} fn
 * @param {{ onError?: (name: string, error: unknown) => void }} [options]
 * @returns {T}
 */
export function guard(name, fn, { onError = reportFailure } = {}) {
  let broken = false;
  return /** @type {T} */ (
    function guarded(...args) {
      if (broken) return undefined;
      try {
        return fn.apply(this, args);
      } catch (error) {
        broken = true;
        onError(name, error);
        return undefined;
      }
    }
  );
}
