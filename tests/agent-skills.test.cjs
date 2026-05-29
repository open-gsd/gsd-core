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
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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
    fs.rmSync(fakeHome, { recursive: true, force: true });
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
