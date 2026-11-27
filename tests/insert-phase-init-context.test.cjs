'use strict';

// #5961: the insert-phase init_context fence called `init.phase-op` with an unassigned `"${after_phase}"`, so the
// verb got an empty phase and reported the phase as not found. The fence is RUN here with `gsd_run` stubbed to record
// the argv it receives; the launcher preamble line is dropped because the stub stands in for it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { runHook } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'insert-phase.md');

function stepFence(step) {
  const text = fs.readFileSync(WORKFLOW, 'utf-8');
  const open = text.indexOf(`<step name="${step}">`);
  const close = text.indexOf('</step>', open);
  assert.ok(open !== -1 && close > open, `insert-phase.md must have a ${step} step`);
  const lines = splitLines(text.slice(open, close));
  const hit = scanFencedBlocks(lines).find((b) => b.closeLineIdx !== -1);
  assert.ok(hit, 'the step carries a bash fence');
  return lines.slice(hit.openLineIdx + 1, hit.closeLineIdx).filter((l) => !l.startsWith('_GSD_SHIM_NAME=')).join('\n');
}

/** Run one step's fence with `args` as the typed $ARGUMENTS; returns the argv `verb` received. */
function verbArgv(step, verb, args) {
  const dir = createTempDir('gsd-5961-');
  try {
    const log = path.join(dir, 'argv.log');
    const fence = stepFence(step).replace('$ARGUMENTS', () => args);
    const script = [
      `gsd_run() { if [ "$1" = query ] && [ "$2" = ${verb} ]; then shift 2; printf "%s\\n" "$@" > "$ARGV"; fi; echo '{"roadmap_exists":true}'; }`,
      fence,
    ].join('\n');
    const res = runHook('-c', [script], { interpreter: 'bash', cwd: dir, env: { ...process.env, ARGV: log } });
    assert.equal(res.exitCode, 0, res.stderr);
    assert.ok(fs.existsSync(log), `${verb} was called`);
    const raw = splitLines(fs.readFileSync(log, 'utf8'));
    return raw.length && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  } finally {
    cleanup(dir);
  }
}

const phaseOpArgv = (args) => verbArgv('init_context', 'init.phase-op', args);
const insertArgv = (args) => verbArgv('insert_phase', 'phase.insert', args);

describe('#5961: insert-phase init_context passes the typed after-phase to init.phase-op', () => {
  test('an integer after-phase reaches init.phase-op, not an empty string', () => {
    assert.deepEqual(phaseOpArgv('--insert 72 Fix critical auth bug'), ['72']);
  });

  test('a decimal after-phase reaches init.phase-op', () => {
    assert.deepEqual(phaseOpArgv('--insert 15.2 Tighten the gate'), ['15.2']);
  });

  test('--ws is forwarded as a flag and is not mistaken for the after-phase', () => {
    assert.deepEqual(phaseOpArgv('--insert --ws foo 72 Fix critical auth bug'), ['--ws=foo', '72']);
    assert.deepEqual(phaseOpArgv('--ws foo --insert 72 Fix it'), ['--ws=foo', '72']);
    assert.deepEqual(phaseOpArgv('72 --ws "foo" Fix it'), ['--ws=foo', '72']);
  });

  test('a flag after the description does not change the after-phase', () => {
    assert.deepEqual(phaseOpArgv('--insert 72 Fix it --sibling'), ['72']);
  });

  test('a quoted after-phase loses its quotes, and a single-dash or leading flag is not taken for it', () => {
    assert.deepEqual(phaseOpArgv('--insert "72" Fix it'), ['72']);
    assert.deepEqual(phaseOpArgv("--insert '72' Fix it"), ['72']);
    assert.deepEqual(phaseOpArgv('--insert -x 72 Fix it'), ['72']);
  });

  test('with no after-phase typed the verb gets an empty value, never a flag', () => {
    assert.deepEqual(phaseOpArgv('--insert'), ['']);
  });

  test('$ARGUMENTS text that looks like a replacement pattern is passed through unchanged', () => {
    assert.deepEqual(insertArgv("--insert 72 Fix $& and $' it"), ['72', "Fix $& and $' it"]);
  });

  test('phase.insert receives the same after-phase and the description, from the same split', () => {
    assert.deepEqual(insertArgv('--insert 72 Fix critical auth bug'), ['72', 'Fix critical auth bug']);
    assert.deepEqual(insertArgv('--insert --ws foo 15.2 Tighten the gate'), ['15.2', 'Tighten the gate']);
    assert.deepEqual(insertArgv('--insert "72" Fix it'), ['72', 'Fix it']);
  });

  test('property: any numeric after-phase followed by a plain description is the value passed', () => {
    fc.assert(fc.property(
      fc.oneof(fc.integer({ min: 1, max: 999 }).map(String), fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 9 })).map(([a, b]) => `${a}.${b}`)),
      fc.array(fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/), { minLength: 1, maxLength: 4 }),
      fc.boolean(),
      (after, words, ws) => {
        const args = `--insert ${ws ? '--ws team1 ' : ''}${after} ${words.join(' ')}`;
        assert.deepEqual(phaseOpArgv(args), ws ? ['--ws=team1', after] : [after]);
        assert.deepEqual(insertArgv(args), [after, words.join(' ')]);
      },
    ), { numRuns: 25 });
  });
});
