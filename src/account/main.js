// src/account/main.js
// アカウント画面(S2.7)。/account(登録・ログイン・組織作成・名簿)、/verify-email、/reset-password を1ファイルで描く。
// API は設計書 v2 §10.2・§10.3 のものだけを使う。ログインのセッションは HttpOnly Cookie(same-origin)。
// 確認・再設定のトークンは読んだらすぐ URL から消し(history.replaceState)、ログや外部へ出さない。
import {
  pageModeForPath, tokenFromSearch, apiErrorMessage, parseRosterText, rosterToText, checkNewPassword, checkRegisterForm, membersView,
  soleAdminOrgs, unloadedAdminOrgs, frozenSuccessionNotices, isOrgAdmin, unloadedNotice, displayName, buildDeleteBody, inviteCodeFromPath, parseInviteForm, inviteLimitLabel, joinFailureView, resendFailureView, accountExtrasFromMeta,
} from './logic.js';

// 凍結した入口(名簿・招待の期限と回数・後任の選択)。サーバが meta を差し込んだときだけ出す(FZ1。FEATURE_ACCOUNT_EXTRAS=1)。
const EXTRAS = accountExtrasFromMeta(document.querySelector('meta[name="sailviz-features"]')?.content);

const main = document.getElementById('ac-main');
const nav = document.getElementById('ac-nav');

// ---- 小さな DOM ヘルパ(文字列は textContent で入れ、HTML として解釈しない) ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const field = (label, input) => h('label', {}, label, input);

// ---- API ----
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { return { status: 0, json: null }; }
  let json = null;
  try { json = await res.json(); } catch { /* 本文なし */ }
  return { status: res.status, json };
}

