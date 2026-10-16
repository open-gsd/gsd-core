/**
 * #5473 — per-line cost attribution for a timestamp-stamped `bash -x` trace.
 *
 * The diagnostic (scripts/diagnose-validate-commit-phases.cjs) runs
 * hooks/gsd-validate-commit.sh under /bin/bash 3.2 on a macOS runner with a
 * PS4 that stamps every traced command. These tests pin the pure parser and
 * attribution that turn that trace into "which line of the hook costs the
 * time", plus one test that drives the real PS4 through a real bash.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const fc = require('fast-check');

const {
  stampPs4,
  parseTimedXtrace,
  phaseCosts,
  slowestLines,
  abbreviate,
} = require('../scripts/xtrace-phase-timing.cjs');
const {
  scenarios,
  parseArgs,
  MAX_LOAD,
  STAMP_COMMAND,
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

describe('the PS4 against a real bash', () => {
  const BASH = '/bin/bash';
  const BASH_PROBE_BOUND_MS = 10000;
  const probe = fs.existsSync(BASH) && process.platform !== 'win32'
    && spawnSync('perl', ['-e', '1'], { timeout: BASH_PROBE_BOUND_MS }).status === 0;

  test('stamps parse, timestamps never go backwards, and lines/functions are attributed', { skip: !probe && 'needs /bin/bash and perl' }, () => {
    const script = ['a=1', 'b=2', 'f() {', '  c=3', '}', 'f'].join('\n');
    const r = spawnSync(BASH, ['-x', '-c', script], {
      env: { ...process.env, PS4: stampPs4(STAMP_COMMAND, NONCE) },
      encoding: 'utf8',
      timeout: BASH_PROBE_BOUND_MS,
    });
    assert.equal(r.status, 0, r.stderr);
    const entries = parseTimedXtrace(r.stderr, NONCE);
    const byCmd = Object.fromEntries(entries.map((e) => [e.cmd, e]));
    assert.equal(byCmd['a=1'].line, 1);
    assert.equal(byCmd['b=2'].line, 2);
    assert.equal(byCmd['c=3'].fn, 'f');
    assert.equal(byCmd['a=1'].fn, '');
    entries.reduce((prev, e) => {
      assert.ok(e.t >= prev, `timestamp went backwards: ${prev} -> ${e.t}`);
      return e.t;
    }, 0);
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

  test('a command costs the gap to the next stamp, summed per source line', () => {
    const { costs, totalMs } = phaseCosts(entries);
    const byLine = Object.fromEntries(costs.map((c) => [c.line, c]));
    assert.equal(byLine[10].totalMs, 2);
    assert.equal(byLine[20].totalMs, 901);
    assert.equal(byLine[20].count, 2);
    assert.equal(byLine[20].maxMs, 900);
    assert.equal(byLine[20].sample, 'b');
    assert.equal(byLine[30].totalMs, 1);
    assert.equal(totalMs, 904);
  });

  test('the same line number in different functions is two different lines', () => {
    const { costs } = phaseCosts([
      { t: 0, line: 5, fn: '', cmd: 'x' },
      { t: 10, line: 5, fn: 'f', cmd: 'y' },
      { t: 30, line: 9, fn: '', cmd: 'end' },
    ]);
    assert.equal(costs.length, 2);
    assert.equal(costs.find((c) => c.fn === '').totalMs, 10);
    assert.equal(costs.find((c) => c.fn === 'f').totalMs, 20);
  });

  test('the last entry has no successor and costs nothing', () => {
    assert.equal(phaseCosts(entries).costs.some((c) => c.line === 40), false);
  });

  test('floorMs is the median gap: odd count, even count, single gap', () => {
    const at = (...ts) => ts.map((t, i) => ({ t, line: i, cmd: '' }));
    assert.equal(phaseCosts(at(0, 1, 3, 10)).floorMs, 2); // gaps 1,2,7 -> 2
    assert.equal(phaseCosts(at(0, 1, 3, 10, 20)).floorMs, 7); // gaps 1,2,7,10 -> upper median 7
    assert.equal(phaseCosts(at(0, 5)).floorMs, 5);
  });

  test('a clock that steps backwards is clamped to zero, never negative', () => {
    const { costs } = phaseCosts([
      { t: 50, line: 1, cmd: 'a' },
      { t: 40, line: 2, cmd: 'b' },
      { t: 41, line: 3, cmd: 'c' },
    ]);
    assert.equal(costs.find((c) => c.line === 1).totalMs, 0);
  });

  test('zero or one entry is an empty report', () => {
    assert.deepEqual(phaseCosts([]), { costs: [], floorMs: 0, totalMs: 0 });
    assert.deepEqual(phaseCosts([{ t: 1, line: 1, cmd: 'a' }]).costs, []);
  });
});

describe('slowestLines', () => {
  const costs = [
    { fn: '', line: 3, totalMs: 5 },
    { fn: '', line: 1, totalMs: 50 },
    { fn: 'f', line: 1, totalMs: 50 },
    { fn: '', line: 4, totalMs: 1 },
  ];

  test('costliest first, ties by function then line, bounded by n', () => {
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

describe('diagnose-validate-commit-phases CLI surface', () => {
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
        const text = entries
          .map((e) => [stamp(e.depth, e.t, e.line, e.cmd, e.fn), ...e.more].join('\n'))
          .join('\n');
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

  test('each (function, line) is charged exactly the gaps that follow ITS entries', () => {
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
        const expected = new Map();
        for (const s of steps) {
          const key = `${s.fn}:${s.line}`;
          expected.set(key, (expected.get(key) || 0) + s.gap);
        }
        const { costs } = phaseCosts(entries);
        assert.equal(costs.length, expected.size);
        for (const c of costs) assert.equal(c.totalMs, expected.get(`${c.fn}:${c.line}`));
      }),
    );
  });
});
