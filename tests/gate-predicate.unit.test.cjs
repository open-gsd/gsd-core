'use strict';

/**
 * U10 — in-process GateVerdict tests for `check predicate` (#5139, epic #5056, ADR-5057 §4).
 *
 * FAILING-FIRST (RED): `gsd-core/bin/lib/gate-predicate.cjs` does not exist yet, so this file
 * fails at require time on origin/next. The module must export
 * `evaluateCheckPredicate({ projectDir, args })` where `args` is the argv AFTER the verb, returning a
 * GateVerdict ({ outcome, block, payload }) for every arm that prints a payload today and a
 * GateUsageFailure ({ failure: { code, message } }) for every arm that calls `error()` today.
 *
 * Every payload below was captured by EXECUTING the pre-move router (`gsd-tools check predicate`)
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

const gate = require('../gsd-core/bin/lib/gate-predicate.cjs');
const { isGateUsageFailure } = require('../gsd-core/bin/lib/gate-verdict.cjs');

function w(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const h = { w };

const CASES = [
  {
    id: 'U10a',
    title: 'command-exit-zero, exit 0 -> pass',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 0"}']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        message: 'command exited 0',
        details: {
          kind: 'command-exit-zero',
          exitCode: 0,
        },
      };
    },
  },
  {
    id: 'U10b',
    title: 'command-exit-zero, exit 3 -> block with details',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 3"}']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        message: 'command exited 3',
        details: {
          kind: 'command-exit-zero',
          exitCode: 3,
          signal: null,
        },
      };
    },
  },
  {
    id: 'U10c',
    title: 'artifact-frontmatter-equals, field matches -> pass',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-VERIFICATION.md', ['---', 'status: passed', '---', '# v', ''].join('\n'));
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'pass',
    block: false,
    expected() {
      return {
        block: false,
        message: 'Frontmatter field "status" matches expected value (passed)',
        details: {
          kind: 'artifact-frontmatter-equals',
          match: true,
        },
      };
    },
  },
  {
    id: 'U10d',
    title: 'artifact-frontmatter-equals, artifact absent -> block artifactNotFound',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-PLAN.md', '# p\n');
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected(dir, real) {
      return {
        block: true,
        message: `Artifact matching VERIFICATION.md not found in ${real}/.planning/phases/01-x`,
        details: {
          kind: 'artifact-frontmatter-equals',
          artifactNotFound: true,
        },
      };
    },
  },
  {
    id: 'U10e',
    title: 'artifact-frontmatter-equals, field differs -> block with actual/expected',
    setup(dir, h) {
      h.w(dir, '.planning/phases/01-x/01-VERIFICATION.md', ['---', 'status: gaps_found', '---', '# v', ''].join('\n'));
    },
    args() { return ['--predicate', '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}', '--phase-dir', '.planning/phases/01-x']; },
    outcome: 'block',
    block: true,
    expected() {
      return {
        block: true,
        message: 'Frontmatter field "status" in VERIFICATION.md is gaps_found, expected passed',
        details: {
          kind: 'artifact-frontmatter-equals',
          match: false,
          actual: 'gaps_found',
          expected: 'passed',
        },
      };
    },
  },
  {
    id: 'U10f',
    title: 'missing --predicate is a usage failure',
    args() { return []; },
    usage: { code: 'sdk_missing_arg', message: 'predicate requires --predicate <json> (the gate hook check.predicate object)' },
  },
  {
    id: 'U10g',
    title: 'non-JSON --predicate is a usage failure',
    args() { return ['--predicate', 'not-json']; },
    usage: { code: 'usage', message: 'predicate --predicate value must be valid JSON' },
  },
  {
    id: 'U10h',
    title: 'evaluator throw (unknown kind) is a usage failure carrying the evaluator message',
    args() { return ['--predicate', '{"kind":"nope"}']; },
    usage: { code: 'usage', message: 'gate predicate evaluation failed: Unknown predicate kind: "nope". Known kinds: command-exit-zero, artifact-frontmatter-equals' },
  },
  {
    id: 'U10i',
    title: '--phase-dir escaping the project root is a usage failure',
    args() { return ['--predicate', '{"kind":"command-exit-zero","command":"exit 0"}', '--phase-dir', '../outside']; },
    usage: { code: 'usage', message: 'path escapes its allowed directory: ../outside' },
  },
];

function run(c) {
  const dir = createTempProject('gate-u10-');
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
    result = gate.evaluateCheckPredicate({ projectDir: dir, args: c.args(dir) });
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    if (typeof restore === 'function') restore();
    cleanup(dir);
  }
  return { result, writes, dir, real, aliases };
}

describe('U10 evaluateCheckPredicate', () => {
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

// #5170 (matrix row 23): `findPhaseArtifact`'s listing used to sit in an empty `catch`, so a phase
// directory that could not be listed read as "artifact not found" — a clean answer a predicate can
// act on. An unreadable thing now throws, and the evaluator's throw is the existing usage failure
// (the dispatch contract routes it by `onError`); an ABSENT thing stays `none` => `artifactNotFound`.
describe('U10 unreadable predicate artifact lookup (#5170)', () => {
  const PREDICATE = '{"kind":"artifact-frontmatter-equals","artifact":"VERIFICATION.md","field":"status","equals":"passed"}';

  function withReaddirFailure(code, fn) {
    const dir = createTempProject('gate-u10-readdir-');
    const real = fs.readdirSync;
    try {
      w(dir, '.planning/phases/01-x/01-PLAN.md', '# p\n');
      fs.readdirSync = function (p, ...rest) {
        if (String(p).endsWith('01-x')) {
          const err = new Error(`${code}: simulated readdir failure`);
          err.code = code;
          throw err;
        }
        return real.call(fs, p, ...rest);
      };
      return fn(dir);
    } finally {
      fs.readdirSync = real;
      cleanup(dir);
    }
  }

  const evaluate = (dir) => gate.evaluateCheckPredicate({
    projectDir: dir,
    args: ['--predicate', PREDICATE, '--phase-dir', '.planning/phases/01-x'],
  });

  test('a phase directory that cannot be listed (EACCES) is the usage failure, never artifactNotFound', () => {
    withReaddirFailure('EACCES', (dir) => {
      const result = evaluate(dir);
      assert.equal(isGateUsageFailure(result), true, JSON.stringify(result));
      assert.equal(result.failure.code, 'usage');
      assert.match(result.failure.message, /^gate predicate evaluation failed: predicate artifact could not be examined: .*01-x \(EACCES\)$/);
    });
  });

  test('a phase directory that is absent when listed (ENOENT) is none: the existing artifactNotFound block', () => {
    withReaddirFailure('ENOENT', (dir) => {
      const result = evaluate(dir);
      assert.equal(isGateUsageFailure(result), false, JSON.stringify(result));
      assert.equal(result.outcome, 'block');
      assert.equal(result.payload.details.artifactNotFound, true);
    });
  });
});

// #5313: two files matching one artifact (stale bare BEADS.md + NN-BEADS.md) used to resolve to
// whichever the OS listed first. >1 match now blocks, naming every candidate in sorted order.
describe('U10 ambiguous predicate artifact (#5313)', () => {
  const predicate = (name) => `{"kind":"artifact-frontmatter-equals","artifact":"${name}","field":"status","equals":"ok"}`;
  const evaluate = (dir, name = 'BEADS.md') => gate.evaluateCheckPredicate({
    projectDir: dir,
    args: ['--predicate', predicate(name), '--phase-dir', '.planning/phases/01-x'],
  });
  const FM = '---\nstatus: ok\n---\n';

  function ambiguousMessage(order) {
    const dir = createTempProject('gate-u10-ambiguous-');
    try {
      for (const f of order) w(dir, `.planning/phases/01-x/${f}`, FM);
      const result = evaluate(dir);
      assert.equal(result.outcome, 'block', JSON.stringify(result));
      assert.equal(result.payload.details.ambiguous, true);
      assert.deepEqual(result.payload.details.candidates.map((c) => path.basename(c)), ['01-BEADS.md', 'BEADS.md']);
      return result.payload.message.replace(dir, '<dir>');
    } finally {
      cleanup(dir);
    }
  }

  test('bare BEADS.md plus 01-BEADS.md blocks naming both', () => {
    const msg = ambiguousMessage(['BEADS.md', '01-BEADS.md']);
    assert.match(msg, /^Multiple artifacts match BEADS\.md in .*01-x: 01-BEADS\.md, BEADS\.md; remove or rename all but one$/);
  });

  // t.after, not try/finally in the body (CONTRIBUTING Testing Standards).
  function project(t, prefix, files) {
    const dir = createTempProject(prefix);
    t.after(() => cleanup(dir));
    for (const f of files) w(dir, `.planning/phases/01-x/${f}`, FM);
    return dir;
  }

  test('three candidates are all named in sorted order', (t) => {
    const dir = project(t, 'gate-u10-three-', ['BEADS.md', '.planning/BEADS.md', '01-BEADS.md']);
    const result = evaluate(dir);
    assert.equal(result.outcome, 'block', JSON.stringify(result));
    assert.match(result.payload.message, /: \.planning\/BEADS\.md, 01-BEADS\.md, BEADS\.md; remove or rename all but one$/);
    assert.equal(result.payload.details.candidates.length, 3);
  });

  test('creation order does not change the message', () => {
    assert.equal(ambiguousMessage(['BEADS.md', '01-BEADS.md']), ambiguousMessage(['01-BEADS.md', 'BEADS.md']));
  });

  test('.planning/BEADS.md plus bare BEADS.md blocks naming both', (t) => {
    const dir = project(t, 'gate-u10-planning-', ['BEADS.md', '.planning/BEADS.md']);
    const result = evaluate(dir);
    assert.equal(result.outcome, 'block', JSON.stringify(result));
    assert.match(result.payload.message, /: \.planning\/BEADS\.md, BEADS\.md; remove or rename all but one$/);
    assert.equal(result.payload.details.ambiguous, true);
    assert.deepEqual(
      result.payload.details.candidates.map((c) => path.relative(path.join(fs.realpathSync(dir), '.planning/phases/01-x'), c).split(path.sep).join('/')),
      ['.planning/BEADS.md', 'BEADS.md'],
    );
  });

  test('a symlink to the same file is one artifact, not an ambiguity', (t) => {
    const dir = project(t, 'gate-u10-symlink-', ['BEADS.md']);
    try {
      fs.symlinkSync('BEADS.md', path.join(dir, '.planning/phases/01-x/01-BEADS.md'));
    } catch (err) {
      if (err.code === 'EPERM') return t.skip('symlink creation not permitted on this host');
      throw err;
    }
    const result = evaluate(dir);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
  });

  test('a single match is unchanged: read, no ambiguity', (t) => {
    const dir = project(t, 'gate-u10-single-', ['01-BEADS.md']);
    const result = evaluate(dir);
    assert.equal(result.outcome, 'pass', JSON.stringify(result));
  });

  test('an unreadable listing throws the usage failure even when a direct file exists', (t) => {
    const dir = project(t, 'gate-u10-ambiguous-eacces-', ['BEADS.md']);
    const real = fs.readdirSync;
    t.after(() => { fs.readdirSync = real; });
    fs.readdirSync = function (p, ...rest) {
      if (String(p).endsWith('01-x')) {
        const err = new Error('EACCES: simulated readdir failure');
        err.code = 'EACCES';
        throw err;
      }
      return real.call(fs, p, ...rest);
    };
    const result = evaluate(dir);
    assert.equal(isGateUsageFailure(result), true, JSON.stringify(result));
    assert.equal(result.failure.code, 'usage');
  });
});
