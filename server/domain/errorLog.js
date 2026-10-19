// 500 のログ用に例外を要約する純関数。e.message は返さない(入力の断片=パスワード等が入りうる)。
// name: Error なら e.name、それ以外(文字列・数値・null など)は型名。
// frames: スタックの「    at …」行だけ。メッセージが複数行で「改行+空白+at 」を含んでも
//   先頭のメッセージ部分を先に切るのでフレーム扱いにならない。
export function describeError(e) {
  const isErr = e instanceof Error || (e && typeof e === 'object' && typeof e.stack === 'string');
  if (!isErr) return { name: e === null ? 'null' : typeof e, frames: '' };
  const name = (typeof e.name === 'string' && e.name) || 'Error';
  let stack = String(e.stack || '');
  const head = String(e);
  if (stack.startsWith(head)) stack = stack.slice(head.length);
  else if (typeof e.message === 'string' && e.message) stack = stack.split(e.message).join('');
  const frames = stack.split('\n').filter((l) => /^\s+at /.test(l)).join('\n');
  return { name, frames };
}

// 静的配信の外側 catch 用。本文は汎用メッセージ(例外の文字列は出さない)。ステータスは 500 のまま。
export function respondStaticError(res, e, label = '') {
  const { name, frames } = describeError(e);
  console.error(`[static] ${label} -> 500: ${name}\n${frames}`);
  res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal Server Error');
}
