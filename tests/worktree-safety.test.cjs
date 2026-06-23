'use strict';

/**
 * Worktree Safety Policy Module — typed IR tests
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: resolveWorktreeContext, parseWorktreePorcelain, planWorktreePrune,
 *            executeWorktreePrunePlan, listLinkedWorktreePaths, inspectWorktreeHealth,
 *            snapshotWorktreeInventory, planWorktreeWaveCleanup,
 *            executeWorktreeWaveCleanupPlan
 *
 * Consolidated from:
 *   - tests/worktree-safety-policy.test.cjs (policy module unit tests)
 *   - tests/bug-3281-worktree-git-timeout.test.cjs (AC1–AC4: timeout/degraded-git)
 *   - tests/bug-3384-worktree-cleanup-manifest.test.cjs (manifest-scoped cleanup module)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');
const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

const WORKTREE_SAFETY_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'
);
const CORE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'
);

const {
  resolveWorktreeContext,
  parseWorktreePorcelain,
  planWorktreePrune,
  executeWorktreePrunePlan,
  listLinkedWorktreePaths,
  inspectWorktreeHealth,
  snapshotWorktreeInventory,
  planWorktreeWaveCleanup,
  executeWorktreeWaveCleanupPlan,
  planWorktreeRecordAgent,
  cmdWorktreeRecordAgent,
} = require(WORKTREE_SAFETY_PATH);

const isWindows = process.platform === 'win32';

// ─── Shared stubs ─────────────────────────────────────────────────────────────

/**
 * Returns an execGit stub that simulates what spawnSync returns when the
 * subprocess is killed by SIGTERM after exceeding its timeout.
 * Per Node.js docs: result.status === null, result.signal === 'SIGTERM',
 * result.error?.code === 'ETIMEDOUT'.
 *
 * The production execGit implementation must detect this shape and:
 *   - return { ..., timedOut: true } so callers can distinguish timeout from auth failure
 *   - not throw
 */
function makeTimeoutStub() {
  return function stubTimedOutExecGit(_args, _opts) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    };
  };
}

// ─── resolveWorktreeContext ───────────────────────────────────────────────────

describe('resolveWorktreeContext', () => {
  test('prefers current directory when .planning exists', () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => true,
      execGit: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.strictEqual(context.effectiveRoot, '/repo/wt');
    assert.strictEqual(context.reason, 'has_local_planning');
    assert.strictEqual(context.mode, 'current_directory');
  });

  test('maps linked worktree to common-dir parent',
    { skip: isWindows ? 'POSIX-rooted fixture paths cannot be expressed on Windows path.resolve' : false },
    () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => false,
      execGit: (args) => {
        if (args[1] === '--git-dir') return { exitCode: 0, stdout: '.git/worktrees/wt', stderr: '' };
        if (args[1] === '--git-common-dir') return { exitCode: 0, stdout: '../.git', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    });
    assert.strictEqual(context.effectiveRoot, '/repo');
    assert.strictEqual(context.reason, 'linked_worktree');
    assert.strictEqual(context.mode, 'linked_worktree_root');
  });

  test('falls back when git metadata is unavailable', () => {
    const context = resolveWorktreeContext('/repo/wt', {
      existsSync: () => false,
      execGit: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    assert.strictEqual(context.effectiveRoot, '/repo/wt');
    assert.strictEqual(context.reason, 'not_git_repo');
  });

  test('keeps cwd for main worktree checkout', () => {
    const context = resolveWorktreeContext('/repo/main', {
      existsSync: () => false,
      execGit: (args) => {
        if (args[1] === '--git-dir') return { exitCode: 0, stdout: '.git', stderr: '' };
        if (args[1] === '--git-common-dir') return { exitCode: 0, stdout: '.git', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    });
    assert.strictEqual(context.effectiveRoot, '/repo/main');
    assert.strictEqual(context.reason, 'main_worktree');
    assert.strictEqual(context.mode, 'current_directory');
  });

  // Counter-test: timeout returns object with effectiveRoot (Contract 6)
  test('returns valid result on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = resolveWorktreeContext('/tmp', { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.ok(
      typeof result.effectiveRoot === 'string',
      'must return effectiveRoot string even on timeout'
    );
  });
});

// ─── parseWorktreePorcelain ───────────────────────────────────────────────────

describe('parseWorktreePorcelain', () => {
  test('skips detached HEAD entries', () => {
    const porcelain = [
      'worktree /repo/main',
      'HEAD deadbeef',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-detached',
      'HEAD cafe1234',
      'detached',
      '',
      'worktree /repo/wt-feature',
      'HEAD f00dbabe',
      'branch refs/heads/feature-x',
      '',
    ].join('\n');
    const parsed = parseWorktreePorcelain(porcelain);
    assert.deepStrictEqual(parsed, [
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/wt-feature', branch: 'feature-x' },
    ]);
  });
});

// ─── planWorktreePrune ────────────────────────────────────────────────────────

