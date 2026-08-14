import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags } from '../src/tags.js';

test('range events from start/end', () => {
  const ev = parseTags(['start', 'end', 'label'],
    [['1786078560000000000', '1786078620000000000', 'upwind']]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'range');
  assert.equal(ev[0].label, 'upwind');
  assert.ok(ev[0].tEnd > ev[0].t);
});

test('point events from time', () => {
  const ev = parseTags(['time', 'label'], [['1000000000000000', 'mark']]);
  assert.equal(ev[0].kind, 'point');
  assert.equal(ev[0].tEnd, null);
  assert.equal(ev[0].label, 'mark');
});

test('optional lat/lon parsed, else null', () => {
  const withPos = parseTags(['time', 'label', 'lat', 'lon'],
    [['1000000000000000', 'x', '35.3', '139.48']]);
  assert.equal(withPos[0].lat, 35.3);
  assert.equal(withPos[0].lon, 139.48);
  const noPos = parseTags(['time', 'label'], [['1000000000000000', 'x']]);
  assert.equal(noPos[0].lat, null);
});

test('skips rows with invalid time', () => {
  const ev = parseTags(['time', 'label'], [['bad', 'x'], ['1000000000000000', 'ok']]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].label, 'ok');
});

test('skips range rows with an invalid end timestamp', () => {
  const ev = parseTags(['start', 'end', 'label'],
    [['1786078560000000000', 'bad', 'broken'],
     ['1786078560000000000', '1786078620000000000', 'ok']]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].label, 'ok');
  assert.equal(ev[0].kind, 'range');
});
