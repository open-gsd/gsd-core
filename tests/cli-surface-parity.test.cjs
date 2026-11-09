'use strict';

/**
 * CLI surface parity (#6087, P1a of #6051). Matrix rows T-C1..T-C4, T-D1..T-D6.
 *
 * Coverage: every dispatchable verb is declared in CLI_SURFACE or listed in UNDECLARED_VERBS.
 * Dispatch: the manifest and real gsd-tools dispatch agree, in both directions (undeclared flag
 * rejected, declared flag accepted, required flag enforced). The `parityProblems` helper is pure so
 * the positive controls T-D5/T-D6 can prove it reports a disagreement.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  CLI_SURFACE,
  UNDECLARED_VERBS,
  verbUniverse,
} = require('../gsd-core/bin/lib/cli-surface.cjs');
const { hostCommandNames } = require('../gsd-core/bin/gsd-tools.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { buildManifest } = require('../scripts/gen-cli-surface-manifest.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const UNDECLARED_BASELINE = 0; // set by the P1a implementation commit to the P1a count, lowered by each later sub-PR (#6088-#6090)
const SENTINEL = '--zz-undeclared-6051';
const USAGE = ERROR_REASON.USAGE; // src/io.cts:401 -> 'usage'

// ─── pure parity logic ─────────────────────────────────────────────────────

/** Argv for a manifest verb: verb tokens, numeric positionals as 'x', every required flag = 'v'. */
function baseArgv(mv) {
  const argv = mv.verb.split('.');
  if (typeof mv.positionals === 'number') {
    for (let i = 0; i < mv.positionals; i += 1) argv.push('x');
  }
  return argv;
}

function requiredArgv(mv) {
  const argv = baseArgv(mv);
  for (const f of mv.required) argv.push(`--${f}`, 'v');
  return argv;
}

/**
 * Compare a manifest verb with observed dispatch behavior.
 * @param {object} mv manifest verb entry
 * @param {(argv: string[]) => {usage: boolean, names: string|null, message?: string}} observe
 * @returns {string[]} problems (empty when dispatch and manifest agree)
 */
function parityProblems(mv, observe) {
  const problems = [];
  const argv = requiredArgv(mv);
  const rest = mv.positionals === 'rest';

  if (!rest) {
    // T-D1: an undeclared flag is rejected as usage and the rejection names it.
    const d1 = observe([...argv, SENTINEL]);
    if (!d1.usage || d1.names !== SENTINEL) {
      problems.push(`${mv.verb}: undeclared ${SENTINEL} not rejected as usage naming it (got usage=${d1.usage} names=${d1.names})`);
    }
    // T-D2: each declared flag is accepted (the sentinel after it is what gets named).
    for (const [flag, kind] of Object.entries(mv.flags)) {
      if (mv.required.includes(flag)) continue;
      const tokens = kind === 'value' ? [`--${flag}`, 'v'] : [`--${flag}`];
      const d2 = observe([...argv, ...tokens, SENTINEL]);
      if (!d2.usage || d2.names !== SENTINEL) {
        problems.push(`${mv.verb}: declared --${flag} not accepted (rejection named ${d2.names})`);
      }
    }
  }

  // T-D3 / T-D4: each required flag omitted, or given an empty value, is a usage rejection naming it.
  for (const f of mv.required) {
    const others = [];
    for (const g of mv.required) if (g !== f) others.push(`--${g}`, 'v');
    const omitted = observe([...baseArgv(mv), ...others]);
    const empty = observe([...baseArgv(mv), ...others, `--${f}`, '']);
    for (const [label, got] of [['omitted', omitted], ['empty', empty]]) {
      if (!got.usage || got.names !== `--${f}`) {
        problems.push(`${mv.verb}: required --${f} ${label} not rejected naming it (got usage=${got.usage} names=${got.names})`);
      }
    }
  }
  return problems;
}

// ─── real dispatch observer ────────────────────────────────────────────────

function lastJsonLine(text) {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  return null;
}

function makeObserver(cwd) {
  return (argv) => {
    const r = runTools(['--json-errors', ...argv], cwd);
    const body = lastJsonLine(r.stderr) ?? lastJsonLine(r.stdout);
    if (!body || body.ok !== false) return { usage: false, names: null, message: '' };
    const message = String(body.message ?? '');
    const m = /--[A-Za-z0-9][A-Za-z0-9-]*/.exec(message);
    return { usage: body.reason === USAGE, names: m ? m[0] : null, message };
  };
}

