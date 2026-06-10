// allow-test-rule: integration-test-input
// Exercises install() as a black-box by inspecting produced SKILL.md output
// in a temp dir. Source command .md files are inputs whose installed
// transformation is asserted — not inspected for string presence.

/**
 * #769 — effort: frontmatter on heavy workflow skills.
 * #921 — spawning orchestrators must NOT carry context: fork.
 *
 * Context: context:fork was added by #769 to protect context budget, but
 * plan-phase, execute-phase, and autonomous are spawning orchestrators — a
 * forked subagent has no Agent/Task tool, breaking their core function.
 * effort: xhigh is preserved; context: fork is removed from these three.
 * The converter still passes context: fork through if a source file has it
 * (for any future leaf skill that legitimately needs isolation).
 *
 * Verifies:
 *   1. Source commands/gsd/autonomous.md does NOT have context: fork, has effort: xhigh
 *   2. Source commands/gsd/execute-phase.md does NOT have context: fork, has effort: xhigh
 *   3. Source commands/gsd/plan-phase.md does NOT have context: fork, has effort: xhigh
 *   4. Source commands/gsd/progress.md has effort: low
 *   5. Source commands/gsd/stats.md has effort: low
 *   6. Claude global install: SKILL.md for autonomous has effort: xhigh, NOT context: fork
 *   7. Claude global install: SKILL.md for execute-phase has effort: xhigh, NOT context: fork
 *   8. Claude global install: SKILL.md for plan-phase has effort: xhigh, NOT context: fork
 *   9. Claude global install: SKILL.md for progress has effort: low
 *  10. Claude global install: SKILL.md for stats has effort: low
 *  11. convertClaudeCommandToClaudeSkill still passes context: fork through (for non-orchestrator skills)
 *  12. convertClaudeCommandToClaudeSkill preserves effort: field
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install, convertClaudeCommandToClaudeSkill } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// #924: Claude global install is now FLAT — concrete skills are at the top level.
// flatSkillPath returns: <skillsRoot>/gsd-<stem>/SKILL.md
function flatSkillPath(skillsRoot, stem) {
  return path.join(skillsRoot, `gsd-${stem}`, 'SKILL.md');
}

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_COMMANDS_DIR = path.join(REPO_ROOT, 'commands', 'gsd');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for Claude, redirecting its home dir to tmpHome.
 * Returns the tmpHome for inspection.
 */
function runClaudeGlobalInstall(claudeHome) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-769-home-'));

  const prevCwd = process.cwd();
  const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, 'claude');
  } finally {
    process.chdir(prevCwd);
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }

  return claudeHome;
}

// ─── describe 1: Source command files have correct frontmatter ────────────────

// #921/#922: spawning orchestrators must NOT carry context: fork — a forked
// subagent has no Agent/Task tool, making it impossible for orchestrators to
// spawn their required subagents. context: fork is appropriate only for leaf
// skills that do not themselves dispatch agents. effort: xhigh is preserved.
describe('#769/#921 source commands: spawning orchestrators have effort: xhigh but NOT context: fork', () => {
  test('commands/gsd/autonomous.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `autonomous.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/autonomous.md has effort: xhigh', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `autonomous.md frontmatter must have effort: xhigh\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `execute-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md has effort: xhigh', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `execute-phase.md frontmatter must have effort: xhigh\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `plan-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md has effort: xhigh', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `plan-phase.md frontmatter must have effort: xhigh\nActual:\n${fm}`);
  });
});

describe('#769 source commands: quick-status skills have effort: low', () => {
  test('commands/gsd/progress.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'progress.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `progress.md frontmatter must have effort: low\nActual:\n${fm}`);
  });

  test('commands/gsd/stats.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'stats.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `stats.md frontmatter must have effort: low\nActual:\n${fm}`);
  });
});

// ─── describe 2: convertClaudeCommandToClaudeSkill preserves new fields ───────

describe('#769 convertClaudeCommandToClaudeSkill: preserves context and effort fields', () => {
  test('preserves context: fork in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^context:[ \t]*fork$/m,
      `SKILL.md frontmatter must include context: fork\nActual frontmatter:\n${fm}`);
  });

  test('preserves effort: xhigh in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `SKILL.md frontmatter must include effort: xhigh\nActual frontmatter:\n${fm}`);
  });

  test('preserves effort: low in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-light',
      'description: Test light skill',
      'effort: low',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Light skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-light');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*low$/m,
      `SKILL.md frontmatter must include effort: low\nActual frontmatter:\n${fm}`);
  });

  test('does NOT emit context: or effort: when absent from source', () => {
    const input = [
      '---',
      'name: gsd:test-plain',
      'description: Plain skill without context or effort',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Plain skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-plain');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.doesNotMatch(fm, /^context:/m,
      `SKILL.md must not emit context: when absent from source\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:/m,
      `SKILL.md must not emit effort: when absent from source\nActual:\n${fm}`);
  });
});

// ─── describe 3: Claude global install — SKILL.md files include new fields ────

// #921/#922: after install, spawning orchestrators must NOT carry context: fork
// in their emitted SKILL.md. effort: xhigh is still emitted (preserved from source).
describe('#769/#921 Claude global install: spawning-orchestrator SKILL.md files have effort: xhigh but NOT context: fork', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-769-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-autonomous SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-autonomous is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-autonomous SKILL.md has effort: xhigh after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-autonomous SKILL.md must have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-execute-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md has effort: xhigh after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-execute-phase SKILL.md must have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-plan-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md has effort: xhigh after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-plan-phase SKILL.md must have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-progress SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'progress');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-progress SKILL.md must have effort: low\nActual:\n${fm}`);
  });

  test('gsd-stats SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'stats');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-stats SKILL.md must have effort: low\nActual:\n${fm}`);
  });
});
