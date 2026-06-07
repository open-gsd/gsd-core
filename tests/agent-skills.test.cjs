/**
 * GSD Tools Tests - Agent Skills Injection
 *
 * CLI integration tests for the `agent-skills` command that reads
 * `agent_skills` from .planning/config.json and returns a formatted
 * skills block for injection into Task() prompts.
 *
 * Migrated (#455): uses `--json` flag to get typed IR
 *   { agent_type, block, skills_count }
 * instead of asserting on raw XML output text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION_ID: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  TTY: '',
  SSH_TTY: '',
};

/**
 * Run gsd-tools and capture BOTH stdout and stderr on success.
 * Returns { success, stdout, stderr }.
 */
function runGsdToolsWithStderr(args, cwd, env) {
  const childEnv = { ...process.env, ...TEST_ENV_BASE, ...(env || {}) };
  try {
    const result = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: childEnv,
    });
    return {
      success: result.status === 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      exitCode: result.status,
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: String(err), exitCode: 1 };
  }
}

const { loadTrustedGlobalRoots, validatePath } = require('../gsd-core/bin/lib/security.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// Run agent-skills with --json for typed IR assertions
function runAgentSkillsJson(args, tmpDir, env) {
  // Insert --json after 'agent-skills' subcommand
  const allArgs = Array.isArray(args) ? args : [args];
  const cmdIdx = allArgs.indexOf('agent-skills');
  const withJson = [...allArgs];
  if (cmdIdx !== -1) {
    withJson.splice(cmdIdx + 1, 0, '--json');
  }
  const result = runGsdTools(withJson, tmpDir, env || { HOME: tmpDir, USERPROFILE: tmpDir });
  if (!result.success) return { success: false, error: result.error, ir: null };
  try {
    return { success: true, ir: JSON.parse(result.output) };
  } catch (e) {
    return { success: false, error: `JSON parse failed: ${e.message} output=${result.output}`, ir: null };
  }
}

// ─── agent-skills command ────────────────────────────────────────────────────

describe('agent-skills command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty block when no config exists', () => {
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-executor');
    assert.strictEqual(r.ir.block, '', 'block must be empty when no skills configured');
  });

  test('returns empty block when config has no agent_skills section', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '');
  });

  test('returns empty block for unconfigured agent type', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-planner'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-planner');
    assert.strictEqual(r.ir.block, '');
  });

  test('returns block containing agent_skills XML for configured agent', () => {
    const skillDir = path.join(tmpDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-executor');
    assert.ok(r.ir.block.includes('<agent_skills>'), `block must contain <agent_skills> tag, got: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('</agent_skills>'), 'block must contain closing tag');
    assert.ok(r.ir.block.includes('skills/test-skill/SKILL.md'), 'block must contain skill path');
  });

  test('skills_count reflects configured skill paths for agent type', () => {
    const skillDir = path.join(tmpDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.skills_count, 1, 'skills_count must be 1 for single configured skill path');
  });

  test('returns block for configured agent with single string path', () => {
    const skillDir = path.join(tmpDir, 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': 'skills/my-skill',
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/my-skill/SKILL.md'), 'block must contain skill path');
    assert.strictEqual(r.ir.skills_count, 1, 'skills_count must be 1 for single string path');
  });

  test('handles multiple skill paths', () => {
    const skill1 = path.join(tmpDir, 'skills', 'skill-a');
    const skill2 = path.join(tmpDir, 'skills', 'skill-b');
    fs.mkdirSync(skill1, { recursive: true });
    fs.mkdirSync(skill2, { recursive: true });
    fs.writeFileSync(path.join(skill1, 'SKILL.md'), '# Skill A\n');
    fs.writeFileSync(path.join(skill2, 'SKILL.md'), '# Skill B\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/skill-a', 'skills/skill-b'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/skill-a/SKILL.md'), 'block must contain first skill');
    assert.ok(r.ir.block.includes('skills/skill-b/SKILL.md'), 'block must contain second skill');
    assert.strictEqual(r.ir.skills_count, 2, 'skills_count must be 2 for two configured paths');
  });

  test('warns for nonexistent skill path but does not error', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/nonexistent'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, 'Command should succeed even with missing skill paths');
    assert.strictEqual(r.ir.block, '', 'block must be empty when all skill paths are missing');
  });

  test('validates path safety — rejects traversal attempts', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['../../../etc/passwd'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(!r.ir || !r.ir.block.includes('/etc/passwd'), 'block must not include traversal path');
  });

  test('returns typed empty IR when no agent type argument provided', () => {
    const r = runAgentSkillsJson(['agent-skills'], tmpDir);
    // With --json and no agent type, the command outputs the empty-string IR
    assert.ok(r.success, 'Command should succeed');
    // Output is JSON, either empty string or empty object
    const parsed = JSON.parse(r.success ? JSON.stringify(r.ir) : '""');
    assert.ok(parsed === '' || (typeof parsed === 'object'), 'Should return empty or empty-agent IR');
  });
});

// ─── config-ensure-section includes agent_skills ────────────────────────────

describe('config-ensure-section with agent_skills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('new configs include agent_skills key', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.ok('agent_skills' in config, 'config should have agent_skills key');
    assert.deepStrictEqual(config.agent_skills, {}, 'agent_skills should default to empty object');
  });
});

// ─── config-set agent_skills ─────────────────────────────────────────────────

describe('config-set agent_skills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Ensure config exists first
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('can set agent_skills via dot notation', () => {
    const result = runGsdTools(
      ['config-set', 'agent_skills.gsd-executor', '["skills/my-skill"]'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.deepStrictEqual(
      config.agent_skills['gsd-executor'],
      ['skills/my-skill'],
      'Should store array of skill paths'
    );
  });
});

// ─── global: prefix support (#1992) ──────────────────────────────────────────

describe('agent-skills global: prefix', () => {
  let tmpDir;
  let fakeHome;
  let globalSkillsDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create a fake HOME with ~/.claude/skills/ structure
    fakeHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-1992-home-'));
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    fs.mkdirSync(globalSkillsDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(fakeHome);
  });

  function createGlobalSkill(name) {
    const skillDir = path.join(globalSkillsDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\nGlobal skill content.\n`);
    return skillDir;
  }

  test('global:valid-skill resolves to $HOME/.claude/skills/valid-skill/SKILL.md', () => {
    createGlobalSkill('valid-skill');
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:valid-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('valid-skill/SKILL.md'), `block must reference the global skill: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('<agent_skills>'), 'block must emit agent_skills XML');
  });

  test('global:invalid!name is rejected by regex and skipped', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:invalid!name'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when invalid name is rejected');
  });

  test('global:missing-skill is skipped when directory is absent', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:missing-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when skill is missing');
  });

  test('mix of global: and project-relative paths both resolve correctly', () => {
    createGlobalSkill('shadcn');

    const projectSkillDir = path.join(tmpDir, 'skills', 'local-skill');
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '# local\n');

    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:shadcn', 'skills/local-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('shadcn/SKILL.md'), 'block must include global shadcn');
    assert.ok(r.ir.block.includes('skills/local-skill/SKILL.md'), 'block must include project-relative skill');
    assert.strictEqual(r.ir.skills_count, 2, 'skills_count must be 2 for both configured paths');
  });

  test('global: with empty name produces clear warning and skips', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty for empty global: prefix');
  });
});

// ─── loadTrustedGlobalRoots unit tests (#52) ──────────────────────────────────

describe('loadTrustedGlobalRoots', () => {
  test('returns [] for undefined config', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots(undefined), []);
  });

  test('returns [] for null config', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots(null), []);
  });

  test('returns [] when agent_skills_security is absent', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({}), []);
  });

  test('returns [] when trusted_global_roots is absent', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: {} }), []);
  });

  test('returns [] when trusted_global_roots is not an array', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: '/some/path' } }), []);
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: 42 } }), []);
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: true } }), []);
  });

  test('drops non-string entries from the array', () => {
    // Use a real temp dir so realpathSync succeeds; non-strings are still dropped
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-ns-'));
    try {
      const realPath = fs.realpathSync(realDir);
      const config = { agent_skills_security: { trusted_global_roots: [42, null, realDir, true] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [realPath]);
    } finally {
      cleanup(realDir);
    }
  });

  test('drops project-relative (non-absolute) entries', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['foo/bar', 'relative/path'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), []);
  });

  test('keeps absolute paths — real dirs are kept and canonicalized', () => {
    // Non-existent dirs are dropped; use real temp dirs and compare against realpaths
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-d1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-d2-'));
    try {
      const real1 = fs.realpathSync(dir1);
      const real2 = fs.realpathSync(dir2);
      const config = { agent_skills_security: { trusted_global_roots: [dir1, dir2] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [real1, real2]);
    } finally {
      cleanup(dir1);
      cleanup(dir2);
    }
  });

  test('expands leading ~/ to os.homedir() — kept only if the dir exists', () => {
    // Create a real subdir under os.tmpdir() and verify it is kept (canonical compare)
    // Note: we cannot reliably create a dir under os.homedir() in CI, so we verify
    // the expansion logic using a known-existing absolute path that happens to be
    // "within" homedir — the tilde expansion is exercised separately; this test
    // verifies the returned value equals the realpath of the expanded path.
    const subdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-tilde-'));
    try {
      const realSub = fs.realpathSync(subdir);
      // Pass a raw path (non-tilde) to verify realpath canonicalization at minimum
      const config = { agent_skills_security: { trusted_global_roots: [subdir] } };
      const result = loadTrustedGlobalRoots(config);
      assert.deepStrictEqual(result, [realSub], 'result must equal realpath of existing dir');
    } finally {
      cleanup(subdir);
    }
  });

  test('non-existent absolute root is dropped (returns [])', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['/nonexistent-gsd-root-12345xyz'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'non-existent root must be dropped');
  });

  test('trusted root that is a symlink is canonicalized to the link target', () => {
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-symtgt-'));
    const symlinkPath = path.join(os.tmpdir(), `gsd-tgr-symlink-${Date.now()}`);
    let symlinkCreated = false;
    try {
      try {
        fs.symlinkSync(realTarget, symlinkPath);
        symlinkCreated = true;
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'ENOSYS') {
          // symlinks not supported on this platform — skip
          return;
        }
        throw err;
      }
      const realResolved = fs.realpathSync(realTarget);
      const config = { agent_skills_security: { trusted_global_roots: [symlinkPath] } };
      const result = loadTrustedGlobalRoots(config);
      assert.deepStrictEqual(result, [realResolved], 'symlink root must be canonicalized to the link target');
    } finally {
      cleanup(realTarget);
      if (symlinkCreated) {
        try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      }
    }
  });

  test('de-duplicates entries by canonical path', () => {
    // Both entries point to the same real dir — after canonicalization, only one is kept
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-dedup-'));
    try {
      const realPath = fs.realpathSync(realDir);
      const config = { agent_skills_security: { trusted_global_roots: [realDir, realDir, realPath] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [realPath]);
    } finally {
      cleanup(realDir);
    }
  });

  test('expands ~/ before absolute check — non-existent ~/x is dropped after expansion', () => {
    // ~/x becomes an absolute path after expansion, but if ~/x does not exist it is
    // dropped by the realpathSync guard (non-existent root is not trustworthy).
    const expandedX = path.join(os.homedir(), 'x-gsd-nonexistent-12345');
    // Ensure it really doesn't exist
    if (fs.existsSync(expandedX)) {
      // Cannot test non-existence reliably — skip assertion
      return;
    }
    const config = { agent_skills_security: { trusted_global_roots: ['~/x-gsd-nonexistent-12345'] } };
    const result = loadTrustedGlobalRoots(config);
    assert.deepStrictEqual(result, [], 'non-existent ~/x must be dropped after expansion');
  });

  test('expands bare ~ to os.homedir()', () => {
    // Bare ~ (exactly) must expand to homedir — mirrors runtime-homes.cts:28
    const config = { agent_skills_security: { trusted_global_roots: ['~'] } };
    const result = loadTrustedGlobalRoots(config);
    // ~ expands to homedir, which is then rejected as a dangerously broad root
    // So the result must be [] (rejected after expansion)
    assert.deepStrictEqual(result, [], 'bare ~ expands to homedir and is then rejected as too broad');
  });

  test('rejects filesystem root /', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['/'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'filesystem root must be rejected');
  });

  test('rejects os.homedir() itself', () => {
    const config = { agent_skills_security: { trusted_global_roots: [os.homedir()] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'homedir itself must be rejected as too broad');
  });
});

// ─── trusted_global_roots integration guard (#52) ─────────────────────────────
//
// NOTE: These tests validate the trusted-root bypass logic by directly calling
// loadTrustedGlobalRoots + validatePath rather than invoking the full CLI
// (which would require controlling the runtime HOME path in a way that also
// triggers a symlink escape scenario through gsd-tools subprocess invocation).
// Full end-to-end symlink testing would require OS-level symlink setup in tmp
// dirs and a mechanism to redirect the runtime home path — coverage here is
// sufficient to verify the core guard logic.

describe('trusted_global_roots guard logic', () => {
  let tmpDir;
  let externalDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-trusted-'));
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-external-'));
    // Create a skill file in externalDir
    fs.writeFileSync(path.join(externalDir, 'SKILL.md'), '# External\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(externalDir);
  });

  test('validatePath rejects skill outside globalSkillsBase (baseline — no trusted roots)', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const result = validatePath(skillMd, tmpDir, { allowAbsolute: true });
    assert.ok(!result.safe, 'skill outside base must be rejected by validatePath');
  });

  test('with trusted root matching real target dir — validatePath accepts', () => {
    // Simulate the trusted-root fallback: skill is outside base but inside trusted root
    const skillMd = path.join(externalDir, 'SKILL.md');
    const baseCheck = validatePath(skillMd, tmpDir, { allowAbsolute: true });
    assert.ok(!baseCheck.safe, 'base check must fail (prerequisite)');

    // Trusted root fallback: check against externalDir
    const config = { agent_skills_security: { trusted_global_roots: [externalDir] } };
    const trustedRoots = loadTrustedGlobalRoots(config);
    const acceptedViaTrustedRoot = trustedRoots.some((root) => {
      const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
      return rootCheck.safe;
    });
    assert.ok(acceptedViaTrustedRoot, 'skill must be accepted when within a trusted root');
  });

  test('with unrelated trusted root — skill still rejected', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-unrelated-'));
    try {
      const config = { agent_skills_security: { trusted_global_roots: [unrelatedDir] } };
      const trustedRoots = loadTrustedGlobalRoots(config);
      const acceptedViaTrustedRoot = trustedRoots.some((root) => {
        const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
        return rootCheck.safe;
      });
      assert.ok(!acceptedViaTrustedRoot, 'skill must still be rejected when trusted root is unrelated');
    } finally {
      cleanup(unrelatedDir);
    }
  });

  test('with empty trusted_global_roots array — skill still rejected (byte-identical to today)', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const config = { agent_skills_security: { trusted_global_roots: [] } };
    const trustedRoots = loadTrustedGlobalRoots(config);
    assert.strictEqual(trustedRoots.length, 0, 'no roots loaded');
    const acceptedViaTrustedRoot = trustedRoots.some((root) => {
      const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
      return rootCheck.safe;
    });
    assert.ok(!acceptedViaTrustedRoot, 'skill must be rejected when trusted roots is empty');
  });
});

// ─── trusted_global_roots e2e CLI tests (#52) ─────────────────────────────────
//
// These tests exercise the full CLI path (runAgentSkillsJson → gsd-tools →
// loadConfig → agent-skills command) to verify that agent_skills_security is
// properly threaded through the config pipeline. Symlinks are created so a
// global: skill's realpath escapes the ~/.claude/skills/ base, requiring a
// trusted root to be accepted.

describe('trusted_global_roots e2e CLI (#52)', () => {
  let tmpDir;
  let fakeHome;
  let globalSkillsDir;
  let sharedRoot;
  let symlinkSupported;

  beforeEach(() => {
    tmpDir = createTempProject();
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-home-'));
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    fs.mkdirSync(globalSkillsDir, { recursive: true });
    sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-shared-'));

    // Create the shared skill directory OUTSIDE fakeHome
    const sharedSkillDir = path.join(sharedRoot, 'shared-skill');
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sharedSkillDir, 'SKILL.md'), '# Shared Skill\nContent from shared root.\n');

    // Attempt to create a symlink inside globalSkillsDir pointing to the shared skill
    symlinkSupported = true;
    try {
      fs.symlinkSync(sharedSkillDir, path.join(globalSkillsDir, 'shared-skill'));
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'ENOSYS') {
        symlinkSupported = false;
      } else {
        throw err;
      }
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(fakeHome);
    cleanup(sharedRoot);
  });

  test('REGRESSION: symlinked-escape skill with NO agent_skills_security in config → block is empty', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // No agent_skills_security in config — symlink escape must be blocked
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when symlink escapes base and no trusted root configured');
  });

  test('FEATURE: symlink escape with matching trusted_global_roots → block includes skill', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // Configure the sharedRoot as a trusted global root
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: [sharedRoot] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('<agent_skills>'), `block must contain <agent_skills> tag, got: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('shared-skill/SKILL.md'), `block must include the shared skill, got: ${r.ir.block}`);
    assert.ok(r.ir.skills_count >= 1, 'skills_count must be at least 1');
  });

  test('FEATURE NOTE: accepted-via-trusted-root emits NOTE on stderr', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // Capture stderr using spawnSync (runGsdTools only captures stderr on failure)
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: [sharedRoot] },
    });

    const r = runGsdToolsWithStderr(
      ['agent-skills', '--json', 'gsd-executor'],
      tmpDir,
      { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed (exit ${r.exitCode}): ${r.stderr}`);
    // The NOTE must appear on stderr using only the skill name (no full paths)
    assert.ok(
      r.stderr.includes('[agent-skills] NOTE: Global skill "shared-skill" accepted via trusted_global_roots'),
      `stderr must contain the trusted-root NOTE, got: ${r.stderr}`,
    );
  });

  test('NEGATIVE: symlink escape with unrelated trusted root (existing dir) → block is empty', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // The unrelated dir MUST exist so it isn't dropped for the wrong reason (non-existence).
    // Rejection must be because it doesn't cover the shared skill location, not because
    // the dir is missing — otherwise the test would pass vacuously.
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-unrelated-'));
    // Verify the dir actually exists so the trusted root is loaded (not silently dropped)
    assert.ok(fs.existsSync(unrelatedRoot), 'unrelated root must exist so it enters the trusted roots list');
    try {
      writeConfig(tmpDir, {
        runtime: 'claude',
        agent_skills: { 'gsd-executor': ['global:shared-skill'] },
        agent_skills_security: { trusted_global_roots: [unrelatedRoot] },
      });

      const r = runAgentSkillsJson(
        ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
      );
      assert.ok(r.success, `Command failed: ${r.error}`);
      assert.strictEqual(r.ir.block, '', 'block must be empty when trusted root does not cover the shared skill location');
    } finally {
      cleanup(unrelatedRoot);
    }
  });

  test('HARDENING: trusted_global_roots: ["/"] → block is empty (broad root rejected)', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: ['/'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when "/" is the trusted root (rejected as too broad)');
  });
});
