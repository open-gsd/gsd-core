'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Coverage for the ROADMAP Progress-table / phase-entry drift guard
 * (scripts/lint-roadmap-progress-drift.cjs, epic #5692, issue #5765, ADR-2143
 * section 7).
 *
 * Behavioral throughout: assertions drive `findProgressDrift`, `scanRepo` and
 * `runPositiveControl` directly, and the CLI entry through a copy of the guard
 * placed in a temp tree. The "historic shapes" test is the red proof: it feeds the
 * guard the exact lines Phases 2 and 4 deleted, so a detector that stops matching
 * them fails here. No `readFileSync().includes()` in a test body.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const GUARD_PATH = path.join(ROOT, 'scripts', 'lint-roadmap-progress-drift.cjs');
const DRIFT_SCAN_PATH = path.join(ROOT, 'scripts', 'lib', 'drift-scan.cjs');
const guard = require(GUARD_PATH);
const { findProgressDrift, scanRepo, runPositiveControl, CLASS, MUST_FLAG, MUST_STAY_CLEAN } = guard;

const FAKE = 'src/fake.cts';

function classesOf(text, rel = FAKE) {
  return findProgressDrift(text, rel).map((d) => d.cls);
}

/** A temp tree holding a copy of the guard, so its CLI scans the temp tree. */
function guardTree(t, files) {
  const root = createTempDir('gsd-5765-');
  t.after(() => cleanup(root));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(GUARD_PATH, path.join(root, 'scripts', 'lint-roadmap-progress-drift.cjs'));
  fs.copyFileSync(DRIFT_SCAN_PATH, path.join(root, 'scripts', 'lib', 'drift-scan.cjs'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function runCli(root) {
  return childProcess.spawnSync(process.execPath, [path.join(root, 'scripts', 'lint-roadmap-progress-drift.cjs')], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
}

describe('#5765 the guard on the real tree', () => {
  test('the real tree has no hand-written Progress or phase-entry pattern', () => {
    assert.deepEqual(scanRepo(ROOT), []);
  });

  test('the built-in positive control passes', () => {
    assert.deepEqual(runPositiveControl(), []);
  });

  test('the CLI exits 0 on the real tree', () => {
    const r = childProcess.spawnSync(process.execPath, [GUARD_PATH], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ok roadmap-progress-drift/);
  });
});

describe('#5765 fixtures: every class goes red, clean code stays silent', () => {
  for (const fixture of MUST_FLAG) {
    test(`flagged as ${fixture.cls}: ${fixture.text.slice(0, 60)}`, () => {
      assert.ok(classesOf(fixture.text).includes(fixture.cls), JSON.stringify(findProgressDrift(fixture.text, FAKE)));
    });
  }

  for (const fixture of MUST_STAY_CLEAN) {
    test(`clean stays silent: ${fixture.name}`, () => {
      assert.deepEqual(findProgressDrift(fixture.text, FAKE), []);
    });
  }

  test('every class has at least one MUST_FLAG fixture', () => {
    const covered = new Set(MUST_FLAG.map((f) => f.cls));
    assert.deepEqual([...covered].sort(), Object.values(CLASS).sort());
  });
});

describe('#5765 red proof: the shapes Phases 2 and 4 deleted are flagged', () => {
  // Quoted from the removed lines of #5799 (Arm A writers) and #5800 (Arm B writers).
  const HISTORIC = [
    [CLASS.PROGRESS_HEADING, 'const progressHeadingMatch = content.match(/^##[ \\t]+Progress\\b/im);'],
    [CLASS.PROGRESS_HEADING, 'const all = [...content.matchAll(/^##[ \\t]+Progress\\b/gim)];'],
    [CLASS.PROGRESS_HEADING, 'const progressMatch = text.match(/^##[ \\t]+Progress\\b/im);'],
    [CLASS.PROGRESS_TITLE, "const BRACKET_PROGRESS_HEADING_TITLE_SRC = 'Progress\\\\b';"],
    [CLASS.PHASE_ENTRY_CHECKBOX, "new RegExp(`\\\\n?-\\\\s*\\\\[[ x]\\\\]\\\\s*.*Phase\\\\s+${padTolerant}${OPTIONAL_PHASE_TAG_SOURCE}[:\\\\s][^\\\\n]*`, 'gi'),"],
    [CLASS.PHASE_ENTRY_CHECKBOX, '/(-\\s*\\[[ x]\\]\\s*.*?Phase\\s+)(\\d+)(\\s*:|\\s+)/gi,'],
    [CLASS.PHASE_ENTRY_CHECKBOX, "new RegExp(`^(\\\\s*-\\\\s*\\\\[[ x]\\\\]\\\\s*\\\\*{0,2}Phase\\\\s+)(${PHASE_NUMBER_TOKEN_SOURCE})(\\\\s*[:\\\\s*])`, 'i')"],
    [CLASS.PHASE_ENTRY_CHECKBOX, 'for (const b of text.matchAll(/^([ \\t]*)-[ \\t]*\\[[ xX]\\][ \\t]*(?:\\*\\*[ \\t]*)?Phase[ \\t][^\\n]*$/gim)) spans.push(b);'],
  ];
  for (const [cls, line] of HISTORIC) {
    test(`${cls}: ${line.slice(0, 64)}`, () => {
      assert.ok(classesOf(line).includes(cls), JSON.stringify(findProgressDrift(line, FAKE)));
    });
  }
});

describe('#5765 owner boundary is per class, not per file', () => {
  const heading = '  const m = text.match(/^##[ \\t]+Progress\\b/im);';
  const checkbox = '  const re = /^- \\[ \\] \\*\\*Phase (\\d+)/m;';

  test('the Progress owner may spell a Progress heading', () => {
    assert.deepEqual(findProgressDrift(heading, guard.PROGRESS_OWNER), []);
  });

  test('the grammar owner may spell a phase-entry checkbox', () => {
    assert.deepEqual(findProgressDrift(checkbox, guard.GRAMMAR_OWNER), []);
  });

  test('the Progress owner may not spell a phase-entry checkbox', () => {
    assert.deepEqual(classesOf(checkbox, guard.PROGRESS_OWNER), [CLASS.PHASE_ENTRY_CHECKBOX]);
  });

  test('the grammar owner may not spell a Progress heading', () => {
    assert.deepEqual(classesOf(heading, guard.GRAMMAR_OWNER), [CLASS.PROGRESS_HEADING]);
  });

  test('a lookalike path is not an owner', () => {
    assert.deepEqual(classesOf(heading, 'src/roadmap-progress.cts.bak'), [CLASS.PROGRESS_HEADING]);
    assert.deepEqual(classesOf(heading, 'hooks/roadmap-progress.cts'), [CLASS.PROGRESS_HEADING]);
  });
});

describe('#5765 detector edges', () => {
  test('one line can carry two classes', () => {
    const line = 'const a = /^##\\s+Progress/m, b = /^Progress\\b/i;';
    assert.deepEqual(classesOf(line).sort(), [CLASS.PROGRESS_HEADING, CLASS.PROGRESS_TITLE].sort());
  });

  test('one and two backslash escape levels are both read', () => {
    assert.ok(classesOf('const a = /^##[ \\t]+Progress/m;').includes(CLASS.PROGRESS_HEADING));
    assert.ok(classesOf("const a = new RegExp('^##[ \\\\t]+Progress', 'm');").includes(CLASS.PROGRESS_HEADING));
  });

  test('CRLF input keeps one finding per violating line and 1-based line numbers', () => {
    const text = ['const ok = 1;', 'const a = /^##\\s+Progress/m;', 'const b = 2;', 'const c = /^- \\[ \\] Phase/m;', ''].join('\r\n');
    const found = findProgressDrift(text, FAKE);
    assert.deepEqual(found.map((d) => [d.line, d.cls]), [[2, CLASS.PROGRESS_HEADING], [4, CLASS.PHASE_ENTRY_CHECKBOX]]);
  });

  test('a very long line does not throw and a violation after it is still found', () => {
    const text = `const pad = "${'x'.repeat(50000)}"; const a = /^##\\s+Progress/m;`;
    assert.deepEqual(classesOf(text), [CLASS.PROGRESS_HEADING]);
  });

  test('a ROADMAP replace that names neither Progress nor a table row is not flagged', () => {
    assert.deepEqual(findProgressDrift('const out = roadmapText.replace(/\\r\\n/g, "\\n");', FAKE), []);
  });

  test('a replace on something other than ROADMAP content is not flagged', () => {
    assert.deepEqual(findProgressDrift('const out = bar.replace(machineSegment, progress);', FAKE), []);
  });
});

describe('#5765 the scan surface', () => {
  const violation = 'const m = text.match(/^##[ \\t]+Progress\\b/im);\n';

  test('scanRepo walks src and hooks and reports posix paths with 1-based lines', (t) => {
    const root = guardTree(t, {
      'src/bad.cts': `const x = 1;\n${violation}`,
      'hooks/bad-hook.js': violation,
      'src/roadmap-progress.cts': violation,
      'src/phase-entry-grammar.cts': 'const re = /^- \\[ \\] \\*\\*Phase/m;\n',
    });
    const found = scanRepo(root).map((d) => [d.file, d.line, d.cls]).sort();
    assert.deepEqual(found, [
      ['hooks/bad-hook.js', 1, CLASS.PROGRESS_HEADING],
      ['src/bad.cts', 2, CLASS.PROGRESS_HEADING],
    ]);
  });

  test('tests and scripts are outside the scan', (t) => {
    const root = guardTree(t, {
      'tests/fixture.test.cjs': violation,
      'scripts/other-lint.cjs': violation,
    });
    assert.deepEqual(scanRepo(root), []);
  });

  test('the CLI exits 1 and names file, line and class for a violating tree', (t) => {
    const root = guardTree(t, { 'src/bad.cts': violation });
    const r = runCli(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /src\/bad\.cts:1 {2}\[progress-heading\]/);
  });

  test('the CLI exits 0 for a clean tree', (t) => {
    const root = guardTree(t, { 'src/ok.cts': 'const heading = "## Progress\\n";\n' });
    const r = runCli(root);
    assert.equal(r.status, 0, r.stderr);
  });
});
