import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';

test('parses header and rows', () => {
  const { header, rows } = parseCsv('time,lat,lon\n1,2,3\n4,5,6\n');
  assert.deepEqual(header, ['time', 'lat', 'lon']);
  assert.deepEqual(rows, [['1', '2', '3'], ['4', '5', '6']]);
});

test('ignores blank lines and trims cells', () => {
  const { rows } = parseCsv('a,b\n 1 , 2 \n\n3,4\n');
  assert.deepEqual(rows, [['1', '2'], ['3', '4']]);
});

test('handles CRLF line endings', () => {
  const { header, rows } = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['1', '2']]);
});

test('empty input -> empty header/rows', () => {
  const { header, rows } = parseCsv('');
  assert.deepEqual(header, []);
  assert.deepEqual(rows, []);
});
