// test/perf-compare-script.test.js
// scripts/perf-compare-projects.mjs が小さいパラメータで「JSON equal: true」・終了コード 0 になること。
// S2 の組織スコープ後、取込みと子サーバに MIGRATION_ORG_ID を渡さず DB 版が 404 になった不具合(S1.1-P5)の回帰。
// node:sqlite が要る(Node >=22.5 / 24)。子サーバを起動するので数秒かかる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const skipMsg = hasSqlite ? undefined : 'node:sqlite が要る(Node >=22.5 / 24)';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'perf-compare-projects.mjs');

test('perf-compare-projects: DB 版も 200 で file 版と JSON が一致し、終了コード 0', { skip: skipMsg, timeout: 120000 }, () => {
  const r = spawnSync(process.execPath,
    [SCRIPT, '--runs', '1', '--warmup', '0', '--synthetic-tracks', '2', '--synthetic-points', '50'],
    { encoding: 'utf8', timeout: 110000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /status=404/);
  assert.doesNotMatch(r.stderr, /MIGRATION_ORG_ID が未設定/);
  assert.equal((r.stdout.match(/JSON equal[^\n]*: true/g) || []).length, 2);
});
