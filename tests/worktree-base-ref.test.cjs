'use strict';

/**
 * Worktree Base-Ref Module — unit tests
 *
 * Seam: gsd-core/bin/lib/worktree-base-ref.cjs
 * Interface: shortSha, readBaseRefFromSettings, applyWorktreeBaseRef,
 *            resolveEffectiveBaseRef, findWorktreeCreateHook,
 *            evaluateWorktreeBaseDegrade
 *
 * Issue #683: worktree base-mismatch detection and degradation logic.
 * All tests use dependency injection (inline stubs) — no real filesystem
 * or real git is exercised.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');
const { cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-base-ref.cjs'
);

const {
  shortSha,
  readBaseRefFromSettings,
  applyWorktreeBaseRef,
  resolveEffectiveBaseRef,
  findWorktreeCreateHook,
  evaluateWorktreeBaseDegrade,
  classifyGitHead,
  cmdWorktreeBaseCheck,
  cmdWorktreeSetBaseRef,
} = require(MODULE_PATH);

// ─── shortSha ────────────────────────────────────────────────────────────────

describe('shortSha', () => {
  test('returns first 8 chars of a full sha', () => {
    assert.strictEqual(shortSha('abc123def456789'), 'abc123de');
  });

  test('returns the string itself when shorter than 8 chars', () => {
    assert.strictEqual(shortSha('abc12'), 'abc12');
  });

  test('returns empty string for null', () => {
    assert.strictEqual(shortSha(null), '');
  });

  test('returns empty string for empty string', () => {
    assert.strictEqual(shortSha(''), '');
  });

  test('returns exactly 8 chars when sha is exactly 8 chars', () => {
    assert.strictEqual(shortSha('12345678'), '12345678');
  });
});

// ─── readBaseRefFromSettings ─────────────────────────────────────────────────

describe('readBaseRefFromSettings', () => {
  test('returns baseRef when present as a string', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 'head' } }), 'head');
  });

  test('returns baseRef value "fresh"', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 'fresh' } }), 'fresh');
  });

  test('returns null when worktree is missing', () => {
    assert.strictEqual(readBaseRefFromSettings({}), null);
  });

  test('returns null when settings is null', () => {
    assert.strictEqual(readBaseRefFromSettings(null), null);
  });

  test('returns null when settings is undefined', () => {
    assert.strictEqual(readBaseRefFromSettings(undefined), null);
  });

  test('returns null when worktree is not an object (string)', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: 'not-an-object' }), null);
  });

  test('returns null when baseRef is a number (non-string)', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: 42 } }), null);
  });

  test('returns null when baseRef is null', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: null } }), null);
  });

  test('returns null when baseRef is undefined', () => {
    assert.strictEqual(readBaseRefFromSettings({ worktree: { baseRef: undefined } }), null);
  });
});

// ─── applyWorktreeBaseRef ─────────────────────────────────────────────────────

describe('applyWorktreeBaseRef', () => {
  test('sets baseRef to "head" when absent, returns changed:true', () => {
    const settings = {};
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.skipped, null);
    assert.strictEqual(result.previous, null);
    assert.strictEqual(result.settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree key is missing entirely', () => {
    const settings = { other: 'value' };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree.baseRef is null', () => {
    const settings = { worktree: { baseRef: null, otherKey: 'keep' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('sets baseRef to "head" when worktree.baseRef is undefined', () => {
    const settings = { worktree: { baseRef: undefined } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('preserves other worktree.* keys when setting baseRef', () => {
    const settings = { worktree: { otherKey: 'preserved', anotherKey: 123 } };
    applyWorktreeBaseRef(settings);
    assert.strictEqual(settings.worktree.otherKey, 'preserved');
    assert.strictEqual(settings.worktree.anotherKey, 123);
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('mutates settings in place and returns the same object reference', () => {
    const settings = {};
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.settings, settings);
  });

  test('returns already-head skip when baseRef is already "head"', () => {
    const settings = { worktree: { baseRef: 'head' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'already-head');
    assert.strictEqual(result.previous, 'head');
    assert.strictEqual(settings.worktree.baseRef, 'head');
  });

  test('returns explicit-other skip when baseRef is "fresh", does NOT overwrite', () => {
    const settings = { worktree: { baseRef: 'fresh' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'fresh');
    assert.strictEqual(settings.worktree.baseRef, 'fresh');
  });

  test('returns explicit-other skip for any other string value', () => {
    const settings = { worktree: { baseRef: 'some-branch' } };
    const result = applyWorktreeBaseRef(settings);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'some-branch');
  });
});

// ─── resolveEffectiveBaseRef ──────────────────────────────────────────────────

describe('resolveEffectiveBaseRef', () => {
  // Helper to build a path-keyed readFile stub
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  test('returns baseRef from settings.local.json when present', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('falls back to settings.json when settings.local.json has no baseRef', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ other: 'value' }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });

  test('returns null when both files are missing', () => {
    const claudeDir = '/repo/.claude';
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('returns null when both files exist but have no baseRef', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ other: 'value' }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ other: 'value2' }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('ignores malformed JSON in settings.local.json and falls back', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: 'not valid json {{{',
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('ignores malformed JSON in settings.json', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: null,
        [path.join(claudeDir, 'settings.json')]: 'not valid json',
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), null);
  });

  test('settings.local.json null baseRef falls back to settings.json', () => {
    const claudeDir = '/repo/.claude';
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: null } }),
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });
});

// ─── evaluateWorktreeBaseDegrade ──────────────────────────────────────────────

// Stub helper: matches on args.join(' ') and returns canned results.
// Module-scoped so the #4734 classifyGitHead describe shares one copy (review finding).
function makeExecGit(responses) {
  return function stubExecGit(args, _opts) {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(responses, key)) {
      return responses[key];
    }
    // Default: fail with a helpful error to surface unexpected calls
    throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
  };
}

describe('evaluateWorktreeBaseDegrade', () => {
  // #3659 rows share the diverged-HEAD stub shape — one builder keeps the
  // four fixtures from drifting apart.
  function makeDivergedExecGit(headSha, forkSha) {
    const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
    return makeExecGit({
      'rev-parse HEAD': ok(headSha),
      'rev-parse --verify --quiet origin/HEAD': ok(forkSha),
    });
  }

  test('effectiveBaseRef="head" + orchestrator mode → no degrade, reason baseref-head, execGit never called (#3659)', () => {
    let called = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { called = true; return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null }; },
      effectiveBaseRef: 'head',
      isolationMode: 'orchestrator-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.headSha, null);
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    assert.strictEqual(called, false, 'orchestrator mode: GSD controls the fork start-point, head is honored by construction');
  });

  test('effectiveBaseRef="head" + harness mode (default) + diverged HEAD → no degrade, reason baseref-head, execGit never called (#4588)', () => {
    // #3659 made harness mode fall through to the origin/HEAD comparison on
    // #48's finding that the harness did not read the setting. It does now —
    // measured on current Claude Code from all three settings layers on macOS,
    // Windows and Linux (#4588) — so `head` means the fork base IS the
    // orchestrator HEAD in harness mode too, and there is nothing to compare.
    let called = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { called = true; return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null }; },
      effectiveBaseRef: 'head',
    });
    assert.strictEqual(result.shouldDegrade, false,
      'head must suppress the comparison in harness mode: the Claude Code harness honors worktree.baseRef, as measured (#4588)');
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.headSha, null);
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    assert.strictEqual(called, false, 'no observation and head set: the fork base is known without asking git');
  });

  test('effectiveBaseRef="head" + explicit harness-worktree mode + diverged → no degrade (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { throw new Error('execGit must not be called'); },
      effectiveBaseRef: 'head',
      isolationMode: 'harness-worktree',
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
  });

  // ── observedForkBase (#4588): the measurement replaces the inference ─────

  test('observedForkBase === HEAD + harness + head → no degrade, reason observed-fork-matches-head; origin/HEAD never resolved (#4588)', () => {
    // The regression the triage brief named: an observed fork base equal to
    // local HEAD in harness mode must be able to yield shouldDegrade:false.
    const SAME_SHA = 'cccc1111223344eecccc1111223344eecccc1111';
    const calls = [];
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'rev-parse HEAD') return { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null };
        throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
      },
      effectiveBaseRef: 'head',
      isolationMode: 'harness-worktree',
      observedForkBase: SAME_SHA,
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
    assert.strictEqual(result.headSha, SAME_SHA);
    assert.strictEqual(result.forkRef, 'observed');
    assert.strictEqual(result.forkSha, SAME_SHA);
    assert.deepStrictEqual(calls, ['rev-parse HEAD'],
      'an observation is the fork base — origin/HEAD must not be consulted');
  });

  test('observedForkBase !== HEAD + harness + head → degrade, reason baseref-head-ignored-by-harness, message names the observation (#4588)', () => {
    // Acceptance criterion (2): a genuine mismatch keeps the existing
    // degrade-and-warn — now reporting a measurement, not a belief.
    const HEAD_SHA = '11111111223344aa11111111223344aa11111111';
    const OBSERVED = '99999999223344bb99999999223344bb99999999';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
      effectiveBaseRef: 'head',
      observedForkBase: OBSERVED,
    });
    assert.strictEqual(result.shouldDegrade, true,
      'head set but the host forked from elsewhere: the harness did not honor it — degrade (#4588)');
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'observed');
    assert.strictEqual(result.forkSha, OBSERVED);
    assert.ok(result.message !== null, 'divergence under head must carry the explanatory message');
    // Pinned VERBATIM — the source declares these messages downstream dependencies, and a
    // substring check lets the untested portions drift (P4.6 review, round 3).
    const expectedMsg = `⚠ Worktree base mismatch: worktree.baseRef:"head" is set, but a worktree created for this dispatch was observed to fork from ${OBSERVED.slice(0, 8)} while HEAD is ${HEAD_SHA.slice(0, 8)} — the worktree was not forked from HEAD despite the setting. Running this phase sequentially on the main working tree. Parallel worktrees return once a fresh dispatch is observed to fork from HEAD, or once HEAD is merged/pushed so the default fork base matches it. See #3659, #4588.`;
    assert.strictEqual(result.message, expectedMsg);
    assert.ok(result.message.includes('observed'), 'message must say the fork base was observed, not inferred');
    assert.ok(!result.message.includes('runtime harness'),
      'message must be mode-neutral — the observation may come from a GSD-created worktree (P4.6 review)');
    assert.ok(result.message.includes('fresh dispatch'),
      'remedy must ask for a fresh observation — pushing cannot change a fixed measurement');
    assert.ok(result.message.includes(OBSERVED.slice(0, 8)) && result.message.includes(HEAD_SHA.slice(0, 8)),
      'message must carry both short SHAs');
    assert.ok(result.message.includes('sequentially'), 'message must state the sequential fallback');
    assert.ok(result.message.includes('#4588'), 'message must cite the measurement issue');
  });

  test('observedForkBase !== HEAD + no baseRef → degrade, reason head-diverged-from-fork, forkRef "observed" (#4588)', () => {
    const HEAD_SHA = 'aaaa1111223344ccaaaa1111223344ccaaaa1111';
    const OBSERVED = 'bbbb1111223344ddbbbb1111223344ddbbbb1111';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
      observedForkBase: OBSERVED,
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
    assert.strictEqual(result.forkRef, 'observed');
    assert.strictEqual(result.forkSha, OBSERVED);
    // Pinned verbatim (P4.6 review, round 4) — the observed branch of buildMsgDiverged.
    const expectedMsg = `⚠ Worktree base mismatch: HEAD (${HEAD_SHA.slice(0, 8)}) differs from the observed fork base (${OBSERVED.slice(0, 8)}). Running this phase sequentially on the main working tree. Parallel worktrees return once a fresh dispatch is observed to fork from HEAD, or once HEAD is merged/pushed so the default fork base matches it, or set worktree.baseRef:"head" to fork worktrees from HEAD instead (honored by GSD-created worktrees and by the Claude Code harness; #683, #4588).`;
    assert.strictEqual(result.message, expectedMsg);
    assert.ok(result.message.includes('the observed fork base'),
      'message must phrase the fork side as an observation, not as a ref name');
    assert.ok(result.message.includes('fresh dispatch') && !result.message.includes('so the observed fork base matches it'),
      'remedy must not tell the user to push until a fixed observation matches');
  });

  test('observedForkBase is case-folded: an uppercase 40-hex observation equal to HEAD matches (#4588 review)', () => {
    const SAME_SHA = '0123456789abcdef0123456789abcdef01234567';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      observedForkBase: SAME_SHA.toUpperCase(),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
    assert.strictEqual(result.forkSha, SAME_SHA, 'forkSha is the canonical lowercase form');
  });

  test('observedForkBase accepts a 64-hex (SHA-256 repository) sha (#4588 review)', () => {
    const SAME_SHA = 'a'.repeat(64);
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      observedForkBase: SAME_SHA,
    });
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
  });

  test('observedForkBase that is not a string (number, object, boolean) THROWS rather than reading as absent (#4588 review r2)', () => {
    for (const bad of [123, {}, true, []]) {
      assert.throws(
        () => evaluateWorktreeBaseDegrade({
          execGit: () => { throw new Error('execGit must not be called'); },
          effectiveBaseRef: 'head',
          observedForkBase: bad,
        }),
        /observedForkBase must be a full 40- or 64-hex commit sha/,
        `observedForkBase=${JSON.stringify(bad)} must fail closed, not short-circuit as baseref-head`
      );
    }
  });

  test('observedForkBase that is non-blank but not a full sha THROWS — an abbreviation could never match and would always degrade (#4588 review)', () => {
    // One full-string pin so the validation message itself cannot drift (P4.6 review, round 4).
    assert.throws(
      () => evaluateWorktreeBaseDegrade({ execGit: () => { throw new Error('unreachable'); }, observedForkBase: 'HEAD' }),
      { name: 'TypeError', message: 'evaluateWorktreeBaseDegrade: observedForkBase must be a full 40- or 64-hex commit sha (git rev-parse HEAD inside the worktree, before any commit), got "HEAD"' }
    );
    // Both alternatives of FULL_SHA_RE get their own ±1 boundary: 39/41 around the
    // 40-hex (SHA-1) arm, 63/65 around the 64-hex (SHA-256) arm (#4921 review).
    for (const bad of ['0123456', '0123456789abcdef0123456789abcdef0123456', 'HEAD', 'not-a-sha', 'g'.repeat(40), 'b'.repeat(41), 'c'.repeat(63), 'd'.repeat(65), 'g'.repeat(64)]) {
      assert.throws(
        () => evaluateWorktreeBaseDegrade({
          execGit: () => { throw new Error('execGit must not be called before the observation is validated'); },
          effectiveBaseRef: 'head',
          observedForkBase: bad,
        }),
        /observedForkBase must be a full 40- or 64-hex commit sha/,
        `observedForkBase=${JSON.stringify(bad)} must fail closed`
      );
    }
  });

  test('observedForkBase === HEAD + no baseRef → no degrade, reason observed-fork-matches-head (#4588)', () => {
    const SAME_SHA = 'dddd1111223344ffdddd1111223344ffdddd1111';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      observedForkBase: SAME_SHA,
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
  });

  test('observedForkBase + head + orchestrator mode → the observation still decides (no short-circuit) (#4588)', () => {
    // An observation is stronger than either mode's belief about the fork
    // base: if GSD's own `git worktree add` somehow forked from elsewhere, the
    // measurement — not the construction argument — is what the verdict reads.
    const HEAD_SHA = 'eeee1111223344abeeee1111223344abeeee1111';
    const OBSERVED = 'ffff1111223344acffff1111223344acffff1111';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
      effectiveBaseRef: 'head',
      isolationMode: 'orchestrator-worktree',
      observedForkBase: OBSERVED,
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
  });

  test('observedForkBase empty or whitespace → treated as absent: head short-circuits, else origin/HEAD is inferred (#4588)', () => {
    // Negative control for the observation path: an empty observation must
    // not be mistaken for a measured fork base of "".
    for (const empty of ['', '   ', null, undefined]) {
      const viaHead = evaluateWorktreeBaseDegrade({
        execGit: () => { throw new Error('execGit must not be called'); },
        effectiveBaseRef: 'head',
        observedForkBase: empty,
      });
      assert.strictEqual(viaHead.reason, 'baseref-head', `head + observedForkBase=${JSON.stringify(empty)} short-circuits`);

      const HEAD_SHA = '12341234123412341234123412341234deadbeef';
      const FORK_SHA = '43214321432143214321432143214321cafebabe';
      const inferred = evaluateWorktreeBaseDegrade({
        execGit: makeDivergedExecGit(HEAD_SHA, FORK_SHA),
        observedForkBase: empty,
      });
      assert.strictEqual(inferred.reason, 'head-diverged-from-fork', `no head + observedForkBase=${JSON.stringify(empty)} infers origin/HEAD`);
      assert.strictEqual(inferred.forkRef, 'origin/HEAD');
    }
  });

  test('observedForkBase does not bypass HEAD resolution: exit 128 → no-head, degrades as #4734 pinned (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repo', signal: null, error: null },
      }),
      observedForkBase: 'abcdef1234567890abcdef1234567890abcdef12',
    });
    // #4734: exit 128 is git's definitive "no repository" answer and degrades —
    // an observation cannot make a worktree creatable where none can exist.
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, true);
  });

  test('git rev-parse HEAD exits 128 (definitive no-repository) → degrades, reason no-head (#4734)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repo', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headSha, null);
  });

  test('git rev-parse HEAD returns empty stdout → no degrade, reason no-head', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
  });

  // ─── #3050: fail-closed matrix for git rev-parse HEAD outcomes ─────────────
  // DECIDED RULE: degrade UNLESS git completed and gave a definitive answer.
  //   - timeout                       → degrade, reason 'head-unresolvable'
  //   (#4734 revised the exit-128 row: git's definitive no-repository answer
  //   now DEGRADES — a worktree can never be created there. The ambiguous
  //   exit-0-empty row is unchanged, still deliberately non-degrading.)
  //   - exitCode === 128              → degrade, reason 'no-head' (#4734)
  //   - exit 0 with non-empty sha     → proceed (unchanged)
  //   - anything else (127, other     → degrade, reason 'head-unresolvable'
  //     non-zero, exit 0 empty stdout
  //     is pinned separately above)

  test('git rev-parse HEAD TIMES OUT → shouldDegrade:true, reason "head-unresolvable" (#3050)', () => {
    const timedOutErr = new Error('spawnSync git ETIMEDOUT');
    timedOutErr.code = 'ETIMEDOUT';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: timedOutErr },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
    assert.ok(result.message, 'a fail-closed degrade must carry a non-null explanatory message');
    // Pinned verbatim (P4.6 review, round 4). #4588 dropped the sentence claiming
    // baseRef:"head" "never applied" in harness mode — with head set this path is
    // no longer reached at all, so the note would have been false.
    assert.strictEqual(result.message,
      '⚠ Cannot determine the worktree base (git rev-parse HEAD did not return a definitive answer). Running this phase sequentially on the main working tree to avoid an unverified base mismatch. Retry; if it persists, check for a stalled filesystem mount or a stale git index lock (.git/index.lock). See #683, #3050.');
    assert.strictEqual(result.headSha, null);
  });

  test('cross-platform: timeout WITHOUT signal set (Windows shape) still degrades (#3050)', () => {
    // Node.js guarantees error.code === 'ETIMEDOUT' cross-platform when the
    // spawnSync `timeout` option fires; `signal` reporting is the
    // platform-fragile half and must not be required to detect a timeout.
    const timedOutErr = new Error('spawnSync git ETIMEDOUT');
    timedOutErr.code = 'ETIMEDOUT';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: null, stdout: '', stderr: '', signal: null, error: timedOutErr },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('git missing (exitCode 127) → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 127, stdout: '', stderr: 'git: not found', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  // Boundary coverage: 128 is the ONLY benign non-zero exit (definitive "not a
  // git repository"). 129 (limit+1) must NOT be swept into that carve-out.
  test('exitCode 129 (limit+1 boundary, just past the 128 carve-out) → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 129, stdout: '', stderr: 'fatal: something else', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('other non-zero, non-128 exit → degrade, reason "head-unresolvable" (#3050)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 1, stdout: '', stderr: 'fatal: something else', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-unresolvable');
  });

  test('exitCode 128 ("not a git repository") degrades with a user-visible message (#4734; was a #3050 non-degrade pin)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, true);
    // Message presence is a typed fact (non-null, non-empty) — its prose is
    // operator-facing text, not a test oracle (no raw-text matching).
    assert.ok(typeof result.message === 'string' && result.message.length > 0, 'the degrade carries the message the workflow prints');
  });

  // ─── #3057 B8: headAbsenceVerified distinguishes the two "no-head" causes ──
  //
  // #4734 revised the exit-128 outcome (degrade, with headAbsenceVerified:true
  // preserved) and left the exit-0-empty outcome deliberately unchanged — the
  // paired tests below prove both, and that a caller can still tell the two
  // 'no-head' causes apart.

  test('exit 128 — git\'s definitive "not a git repository" answer → degrades, headAbsenceVerified:true (#4734)', () => {
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, stderr: 'fatal: not a git repository' }],
    });
    const result = evaluateWorktreeBaseDegrade({ execGit: faultyGit });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, true);
  });

  test('exit 0 with empty stdout — git completed but gave no useful answer → headAbsenceVerified:false', () => {
    // makeFaultyGit()'s default passthrough IS exit 0 / empty stdout / no
    // error / not timed out — a real, completed, but non-substantive answer.
    const faultyGit = makeFaultyGit();
    const result = evaluateWorktreeBaseDegrade({ execGit: faultyGit });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, false);
  });

  test('headAbsenceVerified is null (not applicable) for a reason other than no-head', () => {
    const result = evaluateWorktreeBaseDegrade({ effectiveBaseRef: 'head', isolationMode: 'orchestrator-worktree' });
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.headAbsenceVerified, null);
  });

  test('HEAD == origin/HEAD → no degrade, reason head-matches-fork', () => {
    const HEAD_SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'origin/HEAD');
    assert.strictEqual(result.forkSha, HEAD_SHA);
    assert.strictEqual(result.message, null);
  });

  test('HEAD != origin/HEAD → degrade, reason head-diverged-from-fork, MSG_DIVERGED', () => {
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkRef, 'origin/HEAD');
    assert.strictEqual(result.forkSha, FORK_SHA);
    // Verify message contains the short SHAs and the remediation. #3659 had
    // removed the baseRef:"head" advice on #48's finding that the harness did
    // not read the setting; it does now (#4588), so the advice is back — with
    // the setting absent the harness really does fork from origin/HEAD, and
    // `head` is the fix for that.
    const expectedMsg = `⚠ Worktree base mismatch: HEAD (${HEAD_SHA.slice(0, 8)}) differs from origin/HEAD (${FORK_SHA.slice(0, 8)}). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so origin/HEAD matches it, or set worktree.baseRef:"head" to fork worktrees from HEAD instead (honored by GSD-created worktrees and by the Claude Code harness; #683, #4588).`;
    assert.strictEqual(result.message, expectedMsg);
  });

  test('origin/HEAD fails but symbolic-ref resolves to refs/remotes/origin/next', () => {
    const HEAD_SHA = 'aaaa1111bbbb2222aaaa1111bbbb2222aaaa1111';
    const FORK_SHA = 'cccc3333dddd4444cccc3333dddd4444cccc3333';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/next', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/next': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.forkRef, 'origin/next');
    assert.strictEqual(result.forkSha, FORK_SHA);
    // HEAD != FORK_SHA in this fixture → degrade
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
    assert.ok(result.message !== null);
    assert.ok(result.message.includes('origin/next'));
  });

  test('origin/HEAD fails AND symbolic-ref fails → degrade, reason fork-ref-unknown, MSG_UNKNOWN', () => {
    const HEAD_SHA = 'eeee5555ffff6666eeee5555ffff6666eeee5555';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
    const expectedMsg = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. Parallel worktrees return once origin/HEAD resolves and matches HEAD. See #683, #3659.`;
    assert.strictEqual(result.message, expectedMsg);
  });

  test('cwd is passed through to execGit calls', () => {
    const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678';
    const capturedOpts = [];
    const result = evaluateWorktreeBaseDegrade({
      cwd: '/some/worktree',
      execGit: (args, opts) => {
        capturedOpts.push(opts);
        const key = args.join(' ');
        if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
        if (key === 'rev-parse --verify --quiet origin/HEAD') return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
        throw new Error(`Unexpected: ${key}`);
      },
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.ok(capturedOpts.length > 0);
    for (const opts of capturedOpts) {
      assert.strictEqual(opts && opts.cwd, '/some/worktree');
    }
  });

  test('symbolic-ref resolves but subsequent rev-parse fails → falls through to fork-ref-unknown', () => {
    const HEAD_SHA = 'abcd1234abcd1234abcd1234abcd1234abcd1234';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/main': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'fork-ref-unknown');
    assert.strictEqual(result.forkRef, null);
    assert.strictEqual(result.forkSha, null);
  });
});

// ─── cmdWorktreeBaseCheck ─────────────────────────────────────────────────────

describe('cmdWorktreeBaseCheck', () => {
  function makeExecGitCheck(responses) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        return responses[key];
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('baseRef=head in settings + --mode orchestrator-worktree → shouldDegrade false, reason baseref-head; write emits valid JSON (#3659)', () => {
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    let written = '';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({}),
      write: (s) => { written += s; },
      // Hermetic: point userClaudeDir at a non-existent path so real ~/.claude is never read
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, ['--mode', 'orchestrator-worktree'], deps);
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    const parsed = JSON.parse(written);
    assert.deepStrictEqual(parsed, result);
  });

  test('baseRef=head in settings + default (harness) mode + diverged HEAD → shouldDegrade false, reason baseref-head (#4588)', () => {
    // The #4588 symptom end to end: project-local head, harness mode, HEAD
    // ahead of origin/HEAD — this returned baseref-head-ignored-by-harness and
    // degraded every wave on an unmerged branch. The Claude Code harness honors the
    // setting, so the check no longer compares.
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    const HEAD_SHA = 'fade1111223344cafade1111223344cafade1111';
    const FORK_SHA = 'bead1111223344dbbead1111223344dbbead1111';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, false,
      'settings head suppresses the harness-mode comparison: the Claude Code harness honors worktree.baseRef, as measured (#4588)');
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('--observed-fork-base <sha> equal to HEAD + settings head → observed-fork-matches-head (#4588)', () => {
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    const SAME_SHA = 'feed1111223344dafeed1111223344dafeed1111';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, ['--observed-fork-base', SAME_SHA], deps);
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
    assert.strictEqual(result.forkRef, 'observed');
  });

  test('--observed-fork-base <sha> differing from HEAD + settings head → baseref-head-ignored-by-harness (#4588)', () => {
    const cwd = '/repo';
    const claudeDir = '/repo/.claude';
    const HEAD_SHA = 'fade1111223344cafade1111223344cafade1111';
    const OBSERVED = 'bead1111223344dbbead1111223344dbbead1111';
    const deps = {
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
      }),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, ['--mode', 'harness-worktree', '--observed-fork-base', OBSERVED], deps);
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
    assert.strictEqual(result.forkSha, OBSERVED);
  });

  test('--observed-fork-base rejects a missing or non-sha value — no silent fallback to inference (#4588)', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({}),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    // Includes the abbreviated 7-char form: accepted by an earlier draft, it could never
    // equal the full `rev-parse HEAD` output and so always degraded (P4.6 review).
    for (const bad of [['--observed-fork-base'], ['--observed-fork-base', 'HEAD'], ['--observed-fork-base', 'abc'], ['--observed-fork-base', 'abcdef1'], ['--observed-fork-base', 'g'.repeat(40)], ['--observed-fork-base', 'a'.repeat(39)]]) {
      assert.throws(
        () => cmdWorktreeBaseCheck(cwd, bad, deps),
        /--observed-fork-base: observedForkBase must be a full 40- or 64-hex commit sha/,
        `args ${JSON.stringify(bad)} must fail closed`
      );
    }
  });

  test('--observed-fork-base folds case before comparing (#4588 review)', () => {
    const cwd = '/repo';
    const SAME_SHA = 'feed1111223344dafeed1111223344dafeed1111';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: SAME_SHA, stderr: '', signal: null, error: null },
      }),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, ['--observed-fork-base', SAME_SHA.toUpperCase()], deps);
    assert.strictEqual(result.reason, 'observed-fork-matches-head');
    assert.strictEqual(result.forkSha, SAME_SHA);
  });

  test('--mode rejects invalid values — no silent default that would re-open the #3659 hole', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({}),
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    assert.throws(
      () => cmdWorktreeBaseCheck(cwd, ['--mode', 'bogus-mode'], deps),
      /--mode must be harness-worktree or orchestrator-worktree/
    );
    assert.throws(
      () => cmdWorktreeBaseCheck(cwd, ['--mode'], deps),
      /--mode must be harness-worktree or orchestrator-worktree/
    );
  });

  test('default emit goes through fs.writeSync(1, …) — the seam --pick intercepts (#3659)', (t) => {
    // The CLI's --pick capture patches fs.writeSync, not process.stdout.write;
    // under $(…) command substitution the stdout.write default made --pick
    // emit the full JSON, so the workflow auto-degrade guards never matched.
    const fds = [];
    const chunks = [];
    const original = fs.writeSync;
    fs.writeSync = (fd, buf, offset, length) => {
      const n = original.call(fs, fd, buf, offset, length);
      fds.push(fd);
      // Chunk is derived from the REAL return count `n`, not the requested
      // extent — a genuine short write must be reflected accurately (#4306).
      const start = offset ?? 0;
      chunks.push(typeof buf === 'string' ? buf.slice(start, start + n) : buf.toString('utf8', start, start + n));
      return n;
    };
    t.after(() => { fs.writeSync = original; });
    const result = cmdWorktreeBaseCheck('/repo', [], {
      readFile: () => null,
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null },
      }),
      userClaudeDir: '/nonexistent-hermetic-user-dir',
      // no deps.write — the default seam under test
    });
    assert.ok(fds.length > 0, 'default emit must call fs.writeSync');
    assert.ok(fds.every((fd) => fd === 1), 'every write must target fd 1 (stdout)');
    const emitted = chunks.join('');
    assert.ok(emitted.includes('"reason"'), 'emitted payload is the JSON result');
    assert.strictEqual(result.reason, 'no-head');
  });

  test('diverged shas → shouldDegrade true; captured JSON parses correctly', () => {
    const cwd = '/repo';
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    let written = '';
    const deps = {
      readFile: () => null,
      execGit: makeExecGitCheck({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA, stderr: '', signal: null, error: null },
      }),
      write: (s) => { written += s; },
      // Hermetic: point userClaudeDir at a non-existent path so real ~/.claude is never read
      userClaudeDir: '/nonexistent-hermetic-user-dir',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true);
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.shouldDegrade, true);
    assert.strictEqual(parsed.reason, 'head-diverged-from-fork');
  });
});

// ─── cmdWorktreeSetBaseRef ────────────────────────────────────────────────────

describe('cmdWorktreeSetBaseRef', () => {
  test('readFile returns {} → changed true, writeFile called with worktree.baseRef "head"', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    let writtenPath = null;
    let writtenContent = null;
    let written = '';
    const deps = {
      readFile: () => '{}',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: (p, content) => { writtenPath = p; writtenContent = content; },
      write: (s) => { written += s; },
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.file, file);
    assert.strictEqual(result.baseRef, 'head');
    assert.strictEqual(writtenPath, file);
    const parsedWritten = JSON.parse(writtenContent);
    assert.strictEqual(parsedWritten.worktree.baseRef, 'head');
    const parsedOutput = JSON.parse(written);
    assert.strictEqual(parsedOutput.changed, true);
  });

  test('readFile returns explicit-other → changed false, skipped explicit-other, writeFile NOT called', () => {
    const cwd = '/repo';
    let writeFileCalled = false;
    let written = '';
    const deps = {
      readFile: () => JSON.stringify({ worktree: { baseRef: 'fresh' } }),
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: (s) => { written += s; },
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(result.previous, 'fresh');
    assert.strictEqual(writeFileCalled, false, 'writeFile must NOT be called for explicit-other');
    const parsedOutput = JSON.parse(written);
    assert.strictEqual(parsedOutput.changed, false);
    assert.strictEqual(parsedOutput.skipped, 'explicit-other');
  });

  test('readFile returns malformed JSON → throws refusing-to-modify error', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    const deps = {
      readFile: () => '{',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        assert.ok(err.message.includes('Refusing to modify'), `message should contain "Refusing to modify", got: ${err.message}`);
        assert.ok(err.message.includes(file), `message should contain file path, got: ${err.message}`);
        return true;
      }
    );
  });

  test('readFile returns null (missing file) → treated as {} → changed true', () => {
    const cwd = '/repo';
    let writeFileCalled = false;
    const deps = {
      readFile: () => null,
      existsSync: () => false,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(writeFileCalled, true);
  });

  // FIX 2: non-object top-level JSON must be rejected with a clear error
  test('readFile returns "[]" (array) → throws /expected a JSON object/', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => '[]',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      /expected a JSON object/
    );
  });

  test('readFile returns "42" (primitive) → throws /expected a JSON object/', () => {
    const cwd = '/repo';
    const deps = {
      readFile: () => '42',
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      /expected a JSON object/
    );
  });
});

// FIX 2: applyWorktreeBaseRef must reject non-object/array/null inputs

describe('applyWorktreeBaseRef — non-object inputs (FIX 2)', () => {
  test('applyWorktreeBaseRef(null) → throws TypeError', () => {
    assert.throws(
      () => applyWorktreeBaseRef(null),
      TypeError
    );
  });

  test('applyWorktreeBaseRef([]) → throws TypeError', () => {
    assert.throws(
      () => applyWorktreeBaseRef([]),
      TypeError
    );
  });
});

// ─── FIX 2: JSONC support ─────────────────────────────────────────────────────

describe('resolveEffectiveBaseRef — JSONC (FIX 2)', () => {
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  test('returns baseRef from settings.local.json with // line comments', () => {
    const claudeDir = '/repo/.claude';
    const jsonc = [
      '// this is a comment',
      '{',
      '  // another comment',
      '  "worktree": {',
      '    "baseRef": "head" // inline comment',
      '  }',
      '}',
    ].join('\n');
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: jsonc,
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'head');
  });

  test('returns baseRef from settings.local.json with /* */ block comments', () => {
    const claudeDir = '/repo/.claude';
    const jsonc = [
      '/* block comment */',
      '{',
      '  "worktree": { /* inline block */ "baseRef": "fresh" }',
      '}',
      '/* trailing block */',
    ].join('\n');
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: jsonc,
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps), 'fresh');
  });
});

