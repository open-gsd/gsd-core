'use strict';

/**
 * U1 — in-process GateVerdict tests for `check decision-coverage-plan` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-decision-coverage-plan.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateDecisionCoveragePlan({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check decision-coverage-plan`)
 * on origin/next in a fixture project; the tests compare the deep value AND the serialized key
 * order (stdout is byte-identical only if the payload's insertion order is preserved).
 * `outcome`/`block` are the new GateVerdict fields; their mapping from today's payload is
 * recorded per case (see 50-test-matrix.md, API contract).
 *
 * Each case also asserts the gate never writes to process.stdout / process.stderr: only the
 * router formats output (design D2).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { tempRootAliases, canonicalizeTempPaths } = require('./helpers/path-compare.cjs');

const gate = require('../gsd-core/bin/lib/gate-decision-coverage-plan.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U1a',
    title: 'disabled by nested workflow.context_coverage_gate=false -> skip',
    setup(dir, h) {
      h.w(dir, '.planning/config.json', '{"workflow":{"context_coverage_gate":false}}');
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', '# c\n');
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: true,
        reason: 'workflow.context_coverage_gate is false',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'Decision coverage gate disabled by config.',
      };
    },
  },
  {
    id: 'U1b',
    title: 'string \'false\' is coerced -> skip',
    setup(dir, h) {
      h.w(dir, '.planning/config.json', '{"workflow":{"context_coverage_gate":"false"}}');
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: true,
        reason: 'workflow.context_coverage_gate is false',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'Decision coverage gate disabled by config.',
      };
    },
  },
  {
    id: 'U1c',
    title: 'missing context path argument fails closed',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# p\n');
    },
    args() { return ['.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'missing context path argument',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'Decision coverage gate called without a context path argument — the caller (e.g. the plan-phase workflow) must pass the CONTEXT.md path. An empty argument is a caller error, not evidence there is nothing to check (#2770).',
      };
    },
  },
  {
    id: 'U1d',
    title: 'CONTEXT.md file absent -> legitimate skip',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# p\n');
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: true,
        reason: 'CONTEXT.md missing',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'No CONTEXT.md - nothing to check.',
      };
    },
  },
  {
    id: 'U1e',
    title: 'context path is a directory -> not a file, no uncovered key',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# p\n');
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'context path is not a file',
        total: null,
        covered: null,
        message: 'Decision coverage gate: the context path ".planning/phases/01-x" is not a readable file (directory). Swap the adjacent positionals or pass --context <path-to-CONTEXT.md>.',
      };
    },
  },
  {
    id: 'U1f',
    title: 'partial parse (D-01 valid, D4x-01 malformed) -> could-not-parse',
    stderrPrefix: 'parseDecisions:',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '- **D4x-01:** malformed id', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'could-not-parse',
        total: null,
        covered: null,
        unreadable: [
          'D4x-01',
        ],
        message: 'Decision coverage gate: decisions could not be fully parsed — one or more `- **D-NN ...**` bullets appear malformed (missing `:` or ` — ` separator, or a phase prefix that is not a digit run, e.g. `D4x-01`). Fix the bullet format so all decisions can be read before re-running the gate. Unreadable ids: D4x-01.',
      };
    },
  },
  {
    id: 'U1g',
    title: 'decision-shaped block with no extractable bullets -> could-not-parse (full miss)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **DEC-01:** Unsupported id grammar', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'could-not-parse',
        total: null,
        covered: null,
        unreadable: [],
        message: 'Decision coverage gate: could not parse decisions — possible format mismatch. The CONTEXT.md appears to be decision-shaped (has a <decisions> block, a decisions heading, or D- tokens) but no decision bullets could be extracted. Check the formatting of the decisions block and ensure bullets follow the `- **D-NN:** text`, `- **D4-NN:** text` (phase-prefixed), or `- **D-NN — title** body` form. An ID grammar the parser does not support (e.g. `DEC-01`) also lands here.',
      };
    },
  },
  {
    id: 'U1h',
    title: 'no trackable decisions -> skip',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', '# Phase\n\nNothing decision-shaped here.\n');
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: true,
        reason: 'no trackable decisions',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'No trackable decisions in CONTEXT.md.',
      };
    },
  },
  {
    id: 'U1i',
    title: 'decision cited in a plan objective -> covered, passes',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Honor D-01 in the storage layer</objective>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: false,
        total: 1,
        covered: 1,
        uncovered: [],
        message: 'All trackable CONTEXT.md decisions are covered by plans.',
      };
    },
  },
  {
    id: 'U1j',
    title: 'decision never cited -> uncovered, blocks',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Unrelated work</objective>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        total: 1,
        covered: 0,
        uncovered: [
          {
            id: 'D-01',
            text: 'Use PostgreSQL for the primary datastore layer',
            category: '',
          },
        ],
        message: '## Decision Coverage Gap\n\n1 CONTEXT.md decision(s) are not covered by any plan:\n\n- **D-01** (uncategorized): Use PostgreSQL for the primary datastore layer\n\nResolve by citing `D-NN:` in any of the scanned plan surfaces: front-matter\n`must_haves`/`truths`/`objective`, a `## must_haves`/`truths`/`tasks`/`objective`\nheading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`\ntag body. Other locations (prose outside those headings, comments, other XML tags) are not scanned.\nOR move the decision to `### Claude\'s Discretion` / tag it `[informational]` if it should not be tracked.',
      };
    },
  },
  {
    id: 'U1k',
    title: 'positional context (no --context flag) is honoured',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        passed: true,
        skipped: false,
        total: 1,
        covered: 1,
        uncovered: [],
        message: 'All trackable CONTEXT.md decisions are covered by plans.',
      };
    },
  },
  {
    id: 'U1l',
    title: 'phase dir escaping the project root is a usage failure',
    args() { return ['../outside', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    usage: { code: 'usage', message: 'path escapes its allowed directory: ../outside' },
  },
  {
    // #5170: CONTEXT.md that exists (and is a file) but cannot be read used to be extracted as ''
    // text — "no trackable decisions", a green skip over a CONTEXT.md the gate never saw. The
    // blocking policy is unchanged (fail-closed); the outcome is `unreadable`.
    id: 'U1m',
    title: 'CONTEXT.md that cannot be read -> unreadable outcome, block:true, never "no trackable decisions" (read failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', ''].join('\n'));
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('01-CONTEXT.md')) {
          const err = new Error('EACCES: simulated read failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'unreadable',
    block: true,
    expected(dir, real) {
      const readError = `${real}/.planning/phases/01-x/01-CONTEXT.md: EACCES`;
      return {
        passed: false,
        skipped: false,
        reason: 'unreadable evidence',
        total: null,
        covered: null,
        readError,
        message: `Decision coverage gate could not read its evidence (${readError}). Fix the file permissions or encoding, then re-run the gate.`,
      };
    },
  },
  {
    // A plan that cannot be read is not a plan that fails to cite the decision.
    id: 'U1n',
    title: 'a plan that cannot be read -> unreadable outcome, block:true, not "uncovered" (read failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', ''].join('\n'));
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('01-01-PLAN.md')) {
          const err = new Error('EIO: simulated read failure');
          err.code = 'EIO';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'unreadable',
    block: true,
    expected(dir, real) {
      const readError = `${real}/.planning/phases/01-x/01-01-PLAN.md: EIO`;
      return {
        passed: false,
        skipped: false,
        reason: 'unreadable evidence',
        total: null,
        covered: null,
        readError,
        message: `Decision coverage gate could not read its evidence (${readError}). Fix the file permissions or encoding, then re-run the gate.`,
      };
    },
  },
  {
    // #4939: a phase-dir argument that names no directory (the phase NUMBER in the phase-dir slot) used to
    // scan nothing and answer a measured-looking `covered: 0`. It is a caller error: fail closed, null totals.
    id: 'U1o',
    title: 'phase dir that does not exist -> block:true, reason "phase directory not found", null totals (#4939)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
    },
    args() { return ['1', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'phase directory not found',
        total: null,
        covered: null,
        message: 'Decision coverage gate: the phase directory "1" does not exist, so no plans were scanned. Pass the phase DIRECTORY (e.g. .planning/phases/01-slug), not the phase number.',
      };
    },
  },
  {
    id: 'U1p',
    title: 'a FILE in the phase-dir slot -> block:true, reason "phase path is not a directory", null totals (#4939)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x/01-CONTEXT.md', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'phase path is not a directory',
        total: null,
        covered: null,
        message: 'Decision coverage gate: the phase directory ".planning/phases/01-x/01-CONTEXT.md" is a file, not a directory, so no plans were scanned. Pass the phase DIRECTORY (e.g. .planning/phases/01-slug), not the phase number.',
      };
    },
  },
  {
    // A stat failure other than ENOENT/ENOTDIR is not "the directory is missing": the message must not say so.
    id: 'U1q',
    title: 'phase dir whose stat fails with EACCES -> unreadable outcome, reason "phase directory unreadable" (stat failure injected, #4939)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      const real = fs.statSync;
      fs.statSync = function (p, ...rest) {
        if (String(p).endsWith('01-x')) {
          const err = new Error('EACCES: simulated stat failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.statSync = real; };
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'unreadable',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'phase directory unreadable',
        total: null,
        covered: null,
        message: 'Decision coverage gate: the phase directory ".planning/phases/01-x" could not be read (EACCES), so no plans were scanned. Check that the directory is readable.',
      };
    },
  },
  {
    id: 'U1r',
    title: 'phase dir that holds no PLAN file -> block:true, reason "phase directory holds no plans", null totals (#4939)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        passed: false,
        skipped: false,
        reason: 'phase directory holds no plans',
        total: null,
        covered: null,
        message: 'Decision coverage gate: the phase directory ".planning/phases/01-x" holds no PLAN files, so no plans were scanned. Pass the phase DIRECTORY that holds the plans (e.g. .planning/phases/01-slug), not the phase number.',
      };
    },
  },
];

function run(c) {
  const dir = createTempProject('gate-u1-');
  const real = fs.realpathSync(dir);
  const aliases = tempRootAliases(dir);
  const writes = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  let restore;
  let result;
  try {
    restore = c.setup ? c.setup(dir, h) : undefined;
    process.stdout.write = (chunk) => {
      writes.push({ stream: 'stdout', chunk: String(chunk) });
      return true;
    };
    process.stderr.write = (chunk) => {
      writes.push({ stream: 'stderr', chunk: String(chunk) });
      return true;
    };
    result = gate.evaluateDecisionCoveragePlan({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U1 evaluateDecisionCoveragePlan', () => {
  for (const c of CASES) {
    test(`${c.id}: ${c.title}`, () => {
      const { result, writes, dir, real, aliases } = run(c);
      const unexpected = writes.filter(
        (w) => !(c.stderrPrefix && w.stream === 'stderr' && w.chunk.startsWith(c.stderrPrefix)),
      );
      assert.deepStrictEqual(unexpected, [], 'a gate module must not write to stdout/stderr');
      if (c.usage) {
        assert.equal(isGateUsageFailure(result), true);
        assert.deepStrictEqual(result, { failure: { code: c.usage.code, message: c.usage.message } });
        return;
      }
      assert.equal(isGateUsageFailure(result), false);
      assert.equal(result.outcome, c.outcome);
      assert.equal(result.block, c.block);
      const expected = canonicalizeTempPaths(c.expected(dir, real), aliases);
      const actual = canonicalizeTempPaths(result.payload, aliases);
      assert.deepStrictEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});

// #5317 — tracker-resolved task content counts as plan surface; resolver failure never passes.
describe('U2 evaluateDecisionCoveragePlan tracker-id resolution (#5317)', () => {
  const tcr = require('../gsd-core/bin/lib/task-content-resolution.cjs');
  const ARGS = ['.planning/phases/01-x', '--context', '.planning/phases/01-x/01-CONTEXT.md'];
  const CONTEXT = ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n');
  const trackerPlan = (body) => ['---', 'phase: 1', '---', '<tasks>', '<task type="auto" tracker-id="beads:X-1">', '<name>t</name>', `<action>${body}</action>`, '</task>', '</tasks>', ''].join('\n');
  const STUB_ONLY = '<!-- beads: content synced to bd -->';
  const resolved = (action) => ({ kind: 'resolved', content: { action, verify: null, acceptanceCriteria: [], readFirst: [], done: null } });

  function withProject(plan, stub, fn) {
    const dir = createTempProject('gate-u2-');
    try {
      w(dir, '.planning/phases/01-x/01-CONTEXT.md', CONTEXT);
      w(dir, '.planning/phases/01-x/01-01-PLAN.md', plan);
      const calls = [];
      const deps = { loadCapabilities: () => [], resolveTaskContentFn: (i) => { calls.push(i); return stub(i); } };
      return fn(() => gate.evaluateDecisionCoveragePlan({ projectDir: dir, args: ARGS, deps }), calls);
    } finally { cleanup(dir); }
  }

  test('U2a: stub-only body blocks without resolver content; resolved action D-01 covers', () => {
    withProject(trackerPlan(STUB_ONLY), () => ({ kind: 'empty' }), (run1) => {
      const r = run1();
      assert.equal(r.payload.passed, false);
      assert.equal(r.block, true);
    });
    withProject(trackerPlan(STUB_ONLY), () => resolved('D-01: do it'), (run1, calls) => {
      const r = run1();
      assert.equal(r.payload.passed, true);
      assert.equal(r.payload.total, 1);
      assert.equal(r.payload.covered, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].trackerId, 'beads:X-1');
    });
  });

  const errors = {
    ambiguous: () => new tcr.ResolverAmbiguousError('beads', ['a', 'b']),
    failed: () => new tcr.ResolverFailedError('bd', 1, 'boom'),
    timeout: () => new tcr.ResolverTimeoutError('bd', 1000),
    malformed: () => new tcr.ResolverMalformedOutputError('bd', 'bad json', '{'),
  };
  for (const [name, make] of Object.entries(errors)) {
    test(`U2b: ${name} resolver error blocks, never passes`, () => {
      // even with D-01 cited inline, an unresolved tracker body must not certify
      withProject(trackerPlan('D-01 inline'), () => { throw make(); }, (run1) => {
        const r = run1();
        assert.equal(r.payload.passed, false);
        assert.equal(r.block, true);
        assert.equal(r.outcome, 'unreadable');
        assert.match(r.payload.readError, /beads:X-1/);
      });
    });
  }

  for (const kind of ['not-applicable', 'no-resolver', 'empty']) {
    test(`U2c: ${kind} keeps inline text`, () => {
      withProject(trackerPlan('Honor D-01 inline'), () => ({ kind }), (run1) => {
        assert.equal(run1().payload.passed, true);
      });
      withProject(trackerPlan(STUB_ONLY), () => ({ kind }), (run1) => {
        assert.equal(run1().payload.passed, false);
      });
    });
  }

  test('U2d: non-Resolver error propagates', () => {
    withProject(trackerPlan(STUB_ONLY), () => { throw new TypeError('bug'); }, (run1) => {
      assert.throws(run1, TypeError);
    });
  });

  test('U2e: plan without tracker-id never calls the resolver', () => {
    const plan = ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', ''].join('\n');
    withProject(plan, () => { throw new Error('must not be called'); }, (run1, calls) => {
      assert.equal(run1().payload.passed, true);
      assert.equal(calls.length, 0);
    });
  });

  function evalPlans(plans, deps) {
    const dir = createTempProject('gate-u2x-');
    try {
      w(dir, '.planning/phases/01-x/01-CONTEXT.md', CONTEXT);
      plans.forEach((p, i) => w(dir, `.planning/phases/01-x/01-0${i + 1}-PLAN.md`, p));
      return gate.evaluateDecisionCoveragePlan({ projectDir: dir, args: ARGS, deps });
    } finally { cleanup(dir); }
  }

  test('U2f: throwing capability registry -> unreadable, blocks, no throw', () => {
    const r = evalPlans([trackerPlan(STUB_ONLY)], {
      loadCapabilities: () => { throw new Error('boom'); },
      resolveTaskContentFn: () => resolved('D-01: do it'),
    });
    assert.equal(r.outcome, 'unreadable');
    assert.equal(r.block, true);
    assert.equal(r.payload.passed, false);
    assert.match(r.payload.readError, /capability registry unreadable/);
  });

  test('U2g: tracker-id= only in prose or a code fence -> deps never called, same as no deps', () => {
    const plan = ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', 'prose tracker-id="beads:X-1" here', '```', '<task tracker-id="beads:X-2">', '```', ''].join('\n');
    let calls = 0;
    const deps = { loadCapabilities: () => { calls++; return []; }, resolveTaskContentFn: () => { calls++; return { kind: 'no-resolver' }; } };
    const withDeps = evalPlans([plan], deps);
    assert.equal(calls, 0);
    assert.deepStrictEqual(withDeps, evalPlans([plan], undefined));
  });

  test('U2h: same trackerId in two plans resolves once', () => {
    const calls = [];
    const r = evalPlans([trackerPlan(STUB_ONLY), trackerPlan(STUB_ONLY)], {
      loadCapabilities: () => [],
      resolveTaskContentFn: (i) => { calls.push(i); return resolved('D-01: do it'); },
    });
    assert.equal(calls.length, 1);
    assert.equal(r.payload.passed, true);
  });

  test('U2i: D-01 only inside a fenced block of resolved text does not cover', () => {
    const r = evalPlans([trackerPlan(STUB_ONLY)], {
      loadCapabilities: () => [],
      resolveTaskContentFn: () => resolved('intro\n```\nD-01: fenced\n```\n'),
    });
    assert.equal(r.payload.passed, false);
    assert.equal(r.payload.covered, 0);
  });

  test('U2j: checkpoint task with tracker-id never reaches the resolver', () => {
    const plan = ['---', 'phase: 1', '---', '<tasks>', '<task type="checkpoint:human-verify" tracker-id="beads:X-9">', '<name>c</name>', `<action>${STUB_ONLY}</action>`, '</task>', '</tasks>', ''].join('\n');
    let calls = 0;
    evalPlans([plan], { loadCapabilities: () => { calls++; return []; }, resolveTaskContentFn: () => { calls++; return resolved('D-01'); } });
    assert.equal(calls, 0);
  });

  const stubDeps = (r) => ({ loadCapabilities: () => [], resolveTaskContentFn: () => r });
  const full = (over) => ({ kind: 'resolved', content: { action: null, verify: null, acceptanceCriteria: [], readFirst: [], done: null, ...over } });

  const FIELDS = {
    verify: { verify: 'D-01 check' },
    acceptanceCriteria: { acceptanceCriteria: ['D-01 holds'] },
    readFirst: { readFirst: ['D-01 notes'] },
    done: { done: 'D-01 done' },
  };
  for (const [field, over] of Object.entries(FIELDS)) {
    test(`U2k: decision cited only in resolver ${field} counts`, () => {
      const r = evalPlans([trackerPlan(STUB_ONLY)], stubDeps(full(over)));
      assert.equal(r.payload.passed, true);
      assert.equal(r.payload.covered, 1);
    });
  }

  test('U2l: multi-plan phase keeps resolver text and inline citations aligned', (t) => {
    const ctx2 = ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '- **D-02:** Use Redis for the session cache layer', '</decisions>', ''].join('\n');
    const dir = createTempProject('gate-u2l-');
    t.after(() => cleanup(dir));
    w(dir, '.planning/phases/01-x/01-CONTEXT.md', ctx2);
    w(dir, '.planning/phases/01-x/01-01-PLAN.md', ['---', 'phase: 1', '---', '<objective>Honor D-02</objective>', ''].join('\n'));
    w(dir, '.planning/phases/01-x/01-02-PLAN.md', trackerPlan(STUB_ONLY));
    const r = gate.evaluateDecisionCoveragePlan({ projectDir: dir, args: ARGS, deps: stubDeps(resolved('D-01: do it')) });
    assert.equal(r.payload.total, 2);
    assert.equal(r.payload.covered, 2);
    assert.equal(r.payload.passed, true);
  });

  test('U2p: multi-plan phase fails closed when one plan resolver throws though another plan covers all decisions', () => {
    const covering = ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', ''].join('\n');
    const r = evalPlans([covering, trackerPlan(STUB_ONLY)], { loadCapabilities: () => [], resolveTaskContentFn: () => { throw new tcr.ResolverFailedError('bd', 1, 'boom'); } });
    assert.equal(r.outcome, 'unreadable');
    assert.equal(r.block, true);
  });

  test('U2r: unclosed fence in one resolver field does not swallow later fields', () => {
    const r = evalPlans([trackerPlan(STUB_ONLY)], stubDeps(full({ action: 'intro\n```\nunclosed', done: 'D-01 done' })));
    assert.equal(r.payload.passed, true);
  });

  for (const kind of ['not-applicable', 'no-resolver', 'empty']) {
    test(`U2m: ${kind} retains inline citation next to a tracker stub task`, () => {
      const plan = ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', '<tasks>', '<task type="auto" tracker-id="beads:X-1">', `<action>${STUB_ONLY}</action>`, '</task>', '</tasks>', ''].join('\n');
      assert.equal(evalPlans([plan], stubDeps({ kind })).payload.passed, true);
    });
  }

  test('U2n: case/space variant TRACKER-ID still reaches the resolver', () => {
    const plan = ['---', 'phase: 1', '---', '<tasks>', '<task type="auto" TRACKER-ID = "beads:X-1">', '<name>t</name>', `<action>${STUB_ONLY}</action>`, '</task>', '</tasks>', ''].join('\n');
    const calls = [];
    const r = evalPlans([plan], { loadCapabilities: () => [], resolveTaskContentFn: (i) => { calls.push(i); return resolved('D-01: do it'); } });
    assert.equal(calls.length, 1);
    assert.equal(r.payload.passed, true);
  });

  test('U2o: default loader with no capability for the prefix (first-party beads resolver exists, so use an unknown prefix) -> no-resolver arm, no throw', () => {
    const inline = ['---', 'phase: 1', '---', '<objective>Honor D-01</objective>', '<tasks>', '<task type="auto" tracker-id="nosuchtracker:X-1">', `<action>${STUB_ONLY}</action>`, '</task>', '</tasks>', ''].join('\n');
    assert.equal(evalPlans([inline], undefined).payload.passed, true);
    const r = evalPlans([trackerPlan(STUB_ONLY).replace('beads:X-1', 'nosuchtracker:X-1')], undefined);
    assert.equal(r.payload.passed, false);
    assert.equal(r.outcome, 'unreadable');
    assert.match(r.payload.readError, /no task-content resolver installed for tracker prefix "nosuchtracker"/);
  });

  test('U2s: no-resolver passes when D-01 is cited inline, goes unreadable only when a decision is uncovered', () => {
    assert.equal(evalPlans([trackerPlan('Honor D-01 inline')], stubDeps({ kind: 'no-resolver' })).payload.passed, true);
    const r = evalPlans([trackerPlan(STUB_ONLY)], stubDeps({ kind: 'no-resolver' }));
    assert.equal(r.outcome, 'unreadable');
    assert.match(r.payload.readError, /beads/);
  });

  test('U2t: tracker id "-" or holding control chars is rejected by the seam before any resolver', () => {
    for (const bad of ['beads:--flag', 'beads: -x', 'beads:X\u0001']) {
      const r = evalPlans([trackerPlan(STUB_ONLY).replace('beads:X-1', bad)], { loadCapabilities: () => [] });
      assert.equal(r.outcome, 'unreadable');
      assert.match(r.payload.readError, /tracker-id rejected/);
    }
  });

  test('U2u: aggregate budget exhausted -> unreadable before the next spawn', () => {
    const two = trackerPlan(STUB_ONLY).replace('beads:X-1', 'beads:A-1');
    const three = trackerPlan(STUB_ONLY).replace('beads:X-1', 'beads:B-1');
    const support = require('../gsd-core/bin/lib/decision-coverage-support.cjs');
    let t = 0, calls = 0;
    const r = evalPlans([two, three], { now: () => (t += support.TRACKER_RESOLVE_BUDGET_MS * 0.6), loadCapabilities: () => [], resolveTaskContentFn: () => { calls++; return resolved('D-01'); } });
    assert.equal(calls, 1);
    assert.equal(r.outcome, 'unreadable');
    assert.match(r.payload.readError, /aggregate budget/);
  });

  test('U2w: budget boundary — each spawn is clamped to the remaining budget; elapsed >= budget is rejected', () => {
    const support = require('../gsd-core/bin/lib/decision-coverage-support.cjs');
    const B = support.TRACKER_RESOLVE_BUDGET_MS;
    const plan = trackerPlan(STUB_ONLY);
    // Fractional rows: performance.now() diffs are sub-ms floats; spawnSync rejects non-integer timeouts and 0 means unbounded.
    for (const [elapsed, remaining] of [[B - 1.5, 1], [B - 1, 1], [B - 0.5, null], [B, null], [B + 1, null]]) {
      const ticks = [0, elapsed]; let k = 0;
      const seen = [];
      const r = evalPlans([plan], { now: () => ticks[Math.min(k++, 1)], loadCapabilities: () => [], resolveTaskContentFn: (i) => { seen.push(i.timeoutOverrideMs); return resolved('D-01'); } });
      if (remaining === null) {
        assert.equal(r.outcome, 'unreadable');
        assert.deepStrictEqual(seen, []);
      } else {
        assert.equal(r.payload.passed, true);
        assert.deepStrictEqual(seen, [remaining]);
        assert.ok(Number.isInteger(seen[0]));
      }
    }
  });

  test('U2x: registry load time counts against the aggregate budget', () => {
    const support = require('../gsd-core/bin/lib/decision-coverage-support.cjs');
    let t = 0, calls = 0;
    const r = evalPlans([trackerPlan(STUB_ONLY)], { now: () => t, loadCapabilities: () => { t = support.TRACKER_RESOLVE_BUDGET_MS; return []; }, resolveTaskContentFn: () => { calls++; return resolved('D-01'); } });
    assert.equal(calls, 0);
    assert.equal(r.outcome, 'unreadable');
    assert.match(r.payload.readError, /aggregate budget/);
  });

  test('U2v: property — one body per plan, \'\' without tracker-id, one resolver call per distinct id', () => {
    const fc = require('./helpers/fast-check-setup.cjs');
    const support = require('../gsd-core/bin/lib/decision-coverage-support.cjs');
    const mk = (id) => id === null ? '<tasks>\n<task type="auto">\n<action>x</action>\n</task>\n</tasks>\n' : trackerPlan(STUB_ONLY).replace('beads:X-1', `beads:${id}`);
    fc.assert(fc.property(fc.array(fc.option(fc.constantFrom('A-1', 'B-2', 'C-3'), { nil: null }), { maxLength: 8 }), (ids) => {
      const seen = [];
      const out = support.resolveTrackerBodies(process.cwd(), ids.map(mk), { loadCapabilities: () => [], resolveTaskContentFn: (i) => { seen.push(i.trackerId); return resolved('D-01'); } });
      assert.equal(out.kind, 'found');
      assert.equal(out.value.bodies.length, ids.length);
      ids.forEach((id, i) => { if (id === null) assert.equal(out.value.bodies[i], ''); else assert.match(out.value.bodies[i], /D-01/); });
      assert.equal(seen.length, new Set(ids.filter((x) => x !== null)).size);
    }));
  });
});
