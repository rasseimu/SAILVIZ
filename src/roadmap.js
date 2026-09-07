// src/roadmap.js
// #roadmap-screen に「部員タブ × 大目標 × 順序付きマイルストーンのステッパー」を描画。
// 段階の定義(追加/改名/並べ替え/削除)と達成トグルは利用者が手動で行う。
// 現在地(現在の段階)は roadmapProgress の「最初の未達」で判定し、ステッパー上に「現在地」を表示する。
// データは sailviz.roadmap オーバーレイ(localStorage ミラー＋保存フォルダ JSON)。反省(真実源)は触らない。
import { memberList } from './members.js';
import {
  loadRoadmap, saveRoadmap,
  setGoal, addMilestone, renameMilestone, removeMilestone,
  moveMilestone, toggleMilestone, roadmapProgress,
} from './roadmapstore.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// マイルストーンの一意 id(ブラウザ実行時のみ。テストは store 側に id を注入する)。
function newId() {
  return `ms${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 横並びステッパーの HTML(純粋関数)。達成=済/現在地=強調/未達=灰、全達成時は末尾の先に「達成！」。
// 変更画面(createRoadmap)と進捗画面の読み取り専用トグルで共用する。
export function stepperHtml(milestones = []) {
  if (!milestones.length) return '<p class="roadmap-empty">まだ段階がありません。下で追加してください。</p>';
  const { currentIndex } = roadmapProgress(milestones);
  const nodes = milestones.map((m, i) => {
    const state = m.done ? 'done' : (i === currentIndex ? 'current' : 'future');
    const here = i === currentIndex ? '<span class="rm-here">現在地</span>' : '';
    const mark = m.done ? '✓' : (i + 1);
    return `<li class="rm-step rm-${state}">${here}`
      + `<span class="rm-dot">${mark}</span>`
      + `<span class="rm-step-title">${esc(m.title)}</span></li>`;
  }).join('');
  const goal = currentIndex >= milestones.length
    ? '<li class="rm-step rm-goal"><span class="rm-here">達成！</span><span class="rm-dot">🏁</span><span class="rm-step-title">ゴール</span></li>'
    : '<li class="rm-step rm-goal-future"><span class="rm-dot">🏁</span><span class="rm-step-title">ゴール</span></li>';
  return `<ol class="rm-stepper">${nodes}${goal}</ol>`;
}

// loadRoadmapData/saveRoadmapData を注入すると保存フォルダのファイルへ永続化できる。
// 未指定時は localStorage のみ(単体でも動く)。
export function createRoadmap({
  loadRoadmapData = async () => loadRoadmap(),
  saveRoadmapData = async (obj) => saveRoadmap(obj),
} = {}) {
  let data = {};          // sailviz.roadmap
  let selected = null;    // 選択中の部員フルネーム
  let editingId = null;   // 改名中のマイルストーン id(null=非編集)

  // 保存は UI を止めないよう非同期・投げっぱなし(失敗はログのみ)。
  function persist() {
    Promise.resolve(saveRoadmapData(data)).catch((e) => console.error('ロードマップの保存に失敗', e));
  }

  async function render() {
    data = await loadRoadmapData();
    if (!selected) selected = memberList()[0]?.fullName || null;
    renderNav();
    renderBody();
  }

  function renderNav() {
    const nav = $('roadmap-nav');
    if (!nav) return;
    nav.innerHTML = memberList().map((m) =>
      `<button type="button" class="dashboard-nav-item${m.fullName === selected ? ' active' : ''}" data-key="${esc(m.fullName)}">${esc(m.fullName)}</button>`
    ).join('');
    nav.querySelectorAll('.dashboard-nav-item').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (selected === btn.dataset.key) return;
        selected = btn.dataset.key;
        editingId = null;
        renderNav();
        renderBody();
      }));
  }

  function entry() {
    const e = data[selected] || { goal: '', milestones: [] };
    return { goal: e.goal || '', milestones: e.milestones || [] };
  }

  // 段階の編集リスト(達成トグル・改名・並べ替え・削除)。
  function editorHtml(milestones) {
    const rows = milestones.map((m, i) => {
      const title = editingId === m.id
        ? `<input class="rm-rename-input" data-id="${esc(m.id)}" value="${esc(m.title)}" />`
          + `<button class="rm-rename-save writes-json" data-id="${esc(m.id)}">保存</button>`
          + '<button class="rm-rename-cancel">取消</button>'
        : `<span class="rm-row-title${m.done ? ' rm-row-done' : ''}">${esc(m.title)}</span>`
          + `<button class="rm-edit" data-id="${esc(m.id)}" title="名前を変更">✎</button>`;
      return `<li class="rm-row">`
        + `<input type="checkbox" class="rm-check writes-json" data-id="${esc(m.id)}" ${m.done ? 'checked' : ''} title="達成" />`
        + `${title}`
        + `<span class="rm-row-ctrl">`
        + `<button class="rm-up writes-json" data-id="${esc(m.id)}" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>`
        + `<button class="rm-down writes-json" data-id="${esc(m.id)}" title="下へ" ${i === milestones.length - 1 ? 'disabled' : ''}>↓</button>`
        + `<button class="rm-del writes-json" data-id="${esc(m.id)}" title="削除">🗑</button>`
        + `</span></li>`;
    }).join('');
    return `<ul class="rm-editor">${rows}</ul>`
      + `<div class="rm-add"><input class="rm-add-input" placeholder="新しい段階を追加" />`
      + `<button class="rm-add-btn writes-json">＋ 追加</button></div>`;
  }

  function renderBody() {
    const content = $('roadmap-content');
    if (!content) return;
    if (!selected) { content.innerHTML = '<p>部員がいません。</p>'; return; }
    const { goal, milestones } = entry();
    const { done, total } = roadmapProgress(milestones);
    content.innerHTML =
      `<section class="roadmap-goal-sec"><label class="rm-goal-label">大目標</label>`
      + `<input class="rm-goal-input writes-json" placeholder="例: 全日本インカレ出場" value="${esc(goal)}" /></section>`
      + `<section class="roadmap-stepper-sec">`
      + `<div class="rm-progress-count">${done} / ${total} 段階クリア</div>`
      + `${stepperHtml(milestones)}</section>`
      + `<section class="roadmap-editor-sec"><h3>段階の編集</h3>${editorHtml(milestones)}</section>`;
    wireBody();
  }

  function wireBody() {
    const content = $('roadmap-content');

    // 大目標: 変更確定(blur/Enter)で保存。
    const goalInput = content.querySelector('.rm-goal-input');
    if (goalInput) {
      const save = () => { data = setGoal(data, selected, goalInput.value); persist(); };
      goalInput.addEventListener('blur', save);
      goalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goalInput.blur(); } });
    }

    // 達成トグル。
    content.querySelectorAll('.rm-check').forEach((cb) =>
      cb.addEventListener('change', () => {
        data = toggleMilestone(data, selected, cb.dataset.id, cb.checked, Date.now());
        persist();
        renderBody();
      }));

    // 改名の開始/確定/取消。
    content.querySelectorAll('.rm-edit').forEach((b) =>
      b.addEventListener('click', () => { editingId = b.dataset.id; renderBody(); }));
    content.querySelectorAll('.rm-rename-cancel').forEach((b) =>
      b.addEventListener('click', () => { editingId = null; renderBody(); }));
    content.querySelectorAll('.rm-rename-save').forEach((b) =>
      b.addEventListener('click', () => {
        const input = content.querySelector(`.rm-rename-input[data-id="${CSS.escape(b.dataset.id)}"]`);
        if (input) { data = renameMilestone(data, selected, b.dataset.id, input.value); persist(); }
        editingId = null;
        renderBody();
      }));
    content.querySelectorAll('.rm-rename-input').forEach((input) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); data = renameMilestone(data, selected, input.dataset.id, input.value); persist(); editingId = null; renderBody(); }
        if (e.key === 'Escape') { editingId = null; renderBody(); }
      }));

    // 並べ替え。
    content.querySelectorAll('.rm-up').forEach((b) =>
      b.addEventListener('click', () => { data = moveMilestone(data, selected, b.dataset.id, -1); persist(); renderBody(); }));
    content.querySelectorAll('.rm-down').forEach((b) =>
      b.addEventListener('click', () => { data = moveMilestone(data, selected, b.dataset.id, 1); persist(); renderBody(); }));

    // 削除。
    content.querySelectorAll('.rm-del').forEach((b) =>
      b.addEventListener('click', () => { data = removeMilestone(data, selected, b.dataset.id); persist(); renderBody(); }));

    // 追加。
    const addInput = content.querySelector('.rm-add-input');
    const addBtn = content.querySelector('.rm-add-btn');
    const doAdd = () => {
      if (!addInput || addInput.value.trim() === '') return;
      data = addMilestone(data, selected, newId(), addInput.value);
      persist();
      renderBody();
    };
    if (addBtn) addBtn.addEventListener('click', doAdd);
    if (addInput) addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  }

  return { render };
}