describe('cmdWorktreeSetBaseRef — JSONC (FIX 2)', () => {
  test('commented-but-valid settings.local.json → updates it (changed true) rather than throwing', () => {
    const cwd = '/repo';
    const jsonc = [
      '// user comment',
      '{',
      '  // another comment',
      '  "other": "value"',
      '}',
    ].join('\n');
    let writtenContent = null;
    const deps = {
      readFile: () => jsonc,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: (_p, content) => { writtenContent = content; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, true, 'must set baseRef when absent (even in JSONC file)');
    assert.ok(writtenContent !== null, 'must write the updated file');
    const parsed = JSON.parse(writtenContent);
    assert.strictEqual(parsed.worktree.baseRef, 'head');
  });

  test('JSONC with explicit baseRef="fresh" → skipped explicit-other, does not throw', () => {
    const cwd = '/repo';
    const jsonc = [
      '// user comment',
      '{',
      '  "worktree": {',
      '    // keeps the fork base fixed',
      '    "baseRef": "fresh"',
      '  }',
      '}',
    ].join('\n');
    let writeFileCalled = false;
    const deps = {
      readFile: () => jsonc,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => { writeFileCalled = true; },
      write: () => {},
    };
    const result = cmdWorktreeSetBaseRef(cwd, [], deps);
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.skipped, 'explicit-other');
    assert.strictEqual(writeFileCalled, false);
  });

  test('genuinely malformed JSON (after stripping comments) still throws refusing-to-modify', () => {
    const cwd = '/repo';
    const file = path.join(cwd, '.claude', 'settings.local.json');
    // This is malformed even after comment stripping
    const malformed = '// comment\n{ "key": }';
    const deps = {
      readFile: () => malformed,
      existsSync: () => true,
      mkdir: () => {},
      writeFile: () => {},
      write: () => {},
    };
    assert.throws(
      () => cmdWorktreeSetBaseRef(cwd, [], deps),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Refusing to modify'), `got: ${err.message}`);
        assert.ok(err.message.includes(file), `got: ${err.message}`);
        return true;
      }
    );
  });
});