describe('planWorktreePrune', () => {
  test('is non-destructive by default', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 0, stdout: 'worktree /repo/main\nbranch refs/heads/main\n', stderr: '' }),
      parseWorktreePorcelain: () => [{ path: '/repo/main', branch: 'main' }],
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'worktrees_present');
    assert.strictEqual(plan.destructiveModeRequested, false);
  });

  test('keeps metadata-prune action when destructive mode is requested (scaffold)', () => {
    const plan = planWorktreePrune('/repo/main', { allowDestructive: true }, {
      execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      parseWorktreePorcelain: () => [],
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'no_worktrees');
    assert.strictEqual(plan.destructiveModeRequested, true);
  });

  test('skips when git worktree list fails', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 2, stdout: '', stderr: 'fatal' }),
    });
    assert.strictEqual(plan.action, 'skip');
    assert.strictEqual(plan.reason, 'git_list_failed');
  });

  test('still metadata-prunes when porcelain parser throws', () => {
    const plan = planWorktreePrune('/repo/main', {}, {
      execGit: () => ({ exitCode: 0, stdout: 'not-porcelain', stderr: '' }),
      parseWorktreePorcelain: () => {
        throw new Error('parse failed');
      },
    });
    assert.strictEqual(plan.action, 'metadata_prune_only');
    assert.strictEqual(plan.reason, 'no_worktrees');
  });

  // Counter-test: timeout path (Contract 6)
  test('returns action=skip when execGit times out', () => {
    let threw = false;
    let result;
    try {
      result = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.action, 'skip');
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return a non-empty reason when git times out'
    );
  });

  // AC4 strict: must use specific reason string 'git_timed_out'
  test('reason is git_timed_out (not generic git_list_failed) on timeout', () => {
    const result = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true — not the generic git_list_failed'
    );
  });
});

// ─── executeWorktreePrunePlan ─────────────────────────────────────────────────

describe('executeWorktreePrunePlan', () => {
  test('runs git worktree prune for metadata plan', () => {
    const calls = [];
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'metadata_prune_only', reason: 'worktrees_present' },
      {
        execGit: (args, opts) => {
          calls.push({ cwd: opts.cwd, args });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls, [{ cwd: '/repo/main', args: ['worktree', 'prune'] }]);
  });

  test('returns skip for missing plan', () => {
    const result = executeWorktreePrunePlan(null, {
      execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'missing_plan');
  });

  test('returns skip plan unchanged without git call', () => {
    let called = false;
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'skip', reason: 'git_list_failed' },
      {
        execGit: () => {
          called = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'skip');
    assert.strictEqual(result.reason, 'git_list_failed');
    assert.strictEqual(called, false);
  });

  test('rejects unsupported actions', () => {
    const result = executeWorktreePrunePlan(
      { repoRoot: '/repo/main', action: 'remove_missing_paths', reason: 'explicit' },
      {
        execGit: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'remove_missing_paths');
    assert.strictEqual(result.reason, 'unsupported_action');
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false when plan is skip (timeout path)', () => {
    const plan = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
    const result = executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false, 'must return ok:false on timeout');
  });

  // AC4 strict: timedOut must be surfaced as a first-class field
  test('result.timedOut is true when prune git call times out', () => {
    const plan = {
      repoRoot: '/tmp',
      action: 'metadata_prune_only',
      reason: 'no_worktrees',
      destructiveModeRequested: false,
    };
    const result = executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(
      result.timedOut,
      true,
      'must include timedOut:true in result when the execGit call returns timedOut:true'
    );
  });
});

// ─── listLinkedWorktreePaths ──────────────────────────────────────────────────

describe('listLinkedWorktreePaths', () => {
  test('parses porcelain and skips first/main path', () => {
    const listed = listLinkedWorktreePaths('/repo/main', {
      execGit: () => ({
        exitCode: 0,
        stdout: [
          'worktree /repo/main',
          'HEAD aaa',
          'branch refs/heads/main',
          '',
          'worktree /repo/wt-a',
          'HEAD bbb',
          'branch refs/heads/feat-a',
          '',
          'worktree /repo/wt-b',
          'HEAD ccc',
          'detached',
          '',
        ].join('\n'),
        stderr: '',
      }),
    });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.paths, ['/repo/wt-a', '/repo/wt-b']);
  });

  // Counter-test: failure path (Contract 6)
  test('returns ok:false on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = listLinkedWorktreePaths('/tmp', { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(result.ok, false);
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return non-empty reason on timeout'
    );
  });

  test('reason is git_timed_out on timeout', () => {
    const result = listLinkedWorktreePaths('/tmp', { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true'
    );
  });
});

// ─── inspectWorktreeHealth ────────────────────────────────────────────────────

