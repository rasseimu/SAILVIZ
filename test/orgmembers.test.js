// test/orgmembers.test.js
// 反省・議事録・進捗のメンバー候補(server/orgMembers.js)。accounts はスタブ(名前はダミー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgMemberEntries, rosterForSubject } from '../server/orgMembers.js';
import { legacyMemberList } from '../src/members.js';

// org の名簿行・メンバー・ユーザーを持つ最小のスタブ
function stubAccounts({ roster = [], members = [], users = [] }) {
  return {
    listRoster: () => roster,
    listMembers: () => members,
    getUser: (id) => users.find((u) => u.id === id) ?? null,
  };
}

test('orgMemberEntries: 名簿行に結び付いた人はその旧名簿の氏名、結び付きの無い人(作成者)はメールが一致する未結び付きの名簿行', () => {
  const accounts = stubAccounts({
    roster: [
      { id: 'r1', email: 'm@example.test', legacy_name: '旧 部員' },
      { id: 'r2', email: 'admin@example.test', legacy_name: '旧 管理者' },
      { id: 'r3', email: 'other@example.test', legacy_name: '旧 別人' }, // u3 に結び付き済み
    ],
    members: [
      { user_id: 'u1', roster_id: 'r1' },
      { user_id: 'u2', roster_id: null },
      { user_id: 'u3', roster_id: 'r3' },
      { user_id: 'u4', roster_id: null },
    ],
    users: [
      { id: 'u1', name: '部員 一郎', email: 'm@example.test' },
      { id: 'u2', name: '管理 花子', email: 'ADMIN@example.test' },
      { id: 'u3', name: '別 次郎', email: 'x@example.test' },
      { id: 'u4', name: '', email: 'other@example.test' }, // メールは r3 と同じだが r3 は u3 に結び付き済み
    ],
  });
  const e = orgMemberEntries(accounts, 'o1');
  assert.deepEqual(e.map((x) => [x.userId, x.legacyName]), [['u1', '旧 部員'], ['u2', '旧 管理者'], ['u3', '旧 別人'], ['u4', null]]);
  assert.equal(e[3].name.startsWith('ユーザー'), true); // 名前が無い人は表示名の既定
});

test('rosterForSubject: アカウントの主体で表示中の組織があればそのメンバー、それ以外は従来の名簿', () => {
  const legacy = legacyMemberList().map((m) => m.fullName);
  const accounts = stubAccounts({ members: [{ user_id: 'u1', roster_id: null }], users: [{ id: 'u1', name: '山田 太郎' }] });
  const user = { kind: 'user', userId: 'u1', orgIds: ['o1'] };
  assert.deepEqual(rosterForSubject(accounts, user, 'o1').map((m) => m.fullName), ['山田 太郎']);
  assert.deepEqual(rosterForSubject(accounts, user, null).map((m) => m.fullName), legacy); // 表示中の組織なし
  assert.deepEqual(rosterForSubject(accounts, { kind: 'legacy', shared: true }, 'o1').map((m) => m.fullName), legacy);
  assert.deepEqual(rosterForSubject(null, user, 'o1').map((m) => m.fullName), legacy); // アカウント機能なし
  assert.deepEqual(rosterForSubject(null, null, null).map((m) => m.fullName), legacy);
});