// ─── FIX 3: defensive trim on git SHAs ────────────────────────────────────────

describe('evaluateWorktreeBaseDegrade — defensive trim on SHAs (FIX 3)', () => {
  function makeExecGit(responses) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) {
        return responses[key];
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('HEAD with trailing newline still matches origin/HEAD — no degrade', () => {
    const SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: SHA + '\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
  });

  test('HEAD with trailing whitespace still diverges correctly from different origin/HEAD', () => {
    const HEAD_SHA = 'deadbeef11223344deadbeef11223344deadbeef';
    const FORK_SHA = 'cafebabe11223344cafebabe11223344cafebabe';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 0, stdout: FORK_SHA + '\r\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
    // After trimming, headSha and forkSha should be clean
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkSha, FORK_SHA);
  });

  test('symbolic-ref stdout with trailing newline resolves correctly', () => {
    const HEAD_SHA = 'aaaa1111bbbb2222aaaa1111bbbb2222aaaa1111';
    const FORK_SHA = 'cccc3333dddd4444cccc3333dddd4444cccc3333';
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: HEAD_SHA + '\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet origin/HEAD': { exitCode: 1, stdout: '', stderr: '', signal: null, error: null },
        'symbolic-ref --quiet refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'refs/remotes/origin/next\n', stderr: '', signal: null, error: null },
        'rev-parse --verify --quiet refs/remotes/origin/next': { exitCode: 0, stdout: FORK_SHA + '\n', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(result.forkRef, 'origin/next');
    assert.strictEqual(result.forkSha, FORK_SHA);
    assert.strictEqual(result.shouldDegrade, true);
  });
});

