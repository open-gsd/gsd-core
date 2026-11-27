'use strict';

/**
 * tests/6508-roadmapper-edit-tool-grant.test.cjs — #6508
 * The roadmapper personas instruct "(Edit, not rewrite from scratch)" at Step 9
 * while their `tools:` frontmatter withholds Edit. Method: document-content
 * tests over the shipped persona files (agents/*.md, pi/package-agents/*) with
 * frontmatter parsed via the shared tests/helpers/agent-tools-frontmatter.cjs
 * reader (one copy with tests/agent-tools.install.test.cjs, per the
 * shared-parser parity rule), tools compared as SETS. Rows: canonical/compact
 * Edit grant, exact set equality, a directive scan over every agents/gsd-*.md
 * body naming Edit as the mechanism (parenthetical, backtick, bold,
 * "Edit tool", "use Edit" forms), persona parity, and the Pi mirror manifest
 * lockstep hash. Known gap pinned, not hidden: four personas instruct Edit
 * without an Edit grant (KNOWN_EDIT_DIRECTIVE_OFFENDERS below) — the same bug
 * class on the researcher/synthesizer pair; granting is outside this PR's AC3.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseTools, bodyOf } = require('./helpers/agent-tools-frontmatter.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CANONICAL = 'agents/gsd-roadmapper.md';
const COMPACT = 'agents/gsd-roadmapper.compact.md';
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const EXPECTED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Skill'];

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');

const toolsSet = (rel) => new Set(parseTools(read(rel)));

test('#6508 canonical roadmapper tools set grants Edit (AC1, RED pre-fix)', () => {
  assert.ok(toolsSet(CANONICAL).has('Edit'), `${CANONICAL} tools: must include Edit`);
});

test('#6508 compact roadmapper tools set grants Edit (AC1, RED pre-fix)', () => {
  assert.ok(toolsSet(COMPACT).has('Edit'), `${COMPACT} tools: must include Edit`);
});

test('#6508 canonical roadmapper tools set is exactly the expected set (AC1+AC3, RED pre-fix)', () => {
  assert.deepEqual(toolsSet(CANONICAL), new Set(EXPECTED_TOOLS));
});

test('#6508 compact roadmapper tools set is exactly the expected set (AC1+AC3, RED pre-fix)', () => {
  assert.deepEqual(toolsSet(COMPACT), new Set(EXPECTED_TOOLS));
});

// The directive forms that name Edit as the mechanism to use. The original
// #6508 bug was the parenthetical form; backtick/bold/prose forms carry the
// same instruction and the scan must not go green past them.
const EDIT_DIRECTIVE_FORMS = [
  /\(\s*Edit\b/,
  /`Edit`/,
  /\*\*Edit\*\*/,
  /\bEdit\s+tool\b/,
  /\buse\s+Edit\b/i,
];

// Personas that instruct Edit WITHOUT granting it (verified at this commit).
// AC3 keeps this PR off their tools lines; the rot-guard row below fails if
// any entry gains Edit (drop the entry then), and a NEW offender anywhere
// else fails the scan row immediately.
const KNOWN_EDIT_DIRECTIVE_OFFENDERS = [
  'agents/gsd-project-researcher.md',
  'agents/gsd-project-researcher.compact.md',
  'agents/gsd-research-synthesizer.md',
  'agents/gsd-research-synthesizer.compact.md',
];

function directiveOffenders() {
  const offenders = [];
  for (const name of fs.readdirSync(AGENTS_DIR).filter((n) => /^gsd-.*\.md$/.test(n)).sort()) {
    const rel = `agents/${name}`;
    const content = read(rel);
    if (!EDIT_DIRECTIVE_FORMS.some((re) => re.test(bodyOf(content)))) continue;
    if (!toolsSet(rel).has('Edit')) offenders.push(rel);
  }
  return offenders;
}

test('#6508 every agents/gsd-*.md directive naming Edit as the mechanism grants Edit (AC2, RED pre-fix)', () => {
  const offenders = directiveOffenders().filter(
    (rel) => !KNOWN_EDIT_DIRECTIVE_OFFENDERS.includes(rel),
  );
  assert.deepEqual(
    offenders,
    [],
    `personas instructing Edit without an Edit grant: ${offenders.join(', ')}`,
  );
});

test('#6508 the known Edit-directive offenders are still offenders (allowlist cannot rot)', () => {
  const current = directiveOffenders();
  for (const rel of KNOWN_EDIT_DIRECTIVE_OFFENDERS) {
    assert.ok(
      current.includes(rel),
      `${rel} is allowlisted but no longer instructs Edit without a grant — drop the allowlist entry`,
    );
  }
});

test('#6508 the two roadmapper personas agree on their tools set (guard)', () => {
  assert.deepEqual(toolsSet(CANONICAL), toolsSet(COMPACT));
});

test('#6508 the Pi mirror of gsd-roadmapper.md matches its manifest hash (guard)', () => {
  const manifest = JSON.parse(read('pi/package-agents/manifest.json'));
  const expected = manifest.files['gsd-roadmapper.md'];
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(REPO_ROOT, 'pi', 'package-agents', 'gsd-roadmapper.md')))
    .digest('hex');
  assert.strictEqual(
    actual,
    expected,
    'pi/package-agents/gsd-roadmapper.md drifted from pi/package-agents/manifest.json; rerun npm run build',
  );
});
