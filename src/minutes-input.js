// スマホ議事録入力ページの画面ロジック(DOM グルー)。純ロジックは import 先で検証済み。
import { apiAuthStatus, apiUnlock, apiCommitMinutes } from './api.js';
import { geminiGenerate } from './gemini.js';
import { buildMinutesSystemPrompt, parseAiMinutes, parseMinutes, parseMinutesDate } from './minutes.js';
import { aiToRows, blocksToRows, toCommitRows } from './minutes-rows.js';
import { memberList } from './members.js';
import { jstWallToMs, msToJstWall } from './time.js';

const $ = (id) => document.getElementById(id);
const roster = memberList();
let rows = []; // Row[]（minutes-rows の形状）

function setStatus(msg) { $('mn-status').textContent = msg || ''; }
function toast(msg) {
  const t = $('mn-toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2500);
}

// 練習日 <input type=date> の値(YYYY-MM-DD) → JST 0 時 ms。
function selectedPracticeDate() {
  const v = $('mn-date').value;
  return v ? jstWallToMs(`${v}T00:00`) : NaN;
}
function todayJstDate() { return msToJstWall(Date.now()).slice(0, 10); }

// 本文から練習日を拾って date 欄をプリフィル(取れなければ今日 JST)。
function prefillDate(text) {
  const defaultYear = Number(todayJstDate().slice(0, 4));
  const d = parseMinutesDate(text, { defaultYear });
  if (d) {
    $('mn-date').value = `${d.y}-${String(d.mo).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  } else if (!$('mn-date').value) {
    $('mn-date').value = todayJstDate();
  }
}

function renderPreview() {
  const box = $('mn-preview');
  box.textContent = '';
  if (!rows.length) { box.textContent = '整形結果はここに表示されます。'; return; }
  rows.forEach((row, i) => {
    const card = document.createElement('div');
    card.className = 'mn-row' + (row.fullName ? '' : ' mn-unmatched');

    const head = document.createElement('div');
    head.className = 'mn-row-head';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = row.include;
    chk.addEventListener('change', () => { rows[i].include = chk.checked; });
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(未割当)';
    sel.appendChild(none);
    for (const m of roster) {
      const o = document.createElement('option');
      o.value = m.fullName; o.textContent = m.fullName;
      if (m.fullName === row.fullName) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      rows[i].fullName = sel.value || null;
      if (rows[i].fullName) rows[i].include = true;
      card.classList.toggle('mn-unmatched', !rows[i].fullName);
    });
    head.append(chk, sel);

    const body = document.createElement('div');
    body.className = 'mn-row-body';
    const line = (label, val) => {
      if (!val) return;
      const p = document.createElement('p');
      p.innerHTML = `<b>${label}</b>：`;
      p.appendChild(document.createTextNode(val));
      body.appendChild(p);
    };
    line('目標', row.goal); line('課題', row.issue); line('発見', row.discovery);

    card.append(head, body);
    box.appendChild(card);
  });
}

async function doAi() {
  const text = $('mn-text').value.trim();
  if (!text) { setStatus('テキストを入力してください。'); return; }
  setStatus('AI整形中…');
  try {
    const json = await geminiGenerate({
      system: buildMinutesSystemPrompt(roster),
      parts: [{ text }],
      responseMimeType: 'application/json',
    });
    rows = aiToRows(parseAiMinutes(json, roster), roster);
    if (!rows.length) { setStatus('AIが部員を抽出できませんでした。「AIなしで整形」を試してください。'); }
    else setStatus(`${rows.length}件を整形しました。`);
    prefillDate(text);
    renderPreview();
  } catch (e) {
    setStatus(`AI整形に失敗: ${e.message}。「AIなしで整形」を試してください。`);
  }
}

function doManual() {
  const text = $('mn-text').value.trim();
  if (!text) { setStatus('テキストを入力してください。'); return; }
  rows = blocksToRows(parseMinutes(text), roster);
  setStatus(rows.length ? `${rows.length}件を整形しました(AIなし)。` : '部員ブロックを検出できませんでした。');
  prefillDate(text);
  renderPreview();
}

async function doCommit() {
  const practiceDate = selectedPracticeDate();
  if (!Number.isFinite(practiceDate)) { setStatus('練習日を選択してください。'); return; }
  const payload = toCommitRows(rows);
  if (!payload.length) { setStatus('取込対象(採用かつ部員割当済み)がありません。'); return; }
  setStatus('保存中…');
  try {
    const res = await apiCommitMinutes({ practiceDate, rows: payload });
    toast(`${res.added}件を保存しました`);
    setStatus(`保存しました: ${res.name}`);
    rows = []; renderPreview();
    $('mn-text').value = '';
  } catch (e) {
    setStatus(`保存に失敗: ${e.message}`);
  }
}

async function refreshLock() {
  const unlocked = await apiAuthStatus().catch(() => false);
  $('mn-lock').classList.toggle('hidden', unlocked);
  $('mn-app').classList.toggle('hidden', !unlocked);
}

async function doUnlock() {
  const ok = await apiUnlock($('mn-password').value).catch(() => false);
  $('mn-lock-msg').textContent = ok ? '' : 'パスワードが違います。';
  if (ok) { $('mn-password').value = ''; await refreshLock(); }
}

function init() {
  $('mn-unlock-btn').addEventListener('click', doUnlock);
  $('mn-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });
  $('mn-ai-btn').addEventListener('click', doAi);
  $('mn-manual-btn').addEventListener('click', doManual);
  $('mn-commit-btn').addEventListener('click', doCommit);
  $('mn-date').value = todayJstDate();
  renderPreview();
  refreshLock();
}

init();