describe('inspectWorktreeHealth', () => {
  test('reports orphan and stale findings', () => {
    const health = inspectWorktreeHealth(
      '/repo/main',
      { staleAfterMs: 60 * 60 * 1000, nowMs: 2 * 60 * 60 * 1000 },
      {
        execGit: () => ({
          exitCode: 0,
          stdout: [
            'worktree /repo/main',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /repo/wt-orphan',
            'HEAD bbb',
            'branch refs/heads/feat-a',
            '',
            'worktree /repo/wt-stale',
            'HEAD ccc',
            'branch refs/heads/feat-b',
            '',
          ].join('\n'),
          stderr: '',
        }),
        existsSync: p => p !== '/repo/wt-orphan',
        statSync: () => ({ mtimeMs: 0 }),
      }
    );
    assert.strictEqual(health.ok, true);
    assert.deepStrictEqual(health.findings, [
      { kind: 'orphan', path: '/repo/wt-orphan' },
      { kind: 'stale', path: '/repo/wt-stale', ageMinutes: 120 },
    ]);
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false when git times out', () => {
    let threw = false;
    let result;
    try {
      result = inspectWorktreeHealth('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false);
  });

  test('findings is empty array (not undefined) on timeout', () => {
    const result = inspectWorktreeHealth('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(Array.isArray(result.findings), true, 'findings must be an array even when ok:false');
  });
});

// ─── snapshotWorktreeInventory ────────────────────────────────────────────────

describe('snapshotWorktreeInventory', () => {
  test('returns typed linked-worktree entries', () => {
    const inventory = snapshotWorktreeInventory(
      '/repo/main',
      { staleAfterMs: 60 * 60 * 1000, nowMs: 2 * 60 * 60 * 1000 },
      {
        execGit: () => ({
          exitCode: 0,
          stdout: [
            'worktree /repo/main',
            'HEAD aaa',
            'branch refs/heads/main',
            '',
            'worktree /repo/wt-a',
            'HEAD bbb',
            'branch refs/heads/feat-a',
            '',
            'worktree /repo/wt-b',
            'HEAD ccc',
            'branch refs/heads/feat-b',
            '',
          ].join('\n'),
          stderr: '',
        }),
        existsSync: p => p !== '/repo/wt-b',
        statSync: () => ({ mtimeMs: 0 }),
      }
    );
    assert.strictEqual(inventory.ok, true);
    assert.deepStrictEqual(inventory.entries, [
      { path: '/repo/wt-a', exists: true, isStale: true, ageMinutes: 120 },
      { path: '/repo/wt-b', exists: false, isStale: false, ageMinutes: null },
    ]);
  });

  // Counter-test: timeout path (Contract 6)
  test('returns ok:false with reason on timeout, not throw', () => {
    let threw = false;
    let result;
    try {
      result = snapshotWorktreeInventory('/tmp', {}, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'must not throw on timeout');
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.ok, false);
    assert.ok(
      typeof result.reason === 'string' && result.reason.length > 0,
      'must return non-empty reason on timeout'
    );
  });

  test('reason is git_timed_out on timeout', () => {
    const result = snapshotWorktreeInventory('/tmp', {}, { execGit: makeTimeoutStub() });
    assert.strictEqual(
      result.reason,
      'git_timed_out',
      'must use reason=git_timed_out when execGit returns timedOut:true'
    );
  });
});

// ─── Degraded-git prune flow (AC3) ───────────────────────────────────────────

describe('prune flow under degraded git', () => {
  test('full prune flow (plan -> execute) completes without throwing on timeout', () => {
    let threw = false;
    try {
      const plan = planWorktreePrune('/tmp', {}, { execGit: makeTimeoutStub() });
      executeWorktreePrunePlan(plan, { execGit: makeTimeoutStub() });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'full prune flow must not throw on timeout — must degrade gracefully');
  });
});

// ─── planWorktreeWaveCleanup ──────────────────────────────────────────────────

describe('planWorktreeWaveCleanup', () => {
  test('includes only manifest entries and never discovers global agent worktrees', () => {
    const plan = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [
        {
          agent_id: 'a1',
          worktree_path: '/repo/.claude/worktrees/agent-a1',
          branch: 'worktree-agent-a1',
          expected_base: 'abc123',
          allowed_bases: ['abc123', 'def456'],
        },
      ],
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entries.map((entry) => ({
      agent_id: entry.agent_id,
      worktree_path: entry.worktree_path,
      branch: entry.branch,
      expected_base: entry.expected_base,
      allowed_bases: entry.allowed_bases,
    })), [{
      agent_id: 'a1',
      worktree_path: '/repo/.claude/worktrees/agent-a1',
      branch: 'worktree-agent-a1',
      expected_base: 'abc123',
      allowed_bases: ['abc123', 'def456'],
    }]);
    assert.equal(plan.discovery, 'manifest');
  });

  // Counter-test: invalid entries rejected (Contract 6)
  test('rejects entries without expected base or disposable branch namespace', () => {
    const plan = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [
        {
          agent_id: 'missing-base',
          worktree_path: '/repo/.claude/worktrees/agent-missing-base',
          branch: 'worktree-agent-missing-base',
        },
        {
          agent_id: 'feature-branch',
          worktree_path: '/repo/.claude/worktrees/agent-feature',
          branch: 'feature/user-work',
          expected_base: 'abc123',
        },
      ],
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'empty_manifest');
    assert.deepEqual(plan.entries, []);
  });
});

// ─── planWorktreeRecordAgent (#1298 writer verb) ──────────────────────────────
// These tests pin the verb's reason for existing: a per-agent entry that
// record-agent ACCEPTS must survive the cleanup-wave reader, and one it REJECTS
// is exactly what the reader would have dropped silently. If write- and
// read-side validation ever diverge, the round-trip tests below fail.

describe('planWorktreeRecordAgent', () => {
  const VALID = {
    agentId: 'a1',
    worktreePath: '/repo/.claude/worktrees/agent-a1',
    branch: 'worktree-agent-a1',
    base: 'abc123',
  };

  test('appends a validated entry that the cleanup-wave reader accepts (write/read parity)', () => {
    const plan = planWorktreeRecordAgent('{"orchestrator_root":"/repo/main","worktrees":[]}', VALID);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entry, {
      agent_id: 'a1',
      worktree_path: '/repo/.claude/worktrees/agent-a1',
      branch: 'worktree-agent-a1',
      expected_base: 'abc123',
    });
    // The serialized manifest must round-trip through the reader the cleanup
    // path uses — proving write and read validate identically.
    const written = JSON.parse(plan.manifest);
    assert.equal(written.orchestrator_root, '/repo/main'); // preserved, no schema change
    const readBack = planWorktreeWaveCleanup('/repo/main', written);
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1);
    assert.equal(readBack.entries[0].agent_id, 'a1');
  });

  test('preserves existing entries and other top-level keys when appending', () => {
    const existing = JSON.stringify({
      orchestrator_root: '/repo/main',
      worktrees: [{
        agent_id: 'a0',
        worktree_path: '/repo/.claude/worktrees/agent-a0',
        branch: 'worktree-agent-a0',
        expected_base: 'aaa000',
      }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.ok, true);
    const written = JSON.parse(plan.manifest);
    assert.equal(written.orchestrator_root, '/repo/main');
    assert.equal(written.worktrees.length, 2);
    assert.deepEqual(written.worktrees.map((w) => w.agent_id), ['a0', 'a1']);
  });

  test('accepts a bare top-level array manifest', () => {
    const plan = planWorktreeRecordAgent('[]', VALID);
    assert.equal(plan.ok, true);
    const written = JSON.parse(plan.manifest);
    assert.ok(Array.isArray(written));
    assert.equal(written.length, 1);
    assert.equal(written[0].branch, 'worktree-agent-a1');
  });

  // Write-strict agent_id: the reader treats agent_id as nullable, but the
  // writer requires it — an entry whose author cannot be identified defeats the
  // verb's purpose. This is the deliberate write-strict-vs-read-lenient decision.
  test('fails loudly when --agent-id is empty (write-strict, unlike the lenient reader)', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, agentId: '' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'missing_field');
    assert.match(plan.hint, /--agent-id/);
    assert.equal(plan.manifest, null);
  });

  test('reports every missing field, not just the first', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
      agentId: '', worktreePath: '', branch: '', base: '',
    });
    assert.equal(plan.reason, 'missing_field');
    for (const flag of ['--agent-id', '--path', '--branch', '--base']) {
      assert.match(plan.hint, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  // Branch-regex consistency caveat: a branch outside the disposable namespace
  // is what the reader drops silently — record-agent must reject it at write time.
  test('rejects a branch outside the worktree-agent-* namespace (the entry the reader would drop)', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, branch: 'feature/user-work' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_entry');
    assert.match(plan.hint, /worktree-agent-/);
    assert.equal(plan.manifest, null);
    // Confirm the rejected entry is genuinely one the reader drops.
    const readBack = planWorktreeWaveCleanup('/repo/main', {
      worktrees: [{ agent_id: 'a1', worktree_path: VALID.worktreePath, branch: 'feature/user-work', expected_base: 'abc123' }],
    });
    assert.equal(readBack.ok, false);
    assert.equal(readBack.reason, 'empty_manifest');
  });

  test('fails loudly on malformed manifest JSON instead of clobbering it', () => {
    const plan = planWorktreeRecordAgent('{not valid json', VALID);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'invalid_manifest_json');
    assert.equal(plan.manifest, null);
  });

  test('rejects a manifest whose worktrees field is not an array', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":{}}', VALID);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'manifest_shape_invalid');
    assert.equal(plan.manifest, null);
  });

  // The reader dedups on (worktree_path, branch); a re-record would be silently
  // dropped at cleanup — exactly the failure mode the verb exists to eliminate —
  // so the writer must reject it loudly rather than swallow it.
  test('rejects a duplicate (worktree_path, branch) loudly instead of writing a droppable entry', () => {
    const existing = JSON.stringify({
      worktrees: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    });
    // Same path+branch, different agent_id/base — still a duplicate by the reader's key.
    const plan = planWorktreeRecordAgent(existing, { ...VALID, agentId: 'a1-retry', base: 'deadbee' });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'duplicate_entry');
    assert.match(plan.hint, /worktree-agent-a1/);
    assert.equal(plan.manifest, null);
  });

  test('detects a duplicate stored under the legacy `path` field too', () => {
    const existing = JSON.stringify({
      worktrees: [{ path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', expected_base: 'abc123' }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.reason, 'duplicate_entry');
  });

  // Reader-alignment: the cleanup reader dedups only over entries that normalize
  // successfully, so a malformed same-key entry it would DROP must not block a
  // valid recording — otherwise the writer is stricter than the reader and
  // blocks legitimate recovery.
  test('a malformed same-key existing entry does not block recording a valid one', () => {
    const existing = JSON.stringify({
      // Same path+branch as VALID but no expected_base — the reader drops this.
      worktrees: [{ worktree_path: '/repo/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1' }],
    });
    const plan = planWorktreeRecordAgent(existing, VALID);
    assert.equal(plan.ok, true);
    const readBack = planWorktreeWaveCleanup('/repo/main', JSON.parse(plan.manifest));
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1); // reader keeps only the valid one
    assert.equal(readBack.entries[0].expected_base, 'abc123');
  });

  test('rejects whitespace-only --path/--base (values are trimmed)', () => {
    const wsPath = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, worktreePath: '   ' });
    assert.equal(wsPath.reason, 'missing_field');
    assert.match(wsPath.hint, /--path/);
    const wsBase = planWorktreeRecordAgent('{"worktrees":[]}', { ...VALID, base: '  \t ' });
    assert.equal(wsBase.reason, 'missing_field');
    assert.match(wsBase.hint, /--base/);
  });

  test('trims incidental surrounding whitespace on accepted values', () => {
    const plan = planWorktreeRecordAgent('{"worktrees":[]}', {
      agentId: ' a1 ', worktreePath: ' /repo/wt-a1 ', branch: ' worktree-agent-a1 ', base: ' abc123 ',
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.entry, {
      agent_id: 'a1', worktree_path: '/repo/wt-a1', branch: 'worktree-agent-a1', expected_base: 'abc123',
    });
  });
});

