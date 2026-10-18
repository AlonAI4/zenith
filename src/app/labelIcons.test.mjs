import assert from 'node:assert/strict';
import test from 'node:test';

import { OVERLAY_LABEL_ICONS } from '../overlays/worldOverlayDraw.js';
import { ICONS } from './drawnIcons.js';
import { LABEL_ICONS, iconPicture, installLabelIcons } from './labelIcons.js';

test('every label icon is one of the drawn icons', () => {
  for (const name of Object.values(LABEL_ICONS)) assert.ok(ICONS[name], name);
});

test('an icon picture is a standalone SVG in the given colour', () => {
  const svg = decodeURIComponent(
    iconPicture('rocket', '#22e6e6').split(',')[1],
  );
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  assert.match(svg, /stroke="#22e6e6"/);
  assert.ok(!svg.includes('currentColor'));
});

test('labels get their icons once loaded, and lose them when taken away', () => {
  const made = [];
  class Image {
    constructor() {
      made.push(this);
      this.complete = false;
      this.naturalWidth = 0;
    }
  }
  let renders = 0;
  const stop = installLabelIcons({ requestRender: () => renders++ }, { Image });
  try {
    const rocket = OVERLAY_LABEL_ICONS.get('rocket-missions');
    assert.equal(rocket('#22e6e6'), null, 'nothing to draw while it loads');
    assert.equal(made.length, 1);
    Object.assign(made[0], { complete: true, naturalWidth: 24 });
    made[0].onload();
    assert.equal(renders, 1, 'the map is drawn again');
    assert.equal(rocket('#22e6e6'), made[0]);
    rocket('#22e6e6');
    assert.equal(made.length, 1, 'one picture per icon and colour');
    rocket('#ff8a3d');
    OVERLAY_LABEL_ICONS.get('satellites-iss')('#22e6e6');
    assert.equal(made.length, 3, 'another colour or icon is its own picture');
    assert.match(decodeURIComponent(made[2].src), /stroke="#22e6e6"/);
  } finally {
    stop();
  }
  assert.equal(OVERLAY_LABEL_ICONS.size, 0);
});
