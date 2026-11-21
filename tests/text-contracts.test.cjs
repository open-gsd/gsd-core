'use strict';

/**
 * text-contracts.test.cjs
 *
 * Detection cases for scripts/static-checks/text-contracts.cjs (ADR-6315 item 19, #6337): the engine
 * on temporary trees, and each shipped contract against a copy of the files it reads with one phrase
 * removed. The real files are checked once, in scripts/run-static-checks.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const textContracts = require('../scripts/static-checks/text-contracts.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => cleanup(dir));
  return dir;
}

function write(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A tree with the files under `files`, and a contracts directory holding `contracts` (id -> source). */
function makeTree(t, files, contracts) {
  const root = tempDir(t, 'gsd-text-contracts-');
  const dir = path.join(root, 'contracts');
  fs.mkdirSync(dir);
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  for (const [id, body] of Object.entries(contracts)) {
    fs.writeFileSync(path.join(dir, `${id}.cjs`), `module.exports = { id: ${JSON.stringify(id)}, check(ctx) { ${body} } };\n`);
  }
  return { root, dir };
}

const runTree = ({ root, dir }, extra = {}) => textContracts.run({ root, dir, ...extra });

describe('doc.has and doc.lacks', () => {
  test('a satisfied contract reports nothing', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha beta\n' }, {
      ok: "ctx.doc('a.md').has(/alpha/, 'needs alpha').has('beta', 'needs beta').lacks(/gamma/, 'no gamma');",
    });
    assert.deepEqual(runTree(tree), []);
  });

  test('a missing phrase is one finding naming the file, the contract and the pattern', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n' }, { c1: "ctx.doc('a.md').has(/beta/, 'needs beta');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'a.md');
    assert.match(findings[0].message, /^c1: needs beta \(expected \/beta\/\)$/);
  });

  test('a forbidden phrase is a finding, for a regular expression and for a string', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha gamma\n' }, {
      c2: "ctx.doc('a.md').lacks(/gamma/, 'no gamma').lacks('alpha', 'no alpha');",
    });
    assert.equal(runTree(tree).length, 2);
  });

  test('CRLF text is read as LF, so a line-bound pattern behaves the same', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\r\ntwo\r\n' }, { c3: "ctx.doc('a.md').has(/^one\\ntwo/m, 'LF-normalised');" });
    assert.deepEqual(runTree(tree), []);
  });

  test('a missing file is a finding and its assertions do not also pass vacuously', (t) => {
    const tree = makeTree(t, {}, { c4: "ctx.doc('nope.md').lacks(/anything/, 'never reached as a pass');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /cannot read the file: ENOENT/);
  });
});

