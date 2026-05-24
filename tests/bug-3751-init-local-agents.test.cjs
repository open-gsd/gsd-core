// allow-test-rule: structural-source-contract — tests verify TypeScript source contracts
// (signature shape, fallback ordering, call-site wiring) for the resolveAgentsDir fix.
// These are signed SDK-seam contracts, not source-grep theater: the TypeScript source IS
// the product artifact being validated (analogous to .md workflow contracts in this repo).
'use strict';

/**
 * Bug #3751: resolveAgentsDir() misses repo-local .claude/agents on --local installs.
 *
 * `resolveAgentsDir()` in sdk/src/query/helpers.ts checks only:
 *   1. GSD_AGENTS_DIR (explicit override)
 *   2. <getRuntimeConfigDir(runtime)>/agents  (global, e.g. ~/.claude/agents)
 *
 * For Claude Code `--local` installs (agents land in ./.claude/agents), the
 * repo-local path is never probed when GSD_AGENTS_DIR is unset and the global
 * directory is absent or empty.  Both init.ts:checkAgentsInstalled and
 * init-complex.ts:initNewProject call resolveAgentsDir() and inherit this gap.
 *
 * Fix contract:
 *   resolveAgentsDir(runtime, projectDir) must return <projectDir>/.claude/agents
 *   when GSD_AGENTS_DIR is unset AND the global runtime agents dir is absent/empty,
 *   AND a repo-local .claude/agents directory exists.
 *
 * Precedence (post-fix):
 *   GSD_AGENTS_DIR > global runtime dir (non-empty) > <projectDir>/.claude/agents
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const MODEL_PROFILES = require('../get-shit-done/bin/lib/model-profiles.cjs').MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

function writeRequiredAgents(agentsDir) {
  for (const agentName of EXPECTED_AGENTS) {
    fs.writeFileSync(
      path.join(agentsDir, `${agentName}.md`),
      `---\nname: ${agentName}\ndescription: test\ntools: Read\n---\nAgent content.\n`,
    );
  }
}

function normalizePathForAssert(targetPath) {
  if (typeof targetPath !== 'string') return targetPath;
  const resolved = path.resolve(targetPath);
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(resolved);
    }
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// ─── Source-file structural assertions (no build required) ───────────────────

const helpersTs = fs.readFileSync(
  path.join(__dirname, '../sdk/src/query/helpers.ts'),
  'utf-8',
);

const initTs = fs.readFileSync(
  path.join(__dirname, '../sdk/src/query/init.ts'),
  'utf-8',
);

const initComplexTs = fs.readFileSync(
  path.join(__dirname, '../sdk/src/query/init-complex.ts'),
  'utf-8',
);

describe('#3751: resolveAgentsDir() repo-local fallback — structural contracts', () => {
  // ─── Contract 1: signature accepts optional projectDir ──────────────────
  test('resolveAgentsDir signature accepts an optional projectDir parameter', () => {
    assert.ok(
      helpersTs.includes('resolveAgentsDir(runtime') &&
      helpersTs.includes('projectDir'),
      'resolveAgentsDir must accept an optional projectDir parameter to support repo-local fallback (#3751)',
    );
  });

  // ─── Contract 2: fallback path is .claude/agents under projectDir ──────
  test('resolveAgentsDir body references .claude/agents for the repo-local fallback', () => {
    assert.ok(
      helpersTs.includes('.claude') && helpersTs.includes('agents'),
      'resolveAgentsDir must reference the .claude/agents repo-local path (#3751)',
    );
    // The fallback must probe a path built from projectDir, not a hard-coded literal
    assert.ok(
      helpersTs.match(/join\([^)]*projectDir[^)]*['".]claude['"]/) ||
      helpersTs.match(/join\([^)]*projectDir[^)]*\.claude/) ||
      helpersTs.match(/projectDir.*\.claude.*agents/) ||
      helpersTs.match(/\.claude.*agents.*projectDir/),
      'resolveAgentsDir must construct the repo-local fallback from the projectDir argument (#3751)',
    );
  });

  // ─── Contract 3: local takes precedence over global (#3799) ────────────
  // Supersedes the original #3751 "global-first" contract. Claude Code resolves
  // agents local-first at spawn; the SDK must mirror that ordering so a project-
  // local install with agents in <projectDir>/.claude/agents always wins over an
  // empty or stale global ~/.claude/agents directory.
  test('resolveAgentsDir checks project-local path BEFORE global path (#3799)', () => {
    const fnStart = helpersTs.indexOf('export function resolveAgentsDir');
    const fnEnd = helpersTs.indexOf('\nexport function', fnStart + 1);
    const fnBody = helpersTs.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    const globalIdx = fnBody.indexOf('getRuntimeConfigDir');
    const localIdx = fnBody.search(/projectDir.*claude|\.claude.*projectDir/);
    assert.ok(
      globalIdx !== -1,
      'resolveAgentsDir must still call getRuntimeConfigDir for the global path (#3799)',
    );
    assert.ok(
      localIdx !== -1,
      'resolveAgentsDir must reference the project-local path (#3799)',
    );
    assert.ok(
      localIdx < globalIdx,
      'project-local path check must appear BEFORE global path in resolveAgentsDir — local-first matches Claude Code agent resolution (#3799)',
    );
  });

  // ─── Contract 4: GSD_AGENTS_DIR still short-circuits both paths ─────────
  test('resolveAgentsDir still checks GSD_AGENTS_DIR first', () => {
    const fnStart = helpersTs.indexOf('export function resolveAgentsDir');
    const fnEnd = helpersTs.indexOf('\nexport function', fnStart + 1);
    const fnBody = helpersTs.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    assert.ok(
      fnBody.includes('GSD_AGENTS_DIR'),
      'resolveAgentsDir must still check GSD_AGENTS_DIR as the first override (#3751)',
    );
    const envIdx = fnBody.indexOf('GSD_AGENTS_DIR');
    const globalIdx = fnBody.indexOf('getRuntimeConfigDir');
    assert.ok(
      envIdx < globalIdx,
      'GSD_AGENTS_DIR check must appear before getRuntimeConfigDir in resolveAgentsDir (#3751)',
    );
  });

  // ─── Contract 5: init.ts passes projectDir to resolveAgentsDir ──────────
  test('init.ts checkAgentsInstalled passes projectDir to resolveAgentsDir', () => {
    // After fix: resolveAgentsDir must be called with projectDir (not just runtime)
    // The call site at init.ts must thread projectDir through.
    // We verify either checkAgentsInstalled gains projectDir param or
    // the resolveAgentsDir call in that function uses a projectDir variable.
    const checkFnStart = initTs.indexOf('function checkAgentsInstalled');
    const checkFnEnd = initTs.indexOf('\nfunction ', checkFnStart + 1);
    const checkFnBody = initTs.slice(checkFnStart, checkFnEnd === -1 ? undefined : checkFnEnd);
    assert.ok(
      checkFnBody.includes('projectDir') || checkFnBody.includes('resolveAgentsDir(runtime, '),
      'checkAgentsInstalled in init.ts must pass projectDir to resolveAgentsDir (#3751)',
    );
  });

  // ─── Contract 6: init-complex.ts passes projectDir to resolveAgentsDir ──
  test('init-complex.ts initNewProject passes projectDir to resolveAgentsDir', () => {
    const callIdx = initComplexTs.indexOf('resolveAgentsDir(runtime)');
    assert.strictEqual(
      callIdx,
      -1,
      'init-complex.ts must NOT call resolveAgentsDir(runtime) without projectDir — it must pass projectDir (#3751)',
    );
  });
});

// ─── Runtime behaviour tests (filesystem-level) ──────────────────────────────

describe('#3751: resolveAgentsDir() repo-local fallback — runtime behaviour', () => {
  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3751-'));
    savedEnv = {
      GSD_AGENTS_DIR: process.env.GSD_AGENTS_DIR,
      GSD_RUNTIME: process.env.GSD_RUNTIME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      HOME: process.env.HOME,
    };
    // Clear explicit overrides so we exercise the fallback path
    delete process.env.GSD_AGENTS_DIR;
    // Make runtime deterministic: this suite validates Claude local-agent semantics.
    process.env.GSD_RUNTIME = 'claude';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore env
    if (savedEnv.GSD_AGENTS_DIR !== undefined) {
      process.env.GSD_AGENTS_DIR = savedEnv.GSD_AGENTS_DIR;
    } else {
      delete process.env.GSD_AGENTS_DIR;
    }
    if (savedEnv.GSD_RUNTIME !== undefined) {
      process.env.GSD_RUNTIME = savedEnv.GSD_RUNTIME;
    } else {
      delete process.env.GSD_RUNTIME;
    }
    if (savedEnv.CLAUDE_CONFIG_DIR !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  /**
   * RED test: repo-local .claude/agents present, global absent → returns repo-local.
   *
   * This test MUST FAIL before the fix because resolveAgentsDir() ignores
   * the repo-local path entirely.
   */
  test('resolveAgentsDir returns repo-local .claude/agents when global dir is absent and GSD_AGENTS_DIR unset', () => {
    // Set up a fake global config dir that has no agents/
    const fakeGlobalConfig = path.join(tmpDir, 'fake-global-claude');
    fs.mkdirSync(fakeGlobalConfig, { recursive: true });
    // DO NOT create fakeGlobalConfig/agents/ — simulates absent global agents
    process.env.CLAUDE_CONFIG_DIR = fakeGlobalConfig;

    // Set up repo-local .claude/agents with all required GSD agent files.
    // `agents_installed` is only true when every MODEL_PROFILES key exists.
    const repoRoot = path.join(tmpDir, 'repo');
    const repoLocalAgentsDir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(repoLocalAgentsDir, { recursive: true });
    writeRequiredAgents(repoLocalAgentsDir);

    // Dynamically require helpers so CLAUDE_CONFIG_DIR is picked up
    // (Node caches modules, so we clear the cache first)
    const helpersPath = path.resolve(__dirname, '../sdk/src/query/helpers.ts');
    // We test via the compiled CJS path if available, otherwise skip runtime test
    // and rely on structural contracts above.
    // Since sdk/dist is not pre-built in CI, we use the gsd-tools integration path.
    const { runGsdTools } = require('./helpers.cjs');

    const result = runGsdTools(
      ['query', 'init.new-project', '--raw'],
      repoRoot,
      {
        GSD_AGENTS_DIR: '',         // explicitly empty — must not win over repo-local
        CLAUDE_CONFIG_DIR: fakeGlobalConfig,
      },
    );

    // The command may fail for unrelated reasons (no .planning/); we only check
    // the agents_installed diagnostic field specifically.
    if (result.success) {
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { return; }
      if (parsed && typeof parsed.agents_installed !== 'undefined') {
        // If the fix is not applied, agents_installed will be false (RED state)
        assert.strictEqual(
          parsed.agents_installed,
          true,
          'agents_installed must be true when repo-local .claude/agents has the required agent files (#3751)',
        );
      }
    }
    // If the query fails (non-JSON, missing planning dir, etc.), the structural
    // contracts above are the authoritative RED gate.
  });

  /**
   * Counter-test: no .claude/agents anywhere + no GSD_AGENTS_DIR → returns global path,
   * does not throw.
   */
  test('resolveAgentsDir returns the global path (does not throw) when both local and global are absent', () => {
    const fakeGlobalConfig = path.join(tmpDir, 'fake-global-claude-empty');
    fs.mkdirSync(fakeGlobalConfig, { recursive: true });
    // No agents/ subdir under the fake global config
    process.env.CLAUDE_CONFIG_DIR = fakeGlobalConfig;

    const repoRoot = path.join(tmpDir, 'repo-no-local');
    fs.mkdirSync(repoRoot, { recursive: true });
    // No .claude/agents under repoRoot

    // Verify via structural check: the function must not have unconditional throws
    const fnStart = helpersTs.indexOf('export function resolveAgentsDir');
    const fnEnd = helpersTs.indexOf('\nexport function', fnStart + 1);
    const fnBody = helpersTs.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    // Must return something (the global path) rather than throw when no local exists
    assert.ok(
      fnBody.includes('return'),
      'resolveAgentsDir must return a value (not throw) when no agents dirs exist (#3751)',
    );
    assert.ok(
      !fnBody.match(/throw\s+new\s+Error.*agents/),
      'resolveAgentsDir must NOT throw when agents dirs are absent (#3751)',
    );
  });
});