// ---- メッセージ ----
let msgEl = null;
function setMsg(text, kind = 'info') {
  if (!msgEl) return;
  msgEl.textContent = text || '';
  msgEl.dataset.kind = kind;
  msgEl.hidden = !text;
  msgEl.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
function mount(...nodes) {
  main.replaceChildren();
  msgEl = h('p', { id: 'ac-msg', class: 'ac-msg', hidden: true });
  main.append(msgEl, ...nodes);
}
async function submitting(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

// ---- 状態 ----
let me = null; // GET /api/me の応答。未ログインは null

async function loadMe() {
  const r = await api('GET', '/api/me');
  me = r.status === 200 ? r.json : null;
  return r;
}

function renderNav() {
  nav.replaceChildren();
  if (me) {
    nav.append(h('a', { href: '/account' }, 'アカウント'));
    if (me.org) nav.append(h('a', { href: '/account#roster' }, EXTRAS ? '名簿' : '組織'));
  }
  nav.append(h('a', { href: '/' }, 'SailViz へ'));
}

// ---- /verify-email ----
async function renderVerify() {
  const token = tokenFromSearch(location.search);
  history.replaceState(null, '', location.pathname); // トークンを URL から消す
  const result = h('p', { id: 'ac-verify-result', 'data-state': 'pending' }, '確認しています…');
  mount(h('section', { class: 'ac-card' }, h('h1', {}, 'メールアドレスの確認'), result));
  if (!token) {
    result.dataset.state = 'error';
    result.textContent = '確認リンクが正しくありません。メールのリンクをそのまま開いてください。';
    main.append(h('p', {}, h('a', { href: '/account' }, 'アカウントのページへ')));
    return;
  }
  const r = await api('POST', '/api/auth/verify-email', { verifyToken: token });
  if (r.status === 200) {
    result.dataset.state = 'ok';
    result.textContent = 'メールアドレスを確認しました。';
    main.append(h('section', { class: 'ac-card' },
      h('p', { id: 'ac-verify-next' }, 'SailViz のアプリに戻って、再読み込み(画面を引き下げる、または開き直す)してください。'),
      h('p', { class: 'ac-note' }, 'Web で使う場合は下のリンクからどうぞ。'),
      h('a', { class: 'ac-btn', href: '/account' }, 'アカウントのページへ')));
    return;
  }
  result.dataset.state = 'error';
  result.textContent = r.status === 422
    ? 'このリンクは無効か、期限切れまたは使用済みです。ログイン後、アカウントのページから確認メールを再送してください。'
    : r.status === 0
      ? `${apiErrorMessage(0, null)}。メールのリンクをもう一度開いてください。`
      : apiErrorMessage(r.status, r.json);
  main.append(h('p', {}, h('a', { class: 'ac-btn', href: '/account' }, 'アカウントのページへ')));
}

// ---- /reset-password ----
function renderReset() {
  const token = tokenFromSearch(location.search);
  history.replaceState(null, '', location.pathname);
  if (!token) {
    mount(h('section', { class: 'ac-card' }, h('h1', {}, 'パスワードの再設定'),
      h('p', { id: 'ac-reset-result', 'data-state': 'error' }, '再設定リンクが正しくありません。メールのリンクをそのまま開くか、もう一度再設定を申請してください。'),
      h('a', { class: 'ac-btn', href: '/account#forgot' }, '再設定を申請する')));
    return;
  }
  const pw = h('input', { id: 'ac-reset-pw', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const pw2 = h('input', { id: 'ac-reset-pw2', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const btn = h('button', { id: 'ac-reset-submit', class: 'ac-btn', type: 'submit' }, '新しいパスワードを設定');
  const form = h('form', { class: 'ac-form', novalidate: true }, field('新しいパスワード(8文字以上)', pw), field('新しいパスワード(確認)', pw2), btn);
  mount(h('section', { class: 'ac-card' }, h('h1', {}, 'パスワードの再設定'), form));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      const c = checkNewPassword(pw.value, pw2.value);
      if (!c.ok) return setMsg(c.message, 'error');
      const r = await api('POST', '/api/auth/password-reset/confirm', { resetToken: token, newPassword: pw.value });
      if (r.status === 200) {
        mount(h('section', { class: 'ac-card' }, h('h1', {}, 'パスワードの再設定'),
          h('p', { id: 'ac-reset-result', 'data-state': 'ok' }, 'パスワードを変更しました。新しいパスワードでログインしてください。'),
          h('a', { class: 'ac-btn', href: '/account' }, 'ログインへ')));
      } else if (r.status === 422 && r.json?.error?.code === 'invalid_token') {
        mount(h('section', { class: 'ac-card' }, h('h1', {}, 'パスワードの再設定'),
          h('p', { id: 'ac-reset-result', 'data-state': 'error' }, 'このリンクは無効か、期限切れまたは使用済みです。もう一度再設定を申請してください。'),
          h('a', { class: 'ac-btn', href: '/account#forgot' }, '再設定を申請する')));
      } else setMsg(apiErrorMessage(r.status, r.json), 'error');
    });
  });
}

// ---- /account(未ログイン) ----
function renderLoggedOut(tab) {
  const tabs = h('div', { class: 'ac-tabs', role: 'tablist' },
    ...[['login', 'ログイン'], ['register', '新規登録'], ['forgot', 'パスワードを忘れた']].map(([id, label]) =>
      h('button', { id: `ac-tab-${id}`, class: 'ac-tab', type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => { history.replaceState(null, '', `/account#${id}`); render(); } }, label)));
  let body;
  if (tab === 'register') body = registerForm();
  else if (tab === 'forgot') body = forgotForm();
  else body = loginForm();
  mount(h('section', { class: 'ac-card' }, h('h1', {}, 'SailViz アカウント'), tabs, body));
}

// ログイン・登録のあとの動作。既定は /account へ。参加ページ(/join/:code)では URL を変えずに描き直して戻る。
const toAccount = async () => { history.replaceState(null, '', '/account'); await render(); };

function loginForm(after = toAccount) {
  const email = h('input', { id: 'ac-login-email', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { id: 'ac-login-password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { id: 'ac-login-submit', class: 'ac-btn', type: 'submit' }, 'ログイン');
  const form = h('form', { class: 'ac-form', novalidate: true }, field('メールアドレス', email), field('パスワード', pw), btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      if (!email.value.trim() || !pw.value) return setMsg('メールアドレスとパスワードを入力してください', 'error');
      const r = await api('POST', '/api/auth/login', { email: email.value, password: pw.value });
      if (r.status !== 200) return setMsg(apiErrorMessage(r.status, r.json), 'error');
      await after();
    });
  });
  return form;
}

function registerForm(after = toAccount) {
  const email = h('input', { id: 'ac-reg-email', type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { id: 'ac-reg-password', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const name = h('input', { id: 'ac-reg-name', type: 'text', autocomplete: 'name', required: true });
  const affil = h('input', { id: 'ac-reg-affil', type: 'text', required: true });
  const agree = h('input', { id: 'ac-reg-agree', type: 'checkbox' });
  const btn = h('button', { id: 'ac-reg-submit', class: 'ac-btn', type: 'submit' }, '登録する');
  const form = h('form', { class: 'ac-form', novalidate: true },
    h('p', { class: 'ac-note' }, '登録すると確認メールが届きます。メールのリンクを開くとアカウントが有効になります。'),
    EXTRAS && h('p', { id: 'ac-reg-roster-note', class: 'ac-note' }, '部の名簿に載っているアドレスで登録してください。名簿と違うアドレスでは、部に自動で紐付きません。'),
    field('メールアドレス', email), field('パスワード(8文字以上)', pw), field('氏名', name), field('所属(例: ○○大学ヨット部)', affil),
    h('label', { id: 'ac-reg-agree-label', class: 'ac-check' }, agree, '利用規約・プライバシーポリシー・位置情報と録音の用途に同意します'), btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      const f = { email: email.value, password: pw.value, name: name.value, affiliationText: affil.value, agreed: agree.checked };
      const c = checkRegisterForm(f);
      if (!c.ok) return setMsg(c.message, 'error');
      // agreedAt は「同意ボタンを押した時刻」をクライアントの時計(Date.now())で送る。サーバの受信時刻には揃えていない。
      // サーバ時刻に揃えるなら API 契約(設計書 v2 §10)の変更になるため、人の判断待ち(S2.7-P2 P3-3)。
      const r = await api('POST', '/api/auth/register', {
        email: f.email, password: f.password, name: f.name, affiliationText: f.affiliationText, agreedAt: Date.now(),
      });
      if (r.status !== 200) return setMsg(apiErrorMessage(r.status, r.json), 'error');
      await after();
      setMsg('登録しました。確認メールのリンクを開いてください。', 'ok');
    });
  });
  return form;
}

function forgotForm() {
  const email = h('input', { id: 'ac-forgot-email', type: 'email', autocomplete: 'email', required: true });
  const btn = h('button', { id: 'ac-forgot-submit', class: 'ac-btn', type: 'submit' }, '再設定メールを送る');
  const form = h('form', { class: 'ac-form', novalidate: true },
    h('p', { class: 'ac-note' }, 'メールアドレスを確認済みのアカウントに、再設定のリンクを送ります。'),
    field('メールアドレス', email), btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      if (!email.value.trim()) return setMsg('メールアドレスを入力してください', 'error');
      const r = await api('POST', '/api/auth/password-reset/request', { email: email.value });
      if (r.status !== 200) return setMsg(apiErrorMessage(r.status, r.json), 'error');
      // 登録の有無は返さない(サーバと同じ)ので、文言も断定しない
      setMsg('登録済み(確認済み)のメールアドレスであれば、再設定のリンクを送りました。', 'ok');
    });
  });
  return form;
}

