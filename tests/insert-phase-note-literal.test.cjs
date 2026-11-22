'use strict';

// #6195: the update_project_state step passed the model-filled `{description}` to `state.add-roadmap-evolution --note`
// inside double quotes, so `$(...)`, backticks and `"` in a typed description were interpreted by the shell after the
// insert had already run safely. The step's own fences are RUN here with `gsd_run` stubbed to record argv; a command
// substitution in the description would create the marker file the assertions look for.

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

/** Every bash fence of the update_project_state step, in order. */
function stateFences() {
  const text = fs.readFileSync(WORKFLOW, 'utf-8');
  const open = text.indexOf('<step name="update_project_state">');
  const close = text.indexOf('</step>', open);
  assert.ok(open !== -1 && close > open, 'insert-phase.md must have an update_project_state step');
  const lines = splitLines(text.slice(open, close));
  const fences = scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1)
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  assert.equal(fences.length, 2, 'the step carries a state.patch fence and a roadmap-evolution fence');
  return fences;
}

/** Run both fences with `args` as the typed $ARGUMENTS; returns per-verb argv and whether the marker file was created. */
function runStateFences(args) {
  const dir = createTempDir('gsd-6195-');
  try {
    const log = path.join(dir, 'calls.log');
    const marker = path.join(dir, 'pwned');
    const typed = args.replaceAll('MARKER', marker);
    const calls = {};
    for (const [idx, fence] of stateFences().entries()) {
      const script = [
        'gsd_run() { shift; verb="$1"; shift; { printf "%s\\n" "$verb"; printf "%s\\n" "$@"; printf "\\0"; } >> "$CALLS"; }',
        fence.replace('$ARGUMENTS', () => typed).replace(/\{decimal_phase\}/g, '72.1'),
      ].join('\n');
      const res = runHook('-c', [script], { interpreter: 'bash', cwd: dir, env: { ...process.env, CALLS: log } });
      assert.equal(res.exitCode, 0, `fence ${idx}: ${res.stderr}`);
    }
    const raw = fs.readFileSync(log, 'utf8');
    for (const rec of raw.split('\0').filter(Boolean)) {
      const [verb, ...argv] = rec.split('\n');
      calls[verb] = argv.slice(0, argv[argv.length - 1] === '' ? -1 : undefined);
    }
    return { calls, pwned: fs.existsSync(marker), marker };
  } finally {
    cleanup(dir);
  }
}

const noteOf = (calls) => {
  const argv = calls['state.add-roadmap-evolution'];
  return argv[argv.indexOf('--note') + 1];
};

/** The argument-split block (GSD_REST ... GSD_DESC) of every fence that carries one, keyed by step. */
function splitBlocks() {
  const text = fs.readFileSync(WORKFLOW, 'utf-8');
  const blocks = {};
  for (const step of ['init_context', 'insert_phase', 'update_project_state']) {
    const open = text.indexOf(`<step name="${step}">`);
    const close = text.indexOf('</step>', open);
    const lines = splitLines(text.slice(open, close));
    const start = lines.findIndex((l) => l.startsWith('GSD_REST='));
    const end = lines.findIndex((l) => l.startsWith('GSD_DESC="$*"'));
    assert.ok(start !== -1 && end > start, `${step} carries the argument split`);
    blocks[step] = lines.slice(start, end + 1).join('\n');
  }
  return blocks;
}

describe('#6195: the three argument splits of insert-phase stay one parser', () => {
  test('init_context, insert_phase and update_project_state carry the identical split', () => {
    const b = splitBlocks();
    assert.equal(b.insert_phase, b.init_context, 'phase.insert and init.phase-op must read the same split');
    assert.equal(b.update_project_state, b.init_context, 'the roadmap-evolution note must read the same split');
  });
});

describe('#6195: the roadmap-evolution note carries the typed description as literal text', () => {
  test('an ordinary description reaches --note unchanged, with the after-phase', () => {
    const { calls } = runStateFences('--insert 72 Fix critical auth bug');
    assert.equal(noteOf(calls), 'Fix critical auth bug');
    const argv = calls['state.add-roadmap-evolution'];
    assert.equal(argv[argv.indexOf('--after') + 1], '72');
    assert.equal(argv[argv.indexOf('--phase') + 1], '72.1');
  });

  test('a command substitution in the description is recorded verbatim and not executed', () => {
    const { calls, pwned } = runStateFences('--insert 72 fix $(touch MARKER) now');
    assert.equal(pwned, false, 'the substitution must not run');
    assert.match(noteOf(calls), /^fix \$\(touch .*pwned\) now$/);
  });

  test('backticks and double quotes are recorded verbatim and not executed', () => {
    const { calls, pwned } = runStateFences('--insert 72 fix `touch MARKER` and "quoted" text');
    assert.equal(pwned, false);
    assert.match(noteOf(calls), /^fix `touch .*pwned` and "quoted" text$/);
  });

  test('an unbalanced double quote does not break the command', () => {
    const { calls } = runStateFences('--insert 72 fix the "broken one');
    assert.equal(noteOf(calls), 'fix the "broken one');
  });

  test('--ws is forwarded to both state verbs and is not part of the note', () => {
    const { calls } = runStateFences('--insert --ws team1 72 Fix it');
    assert.deepEqual(calls['state.patch'].slice(0, 1), ['--ws=team1']);
    assert.deepEqual(calls['state.add-roadmap-evolution'].slice(0, 1), ['--ws=team1']);
    assert.equal(noteOf(calls), 'Fix it');
  });

  test('property: shell metacharacters in a description are carried literally and run nothing', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom('$(touch MARKER)', '`touch MARKER`', '"', "'", '$HOME', '${x}', ';', '&&', '|', '*', 'word'), { minLength: 1, maxLength: 5 }),
      (parts) => {
        const desc = parts.join(' ');
        const { calls, pwned, marker } = runStateFences(`--insert 72 ${desc}`);
        assert.equal(pwned, false);
        assert.equal(noteOf(calls), desc.replaceAll('MARKER', marker));
      },
    ), { numRuns: 15 });
  });
});
