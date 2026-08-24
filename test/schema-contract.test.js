import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReflection } from '../src/reflections.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/reflection-golden.json', import.meta.url))
);

test('createReflection がゴールデン期待形と一致する', () => {
  const out = createReflection(golden.input);
  assert.deepEqual(out, golden.expected);
});
