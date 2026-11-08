'use strict';

/**
 * #4309: criterion baseline notation `[HEAD=<value> EXPECT<op><value> ...]`.
 *
 * Failing-first suite for the Criterion Baseline Module
 * (`src/criterion-baseline.cts` -> `gsd-core/bin/lib/criterion-baseline.cjs`).
 * Every row of `.gsd/phase/feat-4309-criterion-baseline-notation/50-test-matrix.md`
 * maps to at least one test below; the row numbers are cited in the test names
 * as `[M<n>]`. Assertions are on typed fields only (rule, severity, line,
 * status code, notation fields, value kind, counts, valid, exit code) and never
 * on message text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const path = require('node:path');
const fs = require('node:fs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const baseline = require(path.join(LIB, 'criterion-baseline.cjs'));
const sectionizer = require(path.join(LIB, 'markdown-sectionizer.cjs'));
const verify = require(path.join(LIB, 'verify.cjs'));

const {
  scanBaselineNotation,
  parseBaselineNotation,
  parseBaselineValue,
  renderBaselineValue,
  compareBaseline,
  parseCriteriaAllowMarkers,
  MAX_BASELINE_STATUSES,
} = baseline;

const PLAN_HEAD = [
  '---',
  'phase: 01-test',
  'plan: 01',
  'type: execute',
  'wave: 1',
  'depends_on: []',
  'files_modified: [some/file.ts]',
  'autonomous: true',
  'must_haves:',
  '  truths:',
  '    - "something is true"',
  '---',
  '',
];

function makePlan({ criteria = '  - Plain criterion.', automated = 'echo ok', action = 'Do the thing', done = 'Thing is done' } = {}) {
  return PLAN_HEAD.concat([
    '<acceptance_criteria>',
    criteria,
    '</acceptance_criteria>',
    '',
    '<task type="auto">',
    '  <name>Task 1: Do something</name>',
    '  <files>some/file.ts</files>',
    `  <action>${action}</action>`,
    `  <verify><automated>${automated}</automated></verify>`,
    `  <done>${done}</done>`,
    '</task>',
  ]).join('\n');
}

function lineOf(content, needle, occurrence = 0) {
  let idx = -1;
  for (let i = 0; i <= occurrence; i += 1) idx = content.indexOf(needle, idx + 1);
  return content.slice(0, idx).split('\n').length;
}

const codes = (result) => result.statuses.map((s) => s.code);
const rules = (result) => result.findings.map((f) => f.rule);
const crit = (notation) => makePlan({ criteria: `  - Count is ${notation} after the change.` });

describe('#4309 value grammar', () => {
  test('[M22] integer digit cap: 15 digits ok, 16 digits null', () => {
    assert.deepStrictEqual(parseBaselineValue('9'.repeat(15)), { kind: 'integer', value: 999999999999999 });
    assert.deepStrictEqual(parseBaselineValue(`-${'9'.repeat(15)}`), { kind: 'integer', value: -999999999999999 });
    assert.strictEqual(parseBaselineValue('9'.repeat(16)), null);
    assert.strictEqual(parseBaselineValue(`-${'9'.repeat(16)}`), null);
  });

  test('[M22] integer digit cap through the notation parser: 16 digits is bad_value', () => {
    const ok = parseBaselineNotation(`HEAD=${'9'.repeat(15)} EXPECT==3`);
    assert.strictEqual(ok.notation.head.kind, 'integer');
    assert.deepStrictEqual(ok.statuses, []);
    const bad = parseBaselineNotation(`HEAD=${'9'.repeat(16)} EXPECT==3`);
    assert.strictEqual(bad.notation, null);
    assert.deepStrictEqual(bad.statuses.map((s) => s.code), ['bad_value']);
  });

  test('[M23] error exit-code range: 1 and 255 ok; 0, 256, x null', () => {
    assert.deepStrictEqual(parseBaselineValue('error:1'), { kind: 'error', code: 1 });
    assert.deepStrictEqual(parseBaselineValue('error:255'), { kind: 'error', code: 255 });
    for (const token of ['error:0', 'error:256', 'error:x', 'error:', 'error:+2', 'error:-1']) {
      assert.strictEqual(parseBaselineValue(token), null, token);
    }
  });

  test('[M23] error exit-code range through the notation parser: bad_value', () => {
    for (const token of ['error:0', 'error:256', 'error:x']) {
      const result = parseBaselineNotation(`HEAD=${token} EXPECT==error:2`);
      assert.strictEqual(result.notation, null, token);
      assert.deepStrictEqual(result.statuses.map((s) => s.code), ['bad_value'], token);
    }
  });

  test('[M9] presence values parse to their kinds', () => {
    assert.deepStrictEqual(parseBaselineValue('absent'), { kind: 'absent' });
    assert.deepStrictEqual(parseBaselineValue('present'), { kind: 'present' });
  });

  test('[M17] tokens outside the value grammar are null', () => {
    for (const token of ['abc', '3.5', '', '0x10', 'Present']) {
      assert.strictEqual(parseBaselineValue(token), null, token);
    }
  });
});

describe('#4309 compareBaseline truth tables', () => {
  const TABLE = {
    '>=': [false, true, true],
    '>': [false, false, true],
    '<=': [true, true, false],
    '<': [true, false, false],
    '==': [false, true, false],
    '!=': [true, false, true],
  };
  const int = (value) => ({ kind: 'integer', value });

  for (const [op, expected] of Object.entries(TABLE)) {
    test(`compare ${op}: HEAD 2/3/4 vs EXPECT 3`, () => {
      assert.deepStrictEqual([2, 3, 4].map((h) => compareBaseline(int(h), op, int(3))), expected);
    });
  }

  test('[M10] error values are never equal to integers; ordering with a non-integer HEAD is false', () => {
    const err2 = { kind: 'error', code: 2 };
    assert.strictEqual(compareBaseline(err2, '==', int(0)), false);
    assert.strictEqual(compareBaseline(err2, '>=', int(1)), false);
    assert.strictEqual(compareBaseline(err2, '==', err2), true);
    assert.strictEqual(compareBaseline(err2, '!=', { kind: 'error', code: 3 }), true);
  });

  test('[M9] presence comparisons are structural', () => {
    const absent = { kind: 'absent' };
    const present = { kind: 'present' };
    assert.strictEqual(compareBaseline(absent, '==', present), false);
    assert.strictEqual(compareBaseline(present, '==', present), true);
    assert.strictEqual(compareBaseline(absent, '!=', present), true);
  });

  test('[M19] ordering op with a non-integer EXPECT is null', () => {
    assert.strictEqual(compareBaseline(int(3), '>=', { kind: 'present' }), null);
    assert.strictEqual(compareBaseline(int(3), '<', { kind: 'error', code: 2 }), null);
  });
});

describe('#4309 scanBaselineNotation: no-notation and happy paths', () => {
  test('[M1] plan without notation is silent', () => {
    const result = scanBaselineNotation(makePlan());
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.notationCount, 0);
  });

  test('[M2] discriminating threshold is silent and counted', () => {
    const result = scanBaselineNotation(crit('[HEAD=1 EXPECT>=3]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
    assert.strictEqual(result.notationCount, 1);
  });

  test('[M2] a B1 finding carries rule, severity, line and an errors entry', () => {
    const plan = crit('[HEAD=3 EXPECT>=3]');
    const result = scanBaselineNotation(plan);
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.findings[0].rule, 'B1');
    assert.strictEqual(result.findings[0].severity, 'error');
    assert.strictEqual(result.findings[0].line, lineOf(plan, '[HEAD=3'));
    assert.strictEqual(result.errors.length, 1);
    assert.deepStrictEqual(result.warnings, []);
  });
});

describe('#4309 B1 boundary: HEAD at limit-1 / limit / limit+1 of EXPECT 3', () => {
  const FIRES = {
    '>=': [false, true, true],
    '>': [false, false, true],
    '<=': [true, true, false],
    '<': [true, false, false],
    '==': [false, true, false],
    '!=': [true, false, true],
  };
  const ROW = { '>=': 3, '>': 4, '<=': 5, '<': 6, '==': 7, '!=': 8 };

  for (const [op, fires] of Object.entries(FIRES)) {
    test(`[M${ROW[op]}] B1 boundary: ${op}`, () => {
      [2, 3, 4].forEach((head, i) => {
        const plan = crit(`[HEAD=${head} EXPECT${op}3]`);
        const result = scanBaselineNotation(plan);
        assert.deepStrictEqual(rules(result), fires[i] ? ['B1'] : [], `HEAD=${head} EXPECT${op}3`);
        if (fires[i]) assert.strictEqual(result.findings[0].line, lineOf(plan, '[HEAD='));
        assert.deepStrictEqual(result.statuses, []);
      });
    });
  }
});

describe('#4309 presence and error values', () => {
  test('[M9] presence values: B1 only when already true', () => {
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=absent EXPECT==present]'))), []);
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=present EXPECT==present]'))), ['B1']);
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=absent EXPECT!=present]'))), ['B1']);
  });

  test('[M10] error values never equal integers', () => {
    const cases = [
      ['[HEAD=error:2 EXPECT>=1]', []],
      ['[HEAD=error:2 EXPECT==0]', []],
      ['[HEAD=error:2 EXPECT==error:2]', ['B1']],
      ['[HEAD=error:2 EXPECT!=error:3]', ['B1']],
    ];
    for (const [notation, expected] of cases) {
      assert.deepStrictEqual(rules(scanBaselineNotation(crit(notation))), expected, notation);
    }
  });

  test('[M24] negative integers compare numerically', () => {
    const result = scanBaselineNotation(crit('[HEAD=-1 EXPECT>=0]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
  });
});

describe('#4309 GUARD MUTATION', () => {
  test('[M11] guard with a mutation reference is honored on an already-true criterion', () => {
    const result = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3 GUARD MUTATION: drop line 4 of f.ts]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
  });

  test('[M12] guard without a mutation reference is not honored', () => {
    for (const notation of ['[HEAD=3 EXPECT>=3 GUARD]', '[HEAD=3 EXPECT>=3 GUARD MUTATION: ]', '[HEAD=3 EXPECT>=3 GUARD MUTATION:]']) {
      assert.deepStrictEqual(rules(scanBaselineNotation(crit(notation))), ['B1'], notation);
    }
  });

  test('[M12] parsed guard fields: GUARD alone leaves mutation null', () => {
    const bare = parseBaselineNotation('HEAD=3 EXPECT>=3 GUARD').notation;
    assert.strictEqual(bare.guard, true);
    assert.strictEqual(bare.mutation, null);
    const empty = parseBaselineNotation('HEAD=3 EXPECT>=3 GUARD MUTATION: ').notation;
    assert.strictEqual(empty.guard, true);
    assert.strictEqual(empty.mutation, null);
    const full = parseBaselineNotation('HEAD=3 EXPECT>=3 GUARD MUTATION: drop line 4').notation;
    assert.strictEqual(full.guard, true);
    assert.strictEqual(full.mutation, 'drop line 4');
  });

  test('[M13] guard on a discriminating criterion is silent', () => {
    const result = scanBaselineNotation(crit('[HEAD=1 EXPECT>=3 GUARD MUTATION: x]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
  });

  test('[M21] a misspelled guard never disarms B1 and is reported as trailing text', () => {
    const result = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3 GAURD MUTATION: x]'));
    assert.deepStrictEqual(rules(result), ['B1']);
    assert.deepStrictEqual(codes(result), ['unrecognized_trailing']);
  });
});

describe('#4309 rev pinning', () => {
  const hex = (n) => 'a'.repeat(n);

  test('[M14] rev boundary: 6 bad, 7 ok, 40 ok, 41 bad (parser)', () => {
    const expected = [[6, false], [7, true], [40, true], [41, false]];
    for (const [n, ok] of expected) {
      const parsed = parseBaselineNotation(`HEAD=1 EXPECT>=3 @${hex(n)}`);
      assert.strictEqual(parsed.notation.rev, ok ? hex(n) : null, `${n} hex`);
      assert.deepStrictEqual(parsed.statuses.map((s) => s.code), ok ? [] : ['bad_rev'], `${n} hex`);
    }
  });

  test('[M14] non-hex revs are bad_rev (parser)', () => {
    for (const rev of ['HEAD~1', 'main', 'ABCDEF1']) {
      const parsed = parseBaselineNotation(`HEAD=1 EXPECT>=3 @${rev}`);
      assert.strictEqual(parsed.notation.rev, null, rev);
      assert.deepStrictEqual(parsed.statuses.map((s) => s.code), ['bad_rev'], rev);
    }
  });

  test('[M14] rev boundary through the scanner: B1 is still evaluated with a bad rev', () => {
    const expected = [[6, false], [7, true], [40, true], [41, false]];
    for (const [n, ok] of expected) {
      const result = scanBaselineNotation(crit(`[HEAD=3 EXPECT>=3 @${hex(n)}]`));
      assert.deepStrictEqual(codes(result), ok ? [] : ['bad_rev'], `${n} hex`);
      assert.deepStrictEqual(rules(result), ['B1'], `${n} hex`);
    }
    for (const rev of ['HEAD~1', 'main']) {
      const result = scanBaselineNotation(crit(`[HEAD=3 EXPECT>=3 @${rev}]`));
      assert.deepStrictEqual(codes(result), ['bad_rev'], rev);
      assert.deepStrictEqual(rules(result), ['B1'], rev);
    }
  });

  test('[M14] a valid rev on a discriminating criterion is recorded and silent', () => {
    const parsed = parseBaselineNotation('HEAD=1 EXPECT>=3 @abc1234');
    assert.strictEqual(parsed.notation.rev, 'abc1234');
    const result = scanBaselineNotation(crit('[HEAD=1 EXPECT>=3 @abc1234]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
  });

  test('[M15] rev and UNPINNED together is pin_conflict, B1 still evaluated', () => {
    const result = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3 @abc1234 UNPINNED]'));
    assert.deepStrictEqual(codes(result), ['pin_conflict']);
    assert.deepStrictEqual(rules(result), ['B1']);
  });

  test('[M16] UNPINNED alone is parsed, silent on a discriminating criterion', () => {
    const parsed = parseBaselineNotation('HEAD=1 EXPECT>=3 UNPINNED');
    assert.strictEqual(parsed.notation.unpinned, true);
    assert.strictEqual(parsed.notation.rev, null);
    assert.deepStrictEqual(parsed.statuses, []);
    const result = scanBaselineNotation(crit('[HEAD=1 EXPECT>=3 UNPINNED]'));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
  });
});

describe('#4309 malformed notation becomes statuses, never findings', () => {
  test('[M17] bad value: status bad_value, no finding', () => {
    for (const notation of ['[HEAD=abc EXPECT>=3]', '[HEAD=3 EXPECT==xyz]']) {
      const result = scanBaselineNotation(crit(notation));
      assert.deepStrictEqual(codes(result), ['bad_value'], notation);
      assert.deepStrictEqual(result.findings, [], notation);
    }
  });

  test('[M18] unknown operator or missing EXPECT: status malformed, no finding', () => {
    for (const notation of ['[HEAD=3 EXPECT=3]', '[HEAD=3 EXPECT≥3]', '[HEAD=3 EXPECT=>3]', '[HEAD=3]']) {
      const result = scanBaselineNotation(crit(notation));
      assert.deepStrictEqual(codes(result), ['malformed'], notation);
      assert.deepStrictEqual(result.findings, [], notation);
    }
  });

  test('[M18] parser returns a null notation for malformed input', () => {
    for (const inner of ['HEAD=3 EXPECT=3', 'HEAD=3']) {
      const parsed = parseBaselineNotation(inner);
      assert.strictEqual(parsed.notation, null, inner);
      assert.deepStrictEqual(parsed.statuses.map((s) => s.code), ['malformed'], inner);
    }
  });

  test('[M19] ordering operator with a non-integer EXPECT: ordering_needs_integer, no finding', () => {
    for (const notation of ['[HEAD=3 EXPECT>=present]', '[HEAD=3 EXPECT<error:2]']) {
      const result = scanBaselineNotation(crit(notation));
      assert.deepStrictEqual(codes(result), ['ordering_needs_integer'], notation);
      assert.deepStrictEqual(result.findings, [], notation);
    }
  });

  test('[M20] unterminated: no closing bracket on the line', () => {
    const noBracket = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3'));
    assert.deepStrictEqual(codes(noBracket), ['unterminated']);
    assert.deepStrictEqual(noBracket.findings, []);
    const nextLine = scanBaselineNotation(makePlan({ criteria: '  - Count [HEAD=3 EXPECT>=3\n  - closes later ]' }));
    assert.deepStrictEqual(codes(nextLine), ['unterminated']);
    assert.deepStrictEqual(nextLine.findings, []);
  });

  test('[M20] 500-char boundary: limit-1 and limit found, one char beyond is unterminated', () => {
    const limitMinusOne = `[${'HEAD=1 EXPECT>=3'.padEnd(498, ' ')}]`;
    const minusResult = scanBaselineNotation(makePlan({ criteria: `  - ${limitMinusOne}` }));
    assert.deepStrictEqual(codes(minusResult), []);
    assert.strictEqual(minusResult.notationCount, 1);
    const inside = `[${'HEAD=1 EXPECT>=3'.padEnd(499, ' ')}]`;
    const beyond = `[${'HEAD=1 EXPECT>=3'.padEnd(500, ' ')}]`;
    const okResult = scanBaselineNotation(makePlan({ criteria: `  - ${inside}` }));
    assert.deepStrictEqual(codes(okResult), []);
    assert.strictEqual(okResult.notationCount, 1);
    const farResult = scanBaselineNotation(makePlan({ criteria: `  - ${beyond}` }));
    assert.deepStrictEqual(codes(farResult), ['unterminated']);
    assert.deepStrictEqual(farResult.findings, []);
  });
});

describe('#4309 zones', () => {
  test('[M25] notation in an <automated> shell comment is judged', () => {
    const plan = makePlan({ automated: "grep -c 'x' f # [HEAD=3 EXPECT>=3]" });
    const result = scanBaselineNotation(plan);
    assert.deepStrictEqual(rules(result), ['B1']);
    assert.strictEqual(result.findings[0].line, lineOf(plan, '[HEAD=3'));
  });

  test('[M26] notation in <verify><automated> is evaluated exactly once', () => {
    const result = scanBaselineNotation(makePlan({ automated: 'echo ok # [HEAD=3 EXPECT>=3]' }));
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.notationCount, 1);
    assert.strictEqual(result.errors.length, 1);
  });

  test('[M27] notation in <action>, <done> and prose is outside_criteria_zone and not judged', () => {
    const inAction = scanBaselineNotation(makePlan({ action: 'Note [HEAD=3 EXPECT>=3] here' }));
    const inDone = scanBaselineNotation(makePlan({ done: 'Done [HEAD=3 EXPECT>=3]' }));
    const inProse = scanBaselineNotation(`${makePlan()}\n\nTrailing prose [HEAD=3 EXPECT>=3] outside.\n`);
    for (const result of [inAction, inDone, inProse]) {
      assert.deepStrictEqual(codes(result), ['outside_criteria_zone']);
      assert.deepStrictEqual(result.findings, []);
      assert.deepStrictEqual(result.errors, []);
    }
  });
});

describe('#4309 normalization', () => {
  test('[M28] entity-escaped operators are decoded', () => {
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=3 EXPECT&gt;=3]'))), ['B1']);
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=3 EXPECT&lt;=3]'))), ['B1']);
    assert.deepStrictEqual(rules(scanBaselineNotation(crit('[HEAD=1 EXPECT&gt;=3]'))), []);
    assert.strictEqual(parseBaselineNotation('HEAD=3 EXPECT&gt;=3').notation.op, '>=');
    assert.strictEqual(parseBaselineNotation('HEAD=3 EXPECT&lt;3').notation.op, '<');
  });

  test('[M29] CRLF plans give the same verdicts and line numbers as LF', () => {
    const lf = makePlan({
      criteria: ['  - first [HEAD=3 EXPECT>=3]', '  - second [HEAD=1 EXPECT>=3]', '  - third [HEAD=4 EXPECT==4]'].join('\n'),
    });
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = scanBaselineNotation(lf);
    const b = scanBaselineNotation(crlf);
    assert.deepStrictEqual(rules(b), rules(a));
    assert.deepStrictEqual(b.findings.map((f) => f.line), a.findings.map((f) => f.line));
    assert.deepStrictEqual(b.findings.map((f) => f.line), [lineOf(lf, '[HEAD=3'), lineOf(lf, '[HEAD=4')]);
    assert.strictEqual(b.notationCount, a.notationCount);
  });

  test('[M30] whitespace tolerance', () => {
    const result = scanBaselineNotation(crit('[ HEAD = 3  EXPECT >= 3 ]'));
    assert.deepStrictEqual(rules(result), ['B1']);
    assert.deepStrictEqual(result.statuses, []);
    const parsed = parseBaselineNotation(' HEAD = 3  EXPECT >= 3 ').notation;
    assert.deepStrictEqual(parsed.head, { kind: 'integer', value: 3 });
    assert.strictEqual(parsed.op, '>=');
    assert.deepStrictEqual(parsed.expect, { kind: 'integer', value: 3 });
  });
});

describe('#4309 independence', () => {
  test('[M31] two notations on one line are judged independently', () => {
    const mixed = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3] and [HEAD=1 EXPECT>=3]'));
    assert.strictEqual(mixed.findings.length, 1);
    assert.strictEqual(mixed.notationCount, 2);
    const both = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3] and [HEAD=4 EXPECT>=3]'));
    assert.strictEqual(both.findings.length, 2);
    assert.strictEqual(both.findings[0].line, both.findings[1].line);
    assert.strictEqual(both.notationCount, 2);
  });

  test('[M32] identical notation text on two lines yields two findings at distinct lines', () => {
    const plan = makePlan({ criteria: ['  - first [HEAD=3 EXPECT>=3]', '  - second [HEAD=3 EXPECT>=3]'].join('\n') });
    const result = scanBaselineNotation(plan);
    assert.deepStrictEqual(result.findings.map((f) => f.line), [lineOf(plan, '[HEAD=3', 0), lineOf(plan, '[HEAD=3', 1)]);
    assert.notStrictEqual(result.findings[0].line, result.findings[1].line);
  });
});

describe('#4309 allow markers', () => {
  const NOTATION = '  - Count is [HEAD=3 EXPECT>=3] after the change.';

  test('[M33] B1 allow marker with a reason suppresses', () => {
    const plan = makePlan({ criteria: ['  <!-- plan-criteria-allow: B1 - pinned by review -->', NOTATION].join('\n') });
    const result = scanBaselineNotation(plan);
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.errors, []);
  });

  test('[M33] B1 allow marker with an empty or missing reason does not suppress', () => {
    for (const marker of [
      '  <!-- plan-criteria-allow: B1 -  -->',
      '  <!-- plan-criteria-allow: B1 -->',
      '  <!-- plan-criteria-allow: B1 -    -->',
    ]) {
      const result = scanBaselineNotation(makePlan({ criteria: [marker, NOTATION].join('\n') }));
      assert.deepStrictEqual(rules(result), ['B1'], marker);
    }
  });

  test('[M34] B2 allow marker suppresses the legacy warning', () => {
    const automated = 'echo ok # baseline at HEAD: 0';
    const without = scanBaselineNotation(makePlan({ automated }));
    assert.deepStrictEqual(rules(without), ['B2']);
    const withMarker = scanBaselineNotation(makePlan({
      criteria: '  <!-- plan-criteria-allow: B2 - legacy plan kept as-is -->',
      automated,
    }));
    assert.deepStrictEqual(withMarker.findings, []);
    assert.deepStrictEqual(withMarker.warnings, []);
  });

  test('[M35] a B1 marker does not suppress B2 (rule ids are independent)', () => {
    const result = scanBaselineNotation(makePlan({
      criteria: '  <!-- plan-criteria-allow: B1 - reason here -->',
      automated: 'echo ok # baseline at HEAD: 0',
    }));
    assert.deepStrictEqual(rules(result), ['B2']);
  });

  test('[M35] shared allow parser returns rule ids as a Set and ignores unknown ids', () => {
    const allowed = '<!-- plan-criteria-allow: R1 - pinned by grep -n -->';
    assert.deepStrictEqual([...parseCriteriaAllowMarkers(allowed)], ['R1']);
    const two = `${allowed}\n<!-- plan-criteria-allow: B2 - legacy -->`;
    assert.deepStrictEqual([...parseCriteriaAllowMarkers(two)].sort(), ['B2', 'R1']);
    assert.deepStrictEqual([...parseCriteriaAllowMarkers('<!-- plan-criteria-allow: R7 - nope -->')], []);
    assert.deepStrictEqual([...parseCriteriaAllowMarkers('<!-- plan-criteria-allow: R1 - -->')], []);
  });

  test('[M35] R1 parity: scanQuantitativeCriteria still errors without the marker and is suppressed with it', () => {
    const trap = "  - `grep -c 'x' f` returns exactly 2.";
    const bare = verify.scanQuantitativeCriteria(makePlan({ criteria: trap }));
    assert.ok(bare.errors.length > 0);
    const allowed = verify.scanQuantitativeCriteria(makePlan({
      criteria: ['  <!-- plan-criteria-allow: R1 - pinned by grep -n -->', trap].join('\n'),
    }));
    assert.deepStrictEqual(allowed.errors, []);
  });
});

describe('#4309 legacy `# baseline at HEAD:` comment (B2)', () => {
  test('[M36] legacy comment inside <automated> is a B2 warning, not an error', () => {
    const plan = makePlan({ automated: 'echo ok # baseline at HEAD: 0' });
    const result = scanBaselineNotation(plan);
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.findings[0].rule, 'B2');
    assert.strictEqual(result.findings[0].severity, 'warning');
    assert.strictEqual(result.findings[0].line, lineOf(plan, '# baseline'));
    assert.strictEqual(result.warnings.length, 1);
    assert.deepStrictEqual(result.errors, []);
  });

  test('[M37] legacy comment outside criteria zones and prose mentions are silent', () => {
    const inAction = scanBaselineNotation(makePlan({ action: 'History: # baseline at HEAD: 4 was the old form' }));
    const prose = scanBaselineNotation(`${makePlan()}\n\nThe baseline at HEAD was measured earlier; baseline notes follow.\n`);
    const baselineProse = scanBaselineNotation(makePlan({ criteria: '  - The baseline at HEAD is documented elsewhere.' }));
    for (const result of [inAction, prose, baselineProse]) {
      assert.deepStrictEqual(result.findings, []);
      assert.deepStrictEqual(result.warnings, []);
    }
  });

  test('[M38] legacy comment and a notation on the same line are both judged', () => {
    const result = scanBaselineNotation(makePlan({ automated: 'echo ok # baseline at HEAD: 3 [HEAD=3 EXPECT>=3]' }));
    assert.deepStrictEqual(rules(result).sort(), ['B1', 'B2']);
  });
});

describe('#4309 negative space', () => {
  test('[M39] text that is not a notation is ignored', () => {
    const criteria = [
      '  - See the [HEAD](https://example.test/head) link.',
      '  - The [HEAD branch] is main.',
      '  - Run HEAD=3 some-command to assign.',
      '  - Lowercase [head=3 expect>=3] is not recognized.',
    ].join('\n');
    const result = scanBaselineNotation(makePlan({ criteria }));
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(result.statuses, []);
    assert.strictEqual(result.notationCount, 0);
  });

  test('[M40] non-string and empty input yields an empty result', () => {
    for (const input of [undefined, null, 42, {}, [], '']) {
      const result = scanBaselineNotation(input);
      assert.deepStrictEqual(result.findings, []);
      assert.deepStrictEqual(result.statuses, []);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.warnings, []);
      assert.strictEqual(result.notationCount, 0);
    }
  });
});

describe('#4309 fault and hostile input', () => {
  test('[M41] an injected parser that throws fails open with scanner_error', () => {
    const result = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3]'), {
      parseNotation: () => { throw new Error('boom'); },
    });
    assert.deepStrictEqual(result.findings, []);
    assert.deepStrictEqual(codes(result), ['scanner_error']);
    assert.deepStrictEqual(result.errors, []);
  });

  test('[M42] 5000 repeated openers on one line complete with bounded output', () => {
    const plan = makePlan({ criteria: `  - ${'[HEAD='.repeat(5000)}` });
    const result = scanBaselineNotation(plan);
    assert.deepStrictEqual(result.findings, []);
    assert.strictEqual(result.statuses.length, MAX_BASELINE_STATUSES + 1);
    assert.ok(result.statuses.slice(0, MAX_BASELINE_STATUSES).every((s) => s.code === 'unterminated'));
    assert.strictEqual(result.statuses[MAX_BASELINE_STATUSES].code, 'truncated');
  });

  test('[M42] status cap boundary: 49 and 50 unterminated openers are uncapped, 51 yields 50 plus one truncated', () => {
    const run = (n) => scanBaselineNotation(makePlan({
      criteria: Array.from({ length: n }, (_, i) => `  - item ${i} [HEAD=`).join('\n'),
    }));
    for (const n of [MAX_BASELINE_STATUSES - 1, MAX_BASELINE_STATUSES]) {
      const r = run(n);
      assert.strictEqual(r.statuses.length, n);
      assert.ok(r.statuses.every((s) => s.code === 'unterminated'), String(n));
    }
    const over = run(MAX_BASELINE_STATUSES + 1);
    assert.strictEqual(over.statuses.length, MAX_BASELINE_STATUSES + 1);
    assert.ok(over.statuses.slice(0, MAX_BASELINE_STATUSES).every((s) => s.code === 'unterminated'));
    const last = over.statuses[MAX_BASELINE_STATUSES];
    assert.strictEqual(last.code, 'truncated');
    assert.match(last.detail, /1 further status /);
    assert.strictEqual(last.line, over.statuses[MAX_BASELINE_STATUSES - 1].line + 1);
  });

  test('[M42] findings are not capped by the status cap', () => {
    const criteria = Array.from({ length: 60 }, (_, i) => `  - n${i} [HEAD=3 EXPECT>=3]`).join('\n');
    assert.strictEqual(scanBaselineNotation(makePlan({ criteria })).findings.length, 60);
  });
});

describe('#4309 line numbers with bare CR line endings', () => {
  test('a CR-only plan reports the same line as its LF equivalent', () => {
    const lf = '<acceptance_criteria>\n- a\n- b [HEAD=3 EXPECT>=1]\n</acceptance_criteria>';
    const cr = lf.replace(/\n/g, '\r');
    const crlf = lf.replace(/\n/g, '\r\n');
    const expected = scanBaselineNotation(lf).findings[0].line;
    assert.strictEqual(expected, 3);
    assert.deepStrictEqual(scanBaselineNotation(cr).findings.map((f) => f.line), [expected]);
    assert.deepStrictEqual(scanBaselineNotation(crlf).findings.map((f) => f.line), [expected]);
  });
});

describe('#4309 misplaced pin inside the MUTATION reference', () => {
  test('a trailing @<rev> after the MUTATION ref is stripped, flagged, and B1 is judged with the remaining ref', () => {
    const r = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3 GUARD MUTATION: x @abc1234]'));
    assert.deepStrictEqual(rules(r), []);
    assert.deepStrictEqual(codes(r), ['unrecognized_trailing']);
    assert.match(r.statuses[0].detail, /must precede GUARD/);
    const parsed = parseBaselineNotation('HEAD=3 EXPECT>=3 GUARD MUTATION: x @abc1234');
    assert.strictEqual(parsed.notation.mutation, 'x');
  });

  test('a MUTATION ref that is only a pin is empty, so B1 is not honored away', () => {
    const r = scanBaselineNotation(crit('[HEAD=3 EXPECT>=3 GUARD MUTATION: @abc1234]'));
    assert.deepStrictEqual(rules(r), ['B1']);
    assert.deepStrictEqual(codes(r), ['unrecognized_trailing']);
  });
});

describe('#4309 allow-marker scan is linear', () => {
  test('16000 unclosed markers complete and match nothing', () => {
    const content = '<!-- plan-criteria-allow: R1 - x '.repeat(16000);
    assert.strictEqual(parseCriteriaAllowMarkers(content).size, 0);
  });
});

describe('#4309 markdown-sectionizer span parity', () => {
  test('[M50] extractTaggedBlockSpans bodies equal extractTaggedBlocks', () => {
    const plan = makePlan({ criteria: '  - one\n  - two' });
    for (const tag of ['acceptance_criteria', 'automated', 'verify', 'action', 'missing_tag']) {
      const spans = sectionizer.extractTaggedBlockSpans(plan, tag);
      assert.deepStrictEqual(
        spans.map((s) => plan.slice(s.start, s.end)),
        sectionizer.extractTaggedBlocks(plan, tag),
        tag,
      );
    }
  });

  test('[M50] nested zones: the <verify> span contains the <automated> span', () => {
    const plan = makePlan();
    const [verifySpan] = sectionizer.extractTaggedBlockSpans(plan, 'verify');
    const [automatedSpan] = sectionizer.extractTaggedBlockSpans(plan, 'automated');
    assert.ok(automatedSpan.start >= verifySpan.start && automatedSpan.end <= verifySpan.end);
  });
});

describe('#4309 properties', () => {
  const valueArb = fc.oneof(
    fc.integer({ min: -1000000, max: 1000000 }).map((value) => ({ kind: 'integer', value })),
    fc.constant({ kind: 'absent' }),
    fc.constant({ kind: 'present' }),
    fc.integer({ min: 1, max: 255 }).map((code) => ({ kind: 'error', code })),
  );
  const opArb = fc.constantFrom('==', '!=', '>=', '>', '<=', '<');

  test('[M48] fc: parse(render(v)) round-trips every value', () => {
    fc.assert(
      fc.property(valueArb, (v) => {
        assert.deepStrictEqual(parseBaselineValue(renderBaselineValue(v)), v);
      }),
      { seed: 4309, numRuns: 300 },
    );
  });

  test('[M49] fc: != is the negation of == for any values', () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        assert.strictEqual(compareBaseline(a, '!=', b), !compareBaseline(a, '==', b));
      }),
      { seed: 4309, numRuns: 300 },
    );
  });

  test('[M47] fc: B1 fires iff the comparison is already true and not guarded', () => {
    fc.assert(
      fc.property(valueArb, opArb, valueArb, fc.boolean(), (head, op, expect, guarded) => {
        const tail = guarded ? ' GUARD MUTATION: m1' : '';
        const notation = `[HEAD=${renderBaselineValue(head)} EXPECT${op}${renderBaselineValue(expect)}${tail}]`;
        const result = scanBaselineNotation(crit(notation));
        const cmp = compareBaseline(head, op, expect);
        if (cmp === null) {
          assert.deepStrictEqual(codes(result), ['ordering_needs_integer']);
          assert.deepStrictEqual(result.findings, []);
        } else {
          assert.deepStrictEqual(result.statuses, []);
          assert.deepStrictEqual(rules(result), cmp && !guarded ? ['B1'] : []);
        }
      }),
      { seed: 4309, numRuns: 300 },
    );
  });
});

describe('#4309 e2e: verify plan-structure', () => {
  const PLAN = '.planning/phases/01-test/01-01-PLAN.md';
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function run(content) {
    fs.writeFileSync(path.join(tmpDir, PLAN), content);
    const result = runGsdTools(['verify', 'plan-structure', PLAN], tmpDir);
    return { result, out: JSON.parse(result.output) };
  }

  test('[M43] a non-discriminating baseline invalidates the plan (exit 1)', () => {
    const { result, out } = run(crit('[HEAD=3 EXPECT>=3]'));
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(out.valid, false);
    assert.strictEqual(out.baseline_notation_count, 1);
    assert.strictEqual(out.baseline_findings.length, 1);
    assert.strictEqual(out.baseline_findings[0].rule, 'B1');
    assert.deepStrictEqual(out.baseline_statuses, []);
  });

  test('[M44] the corrected arm stays valid (exit 0)', () => {
    const { result, out } = run(crit('[HEAD=1 EXPECT>=3 @abc1234]'));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.valid, true);
    assert.strictEqual(out.baseline_notation_count, 1);
    assert.deepStrictEqual(out.baseline_findings, []);
    assert.deepStrictEqual(out.baseline_statuses, []);
  });

  test('[M45] a malformed-only notation records a status and changes no exit code', () => {
    const { result, out } = run(crit('[HEAD=3 EXPECT=3]'));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.valid, true);
    assert.deepStrictEqual(out.baseline_findings, []);
    assert.deepStrictEqual(out.baseline_statuses.map((s) => s.code), ['malformed']);
  });

  test('[M46] a legacy baseline comment warns and stays valid (exit 0)', () => {
    const { result, out } = run(makePlan({ automated: 'echo ok # baseline at HEAD: 0' }));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(out.valid, true);
    assert.deepStrictEqual(out.baseline_findings.map((f) => f.rule), ['B2']);
    assert.strictEqual(out.baseline_findings[0].severity, 'warning');
  });
});
