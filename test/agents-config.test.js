// .claude/agents/*.md の frontmatter 検査。
// 読み取り専用 agent(planner / reviewer / web-verifier)に書込系ツールが紛れ込むと、
// ファイルを変更しないという運用ルールが無言で崩れるため、tools を許可リストと完全一致で固定する。
// 実行時に本当に変更しなかったかは、docs/development/subagent-workflow.md の差分検査で担保する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const agentsDir = join(__dir, '..', '.claude', 'agents');

const CHROME = (tool) => `mcp__claude-in-chrome__${tool}`;

const EXPECTED_TOOLS = {
  'implementation-planner': ['Read', 'Grep', 'Glob'],
  'implementation-engineer': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  'code-reviewer': ['Read', 'Grep', 'Glob'],
  'web-verifier': [
    'Read',
    CHROME('tabs_context_mcp'),
    CHROME('tabs_create_mcp'),
    CHROME('navigate'),
    CHROME('computer'),
    CHROME('read_page'),
    CHROME('find'),
    CHROME('get_page_text'),
    CHROME('form_input'),
    CHROME('resize_window'),
    CHROME('read_console_messages'),
  ],
};

const READ_ONLY = ['implementation-planner', 'code-reviewer', 'web-verifier'];
const WRITE_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

// 先頭の --- ... --- を「key: value」の平坦なマップとして読む(ネストしたキーは名前だけ拾う)。
function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function splitTools(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function loadAgent(name) {
  const text = readFileSync(join(agentsDir, `${name}.md`), 'utf8');
  const fm = parseFrontmatter(text);
  assert.ok(fm, `${name}.md に frontmatter がない`);
  return fm;
}

for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
  test(`${name}: name・description・tools を持つ`, () => {
    const fm = loadAgent(name);
    assert.equal(fm.name, name);
    assert.ok(fm.description, 'description が空');
    assert.ok(fm.tools, 'tools が空(省略すると全ツールを継承する)');
  });

  test(`${name}: tools が許可リストと完全一致する`, () => {
    const fm = loadAgent(name);
    assert.deepEqual(splitTools(fm.tools).sort(), [...expected].sort());
  });

  test(`${name}: isolation を持たない(worktree を使わない)`, () => {
    const fm = loadAgent(name);
    assert.equal(fm.isolation, undefined);
  });
}

for (const name of READ_ONLY) {
  test(`${name}: 読み取り専用で書込系ツール・ワイルドカード・hooks を持たない`, () => {
    const fm = loadAgent(name);
    const tools = splitTools(fm.tools);
    for (const t of WRITE_TOOLS) assert.ok(!tools.includes(t), `${t} が含まれる`);
    assert.ok(!tools.some((t) => t.includes('*')), 'ワイルドカード指定が含まれる');
    assert.equal(fm.hooks, undefined);
  });
}

test('parseFrontmatter: CRLF・BOM を扱え、frontmatter がなければ null', () => {
  assert.deepEqual(parseFrontmatter('﻿---\r\nname: a\r\ntools: Read, Grep\r\n---\r\nbody'), {
    name: 'a',
    tools: 'Read, Grep',
  });
  assert.equal(parseFrontmatter('name: a\n'), null);
});