// ---- /account(ログイン済み) ----
function profileCard() {
  const u = me.user;
  const verified = me.emailVerified === true;
  const logout = h('button', { id: 'ac-logout', class: 'ac-btn ac-btn-ghost', type: 'button' }, 'ログアウト');
  logout.addEventListener('click', () => submitting(logout, async () => {
    await api('POST', '/api/auth/logout', {});
    me = null; history.replaceState(null, '', '/account'); await render();
  }));
  const rows = [
    h('dt', {}, '氏名'), h('dd', { id: 'ac-me-name' }, u.name),
    h('dt', {}, 'メール'), h('dd', { id: 'ac-me-email' }, u.email),
    h('dt', {}, '確認'), h('dd', {}, h('span', { id: 'ac-me-verified', class: 'ac-badge', 'data-ok': String(verified) }, verified ? '確認済み' : '未確認')),
  ];
  const actions = [logout];
  if (!verified) {
    const resend = h('button', { id: 'ac-resend', class: 'ac-btn', type: 'button' }, '確認メールを再送');
    resend.addEventListener('click', () => submitting(resend, async () => {
      const r = await api('POST', '/api/auth/verify-email/resend', {});
      if (r.status === 200) setMsg('確認メールを送りました。届いたリンクを開いてください。', 'ok');
      else {
        const rv = resendFailureView(r.status, r.json);
        if (rv.needsLogin) return dropToAccountLogin();
        setMsg(rv.message, 'error');
      }
    }));
    actions.unshift(resend);
  }
  return h('section', { class: 'ac-card' }, h('h1', {}, 'アカウント'), h('dl', { class: 'ac-dl' }, ...rows),
    !verified && h('p', { class: 'ac-note' }, EXTRAS ? 'メールの確認が済むと、組織の作成や名簿との自動紐付けができます。' : 'メールの確認が済むと、組織の作成や招待リンクでの参加ができます。'),
    h('div', { class: 'ac-row' }, ...actions));
}