// ─── T-C: coverage and ratchet ─────────────────────────────────────────────

describe('verb universe coverage', () => {
  test('T-C1: every dispatchable verb is declared or listed as undeclared', () => {
    const universe = new Set(verbUniverse());
    const covered = new Set([...Object.keys(CLI_SURFACE), ...UNDECLARED_VERBS]);
    const missing = [...universe].filter((v) => !covered.has(v)).sort();
    const stale = [...covered].filter((v) => !universe.has(v)).sort();
    assert.deepEqual(
      { missingFromRegistry: missing, notDispatchable: stale },
      { missingFromRegistry: [], notDispatchable: [] },
      `universe verbs not declared nor undeclared: ${missing.join(', ')}; registry verbs not in universe: ${stale.join(', ')}`,
    );
  });

  test('T-C1: every HOST_COMMAND_ROUTERS key is in the verb universe', () => {
    const universe = new Set(verbUniverse());
    const absent = hostCommandNames().filter((n) => !universe.has(n));
    assert.deepEqual(absent, [], `host commands missing from verbUniverse(): ${absent.join(', ')}`);
  });

  test('T-C2: no verb is both declared and undeclared', () => {
    const both = UNDECLARED_VERBS.filter((v) => Object.prototype.hasOwnProperty.call(CLI_SURFACE, v));
    assert.deepEqual(both, []);
  });

  test('T-C3: UNDECLARED_VERBS never grows past the baseline', () => {
    assert.ok(
      UNDECLARED_VERBS.length <= UNDECLARED_BASELINE,
      `UNDECLARED_VERBS has ${UNDECLARED_VERBS.length} entries, baseline ${UNDECLARED_BASELINE}`,
    );
  });

  test('T-C4: UNDECLARED_VERBS has no duplicates', () => {
    assert.equal(new Set(UNDECLARED_VERBS).size, UNDECLARED_VERBS.length);
  });
});

// ─── T-D5 / T-D6: positive controls ────────────────────────────────────────

describe('parityProblems positive controls', () => {
  const mv = {
    verb: 'fake.verb',
    aliases: [],
    positionals: 0,
    flags: { alpha: 'value', beta: 'boolean', need: 'value' },
    required: ['need'],
    workstreamScoped: false,
  };

  // Faithful fake: rejects exactly the sentinel and enforces `need`.
  function faithful(argv) {
    if (argv.includes(SENTINEL)) return { usage: true, names: SENTINEL };
    const i = argv.indexOf('--need');
    if (i === -1 || argv[i + 1] === undefined || argv[i + 1] === '') return { usage: true, names: '--need' };
    return { usage: false, names: null };
  }

  test('faithful dispatch yields no problems', () => {
    assert.deepEqual(parityProblems(mv, faithful), []);
  });

  test('T-D5: dispatch that rejects a manifest-declared flag is reported', () => {
    const rejectsAlpha = (argv) => (argv.includes('--alpha') ? { usage: true, names: '--alpha' } : faithful(argv));
    const problems = parityProblems(mv, rejectsAlpha);
    assert.ok(problems.some((p) => p.includes('--alpha')), problems.join('\n'));
  });

  test('T-D6: dispatch that accepts an undeclared flag is reported', () => {
    const acceptsAnything = (argv) => (argv.includes(SENTINEL) ? { usage: false, names: null } : faithful(argv));
    const problems = parityProblems(mv, acceptsAnything);
    assert.ok(problems.some((p) => p.includes(SENTINEL)), problems.join('\n'));
  });

  test('dispatch that does not enforce a required flag is reported', () => {
    const lax = (argv) => (argv.includes(SENTINEL) ? { usage: true, names: SENTINEL } : { usage: false, names: null });
    const problems = parityProblems(mv, lax);
    assert.ok(problems.some((p) => p.includes('--need')), problems.join('\n'));
  });
});

// ─── T-D1..T-D4: real dispatch ─────────────────────────────────────────────

describe('manifest agrees with real dispatch', () => {
  let tmpProject;
  let observe;
  before(() => {
    tmpProject = createTempProject();
    observe = makeObserver(tmpProject);
  });
  after(() => {
    if (tmpProject) cleanup(tmpProject);
  });

  const verbs = buildManifest().verbs.filter((v) => !v.thirdParty);
  assert.ok(verbs.length > 0, 'manifest must declare at least one verb');

  for (const mv of verbs) {
    test(`T-D1..T-D4: ${mv.verb}`, () => {
      const problems = parityProblems(mv, observe);
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  }
});
