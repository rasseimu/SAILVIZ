import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectType } from '../src/detect.js';

test('sensor logger header -> gps', () => {
  const h = ['time', 'seconds_elapsed', 'latitude', 'longitude', 'speed', 'bearing', 'horizontalAccuracy'];
  assert.equal(detectType(h), 'gps');
});

test('label column -> tag', () => {
  assert.equal(detectType(['time', 'label']), 'tag');
});

test('start/end -> tag (range)', () => {
  assert.equal(detectType(['start', 'end', 'label']), 'tag');
});

test('case-insensitive', () => {
  assert.equal(detectType(['Time', 'Latitude', 'Longitude', 'Speed']), 'gps');
  assert.equal(detectType(['Start', 'End']), 'tag');
});

test('missing required -> unknown', () => {
  assert.equal(detectType(['foo', 'bar']), 'unknown');
});