describe('doc.slice, doc.step and doc.before', () => {
  const workflow = 'intro\n<step name="one">\nuse A\n</step>\n<step name="two">\nuse B\n</step>\n';

  test('a step is checked on its own body, not on the whole file', (t) => {
    const tree = makeTree(t, { 'w.md': workflow }, {
      s1: "ctx.doc('w.md').step('one').has(/use A/, 'one uses A').lacks(/use B/, 'one does not use B');",
      s2: "ctx.doc('w.md').step('two').has(/use B/, 'two uses B').lacks(/use A/, 'two does not use A');",
    });
    assert.deepEqual(runTree(tree), []);
  });

  test('a phrase that appears only in the other step is caught', (t) => {
    const tree = makeTree(t, { 'w.md': workflow }, { s3: "ctx.doc('w.md').step('one').has(/use B/, 'one uses B');" });
    assert.equal(runTree(tree).length, 1);
  });

  test('a missing step marker, and a step that never closes, are findings', (t) => {
    const tree = makeTree(t, { 'w.md': workflow, 'u.md': '<step name="open">\nno end\n' }, {
      s4: "ctx.doc('w.md').step('absent').lacks(/x/, 'unused');",
      s5: "ctx.doc('u.md').step('open').lacks(/x/, 'unused');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /marker .*absent.* not found/);
    assert.match(messages[1], /closing marker .*<\/step>.* not found/);
  });

  test('before requires both markers, in that order', (t) => {
    const tree = makeTree(t, { 'o.md': 'first ... second\n' }, {
      good: "ctx.doc('o.md').before('first', 'second', 'first then second');",
      reversed: "ctx.doc('o.md').before('second', 'first', 'reversed');",
      absent: "ctx.doc('o.md').before('first', 'third', 'third missing');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /^absent: third missing/);
    assert.match(messages[1], /^reversed: reversed/);
  });
});

describe('doc.before is first-to-first; doc.followedBy looks for b after a', () => {
  test('before fails when a stray b comes before a, even if a later b follows it', (t) => {
    const tree = makeTree(t, { 'o.md': 'b stray ... a ... b later\n' }, {
      strict: "ctx.doc('o.md').before('a ', 'b ', 'the first a before the first b');",
      loose: "ctx.doc('o.md').followedBy('a ', 'b ', 'a b exists after a');",
    });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^strict:/);
  });

  test('followedBy passes when b appears after the first a, and fails when only an earlier b exists', (t) => {
    const tree = makeTree(t, { 'o.md': 'b first, then a\n' }, { only_before: "ctx.doc('o.md').followedBy('a', 'b', 'b after a');" });
    assert.equal(runTree(tree).length, 1);
    const ok = makeTree(t, { 'o.md': 'a then b\n' }, { fine: "ctx.doc('o.md').followedBy('a', 'b', 'b after a');" });
    assert.deepEqual(runTree(ok), []);
  });

  test('a slice that misses is one finding, and the assertions chained on it add none', (t) => {
    const tree = makeTree(t, { 'w.md': 'no steps here\n' }, {
      miss: "ctx.doc('w.md').step('absent').has(/x/, 'h1').has(/y/, 'h2').lacks(/z/, 'l').before('a', 'b', 'o').followedBy('a', 'b', 'f').slice('q');",
    });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /marker .*absent.* not found/);
  });

  test('a global or sticky pattern gives the same answer on every call', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha alpha\n' }, {
      stateful: "const doc = ctx.doc('a.md'); const re = /alpha/g; doc.has(re, 'first').has(re, 'second').has(re, 'third');",
    });
    assert.deepEqual(runTree(tree), []);
  });
});

describe('the run itself fails closed', () => {
  test('a contract that throws is a finding of its own, and the others still run', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n' }, {
      a_boom: "throw new Error('exploded');",
      b_real: "ctx.doc('a.md').has(/missing/, 'real contract still runs');",
    });
    const findings = runTree(tree);
    assert.equal(findings.length, 2);
    assert.match(findings[0].message, /a_boom: the contract threw: exploded/);
    assert.match(findings[1].message, /^b_real:/);
  });

  test('a directory with fewer contracts than the minimum fails, at the limit and one under', (t) => {
    const tree = makeTree(t, { 'a.md': 'x\n' }, { only: "ctx.doc('a.md').has(/x/, 'ok');" });
    assert.deepEqual(runTree(tree, { minContracts: 1 }), []);
    const findings = runTree(tree, { minContracts: 2 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /expected at least 2 contract\(s\), found 1/);
  });

  test('an id in only that matches no contract is a finding, not an empty pass', (t) => {
    const tree = makeTree(t, { 'a.md': 'x\n' }, { real: "ctx.doc('a.md').has(/x/, 'ok');" });
    const findings = runTree(tree, { only: ['typo'] });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /no such contract: typo/);
  });

  test('a module without id and check is reported, not skipped', (t) => {
    const root = tempDir(t, 'gsd-text-contracts-bad-');
    const dir = path.join(root, 'contracts');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'bad.cjs'), 'module.exports = { id: "bad" };\n');
    const findings = textContracts.run({ root, dir });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /bad\.cjs must export/);
  });

  test('the shipped contracts load, with unique ids, and their number is the pinned minimum', () => {
    const ids = textContracts.loadContracts().map((c) => c.id);
    assert.ok(ids.includes('adr-15-progress-converge'));
    assert.ok(ids.includes('autonomous-converge'));
    assert.equal(new Set(ids).size, ids.length);
    // Deleting a contract file, or adding one without raising MIN_CONTRACTS, fails here.
    assert.equal(ids.length, textContracts.MIN_CONTRACTS);
  });
});