function orgCard() {
  if (me.org) {
    return h('section', { class: 'ac-card' }, h('h2', {}, '組織'),
      h('p', {}, h('span', { id: 'ac-org-current' }, me.org.name)),
      h('a', { id: 'ac-open-roster', class: 'ac-btn', href: '/account#roster' }, EXTRAS ? '名簿を開く' : '組織を開く'));
  }
  if (me.emailVerified !== true) {
    return h('section', { class: 'ac-card' }, h('h2', {}, '組織'),
      h('p', { class: 'ac-note' }, '組織を作るには、先にメールアドレスの確認が必要です。'));
  }
  const name = h('input', { id: 'ac-org-name', type: 'text', required: true, maxlength: '100' });
  const btn = h('button', { id: 'ac-org-submit', class: 'ac-btn', type: 'submit' }, '組織を作成');
  const form = h('form', { class: 'ac-form', novalidate: true },
    h('p', { class: 'ac-note' }, EXTRAS ? '作成した人が組織の管理者になり、名簿を管理できます。' : '作成した人が組織の管理者になり、招待リンクでメンバーを招けます。'),
    field('組織の名前(例: ○○大学ヨット部)', name), btn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      if (!name.value.trim()) return setMsg('組織の名前を入力してください', 'error');
      const r = await api('POST', '/api/orgs', { name: name.value });
      if (r.status !== 201) return setMsg(apiErrorMessage(r.status, r.json), 'error');
      history.replaceState(null, '', '/account#roster');
      await render();
    });
  });
  return h('section', { class: 'ac-card' }, h('h2', {}, '組織を作る'), form);
}

// ---- 退会(S2.12。設計書 v2 §4.3・§10.2 DELETE /api/me) ----
// パスワードの再入力が要る。自分が唯一の管理者の組織があれば後任を選べる(選ばなければサーバが最も古く紐付いたメンバーへ自動で引き継ぐ: H25)。
function deleteCard() {
  const card = h('section', { id: 'ac-delete-card', class: 'ac-card' }, h('h2', {}, '退会'));
  const open = h('button', { id: 'ac-delete-open', class: 'ac-btn ac-btn-ghost', type: 'button' }, '退会する…');
  card.append(h('p', { class: 'ac-note' }, 'アカウントを削除します。取り消せません。個人情報は消え、同じメールアドレスで新しく登録し直せます。'), open);
  open.addEventListener('click', () => submitting(open, async () => {
    open.hidden = true;
    const area = h('div', { id: 'ac-delete-area' }, h('p', { class: 'ac-note' }, '読み込み中…'));
    card.append(area);
    const adminOrgs = (me.orgs || []).filter((o) => o.isAdmin === true);
    const membersByOrg = {};
    await Promise.all(adminOrgs.map(async (o) => {
      const r = await api('GET', `/api/orgs/${encodeURIComponent(o.id)}/members`);
      if (r.status === 200 && Array.isArray(r.json)) membersByOrg[o.id] = r.json;
    }));
    const sole = soleAdminOrgs(me.user.id, me.orgs, membersByOrg);
    const selects = {};
    const kids = [];
    for (const o of unloadedAdminOrgs(me.orgs, membersByOrg)) {
      kids.push(h('p', { class: 'ac-note ac-delete-unloaded', 'data-org': o.id },
        unloadedNotice(o.name)));
    }
    if (sole.length && !EXTRAS) {
      // 後任の手動選択は凍結(FZ1)。自動引き継ぎの案内だけ出す(サーバの挙動は変えない)。
      const n = frozenSuccessionNotices(sole);
      if (n.handover) kids.push(h('p', { id: 'ac-delete-successor-note', class: 'ac-note' }, n.handover));
      for (const t of n.noMember) kids.push(h('p', { class: 'ac-note ac-delete-nomember' }, t));
    } else if (sole.length) {
      kids.push(h('p', { id: 'ac-delete-successor-note', class: 'ac-note' },
        '次の組織はあなたが唯一の管理者です。後任の管理者を選んでください。選ばない場合は、最も古く紐付いたメンバーに自動で管理者が引き継がれます。'));
      for (const s of sole) {
        const sel = h('select', { class: 'ac-delete-successor', 'data-org': s.orgId },
          h('option', { value: '' }, '選ばない(自動で引き継ぐ)'),
          ...s.candidates.map((c) => h('option', { value: c.userId }, displayName(c.name))));
        selects[s.orgId] = sel;
        kids.push(field(`${s.orgName} の後任`, sel));
        if (!s.candidates.length) kids.push(h('p', { class: 'ac-note' }, `${s.orgName} には、あなた以外のメンバーがいません。`));
      }
    }
    const pw = h('input', { id: 'ac-delete-password', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { id: 'ac-delete-submit', class: 'ac-btn', type: 'submit' }, '退会を確定する');
    const cancel = h('button', { id: 'ac-delete-cancel', class: 'ac-btn ac-btn-ghost', type: 'button' }, 'やめる');
    cancel.addEventListener('click', () => { area.remove(); open.hidden = false; });
    const form = h('form', { class: 'ac-form', novalidate: true }, ...kids, field('確認のため、パスワードを入力してください', pw), h('div', { class: 'ac-row' }, btn, cancel));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(btn, async () => {
        const choices = {};
        for (const [orgId, sel] of Object.entries(selects)) choices[orgId] = sel.value;
        const b = buildDeleteBody(pw.value, choices);
        if (!b.ok) return setMsg(b.message, 'error');
        const r = await api('DELETE', '/api/me', b.body);
        if (r.status !== 200) return setMsg(apiErrorMessage(r.status, r.json), 'error');
        me = null; history.replaceState(null, '', '/account');
        await render();
        setMsg('退会しました。ご利用ありがとうございました。', 'ok');
      });
    });
    area.replaceChildren(form);
  }));
  return card;
}

