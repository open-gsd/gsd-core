'use strict';

/**
 * U2 — in-process GateVerdict tests for `check decision-coverage-verify` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-decision-coverage-verify.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateDecisionCoverageVerify({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check decision-coverage-verify`)
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
const { createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { tempRootAliases, canonicalizeTempPaths } = require('./helpers/path-compare.cjs');

const gate = require('../gsd-core/bin/lib/gate-decision-coverage-verify.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U2a',
    title: 'disabled by nested config -> skip, blocking false',
    setup(dir, h) {
      h.w(dir, '.planning/config.json', '{"workflow":{"context_coverage_gate":false}}');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        skipped: true,
        blocking: false,
        reason: 'workflow.context_coverage_gate is false',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'Decision coverage gate disabled by config.',
      };
    },
  },
  {
    id: 'U2b',
    title: 'CONTEXT.md absent -> skip',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# p\n');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        skipped: true,
        blocking: false,
        reason: 'CONTEXT.md missing',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'No CONTEXT.md - nothing to check.',
      };
    },
  },
  {
    id: 'U2c',
    title: 'no context argument -> skip (CONTEXT.md missing)',
    args() { return ['.planning/phases/01-x']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        skipped: true,
        blocking: false,
        reason: 'CONTEXT.md missing',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'No CONTEXT.md - nothing to check.',
      };
    },
  },
  {
    id: 'U2d',
    title: 'partial parse -> could-not-parse advisory, total counts extracted decisions',
    stderrPrefix: 'parseDecisions:',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '- **D4x-01:** malformed id', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'advisory',
    block: false,
    expected() {
      return {
        skipped: false,
        blocking: false,
        reason: 'could-not-parse',
        total: 1,
        honored: 0,
        not_honored: [],
        message: 'Decision coverage verify (warning): decisions could not be fully parsed — one or more `- **D-NN ...**` bullets appear malformed (missing `:` or ` — ` separator, or a phase prefix that is not a digit run). Fix the bullet format in the CONTEXT.md decisions block.',
      };
    },
  },
  {
    id: 'U2e',
    title: 'full miss parse -> could-not-parse advisory, total 0',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **DEC-01:** Unsupported id grammar', '</decisions>', ''].join('\n'));
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'advisory',
    block: false,
    expected() {
      return {
        skipped: false,
        blocking: false,
        reason: 'could-not-parse',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'Decision coverage verify (warning): could not parse decisions — possible format mismatch. Check the formatting of the CONTEXT.md decisions block (accepted forms: `- **D-NN:** text`, `- **D4-NN:** text` (phase-prefixed), `- **D-NN — title** body`).',
      };
    },
  },
  {
    id: 'U2f',
    title: 'no trackable decisions -> skip',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', '# Phase\n\nNothing decision-shaped here.\n');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'skip',
    block: false,
    expected() {
      return {
        skipped: true,
        blocking: false,
        reason: 'no trackable decisions',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'No trackable decisions in CONTEXT.md.',
      };
    },
  },
  {
    id: 'U2g',
    title: 'decision honored in a plan -> honored, not blocking',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '<objective>Honor D-01</objective>\n');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        skipped: false,
        blocking: false,
        total: 1,
        honored: 1,
        not_honored: [],
        message: 'All trackable CONTEXT.md decisions are honored by shipped artifacts.',
      };
    },
  },
  {
    id: 'U2h',
    title: 'decision never referenced -> not_honored, still blocking:false',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '<objective>Unrelated work</objective>\n');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'advisory',
    block: false,
    expected() {
      return {
        skipped: false,
        blocking: false,
        total: 1,
        honored: 0,
        not_honored: [
          {
            id: 'D-01',
            text: 'Use PostgreSQL for the primary datastore layer',
            category: '',
          },
        ],
        message: '### Decision Coverage (warning)\n\n1 decision(s) not found in shipped artifacts:\n\n- **D-01** (uncategorized): Use PostgreSQL for the primary datastore layer\n\nThis is a soft warning - verification status is unchanged.',
      };
    },
  },
  {
    id: 'U2i',
    title: 'decision honored only via a SUMMARY files_modified file',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '<objective>Unrelated work</objective>\n');
      h.w(dir, '.planning/phases/01-x/01-01-SUMMARY.md', ['---', 'files_modified:', '  - src/store.js', '---', 'Done.', ''].join('\n'));
      h.w(dir, 'src/store.js', '// implements D-01\n');
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        skipped: false,
        blocking: false,
        total: 1,
        honored: 1,
        not_honored: [],
        message: 'All trackable CONTEXT.md decisions are honored by shipped artifacts.',
      };
    },
  },
  {
    id: 'U2j',
    title: 'phase dir escaping the project root is a usage failure',
    args() { return ['../outside', '.planning/phases/01-x/01-CONTEXT.md']; },
    usage: { code: 'usage', message: 'path escapes its allowed directory: ../outside' },
  },
  {
    // #5170: CONTEXT.md that exists but cannot be read used to be extracted as '' text and answered
    // "no trackable decisions" (a skip). The gate stays advisory (block:false); the OUTCOME is
    // `unreadable`, so the exit status is UNAVAILABLE.
    id: 'U2k',
    title: 'CONTEXT.md that cannot be read -> unreadable outcome (advisory, block:false), never "no trackable decisions" (read failure injected)',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
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
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'unreadable',
    block: false,
    expected(dir, real) {
      const readError = `${real}/.planning/phases/01-x/01-CONTEXT.md: EACCES`;
      return {
        skipped: false,
        blocking: false,
        reason: 'unreadable evidence',
        total: null,
        honored: null,
        not_honored: [],
        readError,
        message: `Decision coverage verify (warning): could not read its evidence (${readError}); no decision was checked.`,
      };
    },
  },
  {
    // A listed `files_modified` file that cannot be read is not a file that fails to honor the decision.
    id: 'U2l',
    title: 'a SUMMARY files_modified file that cannot be read -> unreadable outcome, not "not honored" (read failure injected)',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-CONTEXT.md', ['<decisions>', '- **D-01:** Use PostgreSQL for the primary datastore layer', '</decisions>', ''].join('\n'));
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '<objective>Unrelated work</objective>\n');
      h.w(dir, '.planning/phases/01-x/01-01-SUMMARY.md', ['---', 'files_modified:', '  - src/store.js', '---', 'Done.', ''].join('\n'));
      h.w(dir, 'src/store.js', '// implements D-01\n');
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('store.js')) {
          const err = new Error('EIO: simulated read failure');
          err.code = 'EIO';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['.planning/phases/01-x', '.planning/phases/01-x/01-CONTEXT.md']; },
    outcome: 'unreadable',
    block: false,
    expected(dir, real) {
      const readError = `${real}/src/store.js: EIO`;
      return {
        skipped: false,
        blocking: false,
        reason: 'unreadable evidence',
        total: null,
        honored: null,
        not_honored: [],
        readError,
        message: `Decision coverage verify (warning): could not read its evidence (${readError}); no decision was checked.`,
      };
    },
  },
];

function run(c) {
  const dir = c.git ? createTempGitProject('gate-u2-') : createTempProject('gate-u2-');
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
    result = gate.evaluateDecisionCoverageVerify({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U2 evaluateDecisionCoverageVerify', () => {
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
