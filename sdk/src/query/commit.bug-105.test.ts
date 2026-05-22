/**
 * Behavioral regression tests for bug #105.
 *
 * `gsd-tools commit` / SDK commit unconditionally switches the current
 * checkout to the strategy branch with no opt-out, silently moving a
 * shared HEAD and causing commits from parallel sessions to land on the
 * wrong branch.
 *
 * Fix: when `workflow.use_worktrees` is `false`, `ensureStrategyBranch`
 * must return `{ ok: true, reason: <includes 'use_worktrees'> }` WITHOUT
 * performing a `git checkout`.
 *
 * These tests exercise the real runtime path via Vitest (no source-grep).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Create a minimal project directory with .planning/config.json.
 * Returns the temp directory path.
 *
 * The directory is intentionally NOT a git repo so that any attempt to
 * run `git checkout` inside it will fail — which would propagate as
 * ok: false from ensureStrategyBranch.  The guard in the fix must fire
 * BEFORE any git invocation when use_worktrees is false.
 */
function makeTmpProject(workflowOverrides: Record<string, unknown> = {}): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bug-105-'));
  const planningDir = join(tmpDir, '.planning');
  mkdirSync(planningDir, { recursive: true });
  const config = {
    git: {
      branching_strategy: 'phase',
      phase_branch_template: 'phase/{phase}-{slug}',
      milestone_branch_template: 'ms/{milestone}-{slug}',
      quick_branch_template: null,
    },
    workflow: {
      use_worktrees: false,
      ...workflowOverrides,
    },
  };
  writeFileSync(join(planningDir, 'config.json'), JSON.stringify(config));
  return tmpDir;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── bug-105 behavioral tests ─────────────────────────────────────────────

describe('bug-105: ensureStrategyBranch skips branch switch when use_worktrees is false', () => {
  it('returns ok:true when use_worktrees is false', async () => {
    const { ensureStrategyBranch } = await import('./commit.js');
    const tmpDir = makeTmpProject({ use_worktrees: false });
    tmpDirs.push(tmpDir);

    const result = await ensureStrategyBranch(tmpDir, undefined, ['1-setup/plan.md']);

    expect(result.ok).toBe(true);
  });

  it('reason mentions use_worktrees when skipping', async () => {
    const { ensureStrategyBranch } = await import('./commit.js');
    const tmpDir = makeTmpProject({ use_worktrees: false });
    tmpDirs.push(tmpDir);

    const result = await ensureStrategyBranch(tmpDir, undefined, ['1-setup/plan.md']);

    expect(result.ok).toBe(true);
    const reason = (result as { ok: true; reason?: string }).reason ?? '';
    expect(reason).toContain('use_worktrees');
  });

  it('does not attempt git checkout when use_worktrees is false (non-git dir stays ok:true)', async () => {
    // The tmpDir is NOT a git repo. If ensureStrategyBranch were to run
    // `git checkout` it would exit non-zero and return ok:false with a
    // branch_switch_failed reason. The guard must fire BEFORE the git call.
    const { ensureStrategyBranch } = await import('./commit.js');
    const tmpDir = makeTmpProject({ use_worktrees: false });
    tmpDirs.push(tmpDir);

    const result = await ensureStrategyBranch(tmpDir, undefined, ['2-build/state.md']);

    // If the guard fired correctly, we get ok:true even without a git repo.
    expect(result.ok).toBe(true);
    const reason = (result as { ok: true; reason?: string }).reason ?? '';
    // Must be the use_worktrees skip reason, not a git failure or phase error.
    expect(reason).toContain('use_worktrees');
  });

  it('does NOT skip when use_worktrees is true (attempts checkout in non-git dir → ok:false or no use_worktrees reason)', async () => {
    // With use_worktrees: true, the guard must NOT fire.
    // In a non-git dir the checkout attempt fails → ok:false, or if it somehow
    // returns ok:true the reason must NOT contain 'use_worktrees'.
    const { ensureStrategyBranch } = await import('./commit.js');
    const tmpDir = makeTmpProject({ use_worktrees: true });
    tmpDirs.push(tmpDir);

    const result = await ensureStrategyBranch(tmpDir, undefined, ['1-setup/plan.md']);

    // Either ok:false (checkout failed in non-git dir — expected)
    // or ok:true but the reason must NOT mention the use_worktrees skip.
    if (result.ok) {
      const reason = (result as { ok: true; reason?: string }).reason ?? '';
      expect(reason).not.toContain('use_worktrees');
    } else {
      // ok:false is fine — proves the guard did NOT suppress the attempt
      const reason = (result as { ok: false; reason: string }).reason;
      expect(reason).not.toContain('use_worktrees');
    }
  });

  it('does NOT skip when use_worktrees is absent (undefined → attempts checkout)', async () => {
    // When workflow.use_worktrees is not set at all, the guard must not fire.
    const { ensureStrategyBranch } = await import('./commit.js');
    const tmpDir = mkdtempSync(join(tmpdir(), 'bug-105-absent-'));
    tmpDirs.push(tmpDir);
    const planningDir = join(tmpDir, '.planning');
    mkdirSync(planningDir, { recursive: true });
    // Config with no workflow.use_worktrees key at all
    writeFileSync(join(planningDir, 'config.json'), JSON.stringify({
      git: {
        branching_strategy: 'phase',
        phase_branch_template: 'phase/{phase}-{slug}',
        milestone_branch_template: 'ms/{milestone}-{slug}',
        quick_branch_template: null,
      },
      workflow: {},
    }));

    const result = await ensureStrategyBranch(tmpDir, undefined, ['1-setup/plan.md']);

    if (result.ok) {
      const reason = (result as { ok: true; reason?: string }).reason ?? '';
      expect(reason).not.toContain('use_worktrees');
    } else {
      const reason = (result as { ok: false; reason: string }).reason;
      expect(reason).not.toContain('use_worktrees');
    }
  });
});
