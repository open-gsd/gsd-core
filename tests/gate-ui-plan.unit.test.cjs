'use strict';

/**
 * U3 — in-process GateVerdict tests for `check ui-plan-gate` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-ui-plan.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateUiPlanGate({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check ui-plan-gate`)
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

const gate = require('../gsd-core/bin/lib/gate-ui-plan.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U3a',
    title: 'no ROADMAP.md -> not frontend, nothing blocks',
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: false,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: null,
        matchedLine: null,
      };
    },
  },
  {
    id: 'U3b',
    title: 'frontend phase + static evidence + no UI-SPEC -> blocks',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
    },
    args() { return ['1']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: false,
        block: true,
        uiSpecPath: null,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3c',
    title: 'frontend phase with a UI-SPEC present -> passes, uiSpecPath reported',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected(dir, real) {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: true,
        block: false,
        uiSpecPath: `${real}/.planning/phases/01-dashboard/01-UI-SPEC.md`,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3d',
    title: 'frontend vocabulary without static evidence -> does not block',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: true,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    id: 'U3e',
    title: 'ROADMAP present but phase absent -> phaseLookupFailed appended last',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
    },
    args() { return ['9']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: false,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: null,
        matchedLine: null,
        phaseLookupFailed: true,
      };
    },
  },
  {
    id: 'U3f',
    title: 'missing phase argument is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'ui-plan-gate requires a phase argument: check ui-plan-gate <phase>' },
  },
  {
    // #5170: a phase directory that cannot be listed used to read as "no UI-SPEC" (the tolerant
    // `findUiSpecInDir` returned ''), so the gate blocked — or passed — over a spec it never looked
    // for. The gate's own policy is unchanged (block stays what the formula says); the OUTCOME is
    // `unreadable`, so the exit status is UNAVAILABLE.
    id: 'U3g',
    title: 'phase directory that cannot be listed -> unreadable outcome, block per the gate formula, readError carried (readdir failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
      const real = fs.readdirSync;
      fs.readdirSync = function (p, ...rest) {
        if (String(p).endsWith('01-dashboard')) {
          const err = new Error('EACCES: simulated readdir failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readdirSync = real; };
    },
    args() { return ['1']; },
    outcome: 'unreadable',
    block: true,
    expected() {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: false,
        block: true,
        uiSpecPath: null,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
        readError: 'EACCES',
      };
    },
  },
  {
    // The control for U3g: the same project, listable, finds its spec and passes.
    id: 'U3h',
    title: 'the same project with a listable phase directory -> spec found, pass (control)',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, 'package.json', '{"dependencies":{"react":"^18.0.0"}}');
      h.w(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected(dir, real) {
      return {
        frontend: true,
        hasFrontendEvidence: true,
        hasUiSpec: true,
        block: false,
        uiSpecPath: `${real}/.planning/phases/01-dashboard/01-UI-SPEC.md`,
        matchedToken: 'dashboard',
        matchedLine: '### Phase 1: Dashboard frontend',
      };
    },
  },
  {
    // #5170: ROADMAP.md that exists but cannot be read used to be treated as "no roadmap, cannot be
    // frontend" (or as a phase that failed to match). It is `unreadable` now, never a clean answer.
    id: 'U3i',
    title: 'ROADMAP.md that cannot be read -> unreadable outcome, readError carried, not "not frontend" (read failure injected)',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      const real = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('ROADMAP.md')) {
          const err = new Error('EACCES: simulated read failure');
          err.code = 'EACCES';
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return function restore() { fs.readFileSync = real; };
    },
    args() { return ['1']; },
    outcome: 'unreadable',
    block: false,
    expected() {
      return {
        frontend: false,
        hasFrontendEvidence: false,
        hasUiSpec: false,
        block: false,
        uiSpecPath: null,
        matchedToken: null,
        matchedLine: null,
        readError: 'EACCES',
      };
    },
  },
];

function run(c) {
  const dir = createTempProject('gate-u3-');
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
    result = gate.evaluateUiPlanGate({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U3 evaluateUiPlanGate', () => {
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
      // The temp dir may be spelled through a symlink (macOS /var -> /private/var) or a Windows 8.3 alias with
      // backslashes; both sides go through one normaliser so the comparison is independent of that spelling.
      const expected = canonicalizeTempPaths(c.expected(dir, real), aliases);
      const actual = canonicalizeTempPaths(result.payload, aliases);
      assert.deepStrictEqual(actual, expected);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'payload key order is part of the contract');
    });
  }
});
