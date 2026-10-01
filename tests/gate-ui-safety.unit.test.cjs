'use strict';

/**
 * U4 — in-process GateVerdict tests for `check ui-safety-gate` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-ui-safety.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateUiSafetyGate({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check ui-safety-gate`)
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
const { execFileSync } = require('node:child_process');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { tempRootAliases, canonicalizeTempPaths } = require('./helpers/path-compare.cjs');

const gate = require('../gsd-core/bin/lib/gate-ui-safety.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function git(dir, ...a) {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate-test', '-c', 'user.email=gate-test@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
}

const h = { w, git };

const CASES = [
  {
    id: 'U4a',
    title: 'frontend phase + UI file in HEAD commit + no UI-SPEC -> blocks with message',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
      h.w(dir, 'src/components/Button.tsx', 'export const B = 1;\n');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'feat: add button');
    },
    args() { return ['1']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        frontend: true,
        hasUiFiles: true,
        hasUiSpec: false,
        block: true,
        message: 'UI files changed in this wave but no UI-SPEC.md exists for Phase 1. Run /gsd:ui-phase 1 to generate the design contract before continuing.',
        // #5164: the phase records no task commits, so its scope is the widened phase-directory range, and says so.
        scopeStatus: 'degraded',
        scopeReason: 'no-summary',
      };
    },
  },
  {
    id: 'U4b',
    title: 'UI-SPEC present -> does not block, no message',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, '.planning/phases/01-dashboard/01-UI-SPEC.md', '# spec\n');
      h.w(dir, 'src/components/Button.tsx', 'export const B = 1;\n');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'feat: add button');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: true,
        hasUiFiles: true,
        hasUiSpec: true,
        block: false,
        scopeStatus: 'degraded',
        scopeReason: 'no-summary',
      };
    },
  },
  {
    id: 'U4c',
    title: 'HEAD commit touches no UI file -> hasUiFiles false, does not block',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
      h.w(dir, '.planning/phases/01-dashboard/01-01-PLAN.md', '# p\n');
      h.w(dir, 'notes.md', 'x\n');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'docs: notes');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: true,
        hasUiFiles: false,
        hasUiSpec: false,
        block: false,
        scopeStatus: 'degraded',
        scopeReason: 'no-summary',
      };
    },
  },
  {
    id: 'U4d',
    title: 'non-frontend phase -> frontend false',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Database migration', '**Goal**: Move rows between tables', ''].join('\n'));
      h.w(dir, '.planning/phases/01-database/01-01-PLAN.md', '# p\n');
      h.w(dir, 'src/components/Button.tsx', 'export const B = 1;\n');
      h.git(dir, 'add', '-A');
      h.git(dir, 'commit', '-m', 'feat: add button');
    },
    args() { return ['1']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        frontend: false,
        hasUiFiles: true,
        hasUiSpec: false,
        block: false,
        scopeStatus: 'degraded',
        scopeReason: 'no-summary',
      };
    },
  },
  {
    id: 'U4e',
    title: 'ROADMAP present but phase absent -> phaseLookupFailed appended last',
    git: true,
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
    },
    args() { return ['9']; },
    // #5164/#5170: a phase the resolver cannot find is "could not look" — an `unreadable` verdict
    // (exit UNAVAILABLE), never a `pass`; `block` stays the gate's own policy (false).
    outcome: 'unreadable',
    block: false,
    expected() {
      return {
        frontend: false,
        hasUiFiles: false,
        hasUiSpec: false,
        block: false,
        phaseLookupFailed: true,
        scopeStatus: 'unresolvable',
        scopeReason: 'phase-dir-not-found',
      };
    },
  },
  {
    id: 'U4f',
    title: 'no git repository -> hasUiFiles false, and the unreadable scope is reported (unreadable), not passed',
    setup(dir, h) {
      h.w(dir, '.planning/ROADMAP.md', ['# Roadmap', '', '### Phase 1: Dashboard frontend', '**Goal**: Build the React dashboard UI for operators', ''].join('\n'));
    },
    args() { return ['1']; },
    outcome: 'unreadable',
    block: false,
    expected() {
      return {
        frontend: true,
        hasUiFiles: false,
        hasUiSpec: false,
        block: false,
        scopeStatus: 'unresolvable',
        scopeReason: 'git-failed:rev-parse',
      };
    },
  },
  {
    id: 'U4g',
    title: 'missing phase argument is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'ui-safety-gate requires a phase argument: check ui-safety-gate <phase>' },
  },
];

function run(c) {
  const dir = c.git ? createTempGitProject('gate-u4-') : createTempProject('gate-u4-');
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
    result = gate.evaluateUiSafetyGate({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U4 evaluateUiSafetyGate', () => {
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
