'use strict';

/**
 * #4647 — a seed can be closed.
 *
 * Read side (behavioral, through the real CLI): `list-seeds` returns a closed seed with its
 * machine-readable outcome (`outcome_kind`, `outcome_ref`, `outcome`), and `audit-open` skips every
 * status outside the open set. Write side and prompts (text contracts, the shipped text IS the
 * product): `plant-seed.md` documents the close mode, `commands/gsd/capture.md` routes it,
 * `new-milestone.md` step 2.5 filters on the SAME open set `audit-open` uses, and the docs name the
 * closed value. The parity test derives the open set from `audit-open` behavior and compares it with
 * the set step 2.5 names, so the two readers cannot drift apart.
 *
 * Matrix: .gsd/phase/feat-4647-seed-close/50-test-matrix.md
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function seedsDir(tmpDir) {
  const dir = path.join(tmpDir, '.planning', 'seeds');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `raw` entries are written verbatim as frontmatter lines, so a bare `status:` can be expressed. */
function writeSeed(tmpDir, name, lines, heading, eol = '\n') {
  const body = heading ? `${eol}${eol}# ${heading}${eol}` : eol;
  fs.writeFileSync(path.join(seedsDir(tmpDir), name), `---${eol}${lines.join(eol)}${eol}---${body}`);
}

function listSeeds(tmpDir, filter) {
  const result = runGsdTools(filter ? `list-seeds ${filter}` : 'list-seeds', tmpDir);
  assert.ok(result.success, `list-seeds failed: ${result.error}`);
  return JSON.parse(result.output);
}

function auditSeeds(tmpDir) {
  const result = runGsdTools('audit-open --json', tmpDir);
  assert.ok(result.success, `audit-open failed: ${result.error}`);
  const out = JSON.parse(result.output);
  return { count: out.counts.seeds, items: out.items.seeds };
}

function closedSeed(extra = []) {
  return [
    'id: SEED-002', 'status: closed',
    'outcome_kind: promoted', 'outcome_ref: PLAT-17', 'outcome: promoted to PLAT-17',
    ...extra,
  ];
}