async function renderAccount() {
  mount(profileCard(), orgCard(), deleteCard());
}

// ---- 組織(名簿は凍結中。FZ1) ----
// 名簿の提出・一覧は出さず、招待リンクの管理(管理者のみ)とメンバー一覧だけを出す。管理者かどうかは /api/me の orgs[].isAdmin で見る。
async function renderOrgHome(orgId) {
  const title = h('h1', {}, `組織: ${me.org.name}`);
  mount(h('section', { class: 'ac-card' }, title));
  const mr = await api('GET', `/api/orgs/${orgId}/members`);
  if (!title.isConnected) return; // 待っている間に別の描画が画面を差し替えた
  const isAdmin = isOrgAdmin(me.orgs, me.org.id);
  if (isAdmin) main.append(invitesCard(orgId));
  const mv = membersView(mr.status, mr.json);
  if (mv.kind === 'error') {
    main.append(h('section', { class: 'ac-card' }, h('h2', {}, '組織のメンバー'),
      h('p', { id: 'ac-members-error', class: 'ac-note', role: 'alert' }, mv.message)));
    return;
  }
  main.append(h('section', { class: 'ac-card' }, h('h2', {}, `組織のメンバー(${mv.members.length} 人)`),
    mv.members.length ? h('ul', { id: 'ac-members', class: 'ac-list' }, ...mv.members.map((m) => h('li', {}, m.name))) : h('p', { class: 'ac-note' }, 'まだ紐付け済みのメンバーはいません。')));
}

