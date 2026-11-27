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
const PROJECT_SKILLS = require('../scripts/static-checks/text-contracts/lib/project-skills-discovery.cjs');

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

describe('ctx.list', () => {
  const listAndRead = "for (const rel of ctx.list('wf', '.md', 'workflows')) ctx.doc(rel).has(/ok/, 'needs ok');";

  test('lists nested files by suffix, sorted, and reads each; a satisfied scan reports nothing', (t) => {
    const tree = makeTree(t, { 'wf/b.md': 'ok\n', 'wf/a.md': 'ok\n', 'wf/sub/c.md': 'ok\n', 'wf/skip.txt': 'no\n' }, { l1: listAndRead });
    assert.deepEqual(runTree(tree), []);
  });

  test('a file in a subdirectory that breaks the contract is found and named by its path', (t) => {
    const tree = makeTree(t, { 'wf/a.md': 'ok\n', 'wf/sub/deep/c.md': 'bad\n' }, { l2: listAndRead });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'wf/sub/deep/c.md');
  });

  test('the order is sorted whatever the directory order', (t) => {
    const tree = makeTree(t, { 'wf/z.md': 'ok\n', 'wf/a.md': 'ok\n', 'wf/m/b.md': 'ok\n' }, {
      l3: "const seen = ctx.list('wf', '.md', 'w'); ctx.doc('wf/a.md').satisfies(() => JSON.stringify(seen) === JSON.stringify(['wf/a.md', 'wf/m/b.md', 'wf/z.md']) || JSON.stringify(seen), 'sorted');",
    });
    assert.deepEqual(runTree(tree), []);
  });

  test('a missing directory is one finding and the scan has nothing to pass vacuously', (t) => {
    const findings = runTree(makeTree(t, {}, { l4: listAndRead }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^l4: cannot read the directory: ENOENT$/);
  });

  test('a directory with no file of the suffix is a finding', (t) => {
    const findings = runTree(makeTree(t, { 'wf/a.txt': 'x\n' }, { l5: listAndRead }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^l5: workflows \(no \.md file under wf\)$/);
  });

  test('a trailing slash on the directory is the same directory', (t) => {
    const tree = makeTree(t, { 'wf/a.md': 'ok\n' }, { l6: "for (const rel of ctx.list('wf/', '.md', 'workflows')) ctx.doc(rel).has(/ok/, 'needs ok');" });
    assert.deepEqual(runTree(tree), []);
  });

  test('a path that leaves the tree is a finding and lists nothing', (t) => {
    const tree = makeTree(t, {}, { l7: "ctx.list('../outside', '.md', 'escape');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /not a repo-relative path inside the repository/);
  });

  test('a directory that is itself a symlink is a finding and is not listed', (t) => {
    const tree = makeTree(t, { 'elsewhere/b.md': 'ok\n' }, { l9: listAndRead });
    fs.symlinkSync(path.join(tree.root, 'elsewhere'), path.join(tree.root, 'wf'), 'dir');
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^l9: workflows \(wf is a symlink, expected a directory\)$/);
  });

  test('a regular file where the directory should be is a finding', (t) => {
    const findings = runTree(makeTree(t, { 'wf': 'not a directory\n' }, { l10: listAndRead }));
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /wf is not a directory, expected a directory/);
  });

  test('a symlink is not followed: a linked file is neither listed nor read', (t) => {
    const tree = makeTree(t, { 'wf/a.md': 'ok\n', 'elsewhere/b.md': 'bad\n' }, { l8: listAndRead });
    fs.symlinkSync(path.join(tree.root, 'elsewhere', 'b.md'), path.join(tree.root, 'wf', 'link.md'));
    fs.symlinkSync(path.join(tree.root, 'elsewhere'), path.join(tree.root, 'wf', 'linkdir'), 'dir');
    assert.deepEqual(runTree(tree), []);
  });
});

describe('doc.satisfies', () => {
  test('a predicate returning true reports nothing and counts as an assertion', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\ntwo\n' }, { sat1: "ctx.doc('a.md').satisfies((text) => text.split('\\n').length === 3, 'two lines');" });
    assert.deepEqual(runTree(tree), []);
  });

  test('a predicate returning a string is one finding carrying the reason', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\n' }, { sat2: "ctx.doc('a.md').satisfies(() => '1 line, expected 2', 'needs two lines');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'a.md');
    assert.match(findings[0].message, /^sat2: needs two lines \(1 line, expected 2\)$/);
  });

  test('a predicate returning false is one finding without a reason', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\n' }, { sat3: "ctx.doc('a.md').satisfies(() => false, 'never holds');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /^sat3: never holds$/);
  });

  test('a predicate returning anything but true is a finding, so a truthy non-boolean cannot pass', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\n' }, { sat4: "ctx.doc('a.md').satisfies(() => 1, 'needs exactly true');" });
    assert.equal(runTree(tree).length, 1);
  });

  test('on a missing file the predicate is not run and only the read failure is reported', (t) => {
    const tree = makeTree(t, {}, { sat5: "ctx.doc('nope.md').satisfies(() => { throw new Error('ran'); }, 'unreached');" });
    const findings = runTree(tree);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /cannot read the file: ENOENT/);
  });

  test('the predicate sees the LF text of the document', (t) => {
    const tree = makeTree(t, { 'a.md': 'one\r\ntwo\r\n' }, { sat6: "ctx.doc('a.md').satisfies((text) => !text.includes('\\r'), 'LF only');" });
    assert.deepEqual(runTree(tree), []);
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
    // The earlier contracts are exercised here; the batch 8 ones (#6566) in tests/text-contracts.batch8.test.cjs, the batch 9 ones (#6573) in tests/text-contracts.batch9.test.cjs and the batch 10 ones (#6577) in tests/text-contracts.batch10.test.cjs the batch 11 ones (#6583) in tests/text-contracts.batch11.test.cjs and the batch 12 ones (#6654) in tests/text-contracts.batch12.test.cjs.
    assert.deepEqual([...ids].sort(), [...SHIPPED, ...require('./helpers/text-contracts-batch8-ids.cjs'), ...require('./helpers/text-contracts-batch9-ids.cjs'), ...require('./helpers/text-contracts-batch10-ids.cjs'), ...require('./helpers/text-contracts-batch11-ids.cjs'), ...require('./helpers/text-contracts-batch12-ids.cjs')].sort());
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
  'release-coverage-scope', 'gsd-researcher-flow-diagram', 'import-command', 'gates-taxonomy', 'ios-scaffold-safety',
  'audit-milestone-filename-guard', 'branch-no-track-guard', 'execute-plan-interrupted-agent-guard', 'handoff-next-step',
  'transition-verification-gate',
  'ui-checker-adversarial-stance', 'context7-plugin-grant-parity', 'execute-phase-branch-base-ahead-warning', 'verifier-mvp-section',
  'verifier-harvest-recorded-verdict', 'workflow-step-tag-balance', 'dependency-advisory-floors', 'extraction-discipline-consistency',
  'ci-durations-upload-nonfatal', 'reachability-check', 'review-timeout-guidance', 'quick-planner-scope-guard',
  'roadmapper-contract-guard', 'untrusted-input-isolation', 'verifier-spotcheck-test-discipline',
  'advisor-prefilter',
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
    'agents/gsd-phase-researcher.md', 'gsd-core/templates/research.md', 'commands/gsd/import.md', 'gsd-core/workflows/import.md',
    'gsd-core/references/gates.md', 'gsd-core/workflows/execute-phase.md', 'agents/gsd-plan-checker.md', 'agents/gsd-verifier.md',
    'gsd-core/references/ios-scaffold.md', 'agents/gsd-executor.md', 'gsd-core/references/universal-anti-patterns.md',
    'gsd-core/workflows/audit-milestone.md', 'gsd-core/workflows/execute-plan.md', 'gsd-core/workflows/transition.md',
    'commands/gsd/new-project.md', 'skills/gsd-new-project/SKILL.md', 'pi/package-skills/gsd-new-project/SKILL.md',
    'commands/gsd/new-milestone.md', 'skills/gsd-new-milestone/SKILL.md', 'pi/package-skills/gsd-new-milestone/SKILL.md',
    // Batch 7.
    'agents/gsd-ui-checker.md', 'agents/gsd-advisor-researcher.md', 'agents/gsd-planner.md', 'agents/gsd-doc-classifier.md',
    'agents/gsd-doc-synthesizer.md', 'agents/gsd-project-researcher.md', 'agents/gsd-domain-researcher.md',
    'agents/gsd-ai-researcher.md', 'agents/gsd-research-synthesizer.md', 'agents/gsd-ui-researcher.md',
    'agents/gsd-assumptions-analyzer.md', 'agents/gsd-roadmapper.md',
    'gsd-core/references/verify-mvp-mode.md', 'gsd-core/references/planner-human-verify-mode.md', 'gsd-core/references/checkpoints.md',
    'gsd-core/workflows/settings-advanced.md', 'gsd-core/workflows/review.md', 'gsd-core/workflows/quick.md',
    'gsd-core/references/untrusted-input-boundary.md', 'package-lock.json', '.github/workflows/test.yml',
    // agent-skills-awareness (#4649): the 21 canonical agents, their 15 compact variants and the shared reference.
    ...PROJECT_SKILLS.DISCOVERY_FILES, PROJECT_SKILLS.REFERENCE,
    // advisor-prefilter (#4795): the fragment and the two workflows that deliver it.
    'capabilities/advisor-prefilter/fragments/advisor-prefilter.md', 'gsd-core/workflows/verify-work.md', 'gsd-core/workflows/ship.md',
    // the spawn-prompt files whose project-skills lines must state the same scoped read (#5248).
    ...PROJECT_SKILLS.SPAWN_PROMPT_FILES,
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

  // advisor-prefilter (#4795): the fragment's contract and the two dispatch lines that deliver it.
  for (const [title, rel, phrase, expected] of [
    ['the silent no-op clause gone from the fragment', 'capabilities/advisor-prefilter/fragments/advisor-prefilter.md',
      'no-op', /must declare a silent no-op/],
    ['the never-blocks statement gone from the fragment', 'capabilities/advisor-prefilter/fragments/advisor-prefilter.md',
      'never blocks', /must state it never blocks/],
    ['a reviewer no longer named as unchanged in the fragment', 'capabilities/advisor-prefilter/fragments/advisor-prefilter.md',
      'gsd-security-auditor', /must name gsd-security-auditor as unchanged/],
    ['the verify:post contribution dispatch line gone from verify-work.md', 'gsd-core/workflows/verify-work.md',
      '**Contribution dispatch:** inject every `kind == "contribution"` fragment from `VERIFY_POST_HOOKS_JSON`', /verify-work\.md must dispatch contributions at verify:post/],
    ['the ship:pre contribution dispatch line gone from ship.md', 'gsd-core/workflows/ship.md',
      '**Contribution dispatch:** inject every `kind == "contribution"` fragment from `SHIP_PRE_HOOKS_JSON`', /ship\.md must dispatch contributions at ship:pre/],
  ]) {
    test(`mutation: ${title} fails advisor-prefilter`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      const before = fs.readFileSync(abs, 'utf8');
      assert.ok(before.includes(phrase), 'the phrase is present to start with');
      fs.writeFileSync(abs, before.split(phrase).join(''));
      const findings = runShipped(root, ['advisor-prefilter']);
      assert.ok(findings.some((f) => expected.test(f.message)), `expected a finding matching ${expected}, got ${JSON.stringify(findings.map((f) => f.message))}`);
    });
  }

  // The four autonomous-* contracts: each asserts on the command, the workflow or the smart-discuss reference.
  const SIZE_LIMIT = 41 * 1024; // autonomous-decomposition's ceiling (#2196, raised by #5438)
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
    ['.clinerules loses its GSD workflow mention', '.clinerules',
      (text) => text.replace(/gsd|GSD|workflow/g, 'x'), 'cline-support', /should mention GSD workflows/],
    ['.clinerules loses its CommonJS standard', '.clinerules',
      (text) => text.replace(/CommonJS|require/g, 'x'), 'cline-support', /should mention CommonJS standard/],
    ['.clinerules loses its architecture overview', '.clinerules',
      (text) => text.replace(/bin\/lib|workflows|agents/g, 'x'), 'cline-support', /should describe project architecture/],
    ['.clinerules emptied, so the contract has nothing to read', '.clinerules',
      () => '', 'cline-support', /the file is empty/],
    ['a "(12 shipped)" count back in an INVENTORY heading', 'docs/INVENTORY.md',
      append('## Hooks (12 shipped)'), 'inventory-headings-countfree', /still has a hard-count "\(N shipped\)" heading/],
    ['a count on a heading whose title is 298 characters (one under the pattern bound)', 'docs/INVENTORY.md',
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
    ['the capability manual loses its ADR-857 citation', 'docs/how-to/develop-a-capability.md',
      dropAll('ADR-857'), 'phase6-capability-docs', /manual cites ADR-857/],
    ['the capability manual loses the GSD 1.5 loop', 'docs/how-to/develop-a-capability.md',
      dropAll('GSD 1.5'), 'phase6-capability-docs', /GSD 1\.5 capability development loop/],
    ['the capability manual loses fragment.inline', 'docs/how-to/develop-a-capability.md',
      dropAll('fragment.inline'), 'phase6-capability-docs', /manual documents fragment\.inline/],
    ['the capability manual loses the ai-integration cutover', 'docs/how-to/develop-a-capability.md',
      dropAll('ai-integration'), 'phase6-capability-docs', /ai-integration planning capability cutover/],
    ['the capability manual loses the pattern-mapper cutover', 'docs/how-to/develop-a-capability.md',
      dropAll('pattern-mapper'), 'phase6-capability-docs', /pattern-mapper planning capability cutover/],
    ['the capability manual emptied, so the contract has nothing to read', 'docs/how-to/develop-a-capability.md',
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

  // The five batch-5 contracts.
  const swap = (from, to) => (text) => text.split(from).join(to);
  const dropFirst = (phrase) => (text) => text.replace(phrase, '');
  const RAW_SHARD_STEP = '          npm run test:coverage:unit:raw -- --shard ${{ matrix.shard }}';
  // The text between `<required_reading>` on its own line and its closing tag, edited and put back.
  const inRequiredReading = (edit) => (text) => {
    const open = '<required_reading>\n';
    const at = text.indexOf(open) + open.length;
    const close = text.indexOf('\n</required_reading>', at);
    return text.slice(0, at) + edit(text.slice(at, close)) + text.slice(close);
  };
  // Sets the first job-cap line after the job's own line in release.yml.
  const setJobCap = (job, minutes) => (text) => {
    const cap = text.indexOf('    timeout-minutes: ', text.indexOf(`\n  ${job}:\n`));
    return `${text.slice(0, cap)}    timeout-minutes: ${minutes}${text.slice(text.indexOf('\n', cap))}`;
  };
  for (const [title, rel, edit, contract, expected] of [
    ['a bare full-suite coverage line added to release.yml (#4335)', '.github/workflows/release.yml',
      append('      - run: npm run test:coverage'), 'release-coverage-scope', /1 bare 'npm run test:coverage' line\(s\), expected 0/],
    ['an unsharded unit-coverage line added to release.yml (#4335)', '.github/workflows/release.yml',
      append('        run: npm run test:coverage:unit'), 'release-coverage-scope', /1 unsharded 'npm run test:coverage:unit' line\(s\), expected 0/],
    ['an unsharded unit-coverage line as a `- run:` list item added to release.yml (#4335)', '.github/workflows/release.yml',
      append('      - run: npm run test:coverage:unit'), 'release-coverage-scope', /1 unsharded 'npm run test:coverage:unit' line\(s\), expected 0/],
    ['one sharded raw-coverage step gone from release.yml (#4335)', '.github/workflows/release.yml',
      dropFirst(`${RAW_SHARD_STEP}\n`), 'release-coverage-scope', /1 sharded raw-coverage line\(s\), expected 2/],
    ['a third sharded raw-coverage line added to release.yml (#4335)', '.github/workflows/release.yml',
      append(RAW_SHARD_STEP.trim()), 'release-coverage-scope', /3 sharded raw-coverage line\(s\), expected 2/],
    ['one merged-coverage report step gone from release.yml (#4335)', '.github/workflows/release.yml',
      dropFirst('        run: npm run test:coverage:report'), 'release-coverage-scope', /1 'npm run test:coverage:report' line\(s\), expected 2/],
    ['one shard step stops pinning AUDIT_BASELINE_REF (#4196)', '.github/workflows/release.yml',
      dropFirst('          AUDIT_BASELINE_REF: ${{ github.sha }}\n'), 'release-coverage-scope', /must pin AUDIT_BASELINE_REF to github\.sha/],
    ['rc-test loses its job cap (#5421)', '.github/workflows/release.yml',
      (text) => {
        const cap = text.indexOf('    timeout-minutes: ', text.indexOf('\n  rc-test:\n'));
        return `${text.slice(0, cap)}    # none${text.slice(text.indexOf('\n', cap))}`;
      }, 'release-coverage-scope', /rc-test must set the job cap/],
    ['the Component Responsibilities table redirect gone from the researcher (#2139)', 'agents/gsd-phase-researcher.md',
      swap('Component Responsibilities table', 'table'), 'gsd-researcher-flow-diagram', /redirect file mapping to the Component Responsibilities table/],
    ['the System Architecture Diagram section gone from the researcher (#2139)', 'agents/gsd-phase-researcher.md',
      swap('### System Architecture Diagram', '### Diagram'), 'gsd-researcher-flow-diagram', /gsd-phase-researcher\.md must contain "### System Architecture Diagram"/],
    ['"not file listings" gone from the researcher (#2139)', 'agents/gsd-phase-researcher.md',
      swap('not file listings', 'listings'), 'gsd-researcher-flow-diagram', /must explicitly state "not file listings"/],
    ['"data flow through conceptual components" gone from the researcher (#2139)', 'agents/gsd-phase-researcher.md',
      swap('data flow through conceptual components', 'data flow'), 'gsd-researcher-flow-diagram', /must require "data flow through conceptual components"/],
    ['"entry points" gone from the researcher directive (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => text.replace(/entry points/gi, 'inputs'), 'gsd-researcher-flow-diagram', /must mention "entry points"/],
    ['"processing stages" gone from the researcher directive (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => text.replace(/processing stages/gi, 'steps'), 'gsd-researcher-flow-diagram', /must mention "processing stages"/],
    ['"decision points" gone from the researcher directive (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => text.replace(/decision points/gi, 'branches'), 'gsd-researcher-flow-diagram', /must mention "decision points"/],
    ['"external dependencies" gone from the researcher directive (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => text.replace(/external dependencies/gi, 'services'), 'gsd-researcher-flow-diagram', /must mention "external dependencies"/],
    ['"data flow through conceptual components" gone from the research template (#2139)', 'gsd-core/templates/research.md',
      swap('data flow through conceptual components', 'data flow'), 'gsd-researcher-flow-diagram', /research template must include the flow diagram directive/],
    ['plan-phase gone from the Gate Matrix (#1715)', 'gsd-core/references/gates.md',
      swap('plan-phase', 'planning'), 'gates-taxonomy', /must reference plan-phase/],
    ['execute-phase gone from the Gate Matrix (#1715)', 'gsd-core/references/gates.md',
      swap('execute-phase', 'execution'), 'gates-taxonomy', /must reference execute-phase/],
    ['Package.swift no longer named by ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('Package.swift', 'the package file'), 'ios-scaffold-safety', /must name Package\.swift/],
    ['executableTarget no longer named by ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('executableTarget', 'target kind'), 'ios-scaffold-safety', /must name \.executableTarget/],
    ['"arrows" gone from the researcher directive (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => text.replace(/arrows/gi, 'lines'), 'gsd-researcher-flow-diagram', /must mention "arrows"/],
    ['a Recommended Project Structure heading ahead of the diagram section (#2139)', 'agents/gsd-phase-researcher.md',
      (text) => `### Recommended Project Structure\n${text}`, 'gsd-researcher-flow-diagram', /must come before Recommended Project Structure/],
    ['the System Architecture Diagram section gone from the research template (#2139)', 'gsd-core/templates/research.md',
      swap('### System Architecture Diagram', '### Diagram'), 'gsd-researcher-flow-diagram', /research template must contain "### System Architecture Diagram"/],
    ['"not file listings" gone from the research template (#2139)', 'gsd-core/templates/research.md',
      swap('not file listings', 'listings'), 'gsd-researcher-flow-diagram', /research template must prohibit file listings/],
    ['the import command renamed', 'commands/gsd/import.md',
      swap('name: gsd:import', 'name: gsd:other'), 'import-command', /should have a name field of gsd:import/],
    ['the import command description emptied', 'commands/gsd/import.md',
      (text) => text.replace(/^description:.*$/m, 'description:'), 'import-command', /should have a description field with a value/],
    ['--from gone from the import argument-hint', 'commands/gsd/import.md',
      (text) => text.replace(/^argument-hint:.*$/m, 'argument-hint: "<filepath>"'), 'import-command', /should have an argument-hint with --from/],
    ['the import command no longer references its workflow', 'commands/gsd/import.md',
      dropAll('@~/.claude/gsd-core/workflows/import.md'), 'import-command', /should reference the workflow via @~\/\.claude\/gsd-core\/workflows\/import\.md/],
    ['--from gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('--from', '--source'), 'import-command', /should contain --from mode handling/],
    ['--prd no longer mentioned by the import workflow', 'gsd-core/workflows/import.md',
      swap('--prd', '--plan'), 'import-command', /should mention --prd exists/],
    ['the --prd deferral wording gone from the import workflow', 'gsd-core/workflows/import.md',
      (text) => text.replace(/not yet implemented|follow-up PR|future release/g, 'later'), 'import-command', /should defer --prd to a future release/],
    ['a Path B implementation for --prd added to the import workflow', 'gsd-core/workflows/import.md',
      append('## Path B: MODE=prd'), 'import-command', /should NOT have a Path B implementation for --prd/],
    ['the traversal check gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('traversal', 'walk'), 'import-command', /should validate the --from file path against traversal/],
    ['REQUIREMENTS.md gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('REQUIREMENTS.md', 'the requirements file'), 'import-command', /should load REQUIREMENTS\.md for conflict detection/],
    ['[BLOCKER] gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('[BLOCKER]', 'blocker'), 'import-command', /should include BLOCKER severity/],
    ['[WARNING] gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('[WARNING]', 'warning'), 'import-command', /should include WARNING severity/],
    ['[INFO] gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('[INFO]', 'info'), 'import-command', /should include INFO severity/],
    ['gsd-plan-checker gone from the import workflow', 'gsd-core/workflows/import.md',
      swap('gsd-plan-checker', 'the checker'), 'import-command', /should delegate validation to gsd-plan-checker/],
    ['the usage line gone from the import workflow', 'gsd-core/workflows/import.md',
      (text) => text.replace(/Usage: \/gsd[:-]import/g, 'Help'), 'import-command', /should display usage when no arguments are provided/],
    ['the Abort Gate heading gone from gates.md (#1715)', 'gsd-core/references/gates.md',
      swap('### Abort Gate', '### Abort'), 'gates-taxonomy', /must define "Abort Gate" as an h3 heading/],
    ['the Revision Gate loses its Recovery field (#1715)', 'gsd-core/references/gates.md',
      (text) => text.replace('**Recovery:**', '**Fix:**'), 'gates-taxonomy', /Gate "(Pre-flight|Revision) Gate" must include \*\*Recovery:\*\*/],
    ['the Escalation Gate loses its Examples field (#1715)', 'gsd-core/references/gates.md',
      (text) => {
        const at = text.indexOf('### Escalation Gate');
        return text.slice(0, at) + text.slice(at).replace('**Examples:**', '**Cases:**');
      }, 'gates-taxonomy', /Gate "Escalation Gate" must include \*\*Examples:\*\*/],
    ['the Gate Matrix section gone from gates.md (#1715)', 'gsd-core/references/gates.md',
      swap('## Gate Matrix', '## Matrix'), 'gates-taxonomy', /must include a "Gate Matrix" section/],
    ['the Workflow column gone from the Gate Matrix (#1715)', 'gsd-core/references/gates.md',
      swap('| Workflow |', '| Flow |'), 'gates-taxonomy', /table with a Workflow column/],
    ['verify-work gone from gates.md (#1715)', 'gsd-core/references/gates.md',
      swap('verify-work', 'verification'), 'gates-taxonomy', /must reference verify-work/],
    ['the next row gone from the Gate Matrix (#1715)', 'gsd-core/references/gates.md',
      swap('| next |', '| other |'), 'gates-taxonomy', /must reference the next workflow/],
    ['stall detection gone from gates.md (#1715)', 'gsd-core/references/gates.md',
      swap('stall detection', 'looping'), 'gates-taxonomy', /must mention stall detection/],
    ['plan-phase no longer references gates.md (#1715)', 'gsd-core/workflows/plan-phase.md',
      dropAll('references/gates.md'), 'gates-taxonomy', /plan-phase\.md must reference gates\.md/],
    ['execute-phase no longer references gates.md (#1715)', 'gsd-core/workflows/execute-phase.md',
      dropAll('references/gates.md'), 'gates-taxonomy', /execute-phase\.md must reference gates\.md/],
    ['gsd-verifier loses gates.md from its required_reading block (#1715)', 'agents/gsd-verifier.md',
      inRequiredReading(dropAll('references/gates.md')), 'gates-taxonomy', /gsd-verifier\.md must reference gates\.md inside <required_reading>/],
    ['gsd-plan-checker loses gates.md from its required_reading block (#1715)', 'agents/gsd-plan-checker.md',
      inRequiredReading(dropAll('references/gates.md')), 'gates-taxonomy', /gsd-plan-checker\.md must reference gates\.md inside <required_reading>/],
    ['gsd-plan-checker names gates.md only outside its required_reading block (#1715)', 'agents/gsd-plan-checker.md',
      (text) => `${inRequiredReading(dropAll('references/gates.md'))(text)}\nSee references/gates.md\n`, 'gates-taxonomy', /gsd-plan-checker\.md must reference gates\.md inside <required_reading>/],
    ['the Package.swift prohibition gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('NEVER use `Package.swift`', 'Use `Package.swift`'), 'ios-scaffold-safety', /must explicitly prohibit Package\.swift as the primary build system/],
    ['the .executableTarget prohibition gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('NEVER', 'Always'), 'ios-scaffold-safety', /must explicitly prohibit \.executableTarget for iOS app targets/],
    ['project.yml gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('project.yml', 'the project file'), 'ios-scaffold-safety', /must require project\.yml as the XcodeGen spec file/],
    ['xcodegen generate gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('xcodegen generate', 'xcodegen run'), 'ios-scaffold-safety', /must require the xcodegen generate command/],
    ['SwiftUI API availability gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('SwiftUI API availability', 'SwiftUI notes'), 'ios-scaffold-safety', /must document SwiftUI API availability/],
    ['IPHONEOS_DEPLOYMENT_TARGET gone from ios-scaffold.md (#2023)', 'gsd-core/references/ios-scaffold.md',
      swap('IPHONEOS_DEPLOYMENT_TARGET', 'the target'), 'ios-scaffold-safety', /must document iOS deployment target compatibility/],
    ['the executor no longer references ios-scaffold.md (#2023)', 'agents/gsd-executor.md',
      dropAll('ios-scaffold.md'), 'ios-scaffold-safety', /gsd-executor\.md must reference ios-scaffold\.md/],
    ['the Package.swift anti-pattern gone from universal-anti-patterns.md (#2023)', 'gsd-core/references/universal-anti-patterns.md',
      swap('`Package.swift` + `.executableTarget`', 'a build file'), 'ios-scaffold-safety', /must document the Package\.swift misuse anti-pattern/],
    ['the iOS scope gone from the universal anti-pattern (#2023)', 'gsd-core/references/universal-anti-patterns.md',
      swap('primary build system for iOS apps', 'primary build system'), 'ios-scaffold-safety', /must say the misuse is for iOS apps/],
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

  // The job-cap floor of rc-test and finalize-test is inclusive: 29 fails, 30 and 31 pass.
  for (const job of ['rc-test', 'finalize-test']) {
    for (const [minutes, fails] of [[29, true], [30, false], [31, false]]) {
      test(`${job} with a job cap of ${minutes} minutes ${fails ? 'fails' : 'satisfies'} release-coverage-scope`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, '.github', 'workflows', 'release.yml');
        fs.writeFileSync(abs, setJobCap(job, minutes)(fs.readFileSync(abs, 'utf8')));
        const findings = runShipped(root, ['release-coverage-scope']);
        assert.equal(findings.length, fails ? 1 : 0, JSON.stringify(findings));
        if (fails) assert.match(findings[0].message, new RegExp(`${job} job cap must be at least 30 \\(was 29\\)`));
      });
    }
  }

  // The fifteen batch-7 contracts.
  const yaml = require('js-yaml');
  const erase = (pattern) => (text) => text.replace(pattern, '');
  const eraseAll = (phrase) => (text) => text.split(phrase).join('');
  const within = (from, to, edit) => (text) => {
    const at = text.indexOf(from);
    const end = text.indexOf(to, at + from.length);
    return text.slice(0, at) + edit(text.slice(at, end)) + text.slice(end);
  };
  const inStepOf = (name, edit) => within(`<step name="${name}">`, '</step>', edit);
  const yamlEdit = (edit) => (text) => {
    const workflow = yaml.load(text);
    edit(workflow);
    return yaml.dump(workflow, { lineWidth: -1 });
  };
  const stepsOf = (workflow, prefix) => Object.values(workflow.jobs).flatMap((job) => job.steps || [])
    .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact') && step.with && String(step.with.name).startsWith(prefix));
  const INGEST = [
    'gsd-phase-researcher', 'gsd-project-researcher', 'gsd-domain-researcher', 'gsd-ai-researcher', 'gsd-advisor-researcher',
    'gsd-research-synthesizer', 'gsd-doc-classifier', 'gsd-doc-synthesizer', 'gsd-ui-researcher', 'gsd-assumptions-analyzer',
  ];
  const VERIFIER = 'agents/gsd-verifier.md';
  const UI_CHECKER = 'agents/gsd-ui-checker.md';
  const BOUNDARY = 'gsd-core/references/untrusted-input-boundary.md';
  // The planner's <constraints> block of quick.md (the last block opening before the planner dispatch), edited and put back.
  const inPlannerConstraints = (edit) => (text) => {
    const start = text.lastIndexOf('<constraints>', text.indexOf('subagent_type="gsd-planner"'));
    const end = text.indexOf('</constraints>', start);
    return text.slice(0, start) + edit(text.slice(start, end)) + text.slice(end);
  };
  const keepInputs = (keep) => (text) => {
    let seen = 0;
    return text.replace(/\bInput:/gi, (match) => { seen += 1; return seen <= keep ? match : 'Case:'; });
  };
  const withLockVersion = (pkg, version) => (text) => {
    const lock = JSON.parse(text);
    lock.packages[pkg].version = version;
    return JSON.stringify(lock, null, 2);
  };
  for (const [title, rel, edit, contract, expected] of [
    // ui-checker-adversarial-stance
    ...[
      [/<adversarial_stance>/g, /missing <adversarial_stance>/], [/FORCE stance/g, /missing FORCE stance line/],
      [/go soft/gi, /missing go-soft failure list/], [/BLOCK\b/g, /missing BLOCK tier/], [/FLAG\b/g, /missing FLAG tier/],
      [/The Auditor/gi, /missing named third-person reviewer/], [/The Auditor['’]s verdict/gi, /missing third-person verdict phrasing/],
      [/independent/gi, /missing independent\/objective framing/],
      [/not\s+a\s+standalone\s+accuracy\s+guarantee/gi, /missing limitation on persona efficacy claim/],
      [/anti.?capitulat/gi, /missing anti-capitulation rule/], [/concrete fix/gi, /missing "concrete fix" requirement/],
      [/Self-correction is allowed/gi, /missing carve-out for evidence-backed self-correction/],
      [/prior dimension application was mistaken/gi, /missing mistaken-prior-application carve-out/],
    ].map(([pattern, why]) => [`${pattern} gone from the UI checker`, UI_CHECKER, erase(pattern), 'ui-checker-adversarial-stance', why]),
    // context7-plugin-grant-parity
    ['the plugin grant dropped from an agent that grants standalone context7', 'agents/gsd-advisor-researcher.md',
      (text) => text.split('\n').map((line) => (/^tools:/.test(line) ? line.split('mcp__plugin_context7_context7__*').join('') : line)).join('\n'),
      'context7-plugin-grant-parity', /grants mcp__context7__\* but not mcp__plugin_context7_context7__\*/],
    // execute-phase-branch-base-ahead-warning
    ['the rev-list --count check gone from execute-phase (#2639)', 'gsd-core/workflows/execute-phase.md',
      erase(/rev-list[^\n]{0,500}--count[^\n]{0,500}DEFAULT_BRANCH/gi), 'execute-phase-branch-base-ahead-warning', /must check if local \$DEFAULT_BRANCH is ahead of origin/],
    ['the ahead/unpushed warning gone from execute-phase (#2639)', 'gsd-core/workflows/execute-phase.md',
      erase(/ahead[^\n]{0,500}origin[^\n]{0,500}DEFAULT_BRANCH|unpushed/gi), 'execute-phase-branch-base-ahead-warning', /must warn that local commits are ahead\/unpushed/],
    // verifier-mvp-section
    ['the MVP Mode Verification section gone from the verifier', VERIFIER, erase(/mvp[ -]mode verification/gi), 'verifier-mvp-section', /must define an MVP Mode Verification section/],
    ['verify-mvp-mode.md no longer referenced by the verifier', VERIFIER, erase(/verify-mvp-mode\.md/gi), 'verifier-mvp-section', /must reference verify-mvp-mode\.md/],
    ['goal-backward gone from the verifier', VERIFIER, erase(/goal-backward/gi), 'verifier-mvp-section', /must preserve goal-backward terminology/],
    // verifier-harvest-recorded-verdict
    ['the Step 8 heading renamed in the verifier (#5741)', VERIFIER, eraseAll('## Step 8: Identify Human Verification Needs'), 'verifier-harvest-recorded-verdict', /marker .*Step 8.* not found/],
    ['the Step 9 heading renamed, so Step 8 has no end (#5741)', VERIFIER, (text) => text.split('\n## Step 9').join('\n## Stage 9'), 'verifier-harvest-recorded-verdict', /closing marker .* not found/],
    ['"is not a reason to omit" gone from Step 8 (#5741)', VERIFIER, erase(/recorded verdict[^\n]{0,500}is not a reason to omit/gi), 'verifier-harvest-recorded-verdict', /must not be a reason to omit the check/],
    ['the deduplication limit gone from Step 8 (#5741)', VERIFIER, erase(/[Dd]eduplicate only against your own analysis/g), 'verifier-harvest-recorded-verdict', /deduplication must be limited/],
    ['"unmodified" gone from Step 8 (#5741)', VERIFIER, erase(/<expected>[^\n]{0,500}unmodified/g), 'verifier-harvest-recorded-verdict', /must be carried through unmodified/],
    ['the planner-side harvest sentence gone (#5741)', 'gsd-core/references/planner-human-verify-mode.md',
      eraseAll('verifier (Step 8) harvests every `<verify><human-check>` block at end-of-phase, even when its `<expected>` already records a verdict'), 'verifier-harvest-recorded-verdict', /planner-side reference must agree/],
    ['the checkpoints.md harvest sentence gone (#5741)', 'gsd-core/references/checkpoints.md',
      eraseAll('verifier harvests every `<verify><human-check>` at end-of-phase (Step 8), even when its `<expected>` already records a verdict'), 'verifier-harvest-recorded-verdict', /checkpoints\.md must agree/],
    // workflow-step-tag-balance
    ['an extra </step> in a top-level workflow (#1864)', 'gsd-core/workflows/plan-phase.md', (text) => `${text}\n</step>\n`, 'workflow-step-tag-balance', /\d+ opens \/ \d+ closes/],
    ['an extra <step> in a top-level workflow (#1864)', 'gsd-core/workflows/execute-plan.md', (text) => `${text}\n<step name="orphan">\n`, 'workflow-step-tag-balance', /\d+ opens \/ \d+ closes/],
    ['the model_policy step renamed in settings-advanced (#1864)', 'gsd-core/workflows/settings-advanced.md',
      eraseAll('<step name="model_policy">'), 'workflow-step-tag-balance', /expected <step name="model_policy">/],
    ['the Model Policy section heading gone from settings-advanced (#1864)', 'gsd-core/workflows/settings-advanced.md',
      eraseAll('### Section 8 — Model Policy'), 'workflow-step-tag-balance', /Section 8 .* Model Policy/],
    // extraction-discipline-consistency
    ...['gsd-doc-classifier', 'gsd-doc-synthesizer'].flatMap((name) => [
      [/<extraction_discipline>/g, new RegExp(`${name} missing <extraction_discipline>`)],
      [/rule-application, not generation/gi, new RegExp(`${name} missing rule-application framing`)],
      [/do not (infer|embellish)/gi, new RegExp(`${name} missing no-infer/embellish rule`)],
      [/mark.{0,30}absent/gi, new RegExp(`${name} missing "mark absent"`)],
      [/terminal.{0,60}schema|schema.{0,60}restatement|output.{0,40}contract.{0,40}reminder|final.{0,40}output.{0,40}schema/gi, new RegExp(`${name} missing terminal schema restatement`)],
      [/\bInput:/gi, new RegExp(`${name} missing few-shot Input->Output exemplars`)],
    ].map(([pattern, why]) => [`${pattern} gone from ${name}`, `agents/${name}.md`, erase(pattern), 'extraction-discipline-consistency', why])),
    ...['gsd-doc-classifier', 'gsd-doc-synthesizer'].flatMap((name) => [
      ['the anti-JSON-reasoning overclaim back in', 'do not reason your way to an answer', new RegExp(`${name} still contains the anti-JSON-reasoning overclaim`)],
      ['the anti-reasoning overclaim back in', 'extended deliberation always breaks structure', new RegExp(`${name} still contains the anti-reasoning overclaim`)],
    ].map(([title, line, why]) => [`${title} ${name}`, `agents/${name}.md`, (text) => `${text}\n${line}\n`, 'extraction-discipline-consistency', why])),
    // reachability-check
    ['the reachability_check step tag gone from the planner', 'agents/gsd-planner.md', eraseAll('<step name="reachability_check">'), 'reachability-check', /missing the reachability_check step/],
    ['reachability_check ahead of derive_must_haves in the planner', 'agents/gsd-planner.md', (text) => `reachability_check\n${text}`, 'reachability-check', /must come after derive_must_haves/],
    ['estimate_scope ahead of reachability_check in the planner', 'agents/gsd-planner.md', (text) => `estimate_scope\n${text}`, 'reachability-check', /must come before estimate_scope/],
    ['creation path gone from the planner', 'agents/gsd-planner.md', eraseAll('creation path'), 'reachability-check', /missing creation path verification logic/],
    ['UNREACHABLE gone from the planner', 'agents/gsd-planner.md', eraseAll('UNREACHABLE'), 'reachability-check', /missing the UNREACHABLE marker/],
    // review-timeout-guidance
    ['the invoke_reviewers step renamed', 'gsd-core/workflows/review.md', eraseAll('<step name="invoke_reviewers">'), 'review-timeout-guidance', /marker .*invoke_reviewers.* not found/],
    ['the sequential wording gone from invoke_reviewers (#2194)', 'gsd-core/workflows/review.md', inStepOf('invoke_reviewers', erase(/sequential|in sequence|not in parallel/gi)), 'review-timeout-guidance', /must state that lanes run sequentially/],
    ['the timeout guidance gone from invoke_reviewers (#2194)', 'gsd-core/workflows/review.md', inStepOf('invoke_reviewers', erase(/timeout/gi)), 'review-timeout-guidance', /must carry Bash timeout guidance/],
    ['the high millisecond value gone from invoke_reviewers (#2194)', 'gsd-core/workflows/review.md', inStepOf('invoke_reviewers', erase(/900000|1200000/g)), 'review-timeout-guidance', /recommend a high ms value/],
    ['the timeout-not-crash framing gone from invoke_reviewers (#2194)', 'gsd-core/workflows/review.md',
      inStepOf('invoke_reviewers', erase(/timeout[^\n]{1,500}not[^\n]{1,500}crash|not a crash/gi)), 'review-timeout-guidance', /distinguish a timeout kill from a crash/],
    // quick-planner-scope-guard
    ['the planner dispatch gone from quick.md (#3786)', 'gsd-core/workflows/quick.md', eraseAll('subagent_type="gsd-planner"'), 'quick-planner-scope-guard', /must dispatch the gsd-planner agent/],
    ['live observation gone from the planner constraints (#3786)', 'gsd-core/workflows/quick.md',
      inPlannerConstraints(erase(/live observation/gi)), 'quick-planner-scope-guard', /must be live-observed or kept conditional/],
    ['conditional gone from the planner constraints (#3786)', 'gsd-core/workflows/quick.md',
      inPlannerConstraints(erase(/conditional/gi)), 'quick-planner-scope-guard', /must be live-observed or kept conditional/],
    ['"may guide investigation only" gone from the planner constraints (#3786)', 'gsd-core/workflows/quick.md',
      inPlannerConstraints(erase(/may guide investigation only/gi)), 'quick-planner-scope-guard', /labeled investigation-only/],
    ['the fresh-merge-index command gone from the planner constraints (#3786)', 'gsd-core/workflows/quick.md',
      inPlannerConstraints(eraseAll('git diff --name-only --diff-filter=U')), 'quick-planner-scope-guard', /fresh-merge-index command/],
    ['the planner constraints block closed before its dispatch is missing (#3786)', 'gsd-core/workflows/quick.md',
      (text) => text.split('<constraints>').join('<limits>'), 'quick-planner-scope-guard', /must contain the planner <constraints> block/],
    // roadmapper-contract-guard
    ['approve-first phrasing back in the roadmapper (#3797)', 'agents/gsd-roadmapper.md', append('Return structured draft for user approval'), 'roadmapper-contract-guard', /approve-first phrasing must not return/],
    ['the Awaiting / Approve footer back in the roadmapper (#3797)', 'agents/gsd-roadmapper.md', append('Awaiting / Approve roadmap'), 'roadmapper-contract-guard', /Awaiting \/ Approve output footer/],
    ['a ROADMAP DRAFT header back in the roadmapper (#3797)', 'agents/gsd-roadmapper.md', append('## ROADMAP DRAFT'), 'roadmapper-contract-guard', /DRAFT header matches no orchestrator branch/],
    ['the write-first checklist line gone from the roadmapper (#3797)', 'agents/gsd-roadmapper.md', eraseAll('Files written immediately'), 'roadmapper-contract-guard', /must pin the write-first ordering/],
    ['the Step 7 heading changed in the roadmapper (#3797)', 'agents/gsd-roadmapper.md', eraseAll('## Step 7: Write Files Immediately'), 'roadmapper-contract-guard', /write-first execution flow is the intended contract/],
    ['"(after approval)" back in the roadmapper (#3797)', 'agents/gsd-roadmapper.md', append('Files written (after approval)'), 'roadmapper-contract-guard', /must not claim files are written after an approval/],
    ['the Step 9 revision heading gone from the roadmapper (#3797)', 'agents/gsd-roadmapper.md', eraseAll('## Step 9: Handle Revision (if needed)'), 'roadmapper-contract-guard', /reactive revision \(Step 9\) stays/],
    // untrusted-input-isolation
    ...[
      [/<security_context>/g, /must carry the <security_context> block/], [/treated as data/gi, /treated as data/],
      [/never as instructions/gi, /never treated as instructions|never as instructions|never treated/], [/random|fresh|unique|nonce/gi, /fresh\/random delimiter/],
      [/DATA_/g, /DATA_ marker pattern/],
      [/inspect|scan.{0,30}before|act as.{0,30}guard|self.{0,10}guard|self.{0,10}scan/gi, /self-inspect content/],
      [/only.{0,40}(?:your|the).{0,20}(?:task|assignment)|assigned task|not tied to/gi, /act only on their assigned task/],
    ].map(([pattern, why]) => [`${pattern} gone from the untrusted-input boundary`, BOUNDARY, erase(pattern), 'untrusted-input-isolation', why]),
    ...INGEST.map((name) => [`${name} no longer @-includes the untrusted-input boundary`, `agents/${name}.md`,
      eraseAll('references/untrusted-input-boundary.md'), 'untrusted-input-isolation', new RegExp(`${name} must @-include the untrusted-input-boundary reference`)]),
    // verifier-spotcheck-test-discipline
    ['the Step 7c heading renamed, so Step 7b has no end (#25)', VERIFIER, eraseAll('## Step 7c'), 'verifier-spotcheck-test-discipline', /closing marker .* not found/],
    ['the Step 7b heading renamed (#25)', VERIFIER, eraseAll('## Step 7b'), 'verifier-spotcheck-test-discipline', /marker .*Step 7b.* not found/],
    ['the full-suite grep example back in Step 7b (#25)', VERIFIER,
      (text) => text.replace('## Step 7c', 'npm test -- --grep "$PHASE_TEST_PATTERN" 2>&1 | grep -q "passing"\n## Step 7c'), 'verifier-spotcheck-test-discipline', /example must stay removed/],
    ...[
      [/cargo test -- --list/g, /cargo test -- --list/], [/pytest --collect-only/g, /pytest enumeration/], [/vitest list/g, /vitest enumeration/],
      [/go test -list/g, /go enumeration/], [/-- --exact/g, /cargo single-named-test form/], [/pytest -k/g, /pytest single-named-test form/],
      [/vitest run -t/g, /vitest single-named-test form/], [/at most once per verification/gi, /more than once per verification/],
      [/grep/gi, /full-suite grep anti-pattern/], [/per must-have|per truth/gi, /per must-have/],
    ].map(([pattern, why]) => [`${pattern} gone from Step 7b`, VERIFIER, within('## Step 7b', '## Step 7c', erase(pattern)), 'verifier-spotcheck-test-discipline', why]),
    // ci-durations-upload-nonfatal
    ['a test-timings upload made fatal (#6144)', '.github/workflows/test.yml',
      yamlEdit((wf) => { stepsOf(wf, 'test-timings-')[0]['continue-on-error'] = false; }), 'ci-durations-upload-nonfatal', /every test-timings upload step must be continue-on-error: true/],
    ['a third test-timings upload added (#6144)', '.github/workflows/test.yml',
      yamlEdit((wf) => {
        const [first] = stepsOf(wf, 'test-timings-');
        const job = Object.values(wf.jobs).find((candidate) => (candidate.steps || []).includes(first));
        job.steps.push({ ...first, with: { ...first.with, name: 'test-timings-extra' } });
      }), 'ci-durations-upload-nonfatal', /exactly two test-timings upload steps must exist/],
    ['a test-timings upload gone (#6144)', '.github/workflows/test.yml',
      yamlEdit((wf) => {
        const [first] = stepsOf(wf, 'test-timings-');
        const job = Object.values(wf.jobs).find((candidate) => (candidate.steps || []).includes(first));
        job.steps.splice(job.steps.indexOf(first), 1);
      }), 'ci-durations-upload-nonfatal', /exactly two test-timings upload steps must exist/],
    ['the coverage upload made lenient (#6144)', '.github/workflows/test.yml',
      yamlEdit((wf) => { stepsOf(wf, 'coverage-tmp-shard-')[0]['continue-on-error'] = true; }), 'ci-durations-upload-nonfatal', /compacted-coverage upload must stay fatal/],
    ['the coverage upload gone (#6144)', '.github/workflows/test.yml',
      yamlEdit((wf) => {
        for (const job of Object.values(wf.jobs)) job.steps = (job.steps || []).filter((step) => !(step.with && String(step.with.name).startsWith('coverage-tmp-shard-')));
      }), 'ci-durations-upload-nonfatal', /no coverage upload step found/],
    // dependency-advisory-floors
    ['re2js locked one patch below its floor (#5840)', 'package-lock.json', withLockVersion('node_modules/re2js', '2.8.6'), 'dependency-advisory-floors', /node_modules\/re2js is locked at 2\.8\.6, below the patched 2\.8\.7/],
    ['@hono/node-server locked one patch below its floor (#5840)', 'package-lock.json', withLockVersion('node_modules/@hono/node-server', '2.1.2'), 'dependency-advisory-floors', /node_modules\/@hono\/node-server is locked at 2\.1\.2, below the patched 2\.1\.3/],
    ['the re2js entry gone from the lockfile (#5840)', 'package-lock.json',
      (text) => { const lock = JSON.parse(text); delete lock.packages['node_modules/re2js']; return JSON.stringify(lock, null, 2); }, 'dependency-advisory-floors', /package-lock\.json has no entry for node_modules\/re2js/],
    ['the lockfile no longer valid JSON (#5840)', 'package-lock.json', (text) => `${text}}`, 'dependency-advisory-floors', /package-lock\.json is not valid JSON/],
    // context7: an agent with neither grant is untouched (control below)
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

  // Controls and boundaries of the batch-7 contracts.
  const passes = (title, rel, edit, contract) => test(title, (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, ...rel.split('/'));
    fs.writeFileSync(abs, edit(fs.readFileSync(abs, 'utf8')));
    assert.deepEqual(runShipped(root, [contract]), []);
  });
  const findsOne = (title, rel, edit, contract, expected) => test(title, (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, ...rel.split('/'));
    fs.writeFileSync(abs, edit(fs.readFileSync(abs, 'utf8')));
    const findings = runShipped(root, [contract]);
    assert.equal(findings.length, 1, JSON.stringify(findings));
    // A string is matched literally (no regex is built from data); a RegExp is matched as given.
    if (typeof expected === 'string') assert.ok(findings[0].message.includes(expected), `expected "${expected}" in ${findings[0].message}`);
    else assert.match(findings[0].message, expected);
  });

  passes('an agent granting neither context7 form satisfies context7-plugin-grant-parity', 'agents/gsd-advisor-researcher.md',
    (text) => text.split('\n').map((line) => (/^tools:/.test(line) ? line.split('mcp__plugin_context7_context7__*').join('').split('mcp__context7__*').join('') : line)).join('\n'),
    'context7-plugin-grant-parity');
  passes('an agent granting only the plugin form satisfies context7-plugin-grant-parity', 'agents/gsd-advisor-researcher.md',
    (text) => text.split('\n').map((line) => (/^tools:/.test(line) ? line.split('mcp__context7__*').join('') : line)).join('\n'),
    'context7-plugin-grant-parity');
  passes('an unbalanced <step> inside a code fence does not count for workflow-step-tag-balance', 'gsd-core/workflows/plan-phase.md',
    (text) => `${text}\n\`\`\`\n</step>\n\`\`\`\n`, 'workflow-step-tag-balance');
  passes('an unbalanced </step> in a nested workflow file is outside workflow-step-tag-balance (top-level only)', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
    (text) => `${text}\n</step>\n`, 'workflow-step-tag-balance');
  passes('a second <constraints> block after the planner dispatch is not the planner block for quick-planner-scope-guard', 'gsd-core/workflows/quick.md',
    (text) => `${text}\n<constraints>\nnothing\n</constraints>\n`, 'quick-planner-scope-guard');

  // The Input: exemplar floor is two: one fails, two passes.
  for (const name of ['gsd-doc-classifier', 'gsd-doc-synthesizer']) {
    findsOne(`${name} with one Input: exemplar fails extraction-discipline-consistency`, `agents/${name}.md`, keepInputs(1), 'extraction-discipline-consistency', /needs at least 2 exemplars .*found 1/);
    passes(`${name} with two Input: exemplars satisfies extraction-discipline-consistency`, `agents/${name}.md`, keepInputs(2), 'extraction-discipline-consistency');
  }

  // The lockfile floors are inclusive: floor - 1 fails, the floor and above pass.
  for (const [pkg, floor, below, above] of [['node_modules/re2js', '2.8.7', '2.8.6', '2.8.8'], ['node_modules/@hono/node-server', '2.1.3', '2.1.2', '2.2.0']]) {
    passes(`${pkg} locked at its floor ${floor} satisfies dependency-advisory-floors`, 'package-lock.json', withLockVersion(pkg, floor), 'dependency-advisory-floors');
    passes(`${pkg} locked above its floor (${above}) satisfies dependency-advisory-floors`, 'package-lock.json', withLockVersion(pkg, above), 'dependency-advisory-floors');
    findsOne(`${pkg} locked below its floor (${below}) fails dependency-advisory-floors`, 'package-lock.json', withLockVersion(pkg, below), 'dependency-advisory-floors', `${below}, below the patched ${floor}`);
  }

  // The planner stays under 50000 characters: 49999 passes, 50000 and 50001 fail.
  for (const [length, ok] of [[49999, true], [50000, false], [50001, false]]) {
    test(`the planner at ${length} characters ${ok ? 'satisfies' : 'fails'} reachability-check`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'agents', 'gsd-planner.md');
      const text = fs.readFileSync(abs, 'utf8');
      assert.ok(!text.includes('\r') && text.length < 49999, 'the real planner leaves room to pad to the boundary');
      fs.writeFileSync(abs, text + 'x'.repeat(length - text.length));
      const findings = runShipped(root, ['reachability-check']);
      assert.equal(findings.length, ok ? 0 : 1, JSON.stringify(findings));
    });
  }

  // The bounds of the batch-7 patterns: limit - 1 and limit are matched, limit + 1 is the stated edge.
  const gapCases = (label, rel, contract, build, limit, whyMatch) => {
    for (const [gap, ok] of [[limit - 1, true], [limit, true], [limit + 1, false]]) {
      test(`${label} with a gap of ${gap} characters ${ok ? 'satisfies' : 'is past the bound of'} ${contract}`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, ...rel.split('/'));
        const text = fs.readFileSync(abs, 'utf8');
        const after = build(text, gap);
        assert.notEqual(after, text);
        fs.writeFileSync(abs, after);
        const findings = runShipped(root, [contract]);
        if (ok) assert.deepEqual(findings, []);
        else assert.ok(findings.some((f) => whyMatch.test(f.message)), JSON.stringify(findings));
      });
    }
  };
  gapCases('rev-list and --count', 'gsd-core/workflows/execute-phase.md', 'execute-phase-branch-base-ahead-warning',
    (text, gap) => `${text.replace(/rev-list[^\n]{0,500}--count[^\n]{0,500}DEFAULT_BRANCH/gi, '')}\nrev-list${'x'.repeat(gap)}--count DEFAULT_BRANCH\n`, 500, /must check if local \$DEFAULT_BRANCH is ahead/);
  gapCases('"recorded verdict" and "is not a reason to omit"', VERIFIER, 'verifier-harvest-recorded-verdict',
    (text, gap) => text.replace(/recorded verdict[^\n]{0,500}is not a reason to omit/gi, `recorded verdict${'x'.repeat(gap)}is not a reason to omit`), 500, /must not be a reason to omit the check/);
  gapCases('<expected> and "unmodified"', VERIFIER, 'verifier-harvest-recorded-verdict',
    // Step 8 names <expected> twice on one line; the first is neutralised so the gap is measured from the one before "unmodified".
    (text, gap) => within('## Step 8: Identify Human Verification Needs', '\n## Step 9', (section) => {
      const unmodified = section.indexOf('unmodified');
      const start = section.lastIndexOf('<expected>', unmodified);
      return `${section.slice(0, start).split('<expected>').join('<exp>')}<expected>${'x'.repeat(gap)}${section.slice(unmodified)}`;
    })(text), 500, /must be carried through unmodified/);
  gapCases('whitespace inside "not a standalone accuracy guarantee"', UI_CHECKER, 'ui-checker-adversarial-stance',
    (text, gap) => text.replace(/not\s+a\s+standalone\s+accuracy\s+guarantee/gi, `not${' '.repeat(gap)}a standalone accuracy guarantee`), 20, /missing limitation on persona efficacy claim/);
  for (const [first, second, ok] of [[500, 500, true], [499, 499, true], [501, 500, false], [500, 501, false]]) {
    test(`a timeout-not-crash line with gaps of ${first} and ${second} characters ${ok ? 'satisfies' : 'is past the bound of'} review-timeout-guidance`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'review.md');
      const text = fs.readFileSync(abs, 'utf8');
      const edited = inStepOf('invoke_reviewers', (step) => `${step.replace(/timeout[^\n]{1,500}not[^\n]{1,500}crash|not a crash/gi, '')}\ntimeout${'x'.repeat(first)}not${'y'.repeat(second)}crash\n`)(text);
      fs.writeFileSync(abs, edited);
      const findings = runShipped(root, ['review-timeout-guidance']);
      if (ok) assert.deepEqual(findings, []);
      else assert.ok(findings.some((f) => /distinguish a timeout kill from a crash/.test(f.message)), JSON.stringify(findings));
    });
  }

  // The other gap of rev-list ... --count ... DEFAULT_BRANCH, and both gaps of the ahead ... origin ... DEFAULT_BRANCH alternative
  // (with its `unpushed` alternative removed, so only the ahead pattern can satisfy the warning assertion).
  gapCases('--count and DEFAULT_BRANCH', 'gsd-core/workflows/execute-phase.md', 'execute-phase-branch-base-ahead-warning',
    (text, gap) => `${text.replace(/rev-list[^\n]{0,500}--count[^\n]{0,500}DEFAULT_BRANCH/gi, '')}\nrev-list x--count${'y'.repeat(gap)}DEFAULT_BRANCH\n`, 500, /must check if local \$DEFAULT_BRANCH is ahead/);
  const withoutUnpushed = (text) => text.replace(/unpushed/gi, 'unp').replace(/ahead[^\n]{0,500}origin[^\n]{0,500}DEFAULT_BRANCH/gi, '');
  gapCases('ahead and origin', 'gsd-core/workflows/execute-phase.md', 'execute-phase-branch-base-ahead-warning',
    (text, gap) => `${withoutUnpushed(text)}\nrev-list x--count y DEFAULT_BRANCH\nahead${'x'.repeat(gap)}origin y DEFAULT_BRANCH\n`, 500, /must warn that local commits are ahead\/unpushed/);
  gapCases('origin and DEFAULT_BRANCH (ahead pattern)', 'gsd-core/workflows/execute-phase.md', 'execute-phase-branch-base-ahead-warning',
    (text, gap) => `${withoutUnpushed(text)}\nrev-list x--count y DEFAULT_BRANCH\nahead x origin${'y'.repeat(gap)}DEFAULT_BRANCH\n`, 500, /must warn that local commits are ahead\/unpushed/);

  // Each of the four whitespace gaps of "not a standalone accuracy guarantee" is bounded at 20.
  for (const slot of [1, 2, 3, 4]) {
    gapCases(`whitespace gap ${slot + 1} of "not a standalone accuracy guarantee"`, UI_CHECKER, 'ui-checker-adversarial-stance',
      (text, gap) => text.replace(/not\s+a\s+standalone\s+accuracy\s+guarantee/gi, ['not', 'a', 'standalone', 'accuracy', 'guarantee']
        .reduce((joined, word, i) => (i === 0 ? word : `${joined}${' '.repeat(i === slot ? gap : 1)}${word}`), '')), 20, /missing limitation on persona efficacy claim/);
  }

  // The arrow form of an exemplar (`Input -> ...`) tolerates 20 whitespace characters; no real agent uses it, so the file is rewritten to it.
  for (const name of ['gsd-doc-classifier', 'gsd-doc-synthesizer']) {
    for (const [gap, ok] of [[19, true], [20, true], [21, false]]) {
      test(`${name} with arrow exemplars ${gap} whitespace characters after Input ${ok ? 'satisfies' : 'is past the bound of'} extraction-discipline-consistency`, (t) => {
        const root = copyOfRepoFiles(t);
        const abs = path.join(root, 'agents', `${name}.md`);
        const text = fs.readFileSync(abs, 'utf8').replace(/\bInput:/gi, 'Case:');
        fs.writeFileSync(abs, `${text}\nInput${' '.repeat(gap)}-> first\nInput${' '.repeat(gap)}-> second\n`);
        const findings = runShipped(root, ['extraction-discipline-consistency']);
        if (ok) assert.deepEqual(findings, []);
        else assert.ok(findings.some((f) => /missing few-shot Input->Output exemplars/.test(f.message)), JSON.stringify(findings));
      });
    }
  }

  // The semver comparison parses each component as a number: multi-digit components order numerically, a prerelease tag fails closed.
  passes('re2js locked at a multi-digit patch above its floor (2.8.10) satisfies dependency-advisory-floors', 'package-lock.json',
    withLockVersion('node_modules/re2js', '2.8.10'), 'dependency-advisory-floors');
  passes('re2js locked at a multi-digit minor above its floor (2.10.0) satisfies dependency-advisory-floors', 'package-lock.json',
    withLockVersion('node_modules/re2js', '2.10.0'), 'dependency-advisory-floors');
  findsOne('re2js locked at a prerelease of its floor (2.8.7-rc.1) fails closed in dependency-advisory-floors', 'package-lock.json',
    withLockVersion('node_modules/re2js', '2.8.7-rc.1'), 'dependency-advisory-floors', /locked at 2\.8\.7-rc\.1, below the patched 2\.8\.7/);

  test('compareSemver orders any two numeric versions as a tuple comparison (property)', () => {
    const fc = require('fast-check');
    const { compareSemver } = require('../scripts/static-checks/text-contracts/dependency-advisory-floors.cjs');
    const version = fc.tuple(fc.nat(1000), fc.nat(1000), fc.nat(1000));
    fc.assert(fc.property(version, version, (a, b) => {
      const expected = Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      return Math.sign(compareSemver(a.join('.'), b.join('.'))) === expected && Math.sign(compareSemver(b.join('.'), a.join('.'))) === -expected;
    }), { numRuns: 200 });
  });

  test('gsd-core/references/verify-mvp-mode.md removed from the tree is a finding for verifier-mvp-section', (t) => {
    const root = copyOfRepoFiles(t);
    fs.unlinkSync(path.join(root, 'gsd-core', 'references', 'verify-mvp-mode.md'));
    assert.ok(runShipped(root, ['verifier-mvp-section']).some((f) => /verify-mvp-mode\.md must exist/.test(f.message)));
  });

  test(`${BOUNDARY} removed from the tree is a finding for untrusted-input-isolation`, (t) => {
    const root = copyOfRepoFiles(t);
    fs.unlinkSync(path.join(root, ...BOUNDARY.split('/')));
    assert.ok(runShipped(root, ['untrusted-input-isolation']).some((f) => /untrusted-input-boundary\.md must exist/.test(f.message)));
  });

  // A file one of the batch-7 contracts reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    [UI_CHECKER, 'ui-checker-adversarial-stance'], ['gsd-core/workflows/execute-phase.md', 'execute-phase-branch-base-ahead-warning'],
    [VERIFIER, 'verifier-harvest-recorded-verdict'], ['gsd-core/references/checkpoints.md', 'verifier-harvest-recorded-verdict'],
    ['gsd-core/workflows/settings-advanced.md', 'workflow-step-tag-balance'], ['package-lock.json', 'dependency-advisory-floors'],
    ['agents/gsd-doc-classifier.md', 'extraction-discipline-consistency'], ['.github/workflows/test.yml', 'ci-durations-upload-nonfatal'],
    ['agents/gsd-planner.md', 'reachability-check'], ['gsd-core/workflows/review.md', 'review-timeout-guidance'],
    ['gsd-core/workflows/quick.md', 'quick-planner-scope-guard'], ['agents/gsd-roadmapper.md', 'roadmapper-contract-guard'],
    ['agents/gsd-assumptions-analyzer.md', 'untrusted-input-isolation'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract} (batch 7)`, (t) => {
      const root = copyOfRepoFiles(t);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }

  // The five batch-6 contracts.
  const AUDIT_READER = 'v{version}-MILESTONE-AUDIT.md';
  const WRITER_LINE = 'Create `${PLANNING_ROOT}/v{version}-MILESTONE-AUDIT.md` with:';
  const PROBE = '[ -f .planning/current-agent-id.txt ]';
  const CLEAR = 'rm -f .planning/current-agent-id.txt';
  // The text of the init_agent_tracking step, edited and put back.
  const inTrackingStep = (edit) => (text) => {
    const open = '<step name="init_agent_tracking">';
    const at = text.indexOf(open);
    const close = text.indexOf('</step>', at);
    return text.slice(0, at) + edit(text.slice(at, close)) + text.slice(close);
  };
  // The file with only `keep` readers of the report filename left outside the writer line.
  const withReaders = (keep) => (text) => {
    let total = text.split(AUDIT_READER).length - 1;
    return text.split('\n').map((line) => {
      if (line === WRITER_LINE) return line;
      let out = line;
      while (total > keep && out.includes(AUDIT_READER)) {
        out = out.replace(AUDIT_READER, 'v{version}-AUDIT.md');
        total -= 1;
      }
      return out;
    }).join('\n');
  };
  const HANDOFF_FILES = [
    ['commands/gsd/new-project.md', '/gsd:'], ['skills/gsd-new-project/SKILL.md', '/gsd-'],
    ['pi/package-skills/gsd-new-project/SKILL.md', '/skill:gsd-'], ['commands/gsd/new-milestone.md', '/gsd:'],
    ['skills/gsd-new-milestone/SKILL.md', '/gsd-'], ['pi/package-skills/gsd-new-milestone/SKILL.md', '/skill:gsd-'],
  ];
  for (const [title, rel, edit, contract, expected] of [
    ['a doubled version segment back in audit-milestone (#3796)', 'gsd-core/workflows/audit-milestone.md',
      append('v{version}-v{version}-MILESTONE-AUDIT.md'), 'audit-milestone-filename-guard', /no doubled version segment may appear/],
    ['the writer line back at a root .planning/ path (#5861)', 'gsd-core/workflows/audit-milestone.md',
      swap(WRITER_LINE, 'Create `.planning/v{version}-MILESTONE-AUDIT.md` with:'), 'audit-milestone-filename-guard', /the writer line must create exactly/],
    ['the audit-milestone readers gone (#3796)', 'gsd-core/workflows/audit-milestone.md',
      withReaders(0), 'audit-milestone-filename-guard', /found 1, expected at least 5/],
    ['git checkout -b from origin/$DEFAULT_BRANCH without --no-track added to plan-phase (#2498)', 'gsd-core/workflows/plan-phase.md',
      append('git checkout -b gsd/new origin/$DEFAULT_BRANCH'), 'branch-no-track-guard', /needs --no-track/],
    ['a tab-separated git checkout -b from origin/$BASE_BRANCH added to execute-plan (#2498)', 'gsd-core/workflows/execute-plan.md',
      append('git\tcheckout\t-b gsd/new origin/$BASE_BRANCH'), 'branch-no-track-guard', /needs --no-track/],
    ['a git checkout -b from origin/$MAIN_BRANCH added to a nested workflow file (#2498)', 'gsd-core/workflows/plan-phase/steps/auto-advance-check.md',
      append('git checkout -b gsd/new origin/$MAIN_BRANCH'), 'branch-no-track-guard', /line \d+: git checkout -b gsd\/new origin\/\$MAIN_BRANCH/],
    ['the interrupted-agent probe gone from the tracking step (#3795)', 'gsd-core/workflows/execute-plan.md',
      dropAll(PROBE), 'execute-plan-interrupted-agent-guard', /must probe for a surviving current-agent-id\.txt/],
    ['the stale-id clear gone from the tracking step (#3795)', 'gsd-core/workflows/execute-plan.md',
      dropAll(CLEAR), 'execute-plan-interrupted-agent-guard', /must clear the stale id for the fresh run/],
    ['the clear ahead of the probe in the tracking step (#3795)', 'gsd-core/workflows/execute-plan.md',
      (text) => text.split(PROBE).join('@@').split(CLEAR).join(PROBE).split('@@').join(CLEAR), 'execute-plan-interrupted-agent-guard', /existence check must run BEFORE the rm/],
    ['INTERRUPTED_ID no longer captured (#3795)', 'gsd-core/workflows/execute-plan.md',
      swap('INTERRUPTED_ID=$(', 'SEEN=$('), 'execute-plan-interrupted-agent-guard', /surviving id must be captured/],
    ['the resume prompt gone from the tracking step (#3795)', 'gsd-core/workflows/execute-plan.md',
      inTrackingStep((block) => block.split('resume').join('restart')), 'execute-plan-interrupted-agent-guard', /resume-or-fresh prompt/],
    ['the tracking step renamed (#3795)', 'gsd-core/workflows/execute-plan.md',
      swap('<step name="init_agent_tracking">', '<step name="track">'), 'execute-plan-interrupted-agent-guard', /marker .*init_agent_tracking.* not found/],
    ['the preliminary verification check gone from transition (#1522)', 'gsd-core/workflows/transition.md',
      (text) => text.replace(/preliminary check blocks obviously unresolved verification/gi, 'a check'), 'transition-verification-gate', /preliminary check must block obviously unresolved verification/],
    ['fail-closes gone from transition (#1522)', 'gsd-core/workflows/transition.md',
      (text) => text.replace(/fail-closes/gi, 'fails'), 'transition-verification-gate', /phase\.complete must fail-close/],
    ['the authoritative stale-aware gate gone from transition (#1522)', 'gsd-core/workflows/transition.md',
      (text) => text.replace(/authoritative stale-aware gate/gi, 'gate'), 'transition-verification-gate', /authoritative stale-aware gate must be named/],
    ['the canonical `passed` requirement gone from transition (#1522)', 'gsd-core/workflows/transition.md',
      (text) => text.replace(/canonical verification\s+status is `passed`/gi, 'verification is fine'), 'transition-verification-gate', /canonical verification status must be required/],
    ['"does NOT block transition" back in transition (#1522)', 'gsd-core/workflows/transition.md',
      append('Unresolved verification does NOT block transition.'), 'transition-verification-gate', /must not be described as not blocking/],
    ['"carry forward as debt" back in transition (#1522)', 'gsd-core/workflows/transition.md',
      append('Unresolved items carry forward as debt.'), 'transition-verification-gate', /must not be carried forward as debt/],
    ...HANDOFF_FILES.map(([rel, prefix]) => [`${prefix}execute-phase gone from the hand-off of ${rel} (#5723)`, rel,
      swap(`${prefix}execute-phase`, `${prefix}run-phase`), 'handoff-next-step', /execute-phase does not follow/]),
    ['the hand-off of new-project no longer names discuss-phase (#5723)', 'commands/gsd/new-project.md',
      swap('/gsd:discuss-phase', '/gsd:zzz-phase'), 'handoff-next-step', /does not name \/gsd:discuss-phase/],
    ['the hand-off of new-project no longer names plan-phase after discuss-phase (#5723)', 'commands/gsd/new-project.md',
      swap('/gsd:plan-phase', '/gsd:zzz-phase'), 'handoff-next-step', /\/gsd:plan-phase does not follow \/gsd:discuss-phase/],
    ['fail-closes only ahead of the first phase.complete in transition (#1522)', 'gsd-core/workflows/transition.md',
      (text) => `fail-closes\n${text.replace(/fail-closes/gi, 'fails')}`, 'transition-verification-gate', /expected "fail-closes" after "phase\.complete"/],
    ['the hand-off of new-project says it starts execution (#5723)', 'commands/gsd/new-project.md',
      (text) => text.replace('**After this command:**', '**After this command:** This starts execution.'), 'handoff-next-step', /says it starts execution/],
    ['the hand-off of new-project loses "to execute." (#5723)', 'commands/gsd/new-project.md',
      swap(' to execute.', ' now.'), 'handoff-next-step', /is not followed by "to execute\."/],
    ['a second hand-off line in new-milestone (#5723)', 'commands/gsd/new-milestone.md',
      append('**After:** also run something'), 'handoff-next-step', /2 hand-off lines, expected exactly one/],
    ['the hand-off of new-milestone gone (#5723)', 'commands/gsd/new-milestone.md',
      (text) => text.replace('**After:**', '**Next:**'), 'handoff-next-step', /0 hand-off lines, expected exactly one/],
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

  // The audit-milestone readers are a floor of five: four fails, five passes.
  for (const [keep, fails] of [[4, true], [5, false]]) {
    test(`audit-milestone with ${keep} readers of the report filename ${fails ? 'fails' : 'satisfies'} audit-milestone-filename-guard`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'audit-milestone.md');
      const text = fs.readFileSync(abs, 'utf8');
      assert.ok(text.split(AUDIT_READER).length - 1 > keep, 'the real file has more readers than the boundary, so the mutation removes some');
      fs.writeFileSync(abs, withReaders(keep)(text));
      const findings = runShipped(root, ['audit-milestone-filename-guard']);
      assert.equal(findings.length, fails ? 1 : 0, JSON.stringify(findings));
      if (fails) assert.match(findings[0].message, new RegExp(`found ${keep}, expected at least 5`));
    });
  }

  // Lines that are not a branch created from a remote-tracking ref stay clean.
  for (const line of [
    'git checkout -b gsd/new --no-track origin/$DEFAULT_BRANCH',
    'git checkout -b gsd/new origin/$BASE_BRANCH --no-track',
    'git checkout -b gsd/new "$LOCAL_BRANCH"',
    'git checkout origin/$DEFAULT_BRANCH',
    'git switch -c gsd/new origin/$DEFAULT_BRANCH',
  ]) {
    test(`a workflow with the line ${JSON.stringify(line)} still satisfies branch-no-track-guard`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'plan-phase.md');
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${line}\n`);
      assert.deepEqual(runShipped(root, ['branch-no-track-guard']), []);
    });
  }

  // The bounds of the batch-6 patterns: limit - 1 and limit are scanned, limit + 1 is the stated edge.
  const boundaryCases = [
    ['git and checkout separated by 199 spaces', 'gsd-core/workflows/plan-phase.md', `git${' '.repeat(199)}checkout -b gsd/new origin/$DEFAULT_BRANCH`, 'branch-no-track-guard', true],
    ['git and checkout separated by 200 spaces', 'gsd-core/workflows/plan-phase.md', `git${' '.repeat(200)}checkout -b gsd/new origin/$DEFAULT_BRANCH`, 'branch-no-track-guard', true],
    ['git and checkout separated by 201 spaces', 'gsd-core/workflows/plan-phase.md', `git${' '.repeat(201)}checkout -b gsd/new origin/$DEFAULT_BRANCH`, 'branch-no-track-guard', false],
    ['a remote ref variable with 199 characters before BRANCH', 'gsd-core/workflows/plan-phase.md', `git checkout -b gsd/new origin/$${'A'.repeat(199)}BRANCH`, 'branch-no-track-guard', true],
    ['a remote ref variable with 200 characters before BRANCH', 'gsd-core/workflows/plan-phase.md', `git checkout -b gsd/new origin/$${'A'.repeat(200)}BRANCH`, 'branch-no-track-guard', true],
    ['a remote ref variable with 201 characters before BRANCH', 'gsd-core/workflows/plan-phase.md', `git checkout -b gsd/new origin/$${'A'.repeat(201)}BRANCH`, 'branch-no-track-guard', false],
  ];
  for (const [title, rel, line, contract, caught] of boundaryCases) {
    test(`${title} ${caught ? 'fails' : 'is past the bound of'} ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, ...rel.split('/'));
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n${line}\n`);
      assert.equal(runShipped(root, [contract]).length, caught ? 1 : 0);
    });
  }

  // The hand-off's execute-phase span up to its closing backtick is bounded at 500 characters.
  for (const [span, ok] of [[499, true], [500, true], [501, false]]) {
    test(`a hand-off execute-phase span of ${span} characters ${ok ? 'satisfies' : 'is past the bound of'} handoff-next-step`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'commands', 'gsd', 'new-project.md');
      const text = fs.readFileSync(abs, 'utf8');
      const tail = '/gsd:execute-phase 1`';
      assert.ok(text.includes(tail), 'the real hand-off ends its execute step this way');
      fs.writeFileSync(abs, text.replace(tail, `/gsd:execute-phase${'x'.repeat(span - '/gsd:execute-phase'.length)}\``));
      const findings = runShipped(root, ['handoff-next-step']);
      assert.equal(findings.length, ok ? 0 : 1, JSON.stringify(findings));
    });
  }

  // The whitespace in "canonical verification status" is bounded at 20 characters.
  for (const [gap, ok] of [[19, true], [20, true], [21, false]]) {
    test(`${gap} whitespace characters inside "canonical verification status" ${ok ? 'satisfy' : 'are past the bound of'} transition-verification-gate`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, 'gsd-core', 'workflows', 'transition.md');
      const text = fs.readFileSync(abs, 'utf8');
      const phrase = /canonical verification\s+status is `passed`/i;
      assert.ok(phrase.test(text), 'the real file carries the phrase');
      fs.writeFileSync(abs, text.replace(phrase, `canonical verification${' '.repeat(gap)}status is \`passed\``));
      const findings = runShipped(root, ['transition-verification-gate']);
      assert.equal(findings.length, ok ? 0 : 1, JSON.stringify(findings));
    });
  }

  test('branch-no-track-guard with no workflow file under gsd-core/workflows is a finding, not a pass over nothing', (t) => {
    const root = copyOfRepoFiles(t);
    cleanup(path.join(root, 'gsd-core', 'workflows'));
    const findings = runShipped(root, ['branch-no-track-guard']);
    assert.ok(findings.some((f) => /cannot read the directory|no \.md file under gsd-core\/workflows/.test(f.message)), JSON.stringify(findings));
  });

  // A file one of the batch-6 contracts reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['gsd-core/workflows/audit-milestone.md', 'audit-milestone-filename-guard'],
    ['gsd-core/workflows/execute-plan.md', 'execute-plan-interrupted-agent-guard'],
    ['gsd-core/workflows/transition.md', 'transition-verification-gate'],
    ['skills/gsd-new-project/SKILL.md', 'handoff-next-step'],
    ['pi/package-skills/gsd-new-milestone/SKILL.md', 'handoff-next-step'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract} (batch 6)`, (t) => {
      const root = copyOfRepoFiles(t);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }

  // A file one of the batch-5 contracts reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['.github/workflows/release.yml', 'release-coverage-scope'],
    ['agents/gsd-phase-researcher.md', 'gsd-researcher-flow-diagram'],
    ['gsd-core/workflows/import.md', 'import-command'],
    ['commands/gsd/import.md', 'import-command'],
    ['gsd-core/references/gates.md', 'gates-taxonomy'],
    ['gsd-core/references/ios-scaffold.md', 'ios-scaffold-safety'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract} (batch 5)`, (t) => {
      const root = copyOfRepoFiles(t);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }

  test('a count on a heading whose title is 300 characters is past the stated 300-character bound of the pattern', (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, 'docs', 'INVENTORY.md');
    fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n## ${'t'.repeat(300)} (3 shipped)\n`);
    assert.deepEqual(runShipped(root, ['inventory-headings-countfree']), []);
  });

  // A file the contract reads that is gone from the tree is one finding for that file.
  for (const [rel, contract] of [
    ['.clinerules', 'cline-support'],
    ['docs/how-to/develop-a-capability.md', 'phase6-capability-docs'],
    ['docs/INVENTORY.md', 'inventory-headings-countfree'],
    ['.github/workflows/release.yml', 'policy-release-no-npm-self-upgrade'],
    ['agents/gsd-ui-auditor.md', 'playwright-ui-verify'],
  ]) {
    test(`${rel} removed from the tree is a finding for ${contract}`, (t) => {
      const root = copyOfRepoFiles(t);
      fs.unlinkSync(path.join(root, ...rel.split('/')));
      const findings = runShipped(root, [contract]);
      assert.ok(findings.some((f) => f.file === rel && /cannot read the file/.test(f.message)), JSON.stringify(findings));
    });
  }

  // `npm install -g` and `npm` on separate lines is not a self-upgrade: the original matched line by line.
  test('npm install -g and npm on separate lines still satisfy policy-release-no-npm-self-upgrade', (t) => {
    const root = copyOfRepoFiles(t);
    const abs = path.join(root, '.github', 'workflows', 'release.yml');
    fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n      - run: npm install -g\n        npm@latest\n`);
    assert.deepEqual(runShipped(root, ['policy-release-no-npm-self-upgrade']), []);
  });

  // The gap between `-g` and the second `npm` is bounded at 2000 characters: limit - 1 and limit are caught,
  // limit + 1 is the stated edge of the pattern.
  for (const [gap, caught] of [[1999, true], [2000, true], [2001, false]]) {
    test(`a self-upgrade line with a ${gap}-character gap after -g ${caught ? 'fails' : 'is past the bound of'} policy-release-no-npm-self-upgrade`, (t) => {
      const root = copyOfRepoFiles(t);
      const abs = path.join(root, '.github', 'workflows', 'release.yml');
      const filler = ` ${'a'.repeat(gap - 2)} `;
      assert.equal(filler.length, gap);
      fs.writeFileSync(abs, `${fs.readFileSync(abs, 'utf8')}\n      - run: npm install -g${filler}npm@latest\n`);
      const findings = runShipped(root, ['policy-release-no-npm-self-upgrade']);
      assert.equal(findings.length, caught ? 1 : 0, JSON.stringify(findings));
    });
  }

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
