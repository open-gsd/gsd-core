/**
 * #5473 — per-line cost attribution for a timestamp-stamped `bash -x` trace.
 *
 * The diagnostic (scripts/diagnose-validate-commit-phases.cjs) runs
 * hooks/gsd-validate-commit.sh under /bin/bash 3.2 on a macOS runner with a
 * PS4 that stamps every traced command. These tests pin the pure parser and
 * attribution that turn that trace into "which line of the hook costs the
 * time", with no clock and no bash involved.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  stampPs4,
  parseTimedXtrace,
  phaseCosts,
  slowestLines,
  abbreviate,
} = require('../scripts/lib/xtrace-phase-timing.cjs');

const stamp = (depth, t, line, cmd) => `${'+'.repeat(depth)}@@${t}@@${line}@@ ${cmd}`;

describe('stampPs4', () => {
  test('embeds the timestamp command and the line number', () => {
    assert.equal(stampPs4('stamp-cmd'), '+@@$(stamp-cmd)@@${LINENO}@@ ');
  });
});

describe('parseTimedXtrace', () => {
  test('reads timestamp, line, depth and command from each stamped line', () => {
    const text = [stamp(1, 1000, 12, 'CMD=x'), stamp(2, 1005, 13, 'node -e y')].join('\n');
    assert.deepEqual(parseTimedXtrace(text), [
      { t: 1000, line: 12, depth: 1, cmd: 'CMD=x' },
      { t: 1005, line: 13, depth: 2, cmd: 'node -e y' },
    ]);
  });

  test('folds an unstamped line into the previous command', () => {
    const text = [stamp(1, 1000, 5, "printf 'a"), "b'", stamp(1, 1010, 6, 'next')].join('\n');
    const [first, second] = parseTimedXtrace(text);
    assert.equal(first.cmd, "printf 'a\nb'");
    assert.equal(second.cmd, 'next');
  });

  test('ignores text before the first stamp', () => {
    assert.deepEqual(parseTimedXtrace(`noise\n${stamp(1, 1, 2, 'c')}`), [
      { t: 1, line: 2, depth: 1, cmd: 'c' },
    ]);
  });

  test('empty input yields no entries', () => {
    assert.deepEqual(parseTimedXtrace(''), []);
  });

  test('a stamp is the whole prefix: `+@@` inside a command is not a new entry', () => {
    const entries = parseTimedXtrace(stamp(1, 1, 2, 'echo +@@9@@9@@ x'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].cmd, 'echo +@@9@@9@@ x');
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

  test('the last entry has no successor and costs nothing', () => {
    assert.equal(phaseCosts(entries).costs.some((c) => c.line === 40), false);
  });

  test('floorMs is the median gap (the constant PS4 overhead)', () => {
    assert.equal(phaseCosts(entries).floorMs, 2);
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
    { line: 3, totalMs: 5 },
    { line: 1, totalMs: 50 },
    { line: 2, totalMs: 50 },
    { line: 4, totalMs: 1 },
  ];

  test('costliest first, ties by line number, bounded by n', () => {
    assert.deepEqual(slowestLines(costs, 3).map((c) => c.line), [1, 2, 3]);
  });

  test('boundary: n = length - 1, length, length + 1', () => {
    assert.equal(slowestLines(costs, 3).length, 3);
    assert.equal(slowestLines(costs, 4).length, 4);
    assert.equal(slowestLines(costs, 5).length, 4);
  });

  test('does not mutate its input', () => {
    const before = costs.map((c) => c.line);
    slowestLines(costs, 2);
    assert.deepEqual(costs.map((c) => c.line), before);
  });
});

describe('abbreviate', () => {
  test('boundary: max - 1, max, max + 1 characters', () => {
    assert.equal(abbreviate('x'.repeat(9), 10), 'x'.repeat(9));
    assert.equal(abbreviate('x'.repeat(10), 10), 'x'.repeat(10));
    assert.equal(abbreviate('x'.repeat(11), 10), `${'x'.repeat(10)}… (11 chars)`);
  });

  test('collapses whitespace so a 112KB padded value renders on one short line', () => {
    const out = abbreviate(`a${' '.repeat(112 * 1024)}b`, 100);
    assert.equal(out, 'a b');
  });
});

describe('property: stamped traces round-trip through the parser', () => {
  test('timestamps, lines and depths survive serialize -> parse', () => {
    const entry = fc.record({
      t: fc.integer({ min: 0, max: 2 ** 40 }),
      line: fc.integer({ min: 1, max: 5000 }),
      depth: fc.integer({ min: 1, max: 6 }),
      cmd: fc.stringMatching(/^[a-zA-Z0-9_=\-./ ]{0,40}$/),
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 30 }), (entries) => {
        const text = entries.map((e) => stamp(e.depth, e.t, e.line, e.cmd)).join('\n');
        const parsed = parseTimedXtrace(text);
        assert.equal(parsed.length, entries.length);
        parsed.forEach((p, i) => {
          assert.equal(p.t, entries[i].t);
          assert.equal(p.line, entries[i].line);
          assert.equal(p.depth, entries[i].depth);
        });
      }),
    );
  });

  test('attributed per-line costs sum to the trace span', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 20 })), { minLength: 2, maxLength: 40 }),
        (steps) => {
          let t = 1_000_000;
          const entries = steps.map(([gap, line]) => ({ t: (t += gap), line, cmd: '' }));
          const { costs, totalMs } = phaseCosts(entries);
          assert.equal(costs.reduce((s, c) => s + c.totalMs, 0), totalMs);
        },
      ),
    );
  });
});