// ---- 名簿 ----
// URL の #roster は、既存のリンクやブックマークを壊さないため凍結中も残す(凍結中は中身だけ組織の画面になる)。
async function renderRoster() {
  if (!me.org) { history.replaceState(null, '', '/account'); return renderAccount(); }
  const orgId = encodeURIComponent(me.org.id);
  if (!EXTRAS) return renderOrgHome(orgId);
  const area = h('section', { class: 'ac-card' }, h('h1', {}, `名簿: ${me.org.name}`), h('p', { class: 'ac-note' }, '読み込み中…'));
  mount(area);
  const [rr, mr] = await Promise.all([api('GET', `/api/orgs/${orgId}/roster`), api('GET', `/api/orgs/${orgId}/members`)]);
  if (!area.isConnected) return; // 待っている間に別の描画(hashchange など)が画面を差し替えた。古い方は何も足さない
  area.replaceChildren(h('h1', {}, `名簿: ${me.org.name}`));
  if (rr.status === 403) {
    area.append(h('p', { id: 'ac-roster-denied', class: 'ac-note' }, '名簿を見られるのは組織の管理者だけです。'));
  } else if (rr.status !== 200 || !Array.isArray(rr.json)) {
    setMsg(apiErrorMessage(rr.status, rr.json), 'error');
  } else {
    const rows = rr.json;
    const ta = h('textarea', { id: 'ac-roster-text', rows: '8', spellcheck: 'false', placeholder: '氏名,メール,旧名簿の氏名(任意)\n部員A,a@example.com,' });
    ta.value = rosterToText(rows);
    const save = h('button', { id: 'ac-roster-save', class: 'ac-btn', type: 'submit' }, '名簿を提出');
    const form = h('form', { class: 'ac-form', novalidate: true },
      h('p', { class: 'ac-note' }, '1行に1人、「氏名,メール,旧名簿の氏名(任意)」の順で入力します(CSV の貼り付け可)。提出すると名簿全体が置き換わり、メールが一致する確認済みの人が自動で組織に紐付きます。名簿から外すと紐付けも外れます。'),
      h('p', { id: 'ac-roster-header-note', class: 'ac-note' }, 'ヘッダ行を付けるときは「氏名,メール」の形にしてください(1列だけの「氏名」はヘッダにならず、部員の名前として読まれます)。'),
      ta, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(save, async () => {
        const p = parseRosterText(ta.value);
        if (!p.ok) return setMsg(p.message, 'error');
        const r = await api('PUT', `/api/orgs/${orgId}/roster`, { roster: p.rows });
        if (r.status !== 200) return setMsg(apiErrorMessage(r.status, r.json), 'error');
        await renderRoster();
        setMsg(`名簿を提出しました(${p.rows.length} 人。新しく紐付け ${r.json.linked?.length ?? 0} 人・解除 ${r.json.unlinked?.length ?? 0} 人)。`, 'ok');
      });
    });
    const table = h('div', { class: 'ac-table-wrap' }, h('table', { id: 'ac-roster-table', class: 'ac-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '氏名'), h('th', {}, 'メール'), h('th', {}, '状態'))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.email || '—'), h('td', {}, r.linkedUserId ? '紐付け済み' : '未紐付け'))))));
    area.append(form, h('h2', {}, `名簿の現在の内容(${rows.length} 人)`), rows.length ? table : h('p', { class: 'ac-note' }, 'まだ名簿はありません。'));
    main.append(invitesCard(orgId)); // 名簿が読めた = 管理者。招待の管理は管理者だけに出す
  }
  const mv = membersView(mr.status, mr.json);
  if (mv.kind === 'error') {
    main.append(h('section', { class: 'ac-card' }, h('h2', {}, '組織のメンバー'),
      h('p', { id: 'ac-members-error', class: 'ac-note', role: 'alert' }, mv.message)));
    return;
  }
  const members = mv.members;
  main.append(h('section', { class: 'ac-card' }, h('h2', {}, `組織のメンバー(${members.length} 人)`),
    members.length ? h('ul', { id: 'ac-members', class: 'ac-list' }, ...members.map((m) => h('li', {}, m.name))) : h('p', { class: 'ac-note' }, 'まだ紐付け済みのメンバーはいません。')));
}

// ---- 招待の管理(組織管理者。S2.10) ----
// API: POST/GET /api/orgs/:orgId/invites、POST …/invites/:inviteId/revoke(設計書 v2 §10.3)。
// 配るリンクは参加ページの正規の形 `<このサイトの origin>/join/<code>`(サーバが返す `/?invite=` 形も同じページに着く)。
// 意図: 管理者が今開いているサイトの origin をそのまま使う(サーバの PUBLIC_BASE_URL は使わない。API の url とは別物で、契約は変えない)。
const joinUrlFor = (code) => `${location.origin}/join/${encodeURIComponent(code)}`;

async function copyText(text, inputEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 権限なし・非 https など */ }
  try { inputEl.focus(); inputEl.select(); return document.execCommand('copy'); } catch { return false; }
}

function invitesCard(orgId) {
  const card = h('section', { id: 'ac-invites-card', class: 'ac-card' }, h('h2', {}, '招待リンク'),
    h('p', { class: 'ac-note' }, 'リンクを知っている人は、ログインして「参加」を押すとこの組織のメンバーになれます(メール確認済みの人のみ)。配る相手を選んでください。'));
  const list = h('div', { id: 'ac-invites-list' }, h('p', { class: 'ac-note' }, '読み込み中…'));
  const created = h('div', { id: 'ac-invite-created', hidden: true });
  const days = h('input', { id: 'ac-invite-days', type: 'text', inputmode: 'numeric', placeholder: '空なら無期限' });
  const uses = h('input', { id: 'ac-invite-uses', type: 'text', inputmode: 'numeric', placeholder: '空なら無制限' });
  const btn = h('button', { id: 'ac-invite-create', class: 'ac-btn', type: 'submit' }, '招待リンクを発行');
  // 期限・回数の入力欄は凍結(FZ1)。既定は無期限・無制限で発行する(本文は空)。
  const form = h('form', { class: 'ac-form', novalidate: true }, ...(EXTRAS ? [field('有効日数(1〜365、任意)', days), field('使用回数の上限(1〜1000、任意)', uses)] : []), btn);

  const copyBtn = (text, input, id) => {
    const b = h('button', { class: 'ac-btn ac-btn-ghost ac-invite-copy', type: 'button', id }, 'コピー');
    b.addEventListener('click', async () => {
      const ok = await copyText(text, input);
      setMsg(ok ? '招待リンクをコピーしました。' : 'コピーできませんでした。リンクを選択して手動でコピーしてください。', ok ? 'ok' : 'error');
    });
    return b;
  };
  const urlInput = (url, id) => h('input', { class: 'ac-invite-url', id, type: 'text', readonly: true, value: url, 'aria-label': '招待リンク' });

  async function refresh() {
    const r = await api('GET', `/api/orgs/${orgId}/invites`);
    if (r.status !== 200 || !Array.isArray(r.json)) {
      list.replaceChildren(h('p', { id: 'ac-invites-error', class: 'ac-note', role: 'alert' }, `招待を読み込めませんでした。${apiErrorMessage(r.status, r.json)}`));
      return;
    }
    if (!r.json.length) { list.replaceChildren(h('p', { id: 'ac-invites-empty', class: 'ac-note' }, '有効な招待リンクはありません。')); return; }
    const now = Date.now();
    list.replaceChildren(h('ul', { id: 'ac-invites', class: 'ac-list' }, ...r.json.map((inv) => {
      const url = joinUrlFor(inv.code);
      const input = urlInput(url);
      const revoke = h('button', { class: 'ac-btn ac-btn-ghost ac-invite-revoke', type: 'button' }, '失効させる');
      revoke.addEventListener('click', () => submitting(revoke, async () => {
        if (!window.confirm('この招待リンクを失効させます。以後このリンクでは参加できません。よろしいですか?')) return;
        const rv = await api('POST', `/api/orgs/${orgId}/invites/${encodeURIComponent(inv.id)}/revoke`, {});
        if (rv.status !== 200) return setMsg(apiErrorMessage(rv.status, rv.json), 'error');
        await refresh();
        setMsg('招待リンクを失効させました。', 'ok');
      }));
      return h('li', { class: 'ac-invite-row' }, input, h('p', { class: 'ac-note ac-invite-limit' }, inviteLimitLabel(inv, now)),
        h('div', { class: 'ac-row' }, copyBtn(url, input), revoke));
    })));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(btn, async () => {
      const p = EXTRAS ? parseInviteForm(days.value, uses.value) : { ok: true, body: {} };
      if (!p.ok) return setMsg(p.message, 'error');
      const r = await api('POST', `/api/orgs/${orgId}/invites`, p.body);
      if (r.status !== 201 || !r.json?.code) return setMsg(apiErrorMessage(r.status, r.json), 'error');
      const url = joinUrlFor(r.json.code);
      const input = urlInput(url, 'ac-invite-url');
      created.hidden = false;
      created.replaceChildren(h('p', { class: 'ac-note' }, '発行しました。このリンクを招待したい人に送ってください。'), input, h('div', { class: 'ac-row' }, copyBtn(url, input, 'ac-invite-copy')));
      await refresh();
      setMsg('招待リンクを発行しました。', 'ok');
    });
  });
  card.append(form, created, h('h3', {}, '有効な招待リンク'), list);
  refresh();
  return card;
}