// ─── planWorktreeRecordAgent — property-based write/read parity (#1298) ────────
// The verb's reason for existing is the write→read parity invariant, so it must
// carry a fast-check property test (RULESET.TESTS.property-based-testing): an
// entry the writer ACCEPTS must survive the cleanup reader unchanged, and an
// entry with an invalid branch must be REJECTED symmetrically.

describe('planWorktreeRecordAgent — fast-check parity invariant (#1298)', () => {
  const seg = fc.stringMatching(/^[A-Za-z0-9._/-]+$/); // include '/' — the namespace allows it
  const agentBranch = seg.map((s) => `worktree-agent-${s}`);
  const nonEmpty = fc.stringMatching(/^\S[\S ]*$/); // no leading whitespace, not blank

  test('any writer-accepted entry round-trips through the cleanup reader unchanged', () => {
    fc.assert(fc.property(
      fc.record({ agentId: nonEmpty, worktreePath: nonEmpty, branch: agentBranch, base: nonEmpty }),
      (fields) => {
        const plan = planWorktreeRecordAgent('{"worktrees":[]}', fields);
        if (!plan.ok) return; // rejection is fine; this property is about accepted entries
        const readBack = planWorktreeWaveCleanup('/repo/main', JSON.parse(plan.manifest));
        assert.equal(readBack.ok, true);
        assert.equal(readBack.entries.length, 1);
        const e = readBack.entries[0];
        assert.equal(e.worktree_path, fields.worktreePath.trim());
        assert.equal(e.branch, fields.branch.trim());
        assert.equal(e.expected_base, fields.base.trim());
        assert.equal(e.agent_id, fields.agentId.trim());
      },
    ));
  });

  test('an entry with a branch outside the worktree-agent-* namespace is always rejected', () => {
    fc.assert(fc.property(
      fc.record({
        agentId: nonEmpty,
        worktreePath: nonEmpty,
        // Any branch that does NOT match the disposable namespace.
        branch: fc.string({ minLength: 1 }).filter((b) => !/^worktree-agent-[A-Za-z0-9._/-]+$/.test(b.trim())),
        base: nonEmpty,
      }),
      (fields) => {
        const plan = planWorktreeRecordAgent('{"worktrees":[]}', fields);
        assert.equal(plan.ok, false);
        assert.equal(plan.manifest, null);
      },
    ));
  });
});