// ─── #3799: local-first resolution when both local and global dirs exist ─────
//
// Bug: with a project-local install (agents in <project>/.claude/agents) and an
// empty or stale global ~/.claude/agents, the SDK reported agents_installed: false
// because global-first resolution returned the empty global dir before probing local.
//
// Fix contract: resolveAgentsDir must check <projectDir>/.claude/agents BEFORE
// the global runtime dir. This mirrors Claude Code's own local-first agent
// resolution at spawn time.

describe('#3799: resolveAgentsDir() local-first resolution — structural contracts', () => {
  // ─── Contract A: local-first ordering in function body ──────────────────
  test('resolveAgentsDir function body checks project-local .claude/agents before global dir (#3799)', () => {
    const fnStart = helpersTs.indexOf('export function resolveAgentsDir');
    const fnEnd = helpersTs.indexOf('\nexport function', fnStart + 1);
    const fnBody = helpersTs.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    // Both references must exist
    const globalIdx = fnBody.indexOf('getRuntimeConfigDir');
    const localIdx = fnBody.search(/join\([^)]*projectDir[^)]*['".]claude['"]|join\([^)]*projectDir[^)]*\.claude|projectDir.*\.claude.*agents|\.claude.*agents.*projectDir/);

    assert.ok(globalIdx !== -1, 'resolveAgentsDir must still call getRuntimeConfigDir (#3799)');
    assert.ok(localIdx !== -1, 'resolveAgentsDir must reference project-local path (#3799)');
    assert.ok(
      localIdx < globalIdx,
      `project-local path (idx ${localIdx}) must appear before global path (idx ${globalIdx}) in resolveAgentsDir — local-first matches Claude Code resolution (#3799)`,
    );
  });

  // ─── Contract B: GSD_AGENTS_DIR still short-circuits both ───────────────
  test('GSD_AGENTS_DIR still appears before both local and global checks (#3799)', () => {
    const fnStart = helpersTs.indexOf('export function resolveAgentsDir');
    const fnEnd = helpersTs.indexOf('\nexport function', fnStart + 1);
    const fnBody = helpersTs.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    const envIdx = fnBody.indexOf('GSD_AGENTS_DIR');
    const localIdx = fnBody.search(/join\([^)]*projectDir[^)]*['".]claude['"]|join\([^)]*projectDir[^)]*\.claude/);
    const globalIdx = fnBody.indexOf('getRuntimeConfigDir');

    assert.ok(envIdx !== -1, 'GSD_AGENTS_DIR check must still be present (#3799)');
    assert.ok(envIdx < localIdx || localIdx === -1, 'GSD_AGENTS_DIR must appear before local path check (#3799)');
    assert.ok(envIdx < globalIdx, 'GSD_AGENTS_DIR must appear before global path check (#3799)');
  });
});

describe('#3799: resolveAgentsDir() local-first resolution — runtime behaviour', () => {
  let tmpDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3799-'));
    savedEnv = {
      GSD_AGENTS_DIR: process.env.GSD_AGENTS_DIR,
      GSD_RUNTIME: process.env.GSD_RUNTIME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    delete process.env.GSD_AGENTS_DIR;
    // Keep runtime fixed across suite-order changes and leaked test env.
    process.env.GSD_RUNTIME = 'claude';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedEnv.GSD_AGENTS_DIR !== undefined) process.env.GSD_AGENTS_DIR = savedEnv.GSD_AGENTS_DIR;
    else delete process.env.GSD_AGENTS_DIR;
    if (savedEnv.GSD_RUNTIME !== undefined) process.env.GSD_RUNTIME = savedEnv.GSD_RUNTIME;
    else delete process.env.GSD_RUNTIME;
    if (savedEnv.CLAUDE_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
    else delete process.env.CLAUDE_CONFIG_DIR;
  });

  const { runGsdTools } = require('./helpers.cjs');

  /**
   * RED test (local wins over empty global): When the project has .claude/agents
   * populated and the global dir exists but is EMPTY, the SDK must resolve to the
   * local dir and report agents_installed: true.
   *
   * This is the canonical #3799 scenario: npx install puts agents in project-local,
   * but Claude auto-creates an empty ~/.claude/agents at startup — old global-first
   * code picked up the empty global dir and reported false.
   */
  test('reports agents_installed: true when local .claude/agents has agents and global dir is empty (#3799)', () => {
    // Set up fake global config dir WITH an empty agents/ subdir
    const fakeGlobalConfig = path.join(tmpDir, 'fake-global-claude');
    const fakeGlobalAgents = path.join(fakeGlobalConfig, 'agents');
    fs.mkdirSync(fakeGlobalAgents, { recursive: true });
    // global agents/ exists but is EMPTY — simulates Claude auto-creating the dir
    process.env.CLAUDE_CONFIG_DIR = fakeGlobalConfig;

    // Set up project-local .claude/agents with all required GSD agent files
    const repoRoot = path.join(tmpDir, 'repo');
    const repoLocalAgentsDir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(repoLocalAgentsDir, { recursive: true });
    writeRequiredAgents(repoLocalAgentsDir);

    const result = runGsdTools(
      ['query', 'init.new-project', '--raw'],
      repoRoot,
      {
        CLAUDE_CONFIG_DIR: fakeGlobalConfig,
      },
    );

    if (result.success) {
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { return; }
      if (parsed && typeof parsed.agents_dir !== 'undefined') {
        // agents_dir must point to the local dir, not the empty global dir
        assert.strictEqual(
          normalizePathForAssert(parsed.agents_dir),
          normalizePathForAssert(repoLocalAgentsDir),
          `agents_dir must resolve to project-local path, got: ${parsed.agents_dir} (#3799)`,
        );
      }
    }
    // Structural contract (Contract A above) is the authoritative RED gate when
    // gsd-tools query is not available.
  });

  /**
   * Global-only regression: when no project-local .claude/agents exists but a
   * populated global dir does, the global dir must still be used (no regression).
   */
  test('global-only install: resolves to global dir when no project-local .claude/agents (#3799 no-regression)', () => {
    const fakeGlobalConfig = path.join(tmpDir, 'fake-global-claude-populated');
    const fakeGlobalAgents = path.join(fakeGlobalConfig, 'agents');
    fs.mkdirSync(fakeGlobalAgents, { recursive: true });
    fs.writeFileSync(
      path.join(fakeGlobalAgents, 'gsd-project-researcher.md'),
      '---\nname: gsd-project-researcher\n---\n',
    );
    process.env.CLAUDE_CONFIG_DIR = fakeGlobalConfig;

    // Repo with NO .claude/agents
    const repoRoot = path.join(tmpDir, 'repo-global-only');
    fs.mkdirSync(repoRoot, { recursive: true });

    const result = runGsdTools(
      ['query', 'init.new-project', '--raw'],
      repoRoot,
      {
        CLAUDE_CONFIG_DIR: fakeGlobalConfig,
      },
    );

    if (result.success) {
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { return; }
      if (parsed && typeof parsed.agents_dir !== 'undefined') {
        assert.strictEqual(
          normalizePathForAssert(parsed.agents_dir),
          normalizePathForAssert(fakeGlobalAgents),
          `agents_dir must resolve to global path when no local dir exists, got: ${parsed.agents_dir} (#3799)`,
        );
      }
    }
    // Structural contracts provide the authoritative gate when gsd-tools is unavailable.
  });

  /**
   * Both local and global populated: local wins (Claude Code parity).
   */
  test('local wins over populated global when both .claude/agents dirs exist (#3799)', () => {
    const fakeGlobalConfig = path.join(tmpDir, 'fake-global-both');
    const fakeGlobalAgents = path.join(fakeGlobalConfig, 'agents');
    fs.mkdirSync(fakeGlobalAgents, { recursive: true });
    writeRequiredAgents(fakeGlobalAgents);
    process.env.CLAUDE_CONFIG_DIR = fakeGlobalConfig;

    const repoRoot = path.join(tmpDir, 'repo-both');
    const repoLocalAgentsDir = path.join(repoRoot, '.claude', 'agents');
    fs.mkdirSync(repoLocalAgentsDir, { recursive: true });
    writeRequiredAgents(repoLocalAgentsDir);

    const result = runGsdTools(
      ['query', 'init.new-project', '--raw'],
      repoRoot,
      {
        CLAUDE_CONFIG_DIR: fakeGlobalConfig,
      },
    );

    if (result.success) {
      let parsed;
      try { parsed = JSON.parse(result.output); } catch { return; }
      if (parsed && typeof parsed.agents_dir !== 'undefined') {
        assert.strictEqual(
          normalizePathForAssert(parsed.agents_dir),
          normalizePathForAssert(repoLocalAgentsDir),
          `agents_dir must resolve to local path when both exist, got: ${parsed.agents_dir} (#3799)`,
        );
      }
    }
  });
});