// ─── resolveEffectiveBaseRef — user/global layer (#1013) ─────────────────────

describe('resolveEffectiveBaseRef — user/global layer (#1013)', () => {
  function makeReadFile(files) {
    return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
  }

  const USER_CLAUDE_DIR = '/home/user/.claude';
  const claudeDir = '/repo/.claude';

  test('(a) user/global settings.json provides baseRef:"head" when both project files absent', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'head');
  });

  test('(b) project local "fresh" OVERRIDES user/global "head" → returns "fresh"', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.local.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'fresh');
  });

  test('(c) project shared "fresh" (no local) OVERRIDES user/global "head" → returns "fresh"', () => {
    const deps = {
      readFile: makeReadFile({
        [path.join(claudeDir, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'fresh' } }),
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ worktree: { baseRef: 'head' } }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), 'fresh');
  });

  test('(d) userClaudeDir undefined → behaves as before, returns null when both project files absent', () => {
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, undefined), null);
  });

  test('(d) userClaudeDir null → behaves as before, returns null when both project files absent', () => {
    const deps = { readFile: () => null };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, null), null);
  });

  test('user/global settings.json absent → returns null (no fallback beyond user layer)', () => {
    const deps = {
      readFile: makeReadFile({
        // user settings.json present but has no baseRef
        [path.join(USER_CLAUDE_DIR, 'settings.json')]: JSON.stringify({ other: 'value' }),
      }),
    };
    assert.strictEqual(resolveEffectiveBaseRef(claudeDir, deps, USER_CLAUDE_DIR), null);
  });

  test('userClaudeDir === claudeDir → does not double-read (avoids re-reading shared settings.json)', () => {
    // When project dir IS the user dir (cwd is home), the user layer should be skipped
    // to avoid reading settings.json twice. This is enforced by the path.resolve comparison.
    const sameDir = '/home/.claude';
    let readCount = 0;
    const deps = {
      readFile: (p) => {
        readCount++;
        if (p === path.join(sameDir, 'settings.local.json')) return null;
        if (p === path.join(sameDir, 'settings.json')) return JSON.stringify({ worktree: { baseRef: 'head' } });
        return null;
      },
    };
    // resolveEffectiveBaseRef(sameDir, deps, sameDir) — userClaudeDir === claudeDir
    const result = resolveEffectiveBaseRef(sameDir, deps, sameDir);
    assert.strictEqual(result, 'head'); // still reads shared settings.json (the project layer)
    // The shared settings.json should have been read exactly once (project layer), not twice
    assert.strictEqual(readCount, 2, 'only local + shared should be read; user layer skipped when same dir');
  });
});

// ─── cmdWorktreeBaseCheck — user/global cascade (#1013 KEY REGRESSION) ───────

describe('cmdWorktreeBaseCheck — user/global cascade (#1013)', () => {
  // Phase-lane execGit: origin/HEAD probe fails (no symref either) → fork-ref-unknown → degrade
  function makePhaseLaneExecGit(HEAD_SHA) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: HEAD_SHA, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  const HEAD_SHA = 'phase1lane11223344phase1lane11223344phase';
  const USER_CLAUDE_DIR = '/home/user/.claude';
  const cwd = '/repo';
  const claudeDir = '/repo/.claude';

  test('(e positive) user/global head + phase lane + orchestrator mode → shouldDegrade:false (KEY REGRESSION #1013)', () => {
    // This is the exact bug #1013 fixed: user set worktree.baseRef:"head" in their global
    // settings, but the setting was invisible and the phase lane triggered degrade. The
    // suppress now applies only where GSD manages the fork (--mode orchestrator-worktree),
    // which is also what keeps this cascade proof meaningful post-#3659.
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: (p) => {
        // Project files: no baseRef
        if (p === path.join(claudeDir, 'settings.local.json')) return null;
        if (p === path.join(claudeDir, 'settings.json')) return null;
        // User/global file: baseRef = "head"
        if (p === path.join(USER_CLAUDE_DIR, 'settings.json')) {
          return JSON.stringify({ worktree: { baseRef: 'head' } });
        }
        return null;
      },
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    };
    const result = cmdWorktreeBaseCheck(cwd, ['--mode', 'orchestrator-worktree'], deps);
    assert.strictEqual(result.shouldDegrade, false,
      'user/global worktree.baseRef:"head" must suppress degrade on a phase lane where GSD manages the fork');
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('user/global head + phase lane + default (harness) mode → shouldDegrade:false (#4588)', () => {
    // The mirror of the KEY REGRESSION row. #3659 had this lane degrade in
    // harness mode on #48's finding that the harness did not read the setting;
    // the user/global layer in particular is honored by the harness (measured
    // on current Claude Code, #4588 — the arm #4090's triage left to the
    // originating investigation), so the same lane no longer degrades.
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: (p) => {
        if (p === path.join(claudeDir, 'settings.local.json')) return null;
        if (p === path.join(claudeDir, 'settings.json')) return null;
        if (p === path.join(USER_CLAUDE_DIR, 'settings.json')) {
          return JSON.stringify({ worktree: { baseRef: 'head' } });
        }
        return null;
      },
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, false,
      'harness mode: a user/global head suppresses the lane degrade — the Claude Code harness honors it, as measured (#4588)');
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('(e negative) NO user/global head + same phase lane → shouldDegrade:true (proves lane degrades)', () => {
    // Without a user/global head, the phase lane must still degrade (proves the positive test is real)
    const deps = {
      execGit: makePhaseLaneExecGit(HEAD_SHA),
      readFile: () => null, // no project or user settings
      write: () => {},
      userClaudeDir: '/nonexistent-hermetic-dir-no-global',
    };
    const result = cmdWorktreeBaseCheck(cwd, [], deps);
    assert.strictEqual(result.shouldDegrade, true,
      'without user/global head, a phase lane must degrade');
    assert.strictEqual(result.reason, 'fork-ref-unknown');
  });
});

// ─── workflow dispatch-site coverage: worktree.base-check gates (folded from
// fix-1941-quick-worktree-stale-base.test.cjs and
// fix-2649-diagnose-issues-worktree-stale-base.test.cjs, #3335) ──────────────
//
// allow-test-rule: source-text-is-the-product #1941 #2649
// Workflow .md files are the installed AI instructions — their text IS what the
// runtime loads. Testing text content tests the deployed contract. Per
// CONTRIBUTING.md exception matrix.
//
// Root cause shared by #1941 and #2649: Claude Code's isolation="worktree"
// forks new worktrees from origin/HEAD, not the live local HEAD. When prior
// local commits advance local HEAD without an intervening `git push`,
// origin/HEAD stays pinned to a stale ancestor and the executor's
// worktree_branch_check guard halts with a base-mismatch fatal. The fix ports
// the worktree.base-check auto-degrade pattern (originally execute-phase
// #683/#1369) into each not-yet-covered dispatch site: quick.md's
// single-dispatch path (#1941), and diagnose-issues.md's spawn_agents step
// plus execute-plan.md's Pattern A single-plan dispatch (#2649, fixed
// together per that bug's acceptance criterion 5 — same bug class, same
// one-line gate).

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-1941-quick-worktree-stale-base', () => {

const QUICK_WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

// ─── WorktreeCreate-hook interlock (#4588) ───────────────────────────────────
//
// A Claude Code WorktreeCreate hook creates the agent worktree from the directory it
// emits, and Claude Code does not apply worktree.baseRef on that path. So the #4588
// trust in "head" under harness-worktree must not hold on a host that configures one.

const HOOK_SETTINGS = JSON.stringify({
  hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'make-worktree.sh' }] }] },
});

