/**
 * A short message under the toolbar, for something to know right now: the 3D
 * map falling back to the satellite map, or a data feed not answering. It is
 * read out by screen readers, and a click puts it away.
 * @param {Document} doc
 * @param {string} text
 * @param {{ id?: string, ms?: number }} [options] Each kind of message has
 *   its own id, so a new one replaces the old one of its kind.
 * @returns {HTMLElement}
 */
export function showNotice(
  doc,
  text,
  { id = 'zenith-notice', ms = 30_000 } = {},
) {
  doc.getElementById(id)?.remove();
  const notice = doc.createElement('div');
  notice.id = id;
  notice.setAttribute('role', 'status');
  notice.textContent = text;
  notice.title = 'Click to dismiss';
  notice.style.cssText =
    'position:fixed;top:132px;left:50%;transform:translateX(-50%);z-index:200;' +
    'max-width:min(560px,90vw);padding:10px 14px;border-radius:10px;cursor:pointer;' +
    'border:1px solid rgba(255,190,90,.6);background:rgba(20,14,4,.92);color:#ffd9a0;' +
    'font:600 13px/1.4 var(--font-mono,monospace);text-align:center';
  notice.addEventListener('click', () => notice.remove());
  doc.body.appendChild(notice);
  setTimeout(() => notice.remove(), ms);
  return notice;
}
