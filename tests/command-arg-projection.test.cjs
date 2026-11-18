'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNamedArgs,
  parseMultiwordArg,
} = require('../gsd-core/bin/lib/command-arg-projection.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { runCli } = require('./helpers/cli-negative.cjs');

// ---------------------------------------------------------------------------
// parseNamedArgs — behavior-lock tests (green before AND after the #312 fix)
// ---------------------------------------------------------------------------

test('value flag with valid value', () => {
  const result = parseNamedArgs(['--name', 'foo'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: 'foo' } });
});

// Corrected after the first full verification run: a value flag whose next
// token is another flag is NOT an error (see the "strict argv" describe
// block below, valueFlagFollowedByAnotherFlagResolvesToNullNotAnError) — it
// resolves to `null` and the cursor advances by 1 so the following token is
// validated on its own merits. `--other` is deliberately left undeclared
// here since this row tests extraction only; `positionals: 'rest'` skips
// the unrelated unknown-flag validation.
test('value flag followed by another flag resolves to null, not rejected', () => {
  const result = parseNamedArgs(['--name', '--other'], { valueFlags: ['name'], positionals: 'rest' });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

// Corrected after the first full verification run: a value flag with no
// following token at all resolves to `null`, not an error — see the
// "strict argv" describe block below.
test('value flag at end of array (no following token)', () => {
  const result = parseNamedArgs(['--name'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

// The original 'value flag absent from args' row passed `['--x', 'y']` with
// only `name` declared. Under strict mode `--x` is itself an unknown flag —
// split into two rows so neither original intent (an undeclared flag is
// null when TRULY absent; `--x` is rejected) is silently dropped.
test('absent declared flag resolves to null (not an error)', () => {
  const result = parseNamedArgs([], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: null } });
});

test('an undeclared flag token is rejected, not silently ignored', () => {
  const result = parseNamedArgs(['--x', 'y'], { valueFlags: ['name'], positionals: 0 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.kind, 'InvalidArgs');
  assert.strictEqual(result.arg, '--x');
});

test('boolean flag present', () => {
  const result = parseNamedArgs(['--write'], { booleanFlags: ['write'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { write: true } });
});

test('boolean flag absent', () => {
  const result = parseNamedArgs([], { booleanFlags: ['write'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { write: false } });
});

// Negative space N4: a repeated flag is not an unknown token — first
// occurrence still wins, and each occurrence is itself a well-formed
// flag+value pair, so strict validation still passes.
test('first-occurrence-wins: duplicate value flag uses first index', () => {
  // Locks the indexOf-first semantics that the Map must preserve (#312)
  const result = parseNamedArgs(['--name', 'a', '--name', 'b'], { valueFlags: ['name'], positionals: 0 });
  assert.deepStrictEqual(result, { ok: true, data: { name: 'a' } });
});

test('mixed multiple flags (the O(flags*argv) case)', () => {
  const result = parseNamedArgs(
    ['--a', '1', '--flag', '--b', '2'],
    { valueFlags: ['a', 'b'], booleanFlags: ['flag'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { a: '1', b: '2', flag: true } });
});

test('empty args with multiple declared flags', () => {
  const result = parseNamedArgs(
    [],
    { valueFlags: ['name', 'path'], booleanFlags: ['verbose', 'dry-run'], positionals: 0 },
  );
  assert.deepStrictEqual(result, {
    ok: true,
    data: { name: null, path: null, verbose: false, 'dry-run': false },
  });
});

// Corrected after the first full verification run: a value flag exhausted
// by the array boundary resolves to `null`, not InvalidArgs — including
// when it is preceded by another well-formed flag+value pair.
test('value flag at end of argv resolves to null even when preceded by another flag', () => {
  const result = parseNamedArgs(
    ['--other', 'x', '--count'],
    { valueFlags: ['other', 'count'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { other: 'x', count: null } });
});

test('boolean flag does not clobber an already-set value-flag key when names differ', () => {
  const result = parseNamedArgs(
    ['--msg', 'hello', '--verbose'],
    { valueFlags: ['msg'], booleanFlags: ['verbose'], positionals: 0 },
  );
  assert.deepStrictEqual(result, { ok: true, data: { msg: 'hello', verbose: true } });
});

// ---------------------------------------------------------------------------
// parseMultiwordArg — spot coverage for module completeness
// ---------------------------------------------------------------------------

test('parseMultiwordArg: collects tokens until next flag', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', 'hello', 'world', '--x'], 'msg'),
    'hello world'
  );
});

test('parseMultiwordArg: absent flag returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--other', 'val'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag present but no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', '--next'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag at end of array with no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg'], 'msg'),
    null
  );
});

// ---------------------------------------------------------------------------
// parseNamedArgs — strict argv (#3358, ADR-3473 §8.4)
//
// New shape: parseNamedArgs(args, spec) where
//   spec = { valueFlags?: string[], booleanFlags?: string[], positionals: number | 'rest' }
// returning { ok: true, data } | { ok: false, kind: 'InvalidArgs', arg, reason }.
//
// TODAY (measured on this tree): the function ignores this shape entirely —
// its real signature is still (args, valueFlags = [], booleanFlags = []), so
// passing a spec OBJECT as the second positional argument makes
// `for (const flag of valueFlags)` iterate a non-iterable plain object,
// throwing `TypeError: valueFlags is not iterable` before any of these rows
// can even reach their assertions. Every row below therefore fails against
// the current tree — either via that uncaught throw, or (for the two legacy
// rows) because `assert.throws` finds nothing thrown at all.
// ---------------------------------------------------------------------------

describe('parseNamedArgs — strict argv (#3358, ADR-3473 §8.4)', () => {
  test('valueFlagWithValueResolvesOk', () => {
    const result = parseNamedArgs(
      ['state', 'begin-phase', '--phase', '3'],
      { valueFlags: ['phase', 'name', 'plans'], positionals: 2 },
    );
    assert.deepStrictEqual(result, { ok: true, data: { phase: '3', name: null, plans: null } });
  });

  // Corrected after the first full verification run: ADR-3473 §8.4 mandates
  // rejecting *unrecognized* and *positional* tokens — it says nothing about
  // a value flag whose value is missing or flag-shaped. Treating that as an
  // error was an over-implementation (not the ADR's rule) and it broke the
  // long-standing, deliberately-recorded `null` contract exercised by
  // tests/init.test.cjs emptyPrdValueIsFalsyAndTreatedAsAbsent (row B5) and
  // tests/section-manifest-init-facts.test.cjs "flag-shaped value (--prd
  // --weird)". A value flag whose next token is absent or flag-shaped
  // resolves to `null` and is NOT an error; the cursor advances by 1 so the
  // following flag token is validated on its own merits on the next
  // iteration.
  test('valueFlagFollowedByAnotherFlagResolvesToNullNotAnError', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '--phase', '--name', 'x'],
      { valueFlags: ['phase', 'name'], positionals: 2 },
    );
    assert.deepStrictEqual(result, { ok: true, data: { phase: null, name: 'x' } });
  });

  test('unknownFlagIsRejectedAndListsAcceptedFlags', () => {
    const result = parseNamedArgs(
      ['state', 'begin-phase', '--bogus', 'x'],
      { valueFlags: ['phase', 'name'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--bogus');
    assert.match(result.reason, /phase/i, 'reason must name an accepted flag');
    assert.match(result.reason, /name/i, 'reason must name an accepted flag');
  });

  // #3358: the exact call site shape (`state planned-phase 3`, no --phase)
  // that let a stray positional silently drop and overwrite STATE.md's
  // previously-current phase block. See tests/state.test.cjs
  // positionalPlannedPhaseLeavesStateMdUntouched_3358 for the consumer-output
  // identity row this defect is actually observed through.
  test('unexpectedPositionalIsRejected_3358', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '3'],
      { valueFlags: ['phase', 'name', 'plans'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '3');
    assert.match(result.reason, /positional/i);
  });

  // Negative space N3: a positional the caller declares (and reads itself
  // via args[2]) must never be flagged as unexpected.
  test('declaredPositionalIsNotFlagged', () => {
    const result = parseNamedArgs(
      ['init', 'execute-phase', '01', '--tdd'],
      { booleanFlags: ['tdd'], positionals: 3 },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.tdd, true);
  });

  // Required boundary triple over a fixed argv: positionals one short of the
  // token's index rejects it; positionals at or past that index accepts it.
  test('positionalBoundaryAtNMinus1_N_NPlus1', () => {
    const argv = ['state', 'complete-phase', '3'];

    const nMinus1 = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 2 });
    assert.strictEqual(nMinus1.ok, false);
    assert.strictEqual(nMinus1.arg, '3');

    const atN = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 3 });
    assert.strictEqual(atN.ok, true);

    const nPlus1 = parseNamedArgs(argv, { valueFlags: ['phase'], positionals: 4 });
    assert.strictEqual(nPlus1.ok, true);
  });

  // Negative space N5: a value beginning with a single `-` (a negative
  // number) is not mistaken for a flag. The strict pass must reuse the same
  // `startsWith('--')` predicate the permissive parser already gets right.
  test('negativeNumberValueIsNotTreatedAsFlag', () => {
    const result = parseNamedArgs(
      ['state', 'record-metric', '--plans', '-1'],
      { valueFlags: ['plans'], positionals: 2 },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.plans, '-1');
  });

  // Negative space N6: `init quick <description>` consumes everything after
  // the family/subcommand as free text — undeclared-flag rejection must be
  // disabled for this documented shape, not accidentally re-enabled.
  test('restPositionalsAcceptFreeTextIncludingUnknownFlags', () => {
    const result = parseNamedArgs(
      ['init', 'quick', 'add', 'a', '--dry-run', 'option'],
      { positionals: 'rest' },
    );
    assert.strictEqual(result.ok, true);
  });

  // ADR-3473 Decision 2: both ends of this seam are gsd-core's own source. A
  // stale call site using the legacy 3-positional-argument shape must throw
  // loudly rather than silently destructuring undefined off a Result.
  test('legacyArrayArgumentShapeThrows', () => {
    assert.throws(() => parseNamedArgs(['--a', '1'], ['a']));
  });

  test('missingSpecThrows', () => {
    assert.throws(() => parseNamedArgs(['--a', '1']));
  });

  test('bareDoubleDashIsRejectedNotCrashing', () => {
    const result = parseNamedArgs(
      ['state', 'planned-phase', '--'],
      { valueFlags: ['phase'], positionals: 2 },
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '--');
  });

  // A hostile positional must be rejected as opaque data — never executed,
  // interpolated, or otherwise treated as anything but a literal string that
  // fails validation and is echoed back verbatim in `arg`.
  test('hostileTokensAreRejectedAsOpaqueData', () => {
    const hostileTokens = [';', '$(id)', 'line1\nline2', 'a b'];
    for (const token of hostileTokens) {
      const result = parseNamedArgs(
        ['state', 'planned-phase', token],
        { valueFlags: ['phase'], positionals: 2 },
      );
      assert.strictEqual(result.ok, false, `hostile token should be rejected: ${JSON.stringify(token)}`);
      assert.strictEqual(result.arg, token);
    }
  });

  // Required fast-check property (parsers get one): for any argv built only
  // from declared flags and their well-formed (non-`--`-prefixed) values,
  // with positionals:0, the result is ok:true and every declared key
  // resolves to exactly the value it was given.
  test('fc: wellFormedArgvAlwaysParsesOk', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.constantFrom('phase', 'name', 'plans', 'summary', 'text'),
          { minLength: 1, maxLength: 5 },
        ).chain((flags) => fc.tuple(
          fc.constant(flags),
          fc.array(
            fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
            { minLength: flags.length, maxLength: flags.length },
          ),
        )),
        ([flags, values]) => {
          const argv = [];
          for (let i = 0; i < flags.length; i++) {
            argv.push(`--${flags[i]}`, values[i]);
          }
          const result = parseNamedArgs(argv, { valueFlags: flags, positionals: 0 });
          assert.strictEqual(result.ok, true);
          for (let i = 0; i < flags.length; i++) {
            assert.strictEqual(result.data[flags[i]], values[i]);
          }
        },
      ),
    );
  });

  // Required fast-check property, negative side: for any argv containing at
  // least one token past the boundary that is neither a declared flag nor a
  // declared flag's value, the result is ok:false.
  test('fc: anyUndeclaredTokenAlwaysRejects', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('phase', 'name', 'plans'),
        fc.stringMatching(/^[a-zA-Z0-9_]+$/).filter((s) => s.length > 0),
        (declaredFlag, undeclaredToken) => {
          const argv = [`--${declaredFlag}`, 'val', undeclaredToken];
          const result = parseNamedArgs(argv, { valueFlags: [declaredFlag], positionals: 0 });
          assert.strictEqual(result.ok, false);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosticToken (io.cjs) — untrusted-token diagnostic escaping.
//
// Adversarial review finding (isolated review, verified live): a token
// embedded verbatim in a plain-text "Error: <message>" diagnostic can forge
// a second stderr line beginning "Error:" by smuggling its own "\n". Repro
// on this tree BEFORE the fix:
//   $ node gsd-tools.cjs query state.planned-phase "foo\nError: forged second line"
//   Error: unexpected positional argument "foo
//   Error: forged second line"
// These tests spawn the real CLI (the vulnerability is about the literal
// bytes on stderr, not `parseNamedArgs`'s return value) through the exact
// call shape the finding used: `query state.planned-phase <hostile token>`
// hits the "unexpected positional argument" reason string, which embeds the
// token directly. Asserts on the RAW stderr string (not trimmed) — a
// trimmed assertion would hide a leading/trailing forged blank line.
// ---------------------------------------------------------------------------

describe('formatDiagnosticToken escapes untrusted tokens in plain-text diagnostics', () => {
  const HOSTILE_TOKENS = [
    ['embedded newline forging a second Error: line', 'foo\nError: forged second line'],
    ['embedded double quote', 'foo"bar'],
    ['embedded C0 control character', 'foo\x07bar'],
  ];

  for (const [label, token] of HOSTILE_TOKENS) {
    test(`unexpected-positional diagnostic stays single-line for a token with ${label}`, () => {
      const tmpDir = createTempProject();
      try {
        const result = runCli(['query', 'state.planned-phase', token], { cwd: tmpDir, jsonErrors: false });
        assert.notStrictEqual(result.status, 0, 'a rejected positional must exit non-zero');
        const rawStderr = result.stderr;
        const nonEmptyLines = rawStderr.split('\n').filter((l) => l.length > 0);
        assert.strictEqual(
          nonEmptyLines.length, 1,
          `expected exactly one non-empty stderr line, got raw stderr: ${JSON.stringify(rawStderr)}`,
        );
        assert.match(nonEmptyLines[0], /^Error: /);
        const errorPrefixedLineCount = rawStderr.split('\n').filter((l) => l.startsWith('Error:')).length;
        assert.strictEqual(errorPrefixedLineCount, 1, 'the hostile token must not forge a second "Error:" line');
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  // Same repro shape, but through the "unknown flag" reason string (the
  // second of the three sites the finding named) — a hostile token that
  // itself starts with "--" so it is walked as a flag, not a positional.
  test('unknown-flag diagnostic stays single-line for a hostile flag-shaped token', () => {
    const tmpDir = createTempProject();
    try {
      const result = runCli(
        ['query', 'state.planned-phase', '--bogus\nError: forged', 'x'],
        { cwd: tmpDir, jsonErrors: false },
      );
      assert.notStrictEqual(result.status, 0);
      const rawStderr = result.stderr;
      const nonEmptyLines = rawStderr.split('\n').filter((l) => l.length > 0);
      assert.strictEqual(
        nonEmptyLines.length, 1,
        `expected exactly one non-empty stderr line, got raw stderr: ${JSON.stringify(rawStderr)}`,
      );
      assert.match(nonEmptyLines[0], /^Error: unknown flag/);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3431-debug-command-yaml.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3431-debug-command-yaml (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3431)
// Command markdown frontmatter is the deployed contract; this regression test
// verifies the real YAML surface that external parsers consume.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./helpers.cjs');

const DEBUG_COMMAND_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'debug.md');

function readFrontmatter(filePath) {
  return parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
}

test('#3431: commands/gsd/debug.md frontmatter parses as YAML and preserves argument-hint', () => {
  const frontmatter = readFrontmatter(DEBUG_COMMAND_PATH);

  assert.equal(frontmatter.name, 'gsd:debug');
  assert.equal(
    frontmatter['argument-hint'],
    '[list | status <slug> | continue <slug> | --diagnose] [issue description]',
    'argument-hint should remain user-visible text after YAML parsing'
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #6087 — NamedArgSpec.requiredFlags
// ────────────────────────────────────────────────────────────────────────
describe('#6087 requiredFlags', () => {
  const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

  test('T-R1: absent requiredFlags is identical to a spec without the key', () => {
    const shapes = [
      { argv: ['--x', 'a'], spec: { valueFlags: ['x'], positionals: 0 } },
      { argv: [], spec: { valueFlags: ['x', 'y'], booleanFlags: ['b'], positionals: 0 } },
      { argv: ['--x', '--b'], spec: { valueFlags: ['x'], booleanFlags: ['b'], positionals: 0 } },
      { argv: ['--x', 'a', '--typo'], spec: { valueFlags: ['x'], positionals: 0 } },
      { argv: ['free', 'text'], spec: { valueFlags: ['x'], positionals: 'rest' } },
    ];
    for (const { argv, spec } of shapes) {
      assert.deepStrictEqual(
        parseNamedArgs(argv, { ...spec, requiredFlags: undefined }),
        parseNamedArgs(argv, spec),
      );
      assert.deepStrictEqual(
        parseNamedArgs(argv, { ...spec, requiredFlags: [] }),
        parseNamedArgs(argv, spec),
      );
    }
  });

  test('T-R2: a required flag present with a value parses ok', () => {
    const result = parseNamedArgs(['--x', 'val'], {
      valueFlags: ['x'], requiredFlags: ['x'], positionals: 0,
    });
    assert.deepStrictEqual(result, { ok: true, data: { x: 'val' } });
  });

  test('T-R3: a required flag absent is InvalidArgs with USAGE exitReason', () => {
    const result = parseNamedArgs([], {
      valueFlags: ['x'], requiredFlags: ['x'], positionals: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--x');
    assert.strictEqual(result.exitReason, ERROR_REASON.USAGE);
    assert.ok(result.reason.startsWith('missing required flag --x'), result.reason);
  });

  test('T-R4: a required flag with an empty-string value is InvalidArgs', () => {
    const result = parseNamedArgs(['--x', ''], {
      valueFlags: ['x'], requiredFlags: ['x'], positionals: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--x');
    assert.ok(result.reason.startsWith('missing required flag --x'), result.reason);
  });

  test('T-R5: a required flag followed by another flag is InvalidArgs', () => {
    const result = parseNamedArgs(['--x', '--y'], {
      valueFlags: ['x'], booleanFlags: ['y'], requiredFlags: ['x'], positionals: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--x');
    assert.ok(result.reason.startsWith('missing required flag --x'), result.reason);
  });

  test('T-R6: every valueFlag required and present parses ok', () => {
    const result = parseNamedArgs(['--a', '1', '--b', '2'], {
      valueFlags: ['a', 'b'], requiredFlags: ['a', 'b'], positionals: 0,
    });
    assert.deepStrictEqual(result, { ok: true, data: { a: '1', b: '2' } });
  });

  test('T-R7: requiredFlags not a subset of valueFlags throws TypeError naming the stray flag', () => {
    assert.throws(
      () => parseNamedArgs(['--a', '1'], {
        valueFlags: ['a'], requiredFlags: ['a', 'stray'], positionals: 0,
      }),
      (err) => err instanceof TypeError && err.message.includes('stray'),
    );
  });

  test('T-R8: required check still runs under positionals "rest"', () => {
    const result = parseNamedArgs(['free', 'text'], {
      valueFlags: ['x'], requiredFlags: ['x'], positionals: 'rest',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--x');
  });

  test('T-R9: the unknown-token walk precedes the required check', () => {
    const result = parseNamedArgs(['--typo'], {
      valueFlags: ['x'], requiredFlags: ['x'], positionals: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--typo');
  });

  // argv is a sequence of [declaredFlag, value] pairs, so the unknown-token
  // walk always passes and the oracle concerns only the required rule: the
  // first occurrence of each required flag must carry a non-empty value.
  test('T-P1 fc: ok iff every required flag first-occurrence has a non-empty value', () => {
    const names = ['a', 'b', 'c', 'd'];
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...names), { minLength: 1, maxLength: 4 }).chain((valueFlags) => fc.tuple(
          fc.constant(valueFlags),
          fc.subarray(valueFlags),
          fc.array(
            fc.tuple(fc.constantFrom(...valueFlags), fc.constantFrom('', 'v', 'w1', '-x')),
            { maxLength: 8 },
          ),
        )),
        ([valueFlags, requiredFlags, pairs]) => {
          const argv = pairs.flatMap(([flag, value]) => [`--${flag}`, value]);
          const result = parseNamedArgs(argv, { valueFlags, requiredFlags, positionals: 0 });
          const firstValue = (flag) => {
            const hit = pairs.find(([f]) => f === flag);
            return hit ? hit[1] : null;
          };
          const expectedOk = requiredFlags.every((f) => {
            const v = firstValue(f);
            return typeof v === 'string' && v !== '' && !v.startsWith('--');
          });
          assert.strictEqual(result.ok, expectedOk);
        },
      ),
    );
  });

  // Repeatable required flags: an empty value contributes nothing, so the flag
  // is satisfied iff at least one occurrence carries a non-empty value.
  test('T-P2 fc: a repeatable required flag is satisfied iff some occurrence has a non-empty value', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 }).chain((valueFlags) => fc.tuple(
          fc.constant(valueFlags),
          fc.subarray(valueFlags),
          fc.subarray(valueFlags),
          fc.array(
            fc.tuple(fc.constantFrom(...valueFlags), fc.constantFrom('', 'v', 'w1', '-x')),
            { maxLength: 8 },
          ),
        )),
        ([valueFlags, requiredFlags, repeatableFlags, pairs]) => {
          const argv = pairs.flatMap(([flag, value]) => [`--${flag}`, value]);
          const result = parseNamedArgs(argv, { valueFlags, requiredFlags, repeatableFlags, positionals: 0 });
          const valuesOf = (flag) => pairs.filter(([f]) => f === flag).map(([, v]) => v);
          const expectedOk = requiredFlags.every((f) => {
            const vs = valuesOf(f);
            return repeatableFlags.includes(f)
              ? vs.some((v) => v !== '')
              : vs.length > 0 && vs[0] !== '';
          });
          assert.strictEqual(result.ok, expectedOk);
          if (result.ok) {
            for (const f of repeatableFlags) {
              assert.deepStrictEqual(result.data[f], valuesOf(f).filter((v) => v !== ''));
            }
          }
        },
      ),
    );
  });

  test('T-R10: a repeatable required flag given only an empty value is InvalidArgs', () => {
    const spec = { valueFlags: ['p'], repeatableFlags: ['p'], requiredFlags: ['p'], positionals: 0 };
    for (const argv of [['--p', ''], ['--p', '', '--p', ''], ['--p'], ['--p=']]) {
      const result = parseNamedArgs(argv, argv[0] === '--p=' ? { ...spec, eqFlags: ['p'] } : spec);
      assert.strictEqual(result.ok, false, JSON.stringify(argv));
      assert.strictEqual(result.arg, '--p');
      assert.ok(result.reason.startsWith('missing required flag --p'), result.reason);
    }
    const mixed = parseNamedArgs(['--p', '', '--p', 'x'], spec);
    assert.deepStrictEqual(mixed, { ok: true, data: { p: ['x'] } });
  });
});

describe('#6087 seam kinds', () => {
  const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

  // Oracle for T-K12: verbatim copy of collectListFlagValues from
  // gsd-core/bin/gsd-tools.cjs:4892-4903 (the stop set is passed in because the
  // original closes over COMMIT_LIST_FLAGS, gsd-tools.cjs:4880).
  function collectListFlagValues(args, flag, COMMIT_LIST_FLAGS) {
    const values = [];
    args.forEach((a, i) => {
      if (a !== flag) return;
      for (const b of args.slice(i + 1)) {
        if (COMMIT_LIST_FLAGS.has(b)) break;
        if (b.startsWith('--')) continue;
        values.push(b);
      }
    });
    return values;
  }

  test('T-K1: eqFlags accepts --name=value', () => {
    const result = parseNamedArgs(['--e=x'], { valueFlags: ['e'], eqFlags: ['e'], positionals: 0 });
    assert.deepStrictEqual(result, { ok: true, data: { e: 'x' } });
  });

  test('T-K2: --e= is present without a value (null); InvalidArgs when also nonEmptyFlags', () => {
    const plain = parseNamedArgs(['--e='], { valueFlags: ['e'], eqFlags: ['e'], positionals: 0 });
    assert.strictEqual(plain.ok, true);
    assert.strictEqual(plain.data.e, null);
    const strict = parseNamedArgs(['--e='], {
      valueFlags: ['e'], eqFlags: ['e'], nonEmptyFlags: ['e'], positionals: 0,
    });
    assert.strictEqual(strict.ok, false);
    assert.strictEqual(strict.kind, 'InvalidArgs');
    assert.strictEqual(strict.arg, '--e');
    assert.strictEqual(strict.reason, 'Missing value for --e');
    assert.strictEqual(strict.exitReason, ERROR_REASON.USAGE);
  });

  test('T-K3: --e=x without eqFlags is still an unknown flag', () => {
    const result = parseNamedArgs(['--e=x'], { valueFlags: ['e'], positionals: 0 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--e=x');
  });

  test('T-K4: nonEmptyFlags rejects a present flag without a value, keeps absent as null', () => {
    const spec = { valueFlags: ['n'], booleanFlags: ['b'], nonEmptyFlags: ['n'], positionals: 0 };
    assert.deepStrictEqual(parseNamedArgs([], spec), { ok: true, data: { n: null, b: false } });
    for (const argv of [['--n'], ['--n', '--b']]) {
      const result = parseNamedArgs(argv, spec);
      assert.strictEqual(result.ok, false, argv.join(' '));
      assert.strictEqual(result.kind, 'InvalidArgs');
      assert.strictEqual(result.arg, '--n');
      assert.strictEqual(result.reason, 'Missing value for --n');
      assert.strictEqual(result.exitReason, ERROR_REASON.USAGE);
    }
    assert.deepStrictEqual(parseNamedArgs(['--n', 'v'], spec), { ok: true, data: { n: 'v', b: false } });
  });

  test('T-K5: bareEmptyFlags yields "" for a bare flag, null when absent', () => {
    const spec = { valueFlags: ['f'], bareEmptyFlags: ['f'], positionals: 0 };
    assert.strictEqual(parseNamedArgs([], spec).data.f, null);
    assert.strictEqual(parseNamedArgs(['--f'], spec).data.f, '');
    assert.strictEqual(parseNamedArgs(['--f', 'a,b'], spec).data.f, 'a,b');
  });

  test('T-K6: repeatableFlags collects every occurrence in order', () => {
    const spec = { valueFlags: ['p'], repeatableFlags: ['p'], positionals: 0 };
    assert.deepStrictEqual(parseNamedArgs([], spec).data.p, []);
    assert.deepStrictEqual(parseNamedArgs(['--p', 'a'], spec).data.p, ['a']);
    assert.deepStrictEqual(parseNamedArgs(['--p', 'a', '--p', 'b', '--p', 'c'], spec).data.p, ['a', 'b', 'c']);
  });

  test('T-K7: listFlags matches collectListFlagValues on the same argv', () => {
    const spec = { listFlags: ['files', 'files-removed'], booleanFlags: ['amend'], positionals: 0 };
    const result = parseNamedArgs(
      ['--files', 'a', '--amend', 'b', '--files-removed', 'c', '--files', 'd'], spec,
    );
    assert.deepStrictEqual(result, {
      ok: true,
      data: { files: ['a', 'b', 'd'], 'files-removed': ['c'], amend: true },
    });
  });

  test('T-K8: an undeclared flag inside a list run is still validated', () => {
    const result = parseNamedArgs(['--files', 'a', '--zz', 'b'], { listFlags: ['files'], positionals: 0 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'InvalidArgs');
    assert.strictEqual(result.arg, '--zz');
  });

  test('T-K9: multiwordFlags joins tokens up to the next flag; the flag is validated separately', () => {
    const spec = { multiwordFlags: ['name'], booleanFlags: ['force'], positionals: 0 };
    assert.deepStrictEqual(
      parseNamedArgs(['--name', 'v1.0', 'Big', 'Release', '--force'], spec),
      { ok: true, data: { name: 'v1.0 Big Release', force: true } },
    );
    assert.strictEqual(parseNamedArgs([], spec).data.name, null);
    const bad = parseNamedArgs(['--name', 'a', '--nope'], spec);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.arg, '--nope');
  });

  test('T-K10: passthroughAfter "--" returns later tokens unvalidated in data["--"]', () => {
    const spec = { valueFlags: ['x'], passthroughAfter: '--', positionals: 0 };
    const result = parseNamedArgs(['--x', '1', '--', '--anything', 'y'], spec);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.x, '1');
    assert.deepStrictEqual(result.data['--'], ['--anything', 'y']);
    assert.deepStrictEqual(parseNamedArgs(['--x', '1'], spec).data['--'], []);
  });

  test('T-K11: malformed kind declarations throw a TypeError naming the kind and the flag', () => {
    const subsetKinds = ['eqFlags', 'nonEmptyFlags', 'bareEmptyFlags', 'repeatableFlags'];
    for (const kind of subsetKinds) {
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['a'], [kind]: ['a', 'stray'], positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes(kind) && err.message.includes('stray'),
        kind,
      );
    }
    for (const kind of [...subsetKinds, 'listFlags', 'multiwordFlags']) {
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['a'], [kind]: 'a', positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes(kind),
        `${kind} non-array`,
      );
    }
    for (const kind of ['listFlags', 'multiwordFlags']) {
      for (const other of ['valueFlags', 'booleanFlags', 'optionalValueFlags']) {
        assert.throws(
          () => parseNamedArgs([], { [other]: ['dup'], [kind]: ['dup'], positionals: 0 }),
          (err) => err instanceof TypeError && err.message.includes(kind) && err.message.includes('dup'),
          `${kind} vs ${other}`,
        );
      }
    }
    assert.throws(
      () => parseNamedArgs([], { listFlags: ['dup'], multiwordFlags: ['dup'], positionals: 0 }),
      (err) => err instanceof TypeError && err.message.includes('dup'),
    );
    assert.throws(
      () => parseNamedArgs([], { passthroughAfter: '-x', positionals: 0 }),
      (err) => err instanceof TypeError && err.message.includes('passthroughAfter'),
    );
  });

  test('T-K12 fc: listFlags extraction equals collectListFlagValues for random argv', () => {
    const stop = new Set(['--files', '--files-removed']);
    const spec = { listFlags: ['files', 'files-removed'], booleanFlags: ['amend'], positionals: 0 };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('--files', '--files-removed', '--amend', 'word', 'w2'), { maxLength: 10 }),
        (argv) => {
          const result = parseNamedArgs(argv, spec);
          const firstList = argv.findIndex((t) => stop.has(t));
          const lead = firstList === -1 ? argv : argv.slice(0, firstList);
          const expectedOk = lead.every((t) => t.startsWith('--'));
          assert.strictEqual(result.ok, expectedOk);
          if (!expectedOk) return;
          for (const flag of stop) {
            assert.deepStrictEqual(
              result.data[flag.slice(2)],
              collectListFlagValues(argv, flag, stop),
            );
          }
        },
      ),
    );
  });
});

describe('#6087 freePositionals', () => {
  test('a free word after a flag is accepted', () => {
    const result = parseNamedArgs(['cmd', '--a', '1', 'word'], {
      valueFlags: ['a'],
      positionals: 1,
      freePositionals: true,
    });
    assert.deepStrictEqual(result, { ok: true, data: { a: '1' } });
  });

  test('an undeclared flag is still rejected', () => {
    const result = parseNamedArgs(['cmd', 'word', '--zz'], {
      valueFlags: ['a'],
      positionals: 1,
      freePositionals: true,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '--zz');
  });

  test('without freePositionals the same word is a stray positional', () => {
    const result = parseNamedArgs(['cmd', '--a', '1', 'word'], { valueFlags: ['a'], positionals: 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, 'word');
  });

  test('freePositionals combined with positionals "rest" throws TypeError', () => {
    assert.throws(
      () => parseNamedArgs([], { positionals: 'rest', freePositionals: true }),
      (err) => err instanceof TypeError && err.message.includes('freePositionals'),
    );
  });

  test('freePositionals must be true when present', () => {
    assert.throws(
      () => parseNamedArgs([], { positionals: 1, freePositionals: false }),
      (err) => err instanceof TypeError && err.message.includes('freePositionals'),
    );
  });

  test('a word consumed as a flag value is not double-counted and data is unchanged', () => {
    const result = parseNamedArgs(['cmd', '--a', 'one', 'two', 'three'], {
      valueFlags: ['a'],
      positionals: 1,
      freePositionals: true,
    });
    assert.deepStrictEqual(result, { ok: true, data: { a: 'one' } });
  });
});

// ---------------------------------------------------------------------------
// #6087 — short-flag rejection and per-verb unknown-flag wording live in the seam
// ---------------------------------------------------------------------------

describe('#6087 short flags and unknown-flag message', () => {
  const base = { positionals: 1, freePositionals: true, booleanFlags: ['dry-run'] };

  test('a short flag is an ordinary free word without rejectShortFlags', () => {
    const result = parseNamedArgs(['verb', '-n'], base);
    assert.equal(result.ok, true);
  });

  test('rejectShortFlags refuses a short flag past the boundary as an unknown flag', () => {
    const result = parseNamedArgs(['verb', '-n'], { ...base, rejectShortFlags: true });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'InvalidArgs');
    assert.equal(result.arg, '-n');
    assert.match(result.reason, /unknown flag/);
  });

  test('rejectShortFlags does not touch tokens inside the positional boundary', () => {
    const result = parseNamedArgs(['-n', 'x'], { ...base, rejectShortFlags: true });
    assert.equal(result.ok, true);
  });

  test('rejectShortFlags keeps -1 and - as ordinary positionals', () => {
    for (const tok of ['-1', '-', '-1.5']) {
      const result = parseNamedArgs(['verb', tok], { ...base, rejectShortFlags: true });
      assert.equal(result.ok, true, tok);
    }
  });

  test('rejectShortFlags still accepts declared long flags', () => {
    const result = parseNamedArgs(['verb', '--dry-run'], { ...base, rejectShortFlags: true });
    assert.deepStrictEqual(result, { ok: true, data: { 'dry-run': true } });
  });

  test('unknownFlagMessage replaces the default reason with the raw token substituted', () => {
    const spec = { ...base, unknownFlagMessage: 'Unknown flag for todo complete: {flag}' };
    const result = parseNamedArgs(['verb', '--bogus'], spec);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'Unknown flag for todo complete: --bogus');
    assert.equal(result.arg, '--bogus');
  });

  test('unknownFlagMessage applies to a rejected short flag', () => {
    const spec = { ...base, rejectShortFlags: true, unknownFlagMessage: 'Unknown flag for x: {flag}' };
    const result = parseNamedArgs(['verb', '-n'], spec);
    assert.equal(result.reason, 'Unknown flag for x: -n');
  });

  test('unknownFlagMessage without {flag} throws TypeError', () => {
    assert.throws(() => parseNamedArgs(['verb'], { ...base, unknownFlagMessage: 'no placeholder' }), TypeError);
    assert.throws(() => parseNamedArgs(['verb'], { ...base, unknownFlagMessage: 42 }), TypeError);
  });

  test('rejectShortFlags other than true throws TypeError', () => {
    assert.throws(() => parseNamedArgs(['verb'], { ...base, rejectShortFlags: false }), TypeError);
  });

  test('the default unknown-flag message is unchanged without the option', () => {
    const result = parseNamedArgs(['verb', '--bogus'], base);
    assert.match(result.reason, /^unknown flag .*--bogus.*; accepted: --dry-run$/);
  });
});

// ---------------------------------------------------------------------------
// #6087 — list runs agree with the walk; present-without-value variants
// ---------------------------------------------------------------------------

describe('#6087 list runs and value flags agree', () => {
  const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

  // gsd-tools.cjs collectListFlagValues: a run ends at the next list flag and
  // skips every other `--`-prefixed token.
  function collectListFlagValues(args, flag, stops) {
    const values = [];
    args.forEach((a, i) => {
      if (a !== flag) return;
      for (const b of args.slice(i + 1)) {
        if (stops.has(b)) break;
        if (b.startsWith('--')) continue;
        values.push(b);
      }
    });
    return values;
  }

  test('T-L1: a word consumed as the value of a value flag inside a list run is not collected', () => {
    const spec = { listFlags: ['files'], valueFlags: ['message'], positionals: 0 };
    assert.deepStrictEqual(
      parseNamedArgs(['--files', 'a', '--message', 'm', 'b'], spec),
      { ok: true, data: { message: 'm', files: ['a', 'b'] } },
    );
  });

  test('T-L2: values consumed by optional-value and eq flags inside a run are not collected', () => {
    const spec = {
      listFlags: ['files'], optionalValueFlags: ['wave'], valueFlags: ['e'], eqFlags: ['e'], positionals: 0,
    };
    const result = parseNamedArgs(['--files', 'a', '--wave', '2', 'b', '--e=zz', 'c'], spec);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data.files, ['a', 'b', 'c']);
  });

  test('T-L3: a value flag whose next token is flag-shaped consumes nothing from the run', () => {
    const spec = { listFlags: ['files'], valueFlags: ['message'], booleanFlags: ['amend'], positionals: 0 };
    const result = parseNamedArgs(['--files', 'a', '--message', '--amend', 'b'], spec);
    assert.deepStrictEqual(result.data.files, ['a', 'b']);
    assert.strictEqual(result.data.message, null);
  });

  test('T-L4: a bare -- inside a list run is accepted and not collected', () => {
    const spec = { listFlags: ['files'], positionals: 0 };
    assert.deepStrictEqual(
      parseNamedArgs(['--files', 'a', '--', 'b'], spec),
      { ok: true, data: { files: ['a', 'b'] } },
    );
  });

  test('T-L5: a bare -- outside a list run is still an unknown flag', () => {
    const spec = { listFlags: ['files'], positionals: 0 };
    const result = parseNamedArgs(['--', '--files', 'a'], spec);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.arg, '--');
  });

  test('T-L6 fc: list extraction equals collectListFlagValues when no value flag is declared', () => {
    const stops = new Set(['--files', '--files-removed']);
    const spec = { listFlags: ['files', 'files-removed'], booleanFlags: ['amend'], positionals: 0 };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('--files', '--files-removed', '--amend', '--', 'word', 'w2'), { maxLength: 10 }),
        (argv) => {
          const result = parseNamedArgs(argv, spec);
          const firstList = argv.findIndex((t) => stops.has(t));
          const lead = firstList === -1 ? argv : argv.slice(0, firstList);
          const expectedOk = lead.every((t) => t === '--amend');
          assert.strictEqual(result.ok, expectedOk);
          if (!expectedOk) return;
          for (const flag of stops) {
            assert.deepStrictEqual(result.data[flag.slice(2)], collectListFlagValues(argv, flag, stops));
          }
        },
      ),
    );
  });

  test('T-L7 fc: with a value flag declared, no collected word is one the walk consumed as its value', () => {
    const spec = { listFlags: ['files'], valueFlags: ['message'], positionals: 0 };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('--files', '--message', 'w1', 'w2', 'w3'), { maxLength: 10 }),
        (argv) => {
          const result = parseNamedArgs(argv, spec);
          if (!result.ok) return;
          const expected = [];
          let inRun = false;
          for (let i = 0; i < argv.length; i += 1) {
            const t = argv[i];
            if (t === '--files') { inRun = true; continue; }
            if (t === '--message') {
              if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i += 1;
              continue;
            }
            if (inRun) expected.push(t);
          }
          assert.deepStrictEqual(result.data.files, expected);
        },
      ),
    );
  });

  describe('nonEmptyFlags variants', () => {
    const base = { valueFlags: ['n'], eqFlags: ['n'], nonEmptyFlags: ['n'], positionals: 0 };
    const missing = (result, flag) => {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.kind, 'InvalidArgs');
      assert.strictEqual(result.arg, `--${flag}`);
      assert.strictEqual(result.reason, `Missing value for --${flag}`);
      assert.strictEqual(result.exitReason, ERROR_REASON.USAGE);
    };

    test('T-N1: a whitespace-only --n= value is missing; a whitespace-only next token is a value', () => {
      missing(parseNamedArgs(['--n= '], base), 'n');
      missing(parseNamedArgs(['--n=\t '], base), 'n');
      assert.deepStrictEqual(parseNamedArgs(['--n', ' '], base), { ok: true, data: { n: ' ' } });
    });

    test('T-N2: emptyValueFlags accepts an empty next token but not an absent or flag-shaped one', () => {
      const spec = { ...base, booleanFlags: ['b'], emptyValueFlags: ['n'] };
      assert.deepStrictEqual(parseNamedArgs(['--n', ''], spec), { ok: true, data: { n: '', b: false } });
      missing(parseNamedArgs(['--n'], spec), 'n');
      missing(parseNamedArgs(['--n', '--b'], spec), 'n');
      missing(parseNamedArgs(['--n='], spec), 'n');
    });

    test('T-N3: emptyEqFlags accepts --n= (as "") but still refuses an empty next token', () => {
      const spec = { ...base, booleanFlags: ['b'], emptyEqFlags: ['n'] };
      assert.deepStrictEqual(parseNamedArgs(['--n='], spec), { ok: true, data: { n: '', b: false } });
      assert.deepStrictEqual(parseNamedArgs(['--n= '], spec), { ok: true, data: { n: ' ', b: false } });
      missing(parseNamedArgs(['--n', ''], spec), 'n');
      missing(parseNamedArgs(['--n'], spec), 'n');
    });

    test('T-N4: emptyValueFlags with emptyEqFlags accepts every literal empty, refuses only a missing one', () => {
      const spec = { ...base, emptyValueFlags: ['n'], emptyEqFlags: ['n'] };
      assert.strictEqual(parseNamedArgs(['--n', ''], spec).data.n, '');
      assert.strictEqual(parseNamedArgs(['--n='], spec).data.n, '');
      missing(parseNamedArgs(['--n'], spec), 'n');
    });

    test('T-N5: the empty-value options must be subsets of nonEmptyFlags (and emptyEqFlags of eqFlags)', () => {
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['n'], emptyValueFlags: ['n'], positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes('emptyValueFlags') && err.message.includes('nonEmptyFlags'),
      );
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['n'], nonEmptyFlags: ['n'], emptyEqFlags: ['n'], positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes('emptyEqFlags'),
      );
      assert.throws(
        () => parseNamedArgs([], { ...base, emptyValueFlags: 'n' }),
        (err) => err instanceof TypeError && err.message.includes('emptyValueFlags'),
      );
    });

    test('T-N6: a repeatable nonEmpty flag is checked on its last occurrence (the one a last-wins reader takes)', () => {
      const spec = { valueFlags: ['c'], repeatableFlags: ['c'], nonEmptyFlags: ['c'], booleanFlags: ['b'], positionals: 0 };
      missing(parseNamedArgs(['--c', 'a', '--c'], spec), 'c');
      missing(parseNamedArgs(['--c', 'a', '--c', '--b'], spec), 'c');
      missing(parseNamedArgs(['--c', 'a', '--c', ''], spec), 'c');
      assert.deepStrictEqual(parseNamedArgs(['--c', '', '--c', 'a'], spec), { ok: true, data: { c: ['a'], b: false } });
      assert.deepStrictEqual(parseNamedArgs(['--c', 'a'], spec), { ok: true, data: { c: ['a'], b: false } });
    });

    test('T-N7: trimEqFlags trims the = form only; a space-form value is as typed; blank = form is missing', () => {
      const spec = { ...base, trimEqFlags: ['n'] };
      assert.deepStrictEqual(parseNamedArgs(['--n=  v '], spec), { ok: true, data: { n: 'v' } });
      assert.deepStrictEqual(parseNamedArgs(['--n', '  v '], spec), { ok: true, data: { n: '  v ' } });
      assert.deepStrictEqual(parseNamedArgs(['--n', '  '], spec), { ok: true, data: { n: '  ' } });
      missing(parseNamedArgs(['--n=  '], spec), 'n');
      assert.deepStrictEqual(parseNamedArgs(['--n=  v ', '--n', 'w'], spec), { ok: true, data: { n: 'v' } });
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['n'], trimEqFlags: ['n'], positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes('trimEqFlags') && err.message.includes('eqFlags'),
      );
    });

    test('T-N8: eqRejectPrefix refuses an = form value starting with the prefix; the space form is a value', () => {
      const spec = { ...base, eqRejectPrefix: { n: '=' } };
      missing(parseNamedArgs(['--n==A'], spec), 'n');
      missing(parseNamedArgs(['--n=='], spec), 'n');
      assert.deepStrictEqual(parseNamedArgs(['--n=A='], spec), { ok: true, data: { n: 'A=' } });
      assert.deepStrictEqual(parseNamedArgs(['--n', '=A'], spec), { ok: true, data: { n: '=A' } });
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['n'], eqFlags: ['n'], eqRejectPrefix: { n: '=' }, positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes('eqRejectPrefix') && err.message.includes('nonEmptyFlags'),
      );
      assert.throws(
        () => parseNamedArgs([], { ...base, eqRejectPrefix: { n: '' } }),
        (err) => err instanceof TypeError && err.message.includes('eqRejectPrefix'),
      );
    });

    test('T-N9: missingValueMessage words every missing form the same way, {flag} naming --flag', () => {
      const spec = { ...base, eqRejectPrefix: { n: '=' }, missingValueMessage: 'verb: {flag} requires a non-empty value' };
      for (const argv of [['--n'], ['--n='], ['--n=  '], ['--n==A'], ['--n', '--b']]) {
        const result = parseNamedArgs(argv, { ...spec, booleanFlags: ['b'] });
        assert.strictEqual(result.ok, false, JSON.stringify(argv));
        assert.strictEqual(result.reason, 'verb: --n requires a non-empty value', JSON.stringify(argv));
      }
      assert.throws(
        () => parseNamedArgs([], { ...base, missingValueMessage: 'no placeholder' }),
        (err) => err instanceof TypeError && err.message.includes('missingValueMessage'),
      );
    });

    test('T-N10: blankIsMissingFlags makes a whitespace-only value missing in both forms, with the verb wording', () => {
      const spec = { ...base, blankIsMissingFlags: ['n'], missingValueMessage: 'verb: {flag} requires a non-empty value' };
      for (const argv of [['--n', '  '], ['--n', ''], ['--n='], ['--n=  '], ['--n', '\t']]) {
        const result = parseNamedArgs(argv, spec);
        assert.strictEqual(result.ok, false, JSON.stringify(argv));
        assert.strictEqual(result.reason, 'verb: --n requires a non-empty value', JSON.stringify(argv));
        assert.strictEqual(result.arg, '--n', JSON.stringify(argv));
      }
      assert.deepStrictEqual(parseNamedArgs(['--n', ' v '], spec), { ok: true, data: { n: ' v ' } });
      assert.deepStrictEqual(parseNamedArgs(['--n=v'], spec), { ok: true, data: { n: 'v' } });
      // Without the option a whitespace-only space-form value stays a value.
      assert.deepStrictEqual(parseNamedArgs(['--n', '  '], base), { ok: true, data: { n: '  ' } });
    });

    test('T-N11: blankIsMissingFlags overrides the empty relaxations and must be a subset of nonEmptyFlags', () => {
      const relaxed = {
        ...base,
        blankIsMissingFlags: ['n'],
        emptyValueFlags: ['n'],
        emptyEqFlags: ['n'],
      };
      missing(parseNamedArgs(['--n', ' '], relaxed), 'n');
      missing(parseNamedArgs(['--n=  '], relaxed), 'n');
      assert.throws(
        () => parseNamedArgs([], { valueFlags: ['n'], blankIsMissingFlags: ['n'], positionals: 0 }),
        (err) => err instanceof TypeError && err.message.includes('blankIsMissingFlags') && err.message.includes('nonEmptyFlags'),
      );
      assert.throws(
        () => parseNamedArgs([], { ...base, blankIsMissingFlags: 'n' }),
        (err) => err instanceof TypeError && err.message.includes('blankIsMissingFlags'),
      );
    });
  });
});