function settingsReader(files) {
  return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
}

describe('findWorktreeCreateHook (#4588)', () => {
  const claudeDir = '/repo/.claude';
  const USER_CLAUDE_DIR = '/home/user/.claude';
  const LAYERS = [
    path.join(claudeDir, 'settings.local.json'),
    path.join(claudeDir, 'settings.json'),
    path.join(USER_CLAUDE_DIR, 'settings.json'),
  ];

  test('a WorktreeCreate hook in each of the three layers is found and names that layer (#4588)', () => {
    for (const file of LAYERS) {
      const found = findWorktreeCreateHook(claudeDir, { readFile: settingsReader({ [file]: HOOK_SETTINGS }) }, USER_CLAUDE_DIR);
      assert.deepStrictEqual(found, { file, kind: 'hook' }, `hook in ${file}`);
    }
  });

  test('every layer is checked, not only the one that supplies baseRef (#4588)', () => {
    const found = findWorktreeCreateHook(claudeDir, {
      readFile: settingsReader({
        [LAYERS[0]]: JSON.stringify({ worktree: { baseRef: 'head' } }),
        [LAYERS[2]]: HOOK_SETTINGS,
      }),
    }, USER_CLAUDE_DIR);
    assert.deepStrictEqual(found, { file: LAYERS[2], kind: 'hook' });
  });

  test('no settings, other hook events, an empty WorktreeCreate list or a blank file → null (#4588)', () => {
    const cases = {
      'no files': {},
      'other hook events only': { [LAYERS[1]]: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }], WorktreeRemove: [{ hooks: [] }] } }) },
      'empty WorktreeCreate list': { [LAYERS[0]]: JSON.stringify({ hooks: { WorktreeCreate: [] } }) },
      'baseRef only': { [LAYERS[0]]: JSON.stringify({ worktree: { baseRef: 'head' } }) },
      'whitespace-only file': { [LAYERS[0]]: '  \n' },
      'non-object top level': { [LAYERS[1]]: '[]' },
    };
    for (const [label, files] of Object.entries(cases)) {
      assert.strictEqual(findWorktreeCreateHook(claudeDir, { readFile: settingsReader(files) }, USER_CLAUDE_DIR), null, label);
    }
  });

  test('a layer that does not parse fails closed as kind "unparseable" (#4588)', () => {
    const found = findWorktreeCreateHook(claudeDir, { readFile: settingsReader({ [LAYERS[1]]: '{ "hooks": ' }) }, USER_CLAUDE_DIR);
    assert.deepStrictEqual(found, { file: LAYERS[1], kind: 'unparseable' });
  });

  test('JSONC comments and trailing commas still parse, so a commented hook is found (#4588)', () => {
    const jsonc = '{\n  // local hook\n  "hooks": { "WorktreeCreate": [ { "hooks": [ { "type": "command", "command": "x" } ] }, ] },\n}\n';
    const found = findWorktreeCreateHook(claudeDir, { readFile: settingsReader({ [LAYERS[0]]: jsonc }) }, USER_CLAUDE_DIR);
    assert.deepStrictEqual(found, { file: LAYERS[0], kind: 'hook' });
  });

  test('user/global layer is read only when userClaudeDir is given and differs from claudeDir (#4588)', () => {
    const readPaths = [];
    const readFile = (p) => { readPaths.push(p); return null; };
    findWorktreeCreateHook(claudeDir, { readFile }, claudeDir);
    findWorktreeCreateHook(claudeDir, { readFile }, null);
    findWorktreeCreateHook(claudeDir, { readFile });
    assert.ok(!readPaths.includes(LAYERS[2]), 'user layer never read without a distinct userClaudeDir');
    assert.strictEqual(readPaths.filter((p) => p === LAYERS[1]).length, 3, 'shared settings.json read once per call');
  });
});

describe('evaluateWorktreeBaseDegrade — WorktreeCreate hook interlock (#4588)', () => {
  const HEAD_SHA = 'a1a1a1a1b2b2b2b2c3c3c3c3d4d4d4d4e5e5e5e5';
  const FORK_SHA = 'f6f6f6f6a7a7a7a7b8b8b8b8c9c9c9c9d0d0d0d0';
  const HOOK = { file: '/repo/.claude/settings.json', kind: 'hook' };
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
  function stubGit(responses) {
    return (args) => {
      const key = args.join(' ');
      if (Object.prototype.hasOwnProperty.call(responses, key)) return responses[key];
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('head + harness mode + hook + HEAD diverged from origin/HEAD → degrade, reason baseref-head-bypassed-by-hook naming the file (#4588)', () => {
    for (const isolationMode of [undefined, 'harness-worktree']) {
      const result = evaluateWorktreeBaseDegrade({
        execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA), 'rev-parse --verify --quiet origin/HEAD': ok(FORK_SHA) }),
        effectiveBaseRef: 'head',
        isolationMode,
        worktreeCreateHook: HOOK,
      });
      assert.strictEqual(result.shouldDegrade, true, `isolationMode=${isolationMode}`);
      assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
      assert.strictEqual(result.headSha, HEAD_SHA);
      assert.strictEqual(result.forkRef, 'origin/HEAD');
      assert.strictEqual(result.forkSha, FORK_SHA);
      assert.ok(result.message.includes('WorktreeCreate hook is configured in /repo/.claude/settings.json'), result.message);
      assert.ok(!/harness does not honor/.test(result.message), 'the hook, not the harness, is named');
      // origin/HEAD says nothing about where a hook forks, so the remedy must not promise that
      // pushing restores parallelism; it points at a measurement instead (#4588 round review).
      assert.ok(!/merged\/pushed/.test(result.message), result.message);
      assert.ok(result.message.includes('--observed-fork-base'), result.message);
      assert.ok(result.message.includes('remove the hook'), result.message);
    }
  });

  test('head + harness mode + hook + HEAD equal to origin/HEAD → no degrade, reason head-matches-fork (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA), 'rev-parse --verify --quiet origin/HEAD': ok(HEAD_SHA) }),
      effectiveBaseRef: 'head',
      worktreeCreateHook: HOOK,
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'head-matches-fork');
  });

  test('an unparseable settings layer degrades with the same reason and says the hook cannot be ruled out (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA), 'rev-parse --verify --quiet origin/HEAD': ok(FORK_SHA) }),
      effectiveBaseRef: 'head',
      worktreeCreateHook: { file: '/repo/.claude/settings.local.json', kind: 'unparseable' },
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
    assert.ok(result.message.includes('/repo/.claude/settings.local.json could not be parsed'), result.message);
    assert.ok(result.message.includes('fix /repo/.claude/settings.local.json so it parses'), result.message);
    assert.ok(!/merged\/pushed/.test(result.message), result.message);
  });

  test('hook + head + orchestrator-worktree mode → baseref-head unchanged, execGit never called (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { throw new Error('execGit must not be called'); },
      effectiveBaseRef: 'head',
      isolationMode: 'orchestrator-worktree',
      worktreeCreateHook: HOOK,
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('hook + head + an observed fork base → the observation decides, not the hook (#4588)', () => {
    const match = evaluateWorktreeBaseDegrade({
      execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA) }),
      effectiveBaseRef: 'head',
      observedForkBase: HEAD_SHA,
      worktreeCreateHook: HOOK,
    });
    assert.strictEqual(match.reason, 'observed-fork-matches-head');
    const mismatch = evaluateWorktreeBaseDegrade({
      execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA) }),
      effectiveBaseRef: 'head',
      observedForkBase: FORK_SHA,
      worktreeCreateHook: HOOK,
    });
    assert.strictEqual(mismatch.reason, 'baseref-head-ignored-by-harness');
  });

  test('hook without "head" set → the ordinary divergence verdict, not the hook reason (#4588)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: stubGit({ 'rev-parse HEAD': ok(HEAD_SHA), 'rev-parse --verify --quiet origin/HEAD': ok(FORK_SHA) }),
      effectiveBaseRef: 'fresh',
      worktreeCreateHook: HOOK,
    });
    assert.strictEqual(result.reason, 'head-diverged-from-fork');
  });

  test('no hook finding (null or omitted) → head still short-circuits to baseref-head (#4588)', () => {
    for (const worktreeCreateHook of [null, undefined]) {
      const result = evaluateWorktreeBaseDegrade({
        execGit: () => { throw new Error('execGit must not be called'); },
        effectiveBaseRef: 'head',
        worktreeCreateHook,
      });
      assert.strictEqual(result.reason, 'baseref-head', `worktreeCreateHook=${worktreeCreateHook}`);
    }
  });
});