describe('list-seeds returns the outcome of a closed seed (#4647)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('list-seeds returns the outcome fields of a closed seed', () => {
    writeSeed(tmpDir, 'SEED-002-collab.md', closedSeed(), 'SEED-002: Real-time collaboration');
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.status, 'closed');
    assert.strictEqual(s.outcome_kind, 'promoted');
    assert.strictEqual(s.outcome_ref, 'PLAT-17');
    assert.strictEqual(s.outcome, 'promoted to PLAT-17');
  });

  test('list-seeds keeps a phase number as the outcome_ref string', () => {
    writeSeed(tmpDir, 'SEED-003-built.md',
      ['id: SEED-003', 'status: closed', 'outcome_kind: built', 'outcome_ref: 3', 'outcome: built in phase 3'], 'SEED-003: built');
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.outcome_kind, 'built');
    assert.strictEqual(s.outcome_ref, '3');
  });

  test('a dropped seed has an empty outcome_ref', () => {
    writeSeed(tmpDir, 'SEED-004-drop.md',
      ['id: SEED-004', 'status: closed', 'outcome_kind: dropped', 'outcome: dropped: superseded by the sync engine'], 'SEED-004: drop');
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.outcome_kind, 'dropped');
    assert.strictEqual(s.outcome_ref, '');
    assert.strictEqual(s.outcome, 'dropped: superseded by the sync engine');
  });

  test('open seeds carry empty outcome fields', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: dormant'], 'SEED-001: a');
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.outcome_kind, '');
    assert.strictEqual(s.outcome_ref, '');
    assert.strictEqual(s.outcome, '');
  });

  test('list-seeds filters and summarises the closed status', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: dormant'], 'SEED-001: a');
    writeSeed(tmpDir, 'SEED-002-b.md', closedSeed(), 'SEED-002: b');
    const all = listSeeds(tmpDir);
    assert.strictEqual(all.count, 2);
    assert.deepStrictEqual(all.summary, { dormant: 1, closed: 1 });
    const closedOnly = listSeeds(tmpDir, 'closed');
    assert.strictEqual(closedOnly.count, 1);
    assert.strictEqual(closedOnly.seeds[0].seed_id, 'SEED-002');
  });

  test('list-seeds seed objects have the documented key set', () => {
    writeSeed(tmpDir, 'SEED-002-b.md', closedSeed(), 'SEED-002: b');
    assert.deepStrictEqual(Object.keys(listSeeds(tmpDir).seeds[0]), [
      'seed_id', 'slug', 'status', 'scope', 'trigger_when', 'planted', 'title', 'path',
      'outcome_kind', 'outcome_ref', 'outcome',
    ]);
  });

  test('non-scalar outcome frontmatter is coerced to empty strings', () => {
    writeSeed(tmpDir, 'SEED-005-odd.md',
      ['id: SEED-005', 'status: closed', 'outcome_kind:', 'outcome_ref: [a, b]', 'outcome:', 'title:'], 'SEED-005: odd');
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.outcome_kind, '');
    assert.strictEqual(s.outcome_ref, '');
    assert.strictEqual(s.outcome, '');
    assert.strictEqual(s.title, 'SEED-005: odd');
  });

  test('outcome text is sanitized for display', () => {
    writeSeed(tmpDir, 'SEED-006-ansi.md',
      ['id: SEED-006', 'status: closed', 'outcome_kind: dropped', 'outcome: dropped: \u001b[31mred\u001b[0m\u0007 text'], 'SEED-006: ansi');
    const s = listSeeds(tmpDir).seeds[0];
    const hasControl = [...s.outcome].some((ch) => { const c = ch.charCodeAt(0); return c < 32 || c === 127; });
    assert.ok(!hasControl, 'no control bytes survive');
    assert.ok(s.outcome.includes('red'), 'the readable text is kept');
  });

  test('a long unicode outcome is kept whole', () => {
    const long = `dropped: ${'résumé—日本語 '.repeat(150)}`.trimEnd();
    writeSeed(tmpDir, 'SEED-007-long.md',
      ['id: SEED-007', 'status: closed', 'outcome_kind: dropped', `outcome: ${long}`], 'SEED-007: long');
    assert.strictEqual(listSeeds(tmpDir).seeds[0].outcome, long);
  });

  test('status closed is case and whitespace insensitive on both readers', () => {
    const variants = ['Closed', 'CLOSED', ' closed '];
    variants.forEach((v, i) => {
      writeSeed(tmpDir, `SEED-01${i}-v.md`, [`id: SEED-01${i}`, `status: ${v}`], `SEED-01${i}: v`);
    });
    writeSeed(tmpDir, 'SEED-001-open.md', ['id: SEED-001', 'status: dormant'], 'SEED-001: open');
    const listed = listSeeds(tmpDir);
    assert.deepStrictEqual(listed.summary, { dormant: 1, closed: 3 });
    const audit = auditSeeds(tmpDir);
    assert.deepStrictEqual(audit.items.map(i => i.seed_id), ['SEED-001']);
  });

  test('a CRLF closed seed is still closed', () => {
    writeSeed(tmpDir, 'SEED-002-crlf.md', closedSeed(), 'SEED-002: crlf', '\r\n');
    assert.strictEqual(listSeeds(tmpDir).seeds[0].status, 'closed');
    assert.strictEqual(auditSeeds(tmpDir).count, 0);
  });
});

