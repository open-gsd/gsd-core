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

// The temporary trees hold one or two contracts, not the shipped set; the minimum has its own tests.
const runTree = ({ root, dir }, extra = {}) => textContracts.run({ root, dir, minContracts: 0, ...extra });

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

describe('doc.slice with several closing markers, and doc.shorterThan', () => {
  const branch = 'head\nOPEN\nbody A\n**If `x`:** sibling one\n**If `y`:** sibling two\ntail\n</step>\n';

  test('the slice ends at the earliest closing marker present, searched after the opening marker', (t) => {
    const tree = makeTree(t, { 'b.md': branch }, {
      early: "ctx.doc('b.md').slice('OPEN', ['</step>', '**If `']).has(/body A/, 'inside').lacks(/sibling/, 'cut at the sibling marker');",
      // An end marker that begins like the start marker must end the slice at the NEXT one.
      overlapping: "ctx.doc('b.md').slice('**If `x`:**', ['**If `', '</step>']).has(/sibling one/, 'inside').lacks(/sibling two/, 'cut at the next marker');",
    });
    assert.deepEqual(runTree(tree), []);
  });

  test('a closing marker missing from the list is skipped, and none present at all is a finding', (t) => {
    const tree = makeTree(t, { 'b.md': branch }, {
      some: "ctx.doc('b.md').slice('OPEN', ['absent', '</step>']).has(/tail/, 'ends at the one that exists');",
      none: "ctx.doc('b.md').slice('OPEN', ['absent', 'also absent']).lacks(/x/, 'dead document');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^none: closing marker .*absent.* not found after "OPEN"/);
  });

  test('shorterThan is exclusive at the limit: limit - 1 passes, limit and limit + 1 fail', (t) => {
    for (const [length, fails] of [[9, false], [10, true], [11, true]]) {
      const tree = makeTree(t, { 's.md': `${'x'.repeat(length - 1)}\n` }, { size: "ctx.doc('s.md').shorterThan(10, 'under ten');" });
      const findings = runTree(tree);
      assert.equal(findings.length, fails ? 1 : 0, `length ${length}`);
      if (fails) assert.match(findings[0].message, new RegExp(`^size: under ten \\(${length} characters, expected fewer than 10\\)$`));
    }
  });

  test('an empty list of closing markers, and an empty marker in the list, are findings, not a slice to the end', (t) => {
    const tree = makeTree(t, { 'b.md': branch }, {
      none: "ctx.doc('b.md').slice('OPEN', []).has(/tail/, 'dead document');",
      blank: "ctx.doc('b.md').slice('OPEN', ['</step>', '']).has(/tail/, 'dead document');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    for (const message of messages) assert.match(message, /must be a non-empty list of non-empty markers/);
  });

  test('frontmatter reads a BOM document at the right offsets, and an empty block is an empty document', (t) => {
    const tree = makeTree(t, {
      'bom.md': '\uFEFF---\nname: x\ntools:\n  - A\n---\nbody\n  - B\n',
      'empty.md': '---\n---\nbody\n',
    }, {
      bom: "ctx.doc('bom.md').frontmatter().has(/^[ \\t]+-[ \\t]+A$/m, 'A is listed').lacks(/B|body/, 'the body is excluded');",
      empty: "ctx.doc('empty.md').frontmatter().has(/A/, 'an empty block holds nothing');",
    });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^empty: an empty block holds nothing/);
  });

  test('frontmatter is the closed block only; a body list item is outside it and a missing or unclosed block is a finding', (t) => {
    const tree = makeTree(t, {
      'f.md': '---\nname: x\ntools:\n  - A\n---\nbody\n  - B\n',
      'n.md': 'no block\n  - A\n',
      'u.md': '---\nname: x\n  - A\n',
    }, {
      inside: "ctx.doc('f.md').frontmatter().has(/^[ \\t]+-[ \\t]+A$/m, 'A is listed').lacks(/B/, 'the body is excluded');",
      none: "ctx.doc('n.md').frontmatter().has(/A/, 'dead document');",
      open: "ctx.doc('u.md').frontmatter().has(/A/, 'dead document');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /^none: no closed YAML frontmatter block/);
    assert.match(messages[1], /^open: no closed YAML frontmatter block/);
  });
});

describe('ctx.doc reads only regular, non-empty files inside the repository', () => {
  test('a path that climbs out of the root, an absolute path and an empty path are findings', (t) => {
    const tree = makeTree(t, { 'a.md': 'x\n' }, {
      climb: "ctx.doc('../outside.md').lacks(/x/, 'never a pass');",
      absolute: "ctx.doc('/etc/hosts').lacks(/x/, 'never a pass');",
      empty_path: "ctx.doc('').lacks(/x/, 'never a pass');",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 3);
    for (const message of messages) assert.match(message, /not a repo-relative path inside the repository/);
  });

  test('a symlink and a directory are refused, even when the symlink points at a real file', (t) => {
    const tree = makeTree(t, { 'real.md': 'content\n', 'dir/inner.md': 'x\n' }, {
      linked: "ctx.doc('link.md').has(/content/, 'follows nothing');",
      directory: "ctx.doc('dir').has(/x/, 'a directory is not a document');",
    });
    try {
      fs.symlinkSync(path.join(tree.root, 'real.md'), path.join(tree.root, 'link.md'));
    } catch (err) {
      t.skip(`symlinks are unavailable here: ${err.code}`);
      return;
    }
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    assert.match(messages.find((m) => m.startsWith('linked:')), /a symlink/);
    assert.match(messages.find((m) => m.startsWith('directory:')), /not a file/);
  });

  test('an empty file is a finding, so a lacks-only contract cannot pass on it', (t) => {
    const tree = makeTree(t, { 'empty.md': '  \n' }, { blank: "ctx.doc('empty.md').lacks(/anything/, 'nothing to find');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /the file is empty/);
  });

  test('a contract that makes no assertion, and one that is asynchronous, are findings', (t) => {
    const tree = makeTree(t, { 'a.md': 'x\n' }, {
      idle: "ctx.doc('a.md');",
      later: "return Promise.resolve().then(() => ctx.doc('a.md').has(/never collected/, 'dropped'));",
    });
    const messages = runTree(tree).map((f) => f.message);
    assert.equal(messages.length, 2);
    assert.ok(messages.some((m) => /^idle: the contract made no assertion/.test(m)));
    assert.ok(messages.some((m) => /^later: check must be synchronous/.test(m)));
  });

  test('ctx.fail counts as an assertion and is reported', (t) => {
    const tree = makeTree(t, {}, { explicit: "ctx.fail('x.md', 'stated failure');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^explicit: stated failure/);
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
    assert.deepEqual([...ids].sort(), [...SHIPPED].sort());
    assert.equal(new Set(ids).size, ids.length);
    // Deleting a contract file, or adding one without raising MIN_CONTRACTS, fails here.
    assert.equal(ids.length, textContracts.MIN_CONTRACTS);
  });
});

describe('ctx.docs, ctx.exists and ctx.absent', () => {
  test('docs() joins the files into one document an assertion can match in any of them', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n', 'b.md': 'beta\n' }, {
      ok: "ctx.docs(['a.md', 'b.md']).has('alpha', 'in a').has('beta', 'in b').lacks('gamma', 'in neither');",
    });
    assert.deepEqual(runTree(tree), []);
  });

  test('docs() fails on a phrase that is in none of the files, naming every file', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n', 'b.md': 'beta\n' }, { c: "ctx.docs(['a.md', 'b.md']).has('gamma', 'needs gamma');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'a.md + b.md');
  });

  test('docs() with one missing file is one finding for that file and no noise from the assertions after it', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n' }, { c: "ctx.docs(['a.md', 'gone.md']).has('alpha', 'in a').has('zzz', 'in none');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'gone.md');
    assert.match(findings[0].message, /cannot read the file/);
  });

  test('docs() with no files is a finding, not a vacuous pass', (t) => {
    const tree = makeTree(t, {}, { c: "ctx.docs([]).has('x', 'needs x');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /docs\(\) needs at least one repo-relative path/);
  });

  test('exists() passes for a file and fails for a missing path and for a directory', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n', 'dir/x.md': 'x\n' }, {
      ok: "ctx.exists('a.md', 'a is there');",
      gone: "ctx.exists('gone.md', 'gone is there');",
      dir: "ctx.exists('dir', 'dir is a file');",
    });
    const findings = runTree(tree);
    assert.deepEqual(findings.map((f) => f.file).sort(), ['dir', 'gone.md']);
    assert.ok(findings.every((f) => /expected a regular file at /.test(f.message)));
  });

  test('absent() passes for a missing path and fails for a file, a directory and a symlink', (t) => {
    const tree = makeTree(t, { 'a.md': 'alpha\n', 'dir/x.md': 'x\n' }, {
      ok: "ctx.absent('gone.md', 'gone is gone');",
      file: "ctx.absent('a.md', 'a must go');",
      dir: "ctx.absent('dir', 'dir must go');",
      link: "ctx.absent('link.md', 'link must go');",
    });
    fs.symlinkSync(path.join(tree.root, 'a.md'), path.join(tree.root, 'link.md'));
    const findings = runTree(tree);
    assert.deepEqual(findings.map((f) => f.file).sort(), ['a.md', 'dir', 'link.md']);
    assert.ok(findings.every((f) => /expected no file at /.test(f.message)));
  });

  test('exists() and absent() refuse a path outside the repository and count as assertions', (t) => {
    const tree = makeTree(t, {}, { out: "ctx.exists('../escape.md', 'x'); ctx.absent('/etc/hosts', 'y');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => /not a repo-relative path inside the repository/.test(f.message)));
  });

  test('a symlinked directory in the path cannot redirect doc, docs, exists or absent out of the tree', (t) => {
    const outside = tempDir(t, 'gsd-text-contracts-outside-');
    write(outside, 'secret.md', 'secret\n');
    const tree = makeTree(t, {}, {
      d: "ctx.doc('link/secret.md').has('secret', 's');",
      ds: "ctx.docs(['link/secret.md']).has('secret', 's');",
      e: "ctx.exists('link/secret.md', 'x');",
      a: "ctx.absent('link/secret.md', 'y');",
    });
    fs.symlinkSync(outside, path.join(tree.root, 'link'), 'dir');
    const findings = runTree(tree);
    assert.equal(findings.length, 4, JSON.stringify(findings));
    assert.ok(findings.every((f) => /resolves outside the repository through a symlinked directory/.test(f.message)));
  });

  test('a symlinked directory that stays inside the tree is still read', (t) => {
    const tree = makeTree(t, { 'real/a.md': 'alpha\n' }, { ok: "ctx.doc('alias/a.md').has('alpha', 'a');" });
    fs.symlinkSync(path.join(tree.root, 'real'), path.join(tree.root, 'alias'), 'dir');
    assert.deepEqual(runTree(tree), []);
  });

  test('a contract whose only assertion is absent() is not "made no assertion"', (t) => {
    const tree = makeTree(t, {}, { only: "ctx.absent('gone.md', 'gone');" });
    assert.deepEqual(runTree(tree), []);
  });
});

const SHIPPED = [
  'adr-15-progress-converge', 'autonomous-converge',
  'autonomous-allowed-tools', 'autonomous-decomposition', 'autonomous-interactive', 'autonomous-to-flag',
  'chain-flag-plan-phase', 'discuss-checkpoint', 'agent-skills-awareness', 'scan-command', 'analyze-dependencies',
  'cline-support', 'inventory-headings-countfree', 'policy-release-no-npm-self-upgrade', 'phase6-capability-docs',
  'playwright-ui-verify',
];

describe('the shipped contracts hold on the real files, and fail when a contracted phrase goes', () => {
  // The files each contract reads, copied into a temporary root so one phrase can be removed.
  const FILES = [
    'commands/gsd/progress.md', 'gsd-core/workflows/next.md', 'gsd-core/workflows/help/modes/full.md',
    'docs/COMMANDS.md', 'docs/how-to/run-phases-autonomously.md',
    'commands/gsd/autonomous.md', 'gsd-core/workflows/autonomous.md', 'gsd-core/workflows/plan-review-convergence.md',
    'gsd-core/workflows/autonomous/steps/converge-fail-fast.md', 'gsd-core/workflows/autonomous/steps/converge-dispatch-bg.md',
    'gsd-core/workflows/autonomous/steps/converge-dispatch-inline.md', 'gsd-core/workflows/autonomous/steps/converge-loop.md',
    'gsd-core/references/autonomous-smart-discuss.md',
    'gsd-core/workflows/plan-phase.md', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
    'gsd-core/workflows/discuss-phase.md', 'gsd-core/workflows/discuss-phase/modes/chain.md',
    'gsd-core/workflows/discuss-phase/modes/default.md', 'gsd-core/workflows/discuss-phase/templates/checkpoint.json',
    'commands/gsd/map-codebase.md', 'gsd-core/workflows/scan.md', 'gsd-core/workflows/analyze-dependencies.md',
    ...[
      'gsd-debugger', 'gsd-integration-checker', 'gsd-security-auditor', 'gsd-nyquist-auditor', 'gsd-codebase-mapper',
      'gsd-roadmapper', 'gsd-eval-auditor', 'gsd-intel-updater', 'gsd-doc-writer',
    ].map((name) => `agents/${name}.md`),
    '.clinerules', 'docs/INVENTORY.md', '.github/workflows/release.yml', 'docs/how-to/develop-a-capability.md', 'docs/README.md',
    'gsd-core/workflows/verify-work/steps/automated-ui-verification.md', 'gsd-core/workflows/ui-review.md', 'agents/gsd-ui-auditor.md',
  ];

  function copyOfRepoFiles(t) {
    const root = tempDir(t, 'gsd-text-contracts-copy-');
    for (const rel of FILES) write(root, rel, fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8'));
    return root;
  }

  // The pinned minimum counts the whole directory; a run limited to some contracts must find those.
  const runShipped = (root, only = SHIPPED) => textContracts.run({ root, only, minContracts: only.length });

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

  // The four autonomous-* contracts: each asserts on the command, the workflow or the smart-discuss reference.
  const SIZE_LIMIT = 40 * 1024;
  const dropLine = (line) => (text) => text.split('\n').filter((l) => l.trim() !== line).join('\n');
  for (const [title, rel, edit, contract, expected] of [
    ['Agent dropped from the command allowed-tools (#2043)', 'commands/gsd/autonomous.md',
      dropLine('- Agent'), 'autonomous-allowed-tools', /allowed-tools must include "Agent"/],
    ['Agent dropped from allowed-tools but listed in the body, outside the frontmatter (#2043)', 'commands/gsd/autonomous.md',
      (text) => `${dropLine('- Agent')(text)}\n  - Agent\n`, 'autonomous-allowed-tools', /allowed-tools must include "Agent"/],
    ['the workflow no longer references autonomous-smart-discuss.md (#2196)', 'gsd-core/workflows/autonomous.md',
      (text) => text.split('autonomous-smart-discuss.md').join('the-extracted-file'), 'autonomous-decomposition', /must reference autonomous-smart-discuss\.md/],
    ['CONTEXT.md gone from the smart-discuss reference (#2196)', 'gsd-core/references/autonomous-smart-discuss.md',
      (text) => text.split('CONTEXT.md').join('the context file'), 'autonomous-decomposition', /instructions for writing CONTEXT\.md/],
    ['--interactive gone from the command argument-hint (#1413)', 'commands/gsd/autonomous.md',
      (text) => text.replace('[--interactive] ', ''), 'autonomous-interactive', /argument-hint should include --interactive/],
    ['a sibling **If branch opened straight after the INTERACTIVE marker, so the Skill call falls outside it (#1413)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('**If `INTERACTIVE` is set:**', '**If `INTERACTIVE` is set:**\n**If `other`:**'), 'autonomous-interactive', /INTERACTIVE branch must invoke Skill/],
    ['the success criteria lose "discuss inline" (#1413)', 'gsd-core/workflows/autonomous.md',
      (text) => {
        const at = text.indexOf('discuss inline', text.indexOf('<success_criteria>'));
        return `${text.slice(0, at)}discuss${text.slice(at + 'discuss inline'.length)}`;
      }, 'autonomous-interactive', /success criteria should mention discuss inline/],
    ['TO_PHASE no longer defaults to empty (#1644)', 'gsd-core/workflows/autonomous.md',
      (text) => text.split('TO_PHASE=""').join('TO_PHASE=0'), 'autonomous-to-flag', /TO_PHASE should default to empty/],
    ['the startup banner line stops naming the --to target, the success-criteria checklist still does (#1644)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('If `TO_PHASE` is set, display: `Stopping after', 'If `TO_PHASE` is set, display: `Ending'), 'autonomous-to-flag', /startup banner should display the --to target/],
    ['the already-completed exit message goes, the success-criteria checklist still names it (#1644)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('already completed. Nothing to do.', 'done.'), 'autonomous-to-flag', /exit with a message when the --to target is already completed/],
    ['the iterate step renamed, so its section cannot be found (#1644)', 'gsd-core/workflows/autonomous.md',
      (text) => text.replace('<step name="iterate">', '<step name="advance">'), 'autonomous-to-flag', /marker .*iterate.* not found/],
  ]) {
    test(`mutation: ${title} fails ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the mutation changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  // The five batch-3 contracts: workflows split across files, agent blocks, a consolidated command, a removed one.
  const without = (phrase) => (text) => text.split(phrase).join('');
  const AUTO_GUARD_TAIL = ' && [[ ! "$GSD_ARGS" =~ --chain ]]';
  for (const [title, rel, edit, contract, expected] of [
    ['the --chain half of the dual-flag guard dropped from the plan-phase step file (#1620)', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
      without(AUTO_GUARD_TAIL), 'chain-flag-plan-phase', /plan-phase should check for both --auto and --chain/],
    ['the --chain half of the dual-flag guard dropped from discuss-phase chain mode (#1620)', 'gsd-core/workflows/discuss-phase/modes/chain.md',
      without(AUTO_GUARD_TAIL), 'chain-flag-plan-phase', /discuss-phase .* should use the same dual-flag guard/],
    ['the chain flag no longer persisted by plan-phase (#1620)', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
      without('config-set workflow._auto_chain_active true'), 'chain-flag-plan-phase', /should persist chain flag/],
    ['git checkout -b added to plan-phase (#2388)', 'gsd-core/workflows/plan-phase.md',
      (text) => `${text}\ngit checkout -b gsd/new\n`, 'chain-flag-plan-phase', /must not instruct LLM to create a new branch/],
    ['plan-phase deleted, so its step file is not enough (#2388)', 'gsd-core/workflows/plan-phase.md',
      () => '', 'chain-flag-plan-phase', /the file is empty/],
    ['areas_remaining gone from the checkpoint template (#1485)', 'gsd-core/workflows/discuss-phase/templates/checkpoint.json',
      without('areas_remaining'), 'discuss-checkpoint', /checkpoint should track remaining areas/],
    ['rm -f gone from the discuss-phase workflow, so the checkpoint is never cleaned up (#1485)', 'gsd-core/workflows/discuss-phase.md',
      without('rm -f'), 'discuss-checkpoint', /checkpoint file should be deleted/],
    ['the success criteria lose the resume requirement (#1485)', 'gsd-core/workflows/discuss-phase.md',
      (text) => {
        const at = text.indexOf('<success_criteria>');
        const close = text.indexOf('</success_criteria>');
        return text.slice(0, at) + text.slice(at, close).replace(/resume|Resume/g, 'continue') + text.slice(close);
      }, 'discuss-checkpoint', /success criteria should mention session resume/],
    ['the Project skills block gone from an agent', 'agents/gsd-roadmapper.md',
      without('Project skills'), 'agent-skills-awareness', /gsd-roadmapper missing Project skills block/],
    ['an agent told to load the whole AGENTS.md', 'agents/gsd-debugger.md',
      (text) => `${text}\nRead AGENTS.md first.\n`, 'agent-skills-awareness', /gsd-debugger should not instruct loading full AGENTS\.md/],
    ['the doc writer loses its SECURITY note', 'agents/gsd-doc-writer.md',
      without('SECURITY'), 'agent-skills-awareness', /gsd-doc-writer missing security note/],
    ['--fast gone from map-codebase', 'commands/gsd/map-codebase.md',
      without('--fast'), 'scan-command', /must document --fast flag/],
    ['one focus area gone from the scan workflow', 'gsd-core/workflows/scan.md',
      without('`concerns`'), 'scan-command', /should document the "concerns" focus area/],
    ['the scan workflow no longer names the mapper agent', 'gsd-core/workflows/scan.md',
      without('gsd-codebase-mapper'), 'scan-command', /should reference the gsd-codebase-mapper agent/],
    ['overlap detection gone from the analyze-dependencies workflow', 'gsd-core/workflows/analyze-dependencies.md',
      (text) => text.replace(/overlap|conflict/g, 'clash'), 'analyze-dependencies', /should mention file overlap\/conflict detection/],
    ['the removed command documented again in COMMANDS.md (#2790)', 'docs/COMMANDS.md',
      (text) => `${text}\n### \`/gsd-analyze-dependencies\`\n`, 'analyze-dependencies', /should not document the removed \/gsd-analyze-dependencies command/],
    ['the removed command file restored (#2790)', 'commands/gsd/analyze-dependencies.md',
      () => '---\nname: x\n---\n', 'analyze-dependencies', /should have been deleted in #2790/],
  ]) {
    test(`mutation: ${title} fails ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const exists = fs.existsSync(abs);
      const before = exists ? fs.readFileSync(abs, 'utf8') : '';
      const after = edit(before);
      assert.ok(!exists || after !== before, 'the mutation changed the file');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  // The five batch-4 contracts.
  const dropAll = (phrase) => (text) => text.split(phrase).join('');
  const append = (line) => (text) => `${text}\n${line}\n`;
  for (const [title, rel, edit, contract, expected] of [
    ['.clinerules loses its test framework mention', '.clinerules',
      (text) => text.replace(/node:test|node:assert/g, 'a runner'), 'cline-support', /should mention test framework/],
    ['.clinerules deleted, so the contract has nothing to read', '.clinerules',
      () => '', 'cline-support', /the file is empty/],
    ['a "(12 shipped)" count back in an INVENTORY heading', 'docs/INVENTORY.md',
      append('## Hooks (12 shipped)'), 'inventory-headings-countfree', /still has a hard-count "\(N shipped\)" heading/],
    ['a count on a heading whose title is 298 characters (limit - 2 of the pattern bound)', 'docs/INVENTORY.md',
      append(`## ${'t'.repeat(298)} (3 shipped)`), 'inventory-headings-countfree', /still has a hard-count/],
    ['a count on a heading whose title is 299 characters (the pattern bound)', 'docs/INVENTORY.md',
      append(`## ${'t'.repeat(299)} (3 shipped)`), 'inventory-headings-countfree', /still has a hard-count/],
    ['npm install -g npm@latest added to release.yml (#318)', '.github/workflows/release.yml',
      append('      - run: npm install -g npm@latest'), 'policy-release-no-npm-self-upgrade', /must not contain a runtime global npm self-upgrade step/],
    ['npm i -g npm added to release.yml (#318)', '.github/workflows/release.yml',
      append('      - run: npm i -g npm'), 'policy-release-no-npm-self-upgrade', /must not contain a runtime global npm self-upgrade step/],
    ['npm install --global npm@11 added to release.yml (#318)', '.github/workflows/release.yml',
      append('  run: npm install --global npm@11'), 'policy-release-no-npm-self-upgrade', /must not contain a runtime global npm self-upgrade step/],
    ['the capability manual loses the registry --check step', 'docs/how-to/develop-a-capability.md',
      dropAll('node scripts/gen-capability-registry.cjs --check'), 'phase6-capability-docs', /manual documents the registry --check step/],
    ['the capability manual loses the render-hooks verification', 'docs/how-to/develop-a-capability.md',
      dropAll('gsd-tools loop render-hooks plan:pre'), 'phase6-capability-docs', /manual documents render-hooks verification/],
    ['the docs index no longer links the capability manual', 'docs/README.md',
      dropAll('how-to/develop-a-capability.md'), 'phase6-capability-docs', /docs index links the Capability developer manual/],
    ['the capability manual deleted, so the contract has nothing to read', 'docs/how-to/develop-a-capability.md',
      () => '', 'phase6-capability-docs', /the file is empty/],
    ['Playwright gone from the automated UI verification step (#2994)', 'gsd-core/workflows/verify-work/steps/automated-ui-verification.md',
      (text) => text.replace(/playwright/gi, 'the browser tool'), 'playwright-ui-verify', /should mention Playwright/],
    ['the fallback wording gone from the automated UI verification step (#2994)', 'gsd-core/workflows/verify-work/steps/automated-ui-verification.md',
      (text) => text.replace(/if available|when available|if Playwright|fall back/g, 'always'), 'playwright-ui-verify', /must be conditional with manual fallback/],
    ['Playwright gone from ui-review.md', 'gsd-core/workflows/ui-review.md',
      (text) => text.replace(/playwright/gi, 'the browser tool'), 'playwright-ui-verify', /ui-review\.md should reference Playwright-MCP/],
    ['Playwright gone from the ui-auditor agent', 'agents/gsd-ui-auditor.md',
      (text) => text.replace(/playwright/gi, 'the browser tool'), 'playwright-ui-verify', /gsd-ui-auditor\.md should mention/],
  ]) {
    test(`mutation: ${title} fails ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      const after = edit(before);
      assert.notEqual(after, before, 'the mutation changed the file');
      fs.writeFileSync(abs, after);
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  test('a count on a heading whose title is 300 characters is past the stated 300-character bound of the pattern', (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, 'docs', 'INVENTORY.md');
    fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n## ${'t'.repeat(300)} (3 shipped)\n`);
    assert.deepEqual(runShipped(root, ['inventory-headings-countfree']), []);
  });

  // The release.yml self-upgrade pattern: lines it must not match stay clean (it was a unit test of its own regex).
  for (const line of ['npm ci', 'npm install', 'npm install -g some-other-tool', 'npm run build']) {
    test(`release.yml with the allowed line ${JSON.stringify(line)} still satisfies policy-release-no-npm-self-upgrade`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, '.github', 'workflows', 'release.yml');
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n      - run: ${line}\n`);
      assert.deepEqual(runShipped(root, ['policy-release-no-npm-self-upgrade']), []);
    });
  }

  // The size ceiling is exclusive: SIZE_LIMIT - 1 characters pass, SIZE_LIMIT and SIZE_LIMIT + 1 fail.
  for (const [delta, fails] of [[-1, false], [0, true], [1, true]]) {
    test(`autonomous.md of ${SIZE_LIMIT + delta} characters ${fails ? 'fails' : 'satisfies'} autonomous-decomposition`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'autonomous.md');
      const text = fs.readFileSync(abs, 'utf8');
      assert.ok(text.length <= SIZE_LIMIT - 1, 'the real file leaves room to pad up to the boundary');
      fs.writeFileSync(abs, text + 'x'.repeat(SIZE_LIMIT + delta - text.length));
      const findings = runShipped(root, ['autonomous-decomposition']);
      assert.equal(findings.length, fails ? 1 : 0, JSON.stringify(findings));
      if (fails) assert.match(findings[0].message, /must stay under the 10K-token Read limit/);
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
