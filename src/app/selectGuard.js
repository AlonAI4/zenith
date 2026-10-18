/**
 * Select all (Cmd+A), or a drag that starts on a panel, used to paint the
 * whole app blue: every label, button and readout took the text highlight.
 * Only text a person would copy can be selected now: typed fields, the
 * target box and the address card. Rules that already allow selection keep
 * working, because a set `user-select: text` wins over the page's none.
 */
export const STYLE = `
body {
  -webkit-user-select: none;
  user-select: none;
}
input,
textarea,
[contenteditable='true'],
#target-box-panel .tb-rows,
#address-card {
  -webkit-user-select: text;
  user-select: text;
}
`;

/** @returns {() => void} Takes the rule away again. */
export function installSelectGuard(doc = document) {
  const style = doc.createElement('style');
  style.id = 'zenith-select-guard';
  style.textContent = STYLE;
  doc.head.appendChild(style);
  return () => style.remove();
}
