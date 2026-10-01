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