describe('cmdWorktreeBaseCheck — WorktreeCreate hook interlock (#4588)', () => {
  const cwd = '/repo';
  const claudeDir = '/repo/.claude';
  const USER_CLAUDE_DIR = '/home/user/.claude';
  const LOCAL = path.join(claudeDir, 'settings.local.json');
  const SHARED = path.join(claudeDir, 'settings.json');
  const USER = path.join(USER_CLAUDE_DIR, 'settings.json');
  const HEAD_SHA = '0a0a0a0a1b1b1b1b2c2c2c2c3d3d3d3d4e4e4e4e';
  const FORK_SHA = '5f5f5f5f6a6a6a6a7b7b7b7b8c8c8c8c9d9d9d9d';
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
  function divergedGit() {
    return (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') return ok(HEAD_SHA);
      if (key === 'rev-parse --verify --quiet origin/HEAD') return ok(FORK_SHA);
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }
  function run(files, args = []) {
    return cmdWorktreeBaseCheck(cwd, args, {
      readFile: settingsReader(files),
      execGit: divergedGit(),
      write: () => {},
      userClaudeDir: USER_CLAUDE_DIR,
    });
  }

  test('head set + a WorktreeCreate hook in each layer read + default harness mode → degrade, baseref-head-bypassed-by-hook (#4588)', () => {
    for (const hookFile of [LOCAL, SHARED, USER]) {
      const files = { [hookFile]: HOOK_SETTINGS };
      // head comes from a layer that does not carry the hook, except when the hook shares project-local
      files[hookFile === LOCAL ? USER : LOCAL] = JSON.stringify({ worktree: { baseRef: 'head' } });
      const result = run(files);
      assert.strictEqual(result.shouldDegrade, true, `hook in ${hookFile}`);
      assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook', `hook in ${hookFile}`);
      assert.ok(result.message.includes(hookFile), result.message);
    }
  });

  test('head and the hook in the same file also degrades (#4588)', () => {
    const both = JSON.stringify({ worktree: { baseRef: 'head' }, hooks: JSON.parse(HOOK_SETTINGS).hooks });
    const result = run({ [SHARED]: both });
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
  });

  test('the same hook changes nothing under --mode orchestrator-worktree or with --observed-fork-base (#4588)', () => {
    const files = { [LOCAL]: JSON.stringify({ worktree: { baseRef: 'head' } }), [SHARED]: HOOK_SETTINGS };
    assert.strictEqual(run(files, ['--mode', 'orchestrator-worktree']).reason, 'baseref-head');
    assert.strictEqual(run(files, ['--observed-fork-base', HEAD_SHA]).reason, 'observed-fork-matches-head');
    assert.strictEqual(run(files, ['--observed-fork-base', FORK_SHA]).reason, 'baseref-head-ignored-by-harness');
  });

  test('head set + no WorktreeCreate hook in any layer → baseref-head, the #4588 trust stays (#4588)', () => {
    const result = run({
      [LOCAL]: JSON.stringify({ worktree: { baseRef: 'head' }, hooks: { PreToolUse: [{ hooks: [] }] } }),
      [USER]: JSON.stringify({ hooks: { WorktreeCreate: [] } }),
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
  });

  test('head from the user layer + a project-local layer that does not parse → fails closed and degrades (#4588)', () => {
    // resolveEffectiveBaseRef skips the unparseable layer and still resolves "head" from the
    // user layer; the interlock treats that same layer as a possible hook, so the two stay
    // consistent in direction — neither ever trusts "head" on the strength of a file it could not read.
    const result = run({ [LOCAL]: '{ "worktree": ', [USER]: JSON.stringify({ worktree: { baseRef: 'head' } }) });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
    assert.ok(result.message.includes(`${LOCAL} could not be parsed`), result.message);
  });
});

describe('quick: pre-dispatch worktree base re-check (#1941)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(QUICK_WORKFLOW_PATH), 'workflows/quick.md should exist');
  });

  test('Step 6 runs worktree.base-check before capturing EXPECTED_BASE', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const baseCheckIdx = content.indexOf('worktree.base-check', step6Idx);
    const expectedBaseIdx = content.indexOf('EXPECTED_BASE=$(git rev-parse HEAD)', step6Idx);
    assert.ok(step6Idx !== -1, '"Step 6: Spawn executor" must exist in quick.md');
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within Step 6');
    assert.ok(expectedBaseIdx !== -1, 'EXPECTED_BASE capture must exist within Step 6');
    assert.ok(
      baseCheckIdx < expectedBaseIdx,
      'worktree.base-check must run BEFORE EXPECTED_BASE is captured so the degrade decision reflects the most current local HEAD'
    );
  });

  test('degrade check references #1941 for traceability', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('#1941'), 'quick.md must reference #1941');
  });

  test('degrade check clears BOTH USE_WORKTREES and ISOLATION when shouldDegrade is true', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 900);
    assert.ok(block.includes('shouldDegrade'), 'degrade check must branch on shouldDegrade');
    // Both must move together (#2652). Dispatch keys on ISOLATION while the prompt
    // guard and worktree manifest key on USE_WORKTREES; clearing only one dispatches
    // an isolated executor with no base guard and no manifest, then blocks in cleanup
    // looking for a manifest that was never initialized.
    assert.ok(block.includes('USE_WORKTREES=false'), 'degrade must set USE_WORKTREES=false');
    assert.ok(
      block.includes('ISOLATION=none'),
      'degrade must ALSO set ISOLATION=none — dispatch reads ISOLATION, so clearing only ' +
        'USE_WORKTREES still passes the harness isolation flag (#2652)'
    );
  });

  // #2652: this assertion previously required `RUNTIME = "claude"`, encoding the
  // pre-#2584 premise that worktree isolation is Claude-specific. #2584 replaced
  // that with the negotiated dispatch.isolation capability, so the guard now keys
  // on the capability — Cursor also declares harness-worktree.
  test('degrade check guards on the negotiated capability, not a runtime id', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(Math.max(0, baseCheckIdx - 300), baseCheckIdx + 200);
    assert.ok(
      block.includes('ISOLATION') && block.includes('harness-worktree'),
      'degrade check must guard on ISOLATION = harness-worktree'
    );
    assert.ok(
      !/\[\s*"\$RUNTIME"\s*=/.test(block),
      'degrade check must NOT branch on a RUNTIME literal (#2584/#2652)'
    );
  });

  test('degrade check names origin/HEAD as the stale fork base', () => {
    const content = fs.readFileSync(QUICK_WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const nextSection = content.indexOf('\n---', step6Idx);
    const section = content.slice(step6Idx, nextSection === -1 ? undefined : nextSection);
    assert.ok(section.includes('origin/HEAD'), 'Step 6 must name origin/HEAD as the stale fork base');
  });
});

  });
}

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-2649-diagnose-issues-worktree-stale-base', () => {

const DIAGNOSE_ISSUES_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
const EXECUTE_PLAN_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');

describe('diagnose-issues: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(DIAGNOSE_ISSUES_PATH), 'workflows/diagnose-issues.md should exist');
  });

  test('spawn_agents step runs worktree.base-check before the Agent() dispatch', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist in diagnose-issues.md');
    const baseCheckIdx = content.indexOf('worktree.base-check', spawnIdx);
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within the spawn_agents step');
    // The load-bearing invariant is "base-check BEFORE the Agent() dispatch" so the
    // degrade decision can drop isolation from the spawn. (Where EXPECTED_BASE is
    // captured relative to the check is cosmetic — the check only reads HEAD, never
    // mutates it — so assert the real invariant, not a loose disjunction.)
    const agentIdx = content.indexOf('Agent(', spawnIdx);
    assert.ok(agentIdx !== -1, 'spawn_agents must contain an Agent() dispatch');
    assert.ok(
      baseCheckIdx < agentIdx,
      'worktree.base-check must run before the Agent() dispatch so the degrade decision can drop isolation from the spawn',
    );
  });

  test('verify-only worktree_branch_check backstop remains embedded in the Agent() prompt', () => {
    // Acceptance criterion #4: the base-check is a PRE-DISPATCH degrade; the
    // <worktree_branch_check> guard is a POST-FORK fail-closed backstop. Both
    // layers must survive — a future edit that dropped the backstop embedding
    // would re-open the silent-stale-base class. Guard its continued presence.
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const spawnIdx = content.indexOf('<step name="spawn_agents">');
    assert.ok(spawnIdx !== -1, '"spawn_agents" step must exist');
    assert.ok(
      content.indexOf('worktree-branch-check.md', spawnIdx) !== -1,
      'spawn_agents must still materialize the <worktree_branch_check> backstop after the base-check gate (#2649 acceptance criterion 4)',
    );
  });

  test('degrade check sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 600);
    assert.ok(
      block.includes('shouldDegrade') && block.includes('USE_WORKTREES=false'),
      'degrade check must override USE_WORKTREES=false when shouldDegrade is true',
    );
  });

  test('degrade check references #2649 for traceability', () => {
    const content = fs.readFileSync(DIAGNOSE_ISSUES_PATH, 'utf-8');
    assert.ok(content.includes('#2649'), 'diagnose-issues.md must reference #2649');
  });
});

describe('execute-plan Pattern A: pre-dispatch worktree base-check (#2649)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(EXECUTE_PLAN_PATH), 'workflows/execute-plan.md should exist');
  });

  test('Pattern A runs the worktree base-check before spawning the executor', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    assert.ok(patternAIdx !== -1, '"Pattern A:" must exist in execute-plan.md');
    // The base-check instruction must appear within the Pattern A description,
    // before the isolation="worktree" embedding instruction.
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      patternA.includes('#2649') && /worktree\.base-check|base-check/.test(patternA),
      'Pattern A must run the #2649 worktree base-check before dispatching the executor',
    );
    assert.ok(
      patternA.includes('shouldDegrade'),
      'Pattern A base-check must consult shouldDegrade',
    );
  });

  test('Pattern A documents the auto-degrade (drop isolation on shouldDegrade)', () => {
    const content = fs.readFileSync(EXECUTE_PLAN_PATH, 'utf-8');
    const patternAIdx = content.indexOf('**Pattern A:**');
    const patternAEnd = content.indexOf('**Pattern B:**', patternAIdx);
    const patternA = content.slice(patternAIdx, patternAEnd === -1 ? undefined : patternAEnd);
    assert.ok(
      /degrad|sequential/i.test(patternA),
      'Pattern A must document auto-degrading to sequential mode when shouldDegrade is true',
    );
  });
});

// The base-check prose moved out of execute-phase.md into its own step file
// (#4683/#4828) while this fix was in review, and the move carried the retired
// claim that harness-isolated runtimes ignore worktree.baseRef. Pin the step
// file itself, so a later extraction cannot quietly bring the claim back.
const WORKTREE_BASE_CHECK_STEP_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'worktree-base-check.md',
);