describe('audit-open skips a seed outside the open set (#4647)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('audit-open skips a closed seed', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: dormant'], 'SEED-001: a');
    writeSeed(tmpDir, 'SEED-002-b.md', closedSeed(), 'SEED-002: b');
    const audit = auditSeeds(tmpDir);
    assert.strictEqual(audit.count, 1);
    assert.deepStrictEqual(audit.items.map(i => i.seed_id), ['SEED-001']);
  });

  test('audit-open skips any status outside the open set while list-seeds still shows it', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: promoted'], 'SEED-001: a');
    writeSeed(tmpDir, 'SEED-002-b.md', ['id: SEED-002', 'status: implemented'], 'SEED-002: b');
    assert.strictEqual(auditSeeds(tmpDir).count, 0);
    assert.strictEqual(listSeeds(tmpDir).count, 2);
  });

  test('a hand-closed seed without outcome fields is still closed', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: closed'], 'SEED-001: a');
    assert.strictEqual(auditSeeds(tmpDir).count, 0);
    const s = listSeeds(tmpDir).seeds[0];
    assert.strictEqual(s.status, 'closed');
    assert.strictEqual(s.outcome, '');
  });

  test('the word closed outside status does not close a seed', () => {
    writeSeed(tmpDir, 'SEED-001-a.md',
      ['id: SEED-001', 'status: dormant', 'trigger_when: when the closed beta ends', 'title: closed'], 'SEED-001: closed-loop sync');
    assert.strictEqual(auditSeeds(tmpDir).count, 1);
    assert.strictEqual(listSeeds(tmpDir).seeds[0].status, 'dormant');
  });

  test('outcome prose cannot change the status', () => {
    writeSeed(tmpDir, 'SEED-001-a.md',
      ['id: SEED-001', 'status: closed', 'outcome_kind: dropped', 'outcome: dropped: status: dormant'], 'SEED-001: a');
    assert.strictEqual(listSeeds(tmpDir).seeds[0].status, 'closed');
    assert.strictEqual(auditSeeds(tmpDir).count, 0);
  });

  test('a bare status line does not hide every other seed from audit-open', () => {
    writeSeed(tmpDir, 'SEED-001-a.md', ['id: SEED-001', 'status: dormant'], 'SEED-001: a');
    writeSeed(tmpDir, 'SEED-003-bare.md', ['id: SEED-003', 'status:'], 'SEED-003: bare');
    const audit = auditSeeds(tmpDir);
    assert.ok(!audit.items.some(i => i.scan_error), 'the seeds category must not degrade to scan_error');
    assert.deepStrictEqual(audit.items.map(i => i.seed_id), ['SEED-001', 'SEED-003']);
    assert.strictEqual(audit.items.find(i => i.seed_id === 'SEED-003').status, 'dormant');
  });
});

/** Statuses probed to derive the open set from audit-open behavior. `undefined` means no status line. */
const PROBED_STATUSES = ['dormant', 'active', 'triggered', 'closed', 'promoted', 'implemented', 'resolved', 'dropped', undefined];

function openSetFromAuditOpen() {
  const tmpDir = createTempProject();
  try {
    PROBED_STATUSES.forEach((status, i) => {
      const id = `SEED-0${i + 10}`;
      writeSeed(tmpDir, `${id}-p.md`, status === undefined ? [`id: ${id}`] : [`id: ${id}`, `status: ${status}`], `${id}: probe`);
    });
    return auditSeeds(tmpDir).items.map(i => i.status).sort();
  } finally {
    cleanup(tmpDir);
  }
}

describe('audit-open reports exactly the open statuses (#4647 parity anchor)', () => {
  test('audit-open reports exactly the three open statuses and a missing one', () => {
    // A missing status is read as dormant, so it reports as `dormant` too.
    assert.deepStrictEqual(openSetFromAuditOpen(), ['active', 'dormant', 'dormant', 'triggered']);
  });
});