// ─── cmdWorktreeRecordAgent (#1298 CLI wrapper) ───────────────────────────────

describe('cmdWorktreeRecordAgent', () => {
  // process.exitCode is global; each failure-path test resets it so a failing
  // exit code does not leak into the test runner's own exit status.
  function withExitCode(fn) {
    const saved = process.exitCode;
    try { return fn(); } finally { process.exitCode = saved; }
  }

  const okArgs = [
    '--manifest', 'manifest.json',
    '--agent-id', 'a1',
    '--path', '/repo/.claude/worktrees/agent-a1',
    '--branch', 'worktree-agent-a1',
    '--base', 'abc123',
  ];

  test('writes the manifest and reports ok on the happy path', () => {
    let writtenPath = null;
    let writtenContent = null;
    const out = [];
    const result = cmdWorktreeRecordAgent('/repo/main', okArgs, {
      readFile: () => '{"orchestrator_root":"/repo/main","worktrees":[]}',
      writeFile: (p, c) => { writtenPath = p; writtenContent = c; },
      write: (s) => out.push(s),
      writeErr: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(writtenPath, path.resolve('/repo/main', 'manifest.json'));
    const written = JSON.parse(writtenContent);
    assert.equal(written.worktrees.length, 1);
    assert.equal(written.worktrees[0].agent_id, 'a1');
    assert.match(out.join(''), /"ok": true/);
  });

  test('exits 2 with usage when --manifest is missing', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main', ['--agent-id', 'a1'], {
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'usage');
      assert.equal(process.exitCode, 2);
      assert.match(errs.join(''), /Usage: worktree record-agent/);
    });
  });

  test('exits 1 loudly when the manifest cannot be read', () => {
    withExitCode(() => {
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main', okArgs, {
        readFile: () => { throw new Error('ENOENT'); },
        writeErr: (s) => errs.push(s),
        write: () => {},
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'manifest_read_failed');
      assert.equal(process.exitCode, 1);
      assert.match(errs.join(''), /manifest_read_failed/);
    });
  });

  test('does not write the manifest when the entry is invalid', () => {
    withExitCode(() => {
      let wrote = false;
      const errs = [];
      const result = cmdWorktreeRecordAgent('/repo/main',
        ['--manifest', 'm.json', '--agent-id', 'a1', '--path', '/p', '--branch', 'feature/x', '--base', 'abc123'], {
          readFile: () => '{"worktrees":[]}',
          writeFile: () => { wrote = true; },
          writeErr: (s) => errs.push(s),
          write: () => {},
        });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid_entry');
      assert.equal(wrote, false); // must NOT append an under-populated entry
      assert.equal(process.exitCode, 1);
      assert.match(errs.join(''), /worktree-agent-/);
    });
  });
});

// ─── record-agent: real CLI dispatch + workflow wiring (#1298 integration) ────
// The unit tests above inject IO; these pin the live `gsd-tools.cjs query
// worktree.record-agent` dispatch and the execute-phase.md call site, so a
// future typo in the dotted command or the workflow wiring fails loudly.