describe('execute-phase worktree_base_check step prose (#4588)', () => {
  test('cites #4588 and names both exceptions to the baseRef:"head" trust', () => {
    const content = fs.readFileSync(WORKTREE_BASE_CHECK_STEP_PATH, 'utf-8');
    assert.ok(content.includes('#4588'), 'the step must cite #4588');
    assert.ok(content.includes('WorktreeCreate'),
      'the step must name the WorktreeCreate-hook exception that withholds the "head" trust');
    assert.ok(content.includes('--observed-fork-base'),
      'the step must say a supplied observation is compared against HEAD, not trusted');
  });

  test('does not claim harness-isolated runtimes ignore the setting', () => {
    const content = fs.readFileSync(WORKTREE_BASE_CHECK_STEP_PATH, 'utf-8');
    assert.ok(!/harness-isolated runtimes[^.]{0,200}do\s+not\s+read\s+the\s+setting/i.test(content.replace(/\s+/g, ' ')),
      'the step must not carry the retired #48 claim that harness-isolated runtimes do not read baseRef');
  });
});

  });
}

describe('#4734: classifyGitHead — single owner of the HEAD-resolution classes', () => {
  test('exit 0 with a sha → present, headSha carries the trimmed sha', () => {
    const SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
    const status = classifyGitHead({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: `${SHA}\n`, stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(status.status, 'present');
    assert.strictEqual(status.headSha, SHA);
  });

  test('exit 128 → definitive-absence (not a repository, or a repository with no commits — neither can host a worktree)', () => {
    const status = classifyGitHead({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null },
      }),
    });
    assert.strictEqual(status.status, 'definitive-absence');
    assert.strictEqual(status.headSha, null);
  });

  test('a REAL non-git working directory degrades end-to-end (no injected seam — the #4734 fixture wording)', (t) => {
    const { createTempDir, cleanup } = require('./helpers.cjs');
    const dir = createTempDir('gsd-4734-nogit-real-');
    t.after(() => cleanup(dir));
    const result = evaluateWorktreeBaseDegrade({ cwd: dir });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'no-head');
    assert.strictEqual(result.headAbsenceVerified, true);
    assert.ok(typeof result.message === 'string' && result.message.length > 0);
  });

  test('exit 0 with empty stdout → ambiguous-absence (git completed without a definitive answer)', () => {
    const status = classifyGitHead({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 0, stdout: '', stderr: '', signal: null, error: null },
      }),
    });
    assert.strictEqual(status.status, 'ambiguous-absence');
    assert.strictEqual(status.headSha, null);
  });

  test('timeout → indeterminate (fail closed)', () => {
    const timedOutErr = new Error('spawnSync git ETIMEDOUT');
    timedOutErr.code = 'ETIMEDOUT';
    const status = classifyGitHead({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: timedOutErr },
      }),
    });
    assert.strictEqual(status.status, 'indeterminate');
    assert.strictEqual(status.headSha, null);
  });

  test('other non-zero exit (git missing, exit 127) → indeterminate (fail closed)', () => {
    const status = classifyGitHead({
      execGit: makeExecGit({
        'rev-parse HEAD': { exitCode: 127, stdout: '', stderr: 'command not found', signal: null, error: null },
      }),
    });
    assert.strictEqual(status.status, 'indeterminate');
    assert.strictEqual(status.headSha, null);
  });
});

// ─── #4588 A2: observed fork-from-HEAD confirmation (probe + cache, fail-closed) ──

