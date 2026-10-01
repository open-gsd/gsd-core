'use strict';

/**
 * U11 — in-process GateVerdict tests for `check api-coverage-verify-pre` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-api-coverage-verify-pre.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateApiCoverageVerifyPre({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check api-coverage-verify-pre`)
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

const gate = require('../gsd-core/bin/lib/gate-api-coverage-verify-pre.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function rm(dir, rel) {
  cleanup(path.join(dir, rel));
}

const h = { w, rm };

const CASES = [
  {
    id: 'U11a',
    title: 'no .planning/phases tree -> fail-open pass',
    setup(dir, h) {
      h.rm(dir, '.planning/phases');
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: no .planning/phases directory; gate skipped (not a GSD project layout)',
      };
    },
  },
  {
    id: 'U11b',
    title: 'phases tree exists but phase unresolvable -> fail-closed block, phase_lookup_failed',
    args() { return ['99']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        phase_lookup_failed: true,
        message: 'api-coverage: could not resolve phase "99" under .planning/phases/. Resolve the phase directory (or produce COVERAGE.md) before sealing.',
      };
    },
  },
  {
    id: 'U11c',
    title: 'COVERAGE.md exists but unreadable -> unreadable outcome, block:true (read failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/COVERAGE.md', '# c\n');
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('COVERAGE.md')) {
          const err = new Error('EACCES: simulated');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['01']; },
    outcome: 'unreadable',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: true,
        message: 'api-coverage: COVERAGE.md exists but is unreadable — fix file permissions/encoding before sealing',
      };
    },
  },
  {
    id: 'U11d',
    title: 'COVERAGE.md declares no integration, detector silent -> pass none_declared',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/COVERAGE.md', 'No external API integration: pure local refactor\n');
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nRename internal helpers.\n');
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: true,
        matrix: 'COVERAGE.md',
        counts: {
          surface: 0,
          integrate: 0,
          optout: 0,
        },
        none_declared: true,
        detected: false,
        message: 'api-coverage: COVERAGE.md declares no external API integration — matrix not required',
      };
    },
  },
  {
    id: 'U11e',
    title: 'COVERAGE.md declares no integration but detector fires -> pass with signals',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/COVERAGE.md', 'No external API integration: handled elsewhere\n');
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nIntegrate the Stripe API for payments and call the Stripe SDK.\n');
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: true,
        matrix: 'COVERAGE.md',
        counts: {
          surface: 0,
          integrate: 0,
          optout: 0,
        },
        none_declared: true,
        detected: true,
        signals: [
          {
            verb: 'integrate',
            noun: 'api',
          },
          {
            verb: 'integrate',
            noun: 'sdk',
          },
          {
            verb: '(surface)',
            noun: 'api',
          },
          {
            verb: '(surface)',
            noun: 'sdk',
          },
        ],
        message: 'api-coverage: COVERAGE.md declares no external API integration, overriding 4 detected signal(s) — confirm the declaration is accurate',
      };
    },
  },
  {
    id: 'U11f',
    title: 'valid matrix -> pass with counts',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/COVERAGE.md', ['| capability | decision | reason |', '|---|---|---|', '| search | INTEGRATE | |', '| playlists | OPT-OUT | not needed yet |', ''].join('\n'));
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: true,
        matrix: 'COVERAGE.md',
        counts: {
          surface: 2,
          integrate: 1,
          optout: 1,
        },
        message: 'api-coverage: matrix present (2 capabilities, 1 opt-out)',
      };
    },
  },
  {
    id: 'U11g',
    title: 'matrix with an OPT-OUT lacking a reason -> block with errors[]',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/COVERAGE.md', ['| capability | decision | reason |', '|---|---|---|', '| search | INTEGRATE | |', '| playlists | OPT-OUT | |', ''].join('\n'));
    },
    args() { return ['01']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: true,
        matrix: 'COVERAGE.md',
        error_count: 1,
        errors: [
          'row[1]: OPT-OUT missing reason',
        ],
        message: 'api-coverage: COVERAGE.md has 1 problem(s) — fix the matrix (every capability INTEGRATE or OPT-OUT with a reason) before sealing',
      };
    },
  },
  {
    id: 'U11h',
    title: 'two *-COVERAGE.md files -> block, consolidate',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/a-COVERAGE.md', '# a\n');
      h.w(dir, '.planning/phases/01-x/b-COVERAGE.md', '# b\n');
    },
    args() { return ['01']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        message: 'api-coverage: multiple *-COVERAGE.md files found (2) — consolidate into one COVERAGE.md before sealing',
      };
    },
  },
  {
    id: 'U11i',
    title: 'plan file unreadable -> scope read error, unreadable outcome, block:true (read failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nRename internal helpers.\n');
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
    args() { return ['01']; },
    outcome: 'unreadable',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: could not read the phase scope (could not read 01-01-PLAN.md: EIO: simulated read failure); refusing to certify no external-API integration from incomplete scope. Fix the unreadable plan file, or add a COVERAGE.md declaration.',
      };
    },
  },
  {
    id: 'U11j',
    title: 'no plan body and no roadmap section -> empty scope blocks, scope_unavailable',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/.gitkeep', '');
    },
    args() { return ['01']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        scope_unavailable: true,
        message: 'api-coverage: the phase scope is empty — no plan body and no roadmap section were found, so nothing was examined. Refusing to certify no external-API integration from an unestablished scope. Add the phase plan, or add a COVERAGE.md declaration.',
      };
    },
  },
  {
    id: 'U11k',
    title: 'plan describes an external API integration, no matrix -> block with signals',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nIntegrate the Stripe API for payments and call the Stripe SDK.\n');
    },
    args() { return ['01']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        detected: true,
        signals: [
          {
            verb: 'integrate',
            noun: 'api',
          },
          {
            verb: 'integrate',
            noun: 'sdk',
          },
          {
            verb: '(surface)',
            noun: 'api',
          },
          {
            verb: '(surface)',
            noun: 'sdk',
          },
        ],
        message: 'api-coverage: external-API integration detected without a coverage matrix. Produce COVERAGE.md enumerating the API surface (every capability INTEGRATE or OPT-OUT with a reason) before sealing. Full coverage is the default.',
      };
    },
  },
  {
    id: 'U11l',
    title: 'plan with no API vocabulary -> pass, matrix not required',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nRename internal helpers.\n');
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: no external-API integration detected; coverage matrix not required',
      };
    },
  },
  {
    id: 'U11m',
    title: 'missing phase argument is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'api-coverage.verify-pre requires a phase argument: check api-coverage.verify-pre <phase-dir-or-token>' },
  },
  {
    // #5170 (matrix row 20): the readdir at the COVERAGE.md lookup used to be an empty `catch` that
    // fell through to the detector, whose pass (here: a plan with no API vocabulary) certified a
    // directory the gate never listed. It is `unreadable` now, never the detector's pass.
    id: 'U11n',
    title: 'phase directory cannot be listed -> unreadable outcome, block:true, never the detector pass (readdir failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nRename internal helpers.\n');
      const real = fs.readdirSync;
      fs.readdirSync = function (p, ...rest) {
        if (String(p).endsWith('01-x')) {
          const err = new Error('EACCES: simulated readdir failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readdirSync = real; };
    },
    args() { return ['01']; },
    outcome: 'unreadable',
    block: true,
    expected() {
      return {
        block: true,
        passed: false,
        coverage_present: false,
        detected: false,
        read_error: 'EACCES',
        message: 'api-coverage: could not read the phase directory (EACCES) — refusing to certify the coverage matrix from a directory that could not be listed. Fix the directory permissions before sealing.',
      };
    },
  },
  {
    // The control for row 20: an unlistable directory is the ONLY thing that makes it `unreadable`.
    id: 'U11o',
    title: 'the same plan with a listable phase directory -> detector pass (control)',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-01-PLAN.md', '# Plan\n\nRename internal helpers.\n');
    },
    args() { return ['01']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        passed: true,
        coverage_present: false,
        detected: false,
        message: 'api-coverage: no external-API integration detected; coverage matrix not required',
      };
    },
  },
];

function run(c) {
  const dir = createTempProject('gate-u11-');
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
    result = gate.evaluateApiCoverageVerifyPre({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U11 evaluateApiCoverageVerifyPre', () => {
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