describe('worktree record-agent — real CLI dispatch (#1298)', () => {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

  test('the dotted `query worktree.record-agent` path writes an entry the cleanup reader accepts', () => {
    const dir = createTempDir();
    try {
      const manifest = path.join(dir, 'wave-manifest.json');
      fs.writeFileSync(manifest, `${JSON.stringify({ orchestrator_root: dir, worktrees: [] })}\n`);
      const out = execFileSync(process.execPath, [
        GSD_TOOLS, 'query', 'worktree.record-agent',
        '--manifest', manifest,
        '--agent-id', 'a1',
        '--path', path.join(dir, 'wt-a1'),
        '--branch', 'worktree-agent-a1',
        '--base', 'abc123',
      ], { encoding: 'utf8' });
      assert.match(out, /"ok": true/);
      const written = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.equal(written.worktrees.length, 1);
      assert.equal(written.worktrees[0].agent_id, 'a1');
      // What the live CLI wrote must read back through the cleanup reader.
      const readBack = planWorktreeWaveCleanup(dir, written);
      assert.equal(readBack.ok, true);
      assert.equal(readBack.entries[0].branch, 'worktree-agent-a1');
    } finally {
      cleanup(dir);
    }
  });

  test('a missing field fails loudly via the real CLI (non-zero exit, manifest untouched)', () => {
    const dir = createTempDir();
    try {
      const manifest = path.join(dir, 'wave-manifest.json');
      fs.writeFileSync(manifest, `${JSON.stringify({ worktrees: [] })}\n`);
      let threw = false;
      try {
        execFileSync(process.execPath, [
          GSD_TOOLS, 'query', 'worktree.record-agent',
          '--manifest', manifest,
          '--path', path.join(dir, 'wt'), '--branch', 'worktree-agent-x', '--base', 'abc123',
        ], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        threw = true;
        assert.equal(err.status, 1);
        assert.match(String(err.stderr), /record-agent: missing_field/);
      }
      assert.ok(threw, 'CLI must exit non-zero when --agent-id is missing');
      assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).worktrees, []);
    } finally {
      cleanup(dir);
    }
  });

  test('the execute-phase.md per-agent append calls the record-agent verb', () => {
    const wf = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
    );
    assert.match(wf, /worktree\.record-agent/, 'execute-phase.md must wire the record-agent verb');
  });
});

// ─── executeWorktreeWaveCleanupPlan ───────────────────────────────────────────

