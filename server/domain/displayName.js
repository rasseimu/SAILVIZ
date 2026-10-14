// server/domain/displayName.js
// User の表示名と既定公開範囲の補い(純関数・S2.3-P9 / C3 の決定)。DB には書かない。
// name が null・空・空白のみなら「ユーザー」+ id の sha256 の16進先頭4文字(決定的)。
// 4文字は表示専用。重なってもよい(人の区別は userId で行う)。
// メールの @ 前は使わない(学籍番号が同じ組織の人に見えるため)。
import { createHash } from 'node:crypto';

export const DEFAULT_VISIBILITY = 'private'; // C3 の「self」＝自分のみ＝private(§5.1 の3値に self は無い)

export function displayNameFor(user) {
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  if (name) return user.name;
  const id = String(user?.id ?? '');
  return `ユーザー${createHash('sha256').update(id).digest('hex').slice(0, 4)}`;
}

export function visibilityFor(user) {
  return user?.default_visibility ?? DEFAULT_VISIBILITY;
}