// アカウントページで 401 になったとき: 未ログイン表示に落とす(参加ページの dropToJoinLogin と同じ文言)。
function dropToAccountLogin() {
  me = null; renderNav(); renderLoggedOut('login');
  setMsg('ログインの有効期限が切れました。もう一度ログインしてください。', 'error');
}

// ---- 参加ページ /join/:code(`/?invite=<code>` はサーバが 302 でここへ寄せる。S2.10) ----
// data-join-401="login": 401 でログインの案内に落ちる版の目印(動作テストが版を見分けるのに使う)
function joinCard(...kids) { return h('section', { class: 'ac-card', 'data-join-401': 'login' }, h('h1', {}, '組織への招待'), ...kids); }

// ログイン切れ(401)のとき: 未ログイン表示に落として、ログインを促す(ログイン後は URL のまま参加ページを描き直す)。
function dropToJoinLogin() {
  me = null; renderNav(); renderJoinLoggedOut('login');
  setMsg('ログインの有効期限が切れました。もう一度ログインしてください。', 'error');
}

function renderJoinLoggedOut(tab) {
  const tabs = h('div', { class: 'ac-tabs', role: 'tablist' },
    ...[['login', 'ログイン'], ['register', '新規登録']].map(([id, label]) =>
      h('button', { id: `ac-tab-${id}`, class: 'ac-tab', type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => renderJoinLoggedOut(id) }, label)));
  mount(joinCard(
    h('p', { id: 'ac-join-login-note' }, '組織への招待リンクです。参加するには、ログインまたは新規登録をしてください(メールアドレスの確認も必要です)。'),
    tabs, tab === 'register' ? registerForm(render) : loginForm(render)));
}