// Workflow and command .md text is what the runtime loads, so its text is the contract under test.
function readPromptText(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// The reference docs must name the closed status the readers honor.
function readDocsText(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function normalize(text) { return text.replace(/\r\n/g, '\n'); }

function section(text, startRe, endRe) {
  const start = text.search(startRe);
  assert.ok(start !== -1, `section start ${startRe} not found`);
  const rest = text.slice(start + 1);
  const end = rest.search(endRe);
  return end === -1 ? text.slice(start) : text.slice(start, start + 1 + end);
}

describe('shipped prompts and docs for closing a seed (#4647)', () => {
  test('plant-seed documents the close mode contract', () => {
    const t = normalize(readPromptText('gsd-core/workflows/plant-seed.md'));
    for (const needle of [
      '--close', '--promoted', '--built', '--dropped',
      'status: closed', 'outcome_kind', 'outcome_ref', 'outcome:',
      'exactly one of', 'already closed', 'one line',
    ]) {
      assert.ok(t.includes(needle), `plant-seed.md must contain ${JSON.stringify(needle)}`);
    }
    const closeStep = section(t, /<step name="close-seed">/, /<\/step>/);
    assert.ok(closeStep.includes('--files'), 'the close commit must be scoped with --files');
    for (const kind of ['promoted', 'built', 'dropped']) {
      assert.ok(closeStep.includes(`outcome_kind: ${kind}`), `close step must write outcome_kind: ${kind}`);
    }
  });

  test('capture routes --seed --close to plant-seed', () => {
    const t = normalize(readPromptText('commands/gsd/capture.md'));
    const hint = t.split('\n').find(l => l.startsWith('argument-hint:'));
    assert.ok(hint && hint.includes('--close'), 'argument-hint must name --close');
    assert.ok(t.includes('--seed --close'), 'the routing text must name --seed --close');
  });

  test('new-milestone step 2.5 filters on the audit-open open set', () => {
    const t = normalize(readPromptText('gsd-core/workflows/new-milestone.md'));
    const step = section(t, /^## 2\.5\. Scan Planted Seeds/m, /^## 3\./m);
    const line = step.split('\n').find(l => l.startsWith('**Open seeds only:**'));
    assert.ok(line, 'step 2.5 must carry an "**Open seeds only:**" line');
    const named = [...line.matchAll(/`([a-z]+)`/g)].map(m => m[1]);
    const open = new Set(openSetFromAuditOpen());
    assert.deepStrictEqual([...new Set(named.filter(n => n !== 'status'))].sort(), [...open].sort(),
      'the statuses step 2.5 names must equal the set audit-open reports');
    assert.ok(/missing[^.]*dormant|dormant[^.]*missing/i.test(line), 'a missing status must be read as dormant');
  });

  test('list-seeds workflow names the outcome fields', () => {
    const t = normalize(readPromptText('gsd-core/workflows/list-seeds.md'));
    for (const needle of ['outcome_kind', 'outcome_ref', 'outcome', 'closed']) {
      assert.ok(t.includes(needle), `list-seeds.md must contain ${JSON.stringify(needle)}`);
    }
  });

  test('docs name the closed seed status', () => {
    const cli = normalize(readDocsText('docs/CLI-TOOLS.md'));
    assert.ok(cli.includes('dormant|active|triggered|closed'), 'CLI-TOOLS.md must list closed beside the open values');
    for (const field of ['outcome_kind', 'outcome_ref', 'outcome']) {
      assert.ok(cli.includes(field), `CLI-TOOLS.md must document ${field}`);
    }
    const guide = normalize(readDocsText('docs/USER-GUIDE.md'));
    const seeds = section(guide, /^### Seeds/m, /^### (?!Seeds)/m);
    assert.ok(seeds.includes('closed') && seeds.includes('--close'), 'USER-GUIDE Seeds must explain closing a seed');
    const commands = normalize(readDocsText('docs/COMMANDS.md'));
    const row = commands.split('\n').find(l => l.startsWith('| Seeds |'));
    assert.ok(row, 'the pre-close audit table must keep its Seeds row');
    assert.ok(row.includes('closed'), 'the Seeds row must name the closed value');
    assert.ok(!row.includes('not yet implemented'), 'the Seeds row must stop saying "not yet implemented"');
    assert.ok(commands.includes('--close'), 'COMMANDS.md must document --close');
  });
});