describe('executeWorktreeWaveCleanupPlan', () => {
  test('#1265 accepts a merge-base listed in allowed_bases even when expected_base is the plan commit', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'plancommit',
        allowed_bases: ['plancommit', 'parentcommit'],
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'parentcommit', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('#1265 still blocks a merge-base outside expected_base and allowed_bases', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'plancommit',
        allowed_bases: ['plancommit', 'parentcommit'],
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'unrelatedbase', stderr: '' };
        }
        throw new Error(`unexpected git call after rejected base: ${key}`);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'base_mismatch');
  });

  test('does not delete a branch when worktree removal fails', () => {
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args, opts) => {
        calls.push({ cwd: opts && opts.cwd, args });
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 1, stdout: '', stderr: 'locked' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          throw new Error('branch deletion must not run after remove failure');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'worktree_remove_failed');
    assert.equal(calls.some((call) => call.args.join(' ') === 'branch -D worktree-agent-a1'), false);
  });

  test('stops on merge conflict and records remaining manifest entries', () => {
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [
        {
          agent_id: 'a1',
          worktree_path: '/repo/.claude/worktrees/agent-a1',
          branch: 'worktree-agent-a1',
          expected_base: 'abc123',
        },
        {
          agent_id: 'a2',
          worktree_path: '/repo/.claude/worktrees/agent-a2',
          branch: 'worktree-agent-a2',
          expected_base: 'abc123',
        },
      ],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 1, stdout: '', stderr: 'CONFLICT' };
        }
        throw new Error(`unexpected git call after conflict: ${key}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].status, 'blocked');
    assert.equal(result.entries[0].reason, 'merge_failed');
    assert.deepEqual(result.pending.map((entry) => entry.branch), ['worktree-agent-a2']);
  });

  test('#3804: rescues uncommitted SUMMARY.md from worktree .planning/ before dirty check', () => {
    // Fixture: the only dirty file is .planning/q1-SUMMARY.md (executor left it uncommitted
    // per documented contract — orchestrator commits it).  cleanup-wave MUST rescue it
    // (copy to main tree) and succeed, not return worktree_dirty.
    const calls = [];
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed on the branch — cat-file -e HEAD:<path> returns non-zero
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 1, stdout: '', stderr: 'error: pathspec \'.planning/q1-SUMMARY.md\' did not match any file(s) known to git' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Only the SUMMARY is dirty — no other modified files
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      // Inject FS deps so tests don't touch the real filesystem
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: (p) => {
        if (p === '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md') return 'summary content';
        return '';
      },
      existsSync: (_p) => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // SUMMARY was rescued into the main tree
    assert.equal(rescued.length, 1, 'SUMMARY.md must be rescued (copied) to main tree');
    assert.equal(rescued[0].src, '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md');
    // Normalize to forward slashes for cross-platform assertion (path.join uses \ on Windows)
    assert.equal(rescued[0].dest.replace(/\\/g, '/'), '/repo/main/.planning/q1-SUMMARY.md');

    // Cleanup succeeded — SUMMARY-only dirty state must not block
    assert.equal(result.ok, true, 'cleanup must succeed when only SUMMARY.md is dirty');
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(result.entries[0].reason, 'ok');
  });

  test('#3804: still blocks when worktree has non-SUMMARY dirty files alongside SUMMARY', () => {
    // If there are OTHER dirty files (not SUMMARY), cleanup must still block.
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed on the branch (uncommitted, per quick.md contract)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 1, stdout: '', stderr: 'error: pathspec \'.planning/q1-SUMMARY.md\' did not match any file(s) known to git' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // SUMMARY plus another dirty file
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md\nM  src/foo.js', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
  });

  test('#245: blocks with summary_rescue_failed when copyFileSync throws during rescue', () => {
    // Fixture: the only dirty file is .planning/q1-SUMMARY.md, but copyFileSync throws
    // (simulating ENOSPC / permission error).  The path must NOT be added to rescuedRelPaths,
    // so the entry must be blocked with status='blocked', reason='summary_rescue_failed',
    // and the worktree must NOT be merged or removed.
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is NOT committed on the branch — rescue should proceed (and fail with ENOSPC)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 1, stdout: '', stderr: 'error: pathspec \'.planning/q1-SUMMARY.md\' did not match any file(s) known to git' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Only the SUMMARY is dirty
          return { exitCode: 0, stdout: '?? .planning/q1-SUMMARY.md', stderr: '' };
        }
        // Any merge or worktree-remove call proves we failed to block — throw to surface it
        if (key.startsWith('merge worktree-agent-a1') || key.startsWith('worktree remove')) {
          throw new Error(`worktree was not blocked before merge/remove: ${key}`);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: (p) => {
        if (p === '/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md') return 'summary content';
        return '';
      },
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => { throw new Error('ENOSPC: no space left on device'); },
    });

    assert.equal(result.ok, false, 'result.ok must be false when rescue copy fails');
    assert.equal(result.entries[0].status, 'blocked', 'entry status must be blocked');
    assert.equal(result.entries[0].reason, 'summary_rescue_failed', 'entry reason must be summary_rescue_failed');
    // Verify no merge or worktree-remove call was made (the execGit throw above would have surfaced it)
    const mergeCalls = calls.filter((c) => c.startsWith('merge worktree-agent-a1') || c.startsWith('worktree remove'));
    assert.equal(mergeCalls.length, 0, 'no merge or worktree-remove git call must have been made');
  });

  test('#706: does NOT rescue SUMMARY when it is already committed on the branch (execute-phase contract)', () => {
    // Regression for issue #706: when execute-phase commits SUMMARY.md on the
    // worktree branch, the cleanup-wave helper must NOT copy it as an untracked
    // file into the main tree.  Doing so creates a collision that causes
    // `git merge --no-ff` to abort with "untracked working tree files would be
    // overwritten by merge".
    //
    // Fixture: SUMMARY.md is committed on the branch (git cat-file -e HEAD:<path>
    // returns exit 0).  The worktree status shows the file as committed (not dirty).
    // The rescue step must skip this file entirely.  The merge must succeed.
    const calls = [];
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is committed on the branch — cat-file -e HEAD:<path> succeeds (exit 0)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 0, stdout: '.planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree is clean — SUMMARY is committed, not dirty
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: (_p) => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // The committed SUMMARY must NOT have been copied into the main tree as an untracked file
    assert.equal(rescued.length, 0,
      'rescueSummaryArtifacts must NOT copy an already-committed SUMMARY into the main tree — ' +
      'doing so creates an untracked file that collides with the --no-ff merge');

    // Cleanup must succeed
    assert.equal(result.ok, true, 'cleanup must succeed when SUMMARY is committed on the branch');
    assert.equal(result.entries[0].status, 'merged_removed');
    assert.equal(result.entries[0].reason, 'ok');
  });

  test('#706: SUMMARY committed on branch + untracked non-SUMMARY dirty file still blocks', () => {
    // Even when SUMMARY is committed (no rescue needed), a non-SUMMARY dirty file must block.
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is committed on the branch
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 0, stdout: '.planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Another untracked file exists alongside the committed SUMMARY
          return { exitCode: 0, stdout: '?? scratch.txt', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
  });

  test('#706: SUMMARY staged-but-not-committed is rescued (cat-file -e HEAD only matches committed)', () => {
    // Codex adversarial finding: git ls-files --error-unmatch would match staged
    // files (added to index but not committed), causing rescue to be skipped for
    // a file the merge would NOT carry.  cat-file -e HEAD:<path> only matches
    // committed objects, so staged-but-not-committed SUMMARY is rescued correctly.
    //
    // Fixture: cat-file -e HEAD:<path> returns exit 1 (not in committed tree),
    // but git status shows 'A  .planning/q1-SUMMARY.md' (staged).  Rescue must
    // copy it into the main tree and the cleanup must proceed.
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // SUMMARY is staged but NOT committed — cat-file -e HEAD:<path> returns non-zero
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 1, stdout: '', stderr: 'fatal: Not a valid object name HEAD:.planning/q1-SUMMARY.md' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // File is staged ('A  .planning/q1-SUMMARY.md')
          return { exitCode: 0, stdout: 'A  .planning/q1-SUMMARY.md', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // The staged-but-not-committed SUMMARY must be rescued into the main tree
    assert.equal(rescued.length, 1,
      'staged-but-not-committed SUMMARY must be rescued — cat-file -e HEAD only skips truly committed files');
    // Cleanup succeeded: staged-file shows as 'A  ..' which is in rescuedRelPaths filter
    assert.equal(result.ok, true, 'cleanup must succeed when only staged SUMMARY is present');
    assert.equal(result.entries[0].status, 'merged_removed');
  });

  test('#706: cat-file fatal exit 128 causes rescue to be skipped (fail-closed on uncertain git)', () => {
    // Finding #1 (code-review): exit code 128 means a fatal git error (e.g. corrupt
    // object store, unborn HEAD, missing repo).  The guard must treat it as
    // "uncertain — cannot determine committed status" and skip rescue, NOT proceed.
    // Rescuing when status is uncertain would re-create the #706 merge collision if
    // the file is actually already committed.
    //
    // Fixture: cat-file returns exitCode:128, timedOut:false.
    // The cleanup must NOT rescue the SUMMARY (no copy into main tree).
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // cat-file returns 128 — fatal git error (e.g. corrupt object store)
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', timedOut: false };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree appears clean (SUMMARY is committed on branch)
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // On fatal exit 128, rescue must be skipped (fail-closed) — no copy into main tree
    assert.equal(rescued.length, 0,
      'cat-file exit 128 must NOT rescue the SUMMARY — uncertain git state, skip to avoid recreating #706 collision');
    // The rest of cleanup proceeds normally (merge/remove/delete succeed in this fixture)
    assert.equal(result.ok, true, 'cleanup can still succeed when cat-file returns 128 and worktree is clean');
  });

  test('#706: cat-file timeout causes rescue to be skipped (fail-closed on unreliable git)', () => {
    // Codex adversarial finding: on cat-file timeout, rescuing an actually-committed
    // file would re-create the untracked collision.  The fix treats timeout as
    // "cannot determine status — skip rescue" (fail-closed).  This means the merge
    // will fail with merge_failed, which is the observable pre-fix behaviour and
    // is recoverable, rather than silently corrupting the main tree.
    //
    // Fixture: cat-file returns timedOut:true.  The cleanup must NOT rescue the
    // SUMMARY (no copy).  The merge will then succeed normally (SUMMARY is on the
    // branch) or fail safely if the worktree status check catches something.
    const rescued = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // cat-file times out — cannot determine if SUMMARY is committed
        if (key === '-C /repo/.claude/worktrees/agent-a1 cat-file -e HEAD:.planning/q1-SUMMARY.md') {
          return {
            exitCode: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            signal: 'SIGTERM',
            error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          // Worktree appears clean (SUMMARY is committed on branch)
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('merge worktree-agent-a1')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'worktree remove /repo/.claude/worktrees/agent-a1 --force') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === 'branch -D worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      findSummaryFiles: (worktreePath) => {
        if (worktreePath === '/repo/.claude/worktrees/agent-a1') {
          return ['/repo/.claude/worktrees/agent-a1/.planning/q1-SUMMARY.md'];
        }
        return [];
      },
      readFileSync: () => 'summary content',
      existsSync: () => false,
      mkdirSync: () => {},
      copyFileSync: (src, dest) => { rescued.push({ src, dest }); },
    });

    // On timeout, rescue must be skipped (fail-closed) — no copy into main tree
    assert.equal(rescued.length, 0,
      'cat-file timeout must NOT rescue the SUMMARY — copying a committed file as untracked would recreate the #706 merge collision');
    // The rest of cleanup proceeds normally (merge/remove/delete succeed in this fixture)
    assert.equal(result.ok, true, 'cleanup can still succeed when cat-file times out and worktree is clean');
  });

  test('blocks dirty worktrees before merge/remove/delete', () => {
    const calls = [];
    const plan = {
      ok: true,
      repoRoot: '/repo/main',
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{
        agent_id: 'a1',
        worktree_path: '/repo/.claude/worktrees/agent-a1',
        branch: 'worktree-agent-a1',
        expected_base: 'abc123',
      }],
    };
    const result = executeWorktreeWaveCleanupPlan(plan, {
      execGit: (args) => {
        calls.push(args.join(' '));
        const key = args.join(' ');
        if (key === '-C /repo/.claude/worktrees/agent-a1 rev-parse --abbrev-ref HEAD') {
          return { exitCode: 0, stdout: 'worktree-agent-a1', stderr: '' };
        }
        if (key === 'merge-base HEAD worktree-agent-a1') {
          return { exitCode: 0, stdout: 'abc123', stderr: '' };
        }
        if (key === 'diff --diff-filter=D --name-only HEAD...worktree-agent-a1') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (key === '-C /repo/.claude/worktrees/agent-a1 status --porcelain --untracked-files=all') {
          return { exitCode: 0, stdout: '?? scratch.txt', stderr: '' };
        }
        throw new Error(`unexpected git call after dirty check: ${key}`);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries[0].reason, 'worktree_dirty');
    assert.equal(calls.some((call) => call.startsWith('merge worktree-agent-a1')), false);
    assert.equal(calls.some((call) => call === 'worktree remove /repo/.claude/worktrees/agent-a1 --force'), false);
    assert.equal(calls.some((call) => call === 'branch -D worktree-agent-a1'), false);
  });
});

// ─── MOVE 2: resolveWorktreeRoot and pruneOrphanedWorktrees (#1268 T0) ────────

describe('worktree-safety: resolveWorktreeRoot and pruneOrphanedWorktrees relocation identity', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);
  const core = require(CORE_PATH);

  test('core.resolveWorktreeRoot === worktreeSafety.resolveWorktreeRoot (by reference)', () => {
    assert.strictEqual(
      core.resolveWorktreeRoot,
      worktreeSafety.resolveWorktreeRoot,
      'core.resolveWorktreeRoot must be the same function reference as worktreeSafety.resolveWorktreeRoot'
    );
  });

  test('core.pruneOrphanedWorktrees === worktreeSafety.pruneOrphanedWorktrees (by reference)', () => {
    assert.strictEqual(
      core.pruneOrphanedWorktrees,
      worktreeSafety.pruneOrphanedWorktrees,
      'core.pruneOrphanedWorktrees must be the same function reference as worktreeSafety.pruneOrphanedWorktrees'
    );
  });
});

describe('worktree-safety: resolveWorktreeRoot behaviour', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);

  test('resolveWorktreeRoot(createTempGitProject()) returns a non-empty string', (t) => {
    const dir = createTempGitProject('gsd-wt-root-');
    t.after(() => cleanup(dir));
    const result = worktreeSafety.resolveWorktreeRoot(dir);
    assert.ok(typeof result === 'string' && result.length > 0,
      `Expected non-empty string, got: ${JSON.stringify(result)}`);
  });
});

describe('worktree-safety: pruneOrphanedWorktrees behaviour', () => {
  const worktreeSafety = require(WORKTREE_SAFETY_PATH);

  test('pruneOrphanedWorktrees(temp dir) returns [] and does not throw', (t) => {
    const dir = createTempDir('gsd-prune-');
    t.after(() => cleanup(dir));
    let result;
    assert.doesNotThrow(() => {
      result = worktreeSafety.pruneOrphanedWorktrees(dir);
    });
    assert.deepStrictEqual(result, []);
  });
});
