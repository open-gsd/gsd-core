/**
 * #5473 — per-line cost attribution for a timestamp-stamped `bash -x` trace,
 * and the diagnostic (scripts/diagnose-validate-commit-phases.cjs) built on it.
 *
 * The diagnostic runs hooks/gsd-validate-commit.sh under /bin/bash 3.2 on a
 * macOS runner with a PS4 that stamps every traced command. These tests pin the
 * pure parts: the parser and attribution, the tracing-line injection, and the
 * CLI's argument and rendering helpers. Nothing here spawns a process, so this
 * file carries no real-OS signal and stays out of the Windows/macOS conformance
 * tiers. The tests that need a real bash (the instrumentation, that a traced run
 * of the real hook equals a direct run, and the report pipeline) are in
 * tests/xtrace-phase-timing.platform.test.cjs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  TRACE_PS4_FILE,
  INJECTED_LINES,
  injectTracing,
  parseTimedXtrace,
  shiftLines,
  phaseCosts,
  slowestLines,
  rollupByRegion,
  abbreviate,
} = require('../scripts/xtrace-phase-timing.cjs');
const {
  scenarios,
  parseArgs,
  whereCell,
  renderScenario,
  MAX_LOAD,
} = require('../scripts/diagnose-validate-commit-phases.cjs');

const NONCE = 'k3f9a1';
const stamp = (depth, t, line, cmd, fn = '', nonce = NONCE) =>
  `${'+'.repeat(depth)}@@${nonce}@@${t}@@${line}@@${fn}@@ ${cmd}`;

describe('parseTimedXtrace', () => {
  test('reads timestamp, line, depth, function and command from each stamped line', () => {
    const text = [stamp(1, 1000, 12, 'CMD=x'), stamp(2, 1005, 13, 'node -e y', 'cleanup')].join('\n');
    assert.deepEqual(parseTimedXtrace(text, NONCE), [
      { t: 1000, line: 12, depth: 1, fn: '', cmd: 'CMD=x' },
      { t: 1005, line: 13, depth: 2, fn: 'cleanup', cmd: 'node -e y' },
    ]);
  });

  test('depth boundary: 1 mark, 2 marks, 7 marks', () => {
    for (const depth of [1, 2, 7]) {
      assert.equal(parseTimedXtrace(stamp(depth, 1, 1, 'c'), NONCE)[0].depth, depth);
    }
  });

  test('folds an unstamped line into the previous command', () => {
    const text = [stamp(1, 1000, 5, "printf 'a"), "b'", stamp(1, 1010, 6, 'next')].join('\n');
    const [first, second] = parseTimedXtrace(text, NONCE);
    assert.equal(first.cmd, "printf 'a\nb'");
    assert.equal(second.cmd, 'next');
  });

  test('ignores text before the first stamp', () => {
    assert.deepEqual(parseTimedXtrace(`noise\n${stamp(1, 1, 2, 'c')}`, NONCE), [
      { t: 1, line: 2, depth: 1, fn: '', cmd: 'c' },
    ]);
  });

  test('the newline that terminates the stream is not part of the last command', () => {
    assert.equal(parseTimedXtrace(`${stamp(1, 1, 2, 'c=3')}\n`, NONCE)[0].cmd, 'c=3');
    // ...but a genuinely empty continuation line before the terminator is kept.
    assert.equal(parseTimedXtrace(`${stamp(1, 1, 2, 'c=3')}\n\n`, NONCE)[0].cmd, 'c=3\n');
  });

  test('empty input yields no entries', () => {
    assert.deepEqual(parseTimedXtrace('', NONCE), []);
  });

  test('a traced value that looks like a stamp but lacks the nonce is a continuation, not an entry', () => {
    const forged = stamp(1, 999999, 1, 'forged', '', 'wrong-nonce');
    const entries = parseTimedXtrace([stamp(1, 1, 2, 'real'), forged].join('\n'), NONCE);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].cmd.includes('forged'));
  });

  test('a nonce containing regex metacharacters is matched literally', () => {
    const entries = parseTimedXtrace(stamp(1, 1, 2, 'c', '', 'a.b+c'), 'a.b+c');
    assert.equal(entries.length, 1);
    assert.equal(parseTimedXtrace(stamp(1, 1, 2, 'c', '', 'aXb+c'), 'a.b+c').length, 0);
  });
});

describe('shiftLines', () => {
  test('moves every line back by the injected count and does not mutate its input', () => {
    const entries = [{ t: 1, line: 3, cmd: 'a' }, { t: 2, line: 10, cmd: 'b' }];
    assert.deepEqual(shiftLines(entries, 1).map((e) => e.line), [2, 9]);
    assert.deepEqual(shiftLines(entries, 0).map((e) => e.line), [3, 10]);
    assert.deepEqual(entries.map((e) => e.line), [3, 10]);
  });
});

describe('injectTracing', () => {
  const LINE = `PS4="$(cat "\${0%/*}/${TRACE_PS4_FILE}")"; set -x`;

  test('inserts exactly INJECTED_LINES lines, right after the shebang', () => {
    const out = injectTracing('#!/bin/bash\necho hi\n');
    assert.equal(out, `#!/bin/bash\n${LINE}\necho hi\n`);
    assert.equal(out.split('\n').length - '#!/bin/bash\necho hi\n'.split('\n').length, INJECTED_LINES);
  });

  test('a script with no shebang gets the line at the top', () => {
    assert.equal(injectTracing('echo hi\n'), `${LINE}\necho hi\n`);
  });

  test('boundary: empty script, shebang only, shebang without a newline', () => {
    assert.equal(injectTracing(''), `${LINE}\n`);
    assert.equal(injectTracing('#!/bin/bash\n'), `#!/bin/bash\n${LINE}\n`);
    assert.equal(injectTracing('#!/bin/bash'), `#!/bin/bash\n${LINE}\n`);
  });

  test('the stamp text is read from a file, never quoted into the injected line', () => {
    const out = injectTracing('#!/bin/bash\n');
    assert.ok(!out.includes("'"), 'no quoting of the PS4 text');
    assert.ok(!out.includes('@@'), 'the stamp text is not in the script');
  });
});

describe('phaseCosts', () => {
  const entries = [
    { t: 1000, line: 10, cmd: 'a' },
    { t: 1002, line: 20, cmd: 'b' },
    { t: 1902, line: 20, cmd: 'b2' },
    { t: 1903, line: 30, cmd: 'c' },
    { t: 1904, line: 40, cmd: 'end' },
  ];

  test('afterMs is the gap to the next stamp and beforeMs the gap from the previous one, summed per line', () => {
    const { costs, totalMs } = phaseCosts(entries);
    const byLine = Object.fromEntries(costs.map((c) => [c.line, c]));
    assert.equal(byLine[10].afterMs, 2);
    assert.equal(byLine[10].beforeMs, 0);
    assert.equal(byLine[20].afterMs, 901);
    assert.equal(byLine[20].beforeMs, 2 + 900);
    assert.equal(byLine[20].count, 2);
    assert.equal(byLine[20].maxMs, 900);
    assert.equal(byLine[30].afterMs, 1);
    assert.equal(byLine[40].afterMs, 0);
    assert.equal(byLine[40].beforeMs, 1);
    assert.equal(totalMs, 904);
  });

  test('a slow EXPANSION lands in beforeMs of its own line, a slow EXECUTION in afterMs', () => {
    // t: stamp for `x=${v//a/b}` is printed after its 800 ms expansion; `sleep` then runs 700 ms.
    const { costs } = phaseCosts([
      { t: 0, line: 1, cmd: 'start' },
      { t: 800, line: 2, cmd: 'x=expanded' },
      { t: 801, line: 3, cmd: 'sleep 1' },
      { t: 1501, line: 4, cmd: 'next' },
    ]);
    const line = (n) => costs.find((c) => c.line === n);
    assert.equal(line(2).beforeMs, 800);
    assert.equal(line(3).afterMs, 700);
  });

  test('the same line number in different functions is two different lines', () => {
    const { costs } = phaseCosts([
      { t: 0, line: 5, fn: '', cmd: 'x' },
      { t: 10, line: 5, fn: 'f', cmd: 'y' },
      { t: 30, line: 9, fn: '', cmd: 'end' },
    ]);
    assert.equal(costs.filter((c) => c.line === 5).length, 2);
    assert.equal(costs.find((c) => c.line === 5 && c.fn === '').afterMs, 10);
    assert.equal(costs.find((c) => c.line === 5 && c.fn === 'f').afterMs, 20);
  });

  test('a clock that steps backwards is clamped to zero, never negative', () => {
    const { costs } = phaseCosts([
      { t: 50, line: 1, cmd: 'a' },
      { t: 40, line: 2, cmd: 'b' },
      { t: 41, line: 3, cmd: 'c' },
    ]);
    assert.equal(costs.find((c) => c.line === 1).afterMs, 0);
    assert.equal(costs.find((c) => c.line === 2).beforeMs, 0);
  });

  test('zero or one entry has no gaps', () => {
    assert.deepEqual(phaseCosts([]), { costs: [], totalMs: 0 });
    const [only] = phaseCosts([{ t: 1, line: 1, cmd: 'a' }]).costs;
    assert.equal(only.afterMs + only.beforeMs, 0);
  });
});

describe('slowestLines', () => {
  const costs = [
    { fn: '', line: 3, afterMs: 5, beforeMs: 0 },
    { fn: '', line: 1, afterMs: 50, beforeMs: 0 },
    { fn: 'f', line: 1, afterMs: 0, beforeMs: 50 },
    { fn: '', line: 4, afterMs: 1, beforeMs: 1 },
  ];

  test('ranks by the larger attribution; ties by function then line', () => {
    assert.deepEqual(slowestLines(costs, 3).map((c) => `${c.fn}:${c.line}`), [':1', 'f:1', ':3']);
  });

  test('boundary: n = 0, 1, length - 1, length, length + 1', () => {
    assert.equal(slowestLines(costs, 0).length, 0);
    assert.equal(slowestLines(costs, 1).length, 1);
    assert.equal(slowestLines(costs, 3).length, 3);
    assert.equal(slowestLines(costs, 4).length, 4);
    assert.equal(slowestLines(costs, 5).length, 4);
  });

  test('does not mutate its input', () => {
    const before = costs.map((c) => `${c.fn}:${c.line}`);
    slowestLines(costs, 2);
    assert.deepEqual(costs.map((c) => `${c.fn}:${c.line}`), before);
  });
});

describe('rollupByRegion', () => {
  const costs = [
    { fn: '', line: 1, afterMs: 3 },
    { fn: '', line: 50, afterMs: 4 },
    { fn: '', line: 51, afterMs: 100 },
    { fn: '', line: 100, afterMs: 5 },
    { fn: '', line: 101, afterMs: 7 },
    { fn: 'cleanup', line: 2, afterMs: 9 },
  ];

  test('region boundary: lines size, size+1 and 2*size, 2*size+1 fall in the right region', () => {
    assert.deepEqual(rollupByRegion(costs, 50), [
      { label: 'lines 1-50', afterMs: 7 },
      { label: 'lines 51-100', afterMs: 105 },
      { label: 'lines 101-150', afterMs: 7 },
      { label: 'in cleanup()', afterMs: 9 },
    ]);
  });

  test('size 1 puts every line in its own region; a huge size puts the top level in one', () => {
    assert.equal(rollupByRegion(costs, 1).length, 6);
    assert.deepEqual(rollupByRegion(costs, 1000)[0], { label: 'lines 1-1000', afterMs: 119 });
  });

  test('rejects a non-positive or non-integer size', () => {
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => rollupByRegion(costs, bad), RangeError);
  });

  test('empty input is an empty roll-up', () => {
    assert.deepEqual(rollupByRegion([], 50), []);
  });
});

describe('abbreviate', () => {
  test('boundary: max - 1, max, max + 1 characters', () => {
    assert.equal(abbreviate('x'.repeat(9), 10), 'x'.repeat(9));
    assert.equal(abbreviate('x'.repeat(10), 10), 'x'.repeat(10));
    assert.equal(abbreviate('x'.repeat(11), 10), `${'x'.repeat(10)}… (11 chars)`);
  });

  test('collapses whitespace so a 112KB padded value renders on one short line', () => {
    assert.equal(abbreviate(`a${' '.repeat(112 * 1024)}b`, 100), 'a b');
  });
});

describe('diagnose-validate-commit-phases', () => {
  test('the padded scenarios carry 112KB of padding and stay under MAX_ARG_STRLEN (131072)', () => {
    const [control, withOption] = scenarios();
    for (const s of [control, withOption]) {
      assert.ok(s.command.length > 112 * 1024, `${s.name} must be over 112KB`);
      assert.ok(s.command.length < 131072, `${s.name} must stay under MAX_ARG_STRLEN`);
    }
    assert.ok(withOption.command.endsWith(' --cleanup=verbatim'));
    assert.equal(withOption.command.slice(0, control.command.length), control.command);
  });

  test('defaults and explicit values', () => {
    assert.deepEqual(parseArgs([]), { load: 0, top: 15 });
    assert.deepEqual(parseArgs(['--load', '4', '--top', '3']), { load: 4, top: 3 });
  });

  test('--load boundary: 0, 1, cap, cap + 1', () => {
    assert.equal(parseArgs(['--load', '0']).load, 0);
    assert.equal(parseArgs(['--load', '1']).load, 1);
    assert.equal(parseArgs(['--load', String(MAX_LOAD)]).load, MAX_LOAD);
    assert.throws(() => parseArgs(['--load', String(MAX_LOAD + 1)]), /capped at/);
    assert.throws(() => parseArgs(['--load', '1000000000']), /capped at/);
  });

  test('--top boundary: 0 and 1 accepted, negative and non-integer rejected', () => {
    assert.equal(parseArgs(['--top', '0']).top, 0);
    assert.equal(parseArgs(['--top', '1']).top, 1);
    assert.throws(() => parseArgs(['--top', '-1']), /non-negative integer/);
    assert.throws(() => parseArgs(['--top', '1.5']), /non-negative integer/);
  });

  test('rejects bad input', () => {
    assert.throws(() => parseArgs(['--load', 'x']), /non-negative integer/);
    assert.throws(() => parseArgs(['--load']), /non-negative integer/);
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });

  test('whereCell: a top-level line shows its source; a function line says it may be function-relative', () => {
    const source = ['first', 'second  line', 'third'];
    assert.deepEqual(whereCell({ fn: '', line: 2 }, source), { line: '2', text: 'second line' });
    assert.deepEqual(whereCell({ fn: '', line: 99 }, source), { line: '99', text: '' });
    const inFn = whereCell({ fn: 'cleanup', line: 4 }, source);
    assert.equal(inFn.line, 'cleanup():4');
    assert.match(inFn.text, /function-relative/);
  });

  test('renderScenario: an empty trace is reported loudly, not rendered as a table', () => {
    const m = {
      scenario: { name: 's', command: 'x' },
      walls: [1, 2, 3],
      last: { status: 0, signal: null, error: null },
      traced: { signal: null, error: null },
      entries: 0,
      costs: [],
      totalMs: 0,
    };
    const text = renderScenario(m, [], { top: 3 }).join('\n');
    assert.match(text, /TRACE EMPTY/);
    assert.doesNotMatch(text, /Slowest lines/);
  });

  test('renderScenario escapes backslashes and pipes in a table cell', () => {
    const m = {
      scenario: { name: 's', command: 'x' },
      walls: [1, 2, 3],
      last: { status: 0, signal: null, error: null },
      traced: { signal: null, error: null },
      entries: 1,
      costs: [{ fn: '', line: 1, afterMs: 1, beforeMs: 0, maxMs: 1, count: 1, sample: 'a\\b|c' }],
      totalMs: 1,
    };
    const text = renderScenario(m, ['x'], { top: 1 }).join('\n');
    assert.ok(text.includes('a\\\\b\\|c'), text);
  });

});

describe('property: stamped traces', () => {
  const word = fc.stringMatching(/^[a-zA-Z0-9_=\-./][a-zA-Z0-9_=\-./ ]{0,30}$/);
  // A continuation line is anything that is not a stamp for NONCE.
  const continuation = fc.stringMatching(/^[a-zA-Z0-9_=\-./ ]{0,30}$/);

  test('every field of every entry, including multi-line commands, survives serialize -> parse', () => {
    const entry = fc.record({
      t: fc.integer({ min: 0, max: 2 ** 40 }),
      line: fc.integer({ min: 1, max: 5000 }),
      depth: fc.integer({ min: 1, max: 6 }),
      fn: fc.constantFrom('', 'cleanup', 'f_1'),
      cmd: word,
      more: fc.array(continuation, { maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), (entries) => {
        // Real stderr: every line, the last included, ends with a newline.
        const text = entries
          .flatMap((e) => [stamp(e.depth, e.t, e.line, e.cmd, e.fn), ...e.more])
          .map((line) => `${line}\n`)
          .join('');
        const parsed = parseTimedXtrace(text, NONCE);
        assert.equal(parsed.length, entries.length);
        parsed.forEach((p, i) => {
          const e = entries[i];
          assert.equal(p.t, e.t);
          assert.equal(p.line, e.line);
          assert.equal(p.depth, e.depth);
          assert.equal(p.fn, e.fn);
          assert.equal(p.cmd, [e.cmd, ...e.more].join('\n'));
        });
      }),
    );
  });

  test('each (function, line) is charged exactly the gaps that follow and precede ITS entries', () => {
    const step = fc.record({
      gap: fc.integer({ min: 0, max: 500 }),
      line: fc.integer({ min: 1, max: 6 }),
      fn: fc.constantFrom('', 'f'),
    });
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        // entry i runs for steps[i].gap; a final sentinel entry closes the last gap.
        let t = 1_000_000;
        const entries = steps.map((s) => {
          const e = { t, line: s.line, fn: s.fn, cmd: '' };
          t += s.gap;
          return e;
        });
        entries.push({ t, line: 99, fn: 'end', cmd: '' });
        // Expected per (fn, line), from the construction alone: entry i is followed by
        // steps[i].gap (the sentinel by nothing) and preceded by steps[i - 1].gap.
        const expected = new Map();
        const add = (fn, line, after, before) => {
          const key = `${fn}:${line}`;
          const acc = expected.get(key) || { afterMs: 0, beforeMs: 0 };
          acc.afterMs += after;
          acc.beforeMs += before;
          expected.set(key, acc);
        };
        steps.forEach((s, i) => add(s.fn, s.line, s.gap, i > 0 ? steps[i - 1].gap : 0));
        add('end', 99, 0, steps[steps.length - 1].gap);
        const { costs } = phaseCosts(entries);
        assert.equal(costs.length, expected.size);
        for (const c of costs) {
          const want = expected.get(`${c.fn}:${c.line}`);
          assert.equal(c.afterMs, want.afterMs);
          assert.equal(c.beforeMs, want.beforeMs);
        }
      }),
    );
  });

  test('both attributions each sum to the trace span', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 20 })), { minLength: 2, maxLength: 40 }),
        (steps) => {
          let t = 1_000_000;
          const entries = steps.map(([gap, line]) => ({ t: (t += gap), line, cmd: '' }));
          const { costs, totalMs } = phaseCosts(entries);
          assert.equal(costs.reduce((s, c) => s + c.afterMs, 0), totalMs);
          assert.equal(costs.reduce((s, c) => s + c.beforeMs, 0), totalMs);
        },
      ),
    );
  });
});