describe('#4588 A2: a clean prior harness worktree at the orchestrator HEAD confirms fork-from-HEAD', () => {
  const HEAD_SHA = 'aabbccdd11223344aabbccdd11223344aabbccdd';
  const WT_PATH = '/repo/.claude/worktrees/agent-x';
  const ORIGIN_SHA = 'eeee1111223344abeeceeee1111223344abeeceee';

  // Worktree-listing stub: one harness worktree at WT_PATH; origin/HEAD DIVERGED
  // from HEAD so the pre-#4588 flow would degrade (head-diverged-from-fork).
  function makeWorktreeExecGit({ clean = true, wtHead = HEAD_SHA, listTimeout = false } = {}) {
    return function stubExecGit(args, _opts) {
      const key = args.join(' ');
      if (key === 'worktree list --porcelain') {
        if (listTimeout) {
          const err = new Error('spawnSync git ETIMEDOUT');
          err.code = 'ETIMEDOUT';
          return { exitCode: null, stdout: '', stderr: '', signal: 'SIGTERM', error: err };
        }
        return {
          exitCode: 0,
          stdout: `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT_PATH}\nbranch refs/heads/agent-x\n`,
          stderr: '', signal: null, error: null,
        };
      }
      if (key === `-C ${WT_PATH} status --porcelain`) {
        return { exitCode: 0, stdout: clean ? '' : ' M tracked.txt', stderr: '', signal: null, error: null };
      }
      if (key === `-C ${WT_PATH} rev-parse HEAD`) {
        return { exitCode: 0, stdout: `${wtHead}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 0, stdout: `${ORIGIN_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('a clean prior harness worktree at the orchestrator HEAD confirms fork-from-HEAD (no degrade)', () => {
    // DIVERGED origin/HEAD: the #3659 flow degrades here unless the probe
    // observes that the harness forks from HEAD. All state I/O is in-memory —
    // the rows in this describe must stay hermetic (a default fs cache under
    // the stub cwd is shared state across tests, and a real fs write at a
    // root-level stub path pollutes root CI machines).
    let cache = null;
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeWorktreeExecGit(),
      cwd: '/repo',
      probeStateRead: () => cache,
      probeStateWrite: (_file, content) => { cache = content; },
    });
    assert.strictEqual(result.shouldDegrade, false, 'a clean worktree at the orchestrator HEAD is positive evidence of fork-from-HEAD');
    assert.strictEqual(result.reason, 'fork-from-head-observed');
    assert.strictEqual(result.headSha, HEAD_SHA);
  });

  test('the probe cache serves a matching verdict without re-probing', () => {
    const stateRead = (_file) => JSON.stringify({
      headSha: HEAD_SHA,
      worktreePath: WT_PATH,
      worktreeHead: HEAD_SHA,
      verdict: 'fork-from-head-confirmed',
      probedAt: '2026-09-18T00:00:00.000Z',
    });
    // The stub answers rev-parse HEAD (classifyGitHead needs it before the
    // cache is consulted) and refuses the worktree LIST: if the probe ran,
    // this throws and fails.
    const execGit = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'worktree list --porcelain') {
        throw new Error('probe must not run when the cache matches');
      }
      throw new Error(`unexpected execGit call: ${key}`);
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, cwd: '/repo', probeStateRead: stateRead });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'fork-from-head-observed');
  });

  test('the cache is invalidated by an orchestrator HEAD move', () => {
    const NEW_HEAD = '11223344aabbccdd11223344aabbccdd11223344';
    const stateRead = (_file) => JSON.stringify({
      headSha: HEAD_SHA,
      worktreePath: WT_PATH,
      worktreeHead: HEAD_SHA,
      verdict: 'fork-from-head-confirmed',
      probedAt: '2026-09-18T00:00:00.000Z',
    });
    // The cached entry is keyed to the OLD orchestrator HEAD while the
    // orchestrator HEAD has MOVED (rev-parse HEAD answers NEW_HEAD) and the
    // worktree still sits at the old commit — the cache must be ignored, the
    // probe re-run, and the flow fall through to the fork comparison.
    const execGit = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${NEW_HEAD}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'worktree list --porcelain') {
        return {
          exitCode: 0,
          stdout: `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT_PATH}\nbranch refs/heads/agent-x\n`,
          stderr: '', signal: null, error: null,
        };
      }
      if (key === `-C ${WT_PATH} status --porcelain`) {
        return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
      }
      if (key === `-C ${WT_PATH} rev-parse HEAD`) {
        return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 0, stdout: `${ORIGIN_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`unexpected execGit call: ${key}`);
    };
    const result = evaluateWorktreeBaseDegrade({
      execGit,
      cwd: '/repo',
      probeStateRead: stateRead,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.reason, 'head-diverged-from-fork', 'stale cache must not suppress the #3659 comparison');
    assert.strictEqual(result.shouldDegrade, true);
  });

  test('a dirty harness worktree is not evidence', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeWorktreeExecGit({ clean: false }),
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, true, `unobserved fork base → the #3659 comparison still governs (reason=${result.reason})`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
  });

  test('a harness worktree at a different commit is not evidence', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeWorktreeExecGit({ wtHead: ORIGIN_SHA }),
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
  });

  test('no harness worktrees changes nothing', () => {
    const execGit = makeWorktreeExecGit();
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args, opts) => {
        const key = args.join(' ');
        if (key === 'worktree list --porcelain') {
          return { exitCode: 0, stdout: 'worktree /repo\nbranch refs/heads/main\n', stderr: '', signal: null, error: null };
        }
        return execGit(args, opts);
      },
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', `reason=${result.reason}`);
  });

  test('a probe timeout fails closed to the existing flow', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeWorktreeExecGit({ listTimeout: true }),
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'head-diverged-from-fork', 'a probe timeout must fall through to the comparison, not skip it');
  });

  test('untracked-only worktrees count as clean', () => {
    const execGit = makeWorktreeExecGit();
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args, opts) => {
        const key = args.join(' ');
        if (key === `-C ${WT_PATH} status --porcelain`) {
          return { exitCode: 0, stdout: '?? pr-review-notes.md', stderr: '', signal: null, error: null };
        }
        return execGit(args, opts);
      },
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, false, 'untracked review notes do not disqualify the observation');
    assert.strictEqual(result.reason, 'fork-from-head-observed');
  });

  test('orchestrator-worktree mode never probes (the suppress predates the probe)', () => {
    const refusing = () => { throw new Error('probe must not run in orchestrator-worktree mode'); };
    const result = evaluateWorktreeBaseDegrade({
      execGit: refusing,
      cwd: '/repo',
      effectiveBaseRef: 'head',
      isolationMode: 'orchestrator-worktree',
    });
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(result.shouldDegrade, false);
  });

  test('a corrupt cache is re-probed, not trusted', () => {
    const stateRead = (_file) => '{ this is not json';
    let probed = false;
    const execGit = (args) => {
      const key = args.join(' ');
      if (key === 'worktree list --porcelain') {
        probed = true;
        return { exitCode: 0, stdout: 'worktree /repo\nbranch refs/heads/main\n', stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 0, stdout: `${ORIGIN_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`unexpected execGit call: ${key}`);
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, cwd: '/repo', probeStateRead: stateRead });
    assert.ok(probed, 'the probe must run past a corrupt cache');
    assert.strictEqual(result.reason, 'head-diverged-from-fork', 'corrupt cache → re-probe → the comparison governs');
  });

  test('worktrees outside the harness directory are not candidates', () => {
    const execGit = (args) => {
      const key = args.join(' ');
      if (key === 'worktree list --porcelain') {
        return {
          exitCode: 0,
          stdout: `worktree /repo\nbranch refs/heads/main\n\nworktree /elsewhere/agent-y\nbranch refs/heads/agent-y\n`,
          stderr: '', signal: null, error: null,
        };
      }
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'rev-parse --verify --quiet origin/HEAD') {
        return { exitCode: 0, stdout: `${ORIGIN_SHA}\n`, stderr: '', signal: null, error: null };
      }
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
        return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      }
      throw new Error(`unexpected execGit call: ${key}`);
    };
    const result = evaluateWorktreeBaseDegrade({ execGit, cwd: '/repo' });
    assert.strictEqual(result.reason, 'head-diverged-from-fork', 'a non-harness worktree must not confirm the observation');
  });

  test('end-to-end: a real repo with a clean harness worktree at HEAD passes the base-check', (t) => {
    const { createTempGitProject } = require('./helpers.cjs');
    const { gitOrThrow } = require('./helpers/git-fixture.cjs');
    const dir = createTempGitProject('gsd-4588-e2e-');
    t.after(() => cleanup(dir));
    const wtPath = path.join(dir, '.claude', 'worktrees', 'agent-e2e');
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    gitOrThrow(['worktree', 'add', '-b', 'agent-e2e', wtPath, 'HEAD'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });

    // The command emits its JSON via fs.writeSync(1, …) — capture through the
    // approved mock mechanism and assert on the EMITTED payload too (the
    // workflow-facing contract), not just the return value.
    const emitted = [];
    const writeSyncMock = t.mock.method(fs, 'writeSync', (fd, buf, ...rest) => {
      void fd; void rest;
      emitted.push(typeof buf === 'string' ? buf : Buffer.from(buf).toString('utf8'));
      return (typeof buf === 'string' ? buf : Buffer.from(buf)).length;
    });
    const result = cmdWorktreeBaseCheck(dir, ['--mode', 'harness-worktree']);
    assert.ok(writeSyncMock.mock.calls.length > 0, 'the check must emit its JSON payload');
    const emittedJson = JSON.parse(emitted.join(''));
    assert.strictEqual(emittedJson.reason, 'fork-from-head-observed', 'the emitted workflow payload must carry the observation');
    assert.strictEqual(emittedJson.shouldDegrade, false);
    assert.strictEqual(result.shouldDegrade, false,
      `a clean harness worktree at HEAD must confirm fork-from-HEAD; got reason=${result.reason}`);
    assert.strictEqual(result.reason, 'fork-from-head-observed');
  });
});

// ─── #4881: the baseRef:"head" trust and the #4868 observation compose ──────────

describe('#4881: the baseRef:"head" trust and the prior-worktree observation compose', () => {
  const HEAD_SHA = '1234123412341234123412341234123412341234';
  const ORIGIN_SHA = 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd';
  const WT_PATH = '/repo/.claude/worktrees/agent-hook';
  const HOOK = { file: '/repo/.claude/settings.json', kind: 'hook' };
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });

  // A harness host: HEAD diverged from origin/HEAD, and either one clean
  // agent worktree at HEAD or none at all.
  function makeHostGit({ worktreeAtHead }) {
    const list = worktreeAtHead
      ? `worktree /repo\nbranch refs/heads/feature\n\nworktree ${WT_PATH}\nbranch refs/heads/agent-hook\n`
      : 'worktree /repo\nbranch refs/heads/feature\n';
    return (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') return ok(`${HEAD_SHA}\n`);
      if (key === 'worktree list --porcelain') return ok(list);
      if (key === `-C ${WT_PATH} status --porcelain`) return ok('');
      if (key === `-C ${WT_PATH} rev-parse HEAD`) return ok(`${HEAD_SHA}\n`);
      if (key === 'rev-parse --verify --quiet origin/HEAD') return ok(`${ORIGIN_SHA}\n`);
      if (key === 'symbolic-ref --quiet refs/remotes/origin/HEAD') return { exitCode: 1, stdout: '', stderr: '', signal: null, error: null };
      throw new Error(`Unexpected execGit call: ${JSON.stringify(args)}`);
    };
  }

  test('the start of every run: head + harness + no prior worktree + HEAD diverged → baseref-head, and git is never consulted (#4881)', () => {
    // The state an execute-phase run is in at its first base-check and after
    // every wave commit (#4881 repro state 1/4): no evidence can exist yet.
    // The setting is trusted, so no worktree probe and no origin/HEAD
    // comparison runs — the degrade the issue reports is unreachable.
    let calls = 0;
    const result = evaluateWorktreeBaseDegrade({
      execGit: () => { calls += 1; throw new Error('the trust must not consult git'); },
      effectiveBaseRef: 'head',
      cwd: '/repo',
      probeStateRead: () => { throw new Error('the trust must not read the probe cache'); },
    });
    assert.strictEqual(result.shouldDegrade, false);
    assert.strictEqual(result.reason, 'baseref-head');
    assert.strictEqual(calls, 0, 'branch a returns before HEAD is resolved');
  });

  test('a wave commit cannot erase the verdict on the common path: the same call at a new HEAD returns baseref-head again (#4881)', () => {
    // There is no per-HEAD verdict to lose — the trust is a property of the
    // configuration, not of the commit — so advancing HEAD between waves
    // (#4881 repro state 4) changes nothing.
    for (const _head of ['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222']) {
      const result = evaluateWorktreeBaseDegrade({
        execGit: () => { throw new Error('the trust must not consult git'); },
        effectiveBaseRef: 'head',
        cwd: '/repo',
      });
      assert.strictEqual(result.reason, 'baseref-head');
    }
  });

  test('head + harness + WorktreeCreate hook + a clean prior harness worktree at HEAD → baseref-head-bypassed-by-hook: the observation is withheld, not consulted (#4921)', () => {
    // The stale-evidence case. A clean agent worktree sits at HEAD, so the
    // #4868 probe WOULD confirm — but nothing on disk records which creator
    // left it there, and a worktree the plain harness created before this hook
    // was configured is indistinguishable from one the hook created. So the
    // probe is not consulted at all: neither leg runs, which is why keying the
    // cache by hook configuration would not have closed this (a cache miss
    // falls through to the live probe and re-finds the same worktree).
    // The stubs RECORD rather than throw: observeHarnessForkFromHead treats a throwing
    // execGit or stateRead as an inconclusive observation and swallows it, so a throwing
    // stub would fall through to the same verdict with or without the interlock and pin
    // nothing. Recording keeps both assertions live under reversion.
    const host = makeHostGit({ worktreeAtHead: true });
    let consulted = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args) => {
        if (args.join(' ') === 'worktree list --porcelain') consulted = true;
        return host(args);
      },
      effectiveBaseRef: 'head',
      cwd: '/repo',
      worktreeCreateHook: HOOK,
      probeStateRead: () => { consulted = true; return null; },
      probeStateWrite: () => { consulted = true; },
    });
    assert.strictEqual(consulted, false, 'the observation must not be consulted once a hook withheld the trust');
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
    assert.strictEqual(result.headSha, HEAD_SHA);
    assert.strictEqual(result.forkSha, ORIGIN_SHA, 'the inferred comparison still governs');
  });

  test('head + harness + WorktreeCreate hook + no prior harness worktree → baseref-head-bypassed-by-hook: with no observation the inferred comparison governs (#4881)', () => {
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeHostGit({ worktreeAtHead: false }),
      effectiveBaseRef: 'head',
      cwd: '/repo',
      worktreeCreateHook: HOOK,
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
    assert.strictEqual(result.forkSha, ORIGIN_SHA, 'the inferred comparison still governs');
  });

  test('an unparseable settings layer withholds the observation the same way — a hook in it cannot be ruled out (#4921)', () => {
    const host = makeHostGit({ worktreeAtHead: true });
    let consulted = false;
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args) => {
        if (args.join(' ') === 'worktree list --porcelain') consulted = true;
        return host(args);
      },
      effectiveBaseRef: 'head',
      cwd: '/repo',
      worktreeCreateHook: { file: '/repo/.claude/settings.local.json', kind: 'unparseable' },
      probeStateRead: () => { consulted = true; return null; },
      probeStateWrite: () => { consulted = true; },
    });
    assert.strictEqual(consulted, false, 'the observation must not be consulted once an unparseable layer withheld the trust');
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
  });

  test('a cached fork-from-head verdict at this HEAD does NOT survive the hook interlock (#4921)', () => {
    // The cache leg stated explicitly, because the review's proposed remedy
    // aimed at it: a cache entry keyed to this exact HEAD and carrying the
    // confirmed verdict is still never read once a hook withheld the trust.
    const host = makeHostGit({ worktreeAtHead: false });
    const cached = JSON.stringify({
      headSha: HEAD_SHA,
      worktreePath: WT_PATH,
      worktreeHead: HEAD_SHA,
      verdict: 'fork-from-head-confirmed',
      probedAt: '2026-09-01T00:00:00.000Z',
    });
    const result = evaluateWorktreeBaseDegrade({
      execGit: host,
      effectiveBaseRef: 'head',
      cwd: '/repo',
      worktreeCreateHook: HOOK,
      probeStateRead: () => cached,
      probeStateWrite: () => { assert.fail('the probe cache must not be written once a hook withheld the trust'); },
    });
    assert.strictEqual(result.shouldDegrade, true, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'baseref-head-bypassed-by-hook');
  });

  test('the withholding is scoped to head + hook: with no setting, a hook does NOT withhold #4868 arm (#4921)', () => {
    // The boundary this PR deliberately did not cross. b2 is #4868's own arm
    // when `"head"` is absent, hook or not; re-scoping that trust is a separate
    // question from the one #4881 opened, and is not taken here.
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeHostGit({ worktreeAtHead: true }),
      effectiveBaseRef: null,
      cwd: '/repo',
      worktreeCreateHook: HOOK,
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.shouldDegrade, false, `reason=${result.reason}`);
    assert.strictEqual(result.reason, 'fork-from-head-observed');
  });

  test('an explicit observedForkBase outranks the prior-worktree probe: the probe never runs (#4881)', () => {
    // A clean worktree at HEAD is present AND the caller measured a different
    // fork base for this dispatch: the measurement wins and degrades. Were the
    // probe consulted first, the stale worktree would suppress it.
    const host = makeHostGit({ worktreeAtHead: true });
    const result = evaluateWorktreeBaseDegrade({
      execGit: (args) => {
        if (args.join(' ') === 'worktree list --porcelain') throw new Error('the probe must not run under an explicit observation');
        return host(args);
      },
      effectiveBaseRef: 'head',
      cwd: '/repo',
      observedForkBase: ORIGIN_SHA,
      probeStateRead: () => { throw new Error('the probe cache must not be read under an explicit observation'); },
    });
    assert.strictEqual(result.shouldDegrade, true);
    assert.strictEqual(result.reason, 'baseref-head-ignored-by-harness');
    assert.strictEqual(result.forkRef, 'observed');
  });

  test('no setting + a clean prior harness worktree at HEAD → fork-from-head-observed, exactly as #4868 shipped it (#4881)', () => {
    // The #4868 rows above run with the setting unset; this pins that #4881
    // left that arm reachable and unchanged.
    const result = evaluateWorktreeBaseDegrade({
      execGit: makeHostGit({ worktreeAtHead: true }),
      cwd: '/repo',
      probeStateRead: () => null,
      probeStateWrite: () => {},
    });
    assert.strictEqual(result.reason, 'fork-from-head-observed');
  });
});