async function renderJoin() {
  const code = inviteCodeFromPath(location.pathname);
  if (!code) {
    mount(joinCard(h('p', { id: 'ac-join-result', 'data-state': 'error' }, '招待リンクが正しくありません。')));
    return;
  }
  const r = await loadMe();
  renderNav();
  if (!me) {
    renderJoinLoggedOut('login');
    if (r.status === 503) setMsg(apiErrorMessage(503, r.json), 'error');
    return;
  }
  const pv = await api('GET', `/api/invites/${encodeURIComponent(code)}`);
  if (pv.status !== 200) {
    const v = joinFailureView(pv.status, pv.json);
    if (v.needsLogin) return dropToJoinLogin();
    const kids = [h('p', { id: 'ac-join-result', 'data-state': 'error', 'data-kind': v.kind }, v.message)];
    if (v.kind === 'unverified') {
      const resend = h('button', { id: 'ac-resend', class: 'ac-btn', type: 'button' }, '確認メールを再送');
      resend.addEventListener('click', () => submitting(resend, async () => {
        const rs = await api('POST', '/api/auth/verify-email/resend', {});
        if (rs.status === 200) setMsg('確認メールを送りました。届いたリンクを開いたあと、この招待リンクをもう一度開いてください。', 'ok');
        else {
          const rv = resendFailureView(rs.status, rs.json);
          if (rv.needsLogin) return dropToJoinLogin();
          setMsg(rv.message, 'error');
        }
      }));
      kids.push(resend);
    }
    mount(joinCard(...kids));
    return;
  }
  const { orgName, valid } = pv.json;
  if (!valid) {
    const v = joinFailureView(410, { error: { code: `invite_${pv.json.reason}` } });
    mount(joinCard(h('p', { id: 'ac-join-org' }, orgName), h('p', { id: 'ac-join-result', 'data-state': 'error', 'data-kind': v.kind }, v.message)));
    return;
  }
  const btn = h('button', { id: 'ac-join-submit', class: 'ac-btn', type: 'button' }, `${orgName} に参加`);
  btn.addEventListener('click', () => submitting(btn, async () => {
    const a = await api('POST', `/api/invites/${encodeURIComponent(code)}/accept`, {});
    if (a.status === 200) {
      mount(joinCard(h('p', { id: 'ac-join-result', 'data-state': 'ok' }, `${orgName} に参加しました。すでに参加済みだった場合も、この表示になります。`),
        h('a', { class: 'ac-btn', href: '/account' }, 'アカウントのページへ')));
      return;
    }
    const v = joinFailureView(a.status, a.json);
    if (v.needsLogin) return dropToJoinLogin();
    setMsg(v.message, 'error');
  }));
  mount(joinCard(h('p', { id: 'ac-join-org' }, orgName), h('p', { class: 'ac-note' }, `「${orgName}」に招待されています。参加すると、この組織のメンバーとして${EXTRAS ? '名簿・' : ''}共有の対象になります。`), btn));
}

// ---- 入口 ----
async function render() {
  const mode = pageModeForPath(location.pathname);
  if (mode === 'join') return renderJoin();
  if (mode === 'verify') { renderNav(); return renderVerify(); }
  if (mode === 'reset') { renderNav(); return renderReset(); }
  const r = await loadMe();
  renderNav();
  const hash = location.hash.replace('#', '');
  if (me) return hash === 'roster' ? renderRoster() : renderAccount();
  renderLoggedOut(['register', 'forgot'].includes(hash) ? hash : 'login');
  if (r.status === 503) setMsg(apiErrorMessage(503, r.json), 'error');
}

window.addEventListener('hashchange', render);
render();
