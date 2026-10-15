import assert from 'node:assert/strict';
import test from 'node:test';

import { startCinema } from './cinema.js';
import { fakeDocument } from './fakeDom.mjs';

test('when it ends, focus that fell to the page goes back to the button that started it', () => {
  const doc = fakeDocument();
  const opener = doc.createElement('button');
  doc.body.appendChild(opener);
  // Starting hides the controls, so the focus drops to the page.
  const session = startCinema({ hint: 'Press any key to stop.', doc, win: doc.defaultView, returnFocusTo: opener });
  doc.activeElement = doc.body;
  session.end();
  assert.ok(doc.activeElement === opener, 'the focus went back to the button');
  // Focus the person moved somewhere on purpose is left alone.
  const elsewhere = doc.createElement('input');
  doc.body.appendChild(elsewhere);
  const again = startCinema({ hint: 'Again.', doc, win: doc.defaultView, returnFocusTo: opener });
  elsewhere.focus();
  again.end();
  assert.ok(doc.activeElement === elsewhere, 'focus moved on purpose stays put');
});