describe('the shipped contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    'commands/gsd/progress.md', 'gsd-core/workflows/next.md', 'gsd-core/workflows/help/modes/full.md',
    'docs/COMMANDS.md', 'docs/how-to/run-phases-autonomously.md',
    'commands/gsd/autonomous.md', 'gsd-core/workflows/autonomous.md', 'gsd-core/workflows/plan-review-convergence.md',
    'gsd-core/workflows/autonomous/steps/converge-fail-fast.md', 'gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md', 'gsd-core/workflows/autonomous/steps/converge-loop.md',
  ];

  function copyOfRepoFiles(t) {
    const root = tempDir(t, 'gsd-text-contracts-copy-');
    for (const rel of FILES) write(root, rel, fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8'));
    return root;
  }

  const runShipped = (root) => textContracts.run({ root, only: ['adr-15-progress-converge', 'autonomous-converge'] });

  test('an untouched copy of the files satisfies every shipped contract', (t) => {
    assert.deepEqual(runShipped(copyOfRepoFiles(t)), []);
  });

  for (const [rel, phrase, contract] of [
    ['gsd-core/workflows/autonomous.md', '--override-gate', 'autonomous-converge'],
    ['gsd-core/workflows/next.md', 'PLAN_STRATEGY="converge"', 'adr-15-progress-converge'],
    ['commands/gsd/progress.md', '--cross-ai', 'adr-15-progress-converge'],
    ['gsd-core/workflows/autonomous/steps/converge-fail-fast.md', 'OVERRIDES the `workflow.plan_review_convergence` config gate', 'autonomous-converge'],
  ]) {
    test(`removing ${JSON.stringify(phrase)} from ${rel} fails ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      assert.ok(before.includes(phrase), 'the phrase is present to start with');
      fs.writeFileSync(abs, before.split(phrase).join(''));
      const findings = runShipped(root);
      assert.ok(findings.length > 0, 'a finding is reported');
      assert.ok(findings.every((f) => f.message.startsWith(`${contract}:`) || f.message.includes(`${contract}:`)), 'and it names the contract');
    });
  }

  // Regressions the contracts exist to catch, introduced into a copy by editing one file.
  for (const [title, rel, edit, expected] of [
    ['a stray "Proceed to iterate step" before transition.md in the passed branch (#1526)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('**If `passed`:**', '**If `passed`:** Proceed to iterate step'), /passed verification must invoke transition\.md/],
    ['a hardcoded .planning/STATE.md read back in discover_phases (#4455)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('<step name="discover_phases">', '<step name="discover_phases">\nSTATE_CONTENT=$(cat .planning/STATE.md 2>/dev/null || true)'), /hardcoded root \.planning\/STATE\.md read/],
    ['disk_status !== "complete" back in discover_phases', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('<step name="discover_phases">', '<step name="discover_phases">\ndisk_status !== "complete"'), /must not filter on disk_status/],
    ['`exit 1` back in the converge-fail-fast step (#4600)', 'gsd-core/workflows/autonomous/steps/converge-fail-fast.md',
      (text) => `${text}\nexit 1\n`, /must not stop an explicit-flag run/],
    ['the override-gate conditional removed from the host workflow (#4600)', 'gsd-core/workflows/autonomous.md',
      (text) => text.split('if [ "${PLAN_STRATEGY}" = "converge" ]; then').join('if [ "${PLAN_STRATEGY}" = "never" ]; then'), /conditional must exist and append --override-gate/],
    ['a raw-frontmatter grep back in the human_needed read (#1522)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('After execute, read canonical verification', 'After execute, read canonical verification grep "^status:"'), /must not route stale human_needed reports from raw frontmatter/],
  ]) {
    test(`mutation: ${title} fails autonomous-converge`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the mutation changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  test('adding a hand-listed reviewer lane flag back to the next workflow fails the anti-parity guard', (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, 'gsd-core', 'workflows', 'next.md');
    fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\nPass --codex to review.\n`);
    const findings = runShipped(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /should NOT hand-enumerate reviewer lane flag --codex/);
  });
});
