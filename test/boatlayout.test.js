import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIG_FIELDS } from '../src/reflections.js';
import { ANCHORS, anchorFor, BOAT_IMAGE } from '../src/boatlayout.js';

test('boatNo 以外の全 RIG_FIELDS にアンカーがある', () => {
  for (const f of RIG_FIELDS) {
    if (f === 'boatNo') continue;
    const a = anchorFor(f);
    assert.ok(a, `missing anchor: ${f}`);
    assert.ok(a.x >= 0 && a.x <= 1, `x range: ${f}`);
    assert.ok(a.y >= 0 && a.y <= 1, `y range: ${f}`);
    assert.ok(a.side === 'left' || a.side === 'right', `side: ${f}`);
  }
});

test('boatNo にはアンカーが無い', () => {
  assert.equal(anchorFor('boatNo'), null);
  assert.equal(ANCHORS.boatNo, undefined);
});

test('BOAT_IMAGE は 470.jpg を指す', () => {
  assert.equal(BOAT_IMAGE, 'sample-data/470.jpg');
});
