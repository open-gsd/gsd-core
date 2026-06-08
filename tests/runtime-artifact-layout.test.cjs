'use strict';
/**
 * Consolidated tests for the Runtime Artifact Layout Module (ADR-3660) — layout seam.
 *
 * Covers:
 *   - resolveRuntimeArtifactLayout — structural shape per runtime
 *   - resolveRuntimeArtifactLayout edge-cases (error paths, invalid input)
 *   - kind.stage() invocations per kind type
 *
 * Sources consolidated (3 files deleted):
 *   tests/runtime-artifact-layout-resolve.test.cjs
 *   tests/runtime-artifact-layout-edge-cases.test.cjs
 *   tests/runtime-artifact-layout-stage.test.cjs
 *
 * See also:
 *   runtime-artifact-layout-surface.test.cjs       — surface seam
 *   runtime-artifact-layout-install-profiles.test.cjs — install-profiles seam
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const FAKE_DIR = '/tmp/fake-config-dir';

// ─── resolveRuntimeArtifactLayout — structural shape ────────────────────────

describe('resolveRuntimeArtifactLayout — claude local', () => {
  test('returns correct layout for claude scope=local', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_DIR, 'local');
    assert.strictEqual(layout.runtime, 'claude');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands/gsd');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    assert.strictEqual(layout.kinds[1].kind, 'agents');
    assert.strictEqual(layout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — claude global', () => {
  test('returns correct layout for claude scope=global', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_DIR, 'global');
    assert.strictEqual(layout.runtime, 'claude');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — cursor', () => {
  test('returns correct layout for cursor — skills + commands kinds (#785)', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'cursor');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have a commands kind (#785 Cursor 1.6 slash commands)');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — gemini', () => {
  test('returns correct layout for gemini', () => {
    const layout = resolveRuntimeArtifactLayout('gemini', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'gemini');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands/gsd');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — codex', () => {
  test('returns correct layout for codex', () => {
    const layout = resolveRuntimeArtifactLayout('codex', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'codex');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — copilot', () => {
  test('returns correct layout for copilot', () => {
    const layout = resolveRuntimeArtifactLayout('copilot', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'copilot');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — antigravity', () => {
  test('returns correct layout for antigravity', () => {
    const layout = resolveRuntimeArtifactLayout('antigravity', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'antigravity');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — windsurf', () => {
  test('returns correct layout for windsurf', () => {
    const layout = resolveRuntimeArtifactLayout('windsurf', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'windsurf');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — augment', () => {
  test('returns correct layout for augment (commands + skills)', () => {
    const layout = resolveRuntimeArtifactLayout('augment', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'augment');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);
    // commands kind first
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    // skills kind second
    assert.strictEqual(layout.kinds[1].kind, 'skills');
    assert.strictEqual(layout.kinds[1].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — trae', () => {
  test('returns correct layout for trae', () => {
    const layout = resolveRuntimeArtifactLayout('trae', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'trae');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — qwen', () => {
  test('returns correct layout for qwen', () => {
    const layout = resolveRuntimeArtifactLayout('qwen', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'qwen');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — hermes', () => {
  test('returns correct layout for hermes', () => {
    const layout = resolveRuntimeArtifactLayout('hermes', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'hermes');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills/gsd');
    assert.strictEqual(layout.kinds[0].prefix, '');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — codebuddy', () => {
  test('returns correct layout for codebuddy (commands + skills — #789)', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'codebuddy');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);
    // commands kind first
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    // skills kind second
    assert.strictEqual(layout.kinds[1].kind, 'skills');
    assert.strictEqual(layout.kinds[1].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — omp', () => {
  test('returns OMP commands, skills, agents, rules, and extensions layout', () => {
    const layout = resolveRuntimeArtifactLayout('omp', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'omp');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.deepStrictEqual(layout.kinds.map(k => k.kind), ['commands', 'skills', 'agents', 'rules', 'extensions']);
    assert.deepStrictEqual(layout.kinds.map(k => k.destSubpath), ['commands', 'skills', 'agents', 'rules', 'extensions']);
    assert.ok(layout.kinds.every(k => k.prefix === 'gsd-'));
    assert.ok(layout.kinds.every(k => typeof k.stage === 'function'));
  });
});

describe('resolveRuntimeArtifactLayout — cline', () => {
  test('returns correct layout for cline global (skills-capable since v3.48.0 — #782)', () => {
    const layout = resolveRuntimeArtifactLayout('cline', FAKE_DIR, 'global');
    assert.strictEqual(layout.runtime, 'cline');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });

  test('cline local: no skills kinds (global-only, #782)', () => {
    const layout = resolveRuntimeArtifactLayout('cline', FAKE_DIR, 'local');
    assert.strictEqual(layout.runtime, 'cline');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 0);
  });
});

describe('resolveRuntimeArtifactLayout — opencode', () => {
  test('returns commands + skills layout for opencode (#784)', () => {
    const layout = resolveRuntimeArtifactLayout('opencode', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'opencode');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const commands = layout.kinds.find((k) => k.kind === 'commands');
    assert.ok(commands, 'should have a commands kind');
    assert.strictEqual(commands.destSubpath, 'command');
    assert.strictEqual(commands.prefix, 'gsd-');
    assert.strictEqual(typeof commands.stage, 'function');

    const skills = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skills, 'should have a skills kind');
    assert.strictEqual(skills.destSubpath, 'skills');
    assert.strictEqual(skills.prefix, 'gsd-');
    assert.strictEqual(typeof skills.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — kilo', () => {
  test('returns commands + skills layout for kilo (#784)', () => {
    const layout = resolveRuntimeArtifactLayout('kilo', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'kilo');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const commands = layout.kinds.find((k) => k.kind === 'commands');
    assert.ok(commands, 'should have a commands kind');
    assert.strictEqual(commands.destSubpath, 'command');
    assert.strictEqual(commands.prefix, 'gsd-');
    assert.strictEqual(typeof commands.stage, 'function');

    const skills = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skills, 'should have a skills kind');
    assert.strictEqual(skills.destSubpath, 'skills');
    assert.strictEqual(skills.prefix, 'gsd-');
    assert.strictEqual(typeof skills.stage, 'function');
  });
});

// ─── resolveRuntimeArtifactLayout — edge-cases ──────────────────────────────

describe('resolveRuntimeArtifactLayout edge-cases', () => {
  test('hermes has destSubpath skills/gsd and empty prefix', () => {
    const layout = resolveRuntimeArtifactLayout('hermes', '/tmp/x');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills/gsd');
    assert.strictEqual(layout.kinds[0].prefix, '');
  });

  test('cline has one skills kind (#782)', () => {
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x');
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('gemini has one commands kind', () => {
    const layout = resolveRuntimeArtifactLayout('gemini', '/tmp/x');
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
  });

  test('claude local has both commands and agents kinds', () => {
    const layout = resolveRuntimeArtifactLayout('claude', '/tmp/x', 'local');
    const kindNames = layout.kinds.map(k => k.kind);
    assert.ok(kindNames.includes('commands'), 'should have commands kind');
    assert.ok(kindNames.includes('agents'), 'should have agents kind');
  });

  test('cursor has both skills and commands kinds (#785)', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', '/tmp/x');
    const kindNames = layout.kinds.map(k => k.kind);
    assert.ok(kindNames.includes('skills'), 'cursor must have skills kind');
    assert.ok(kindNames.includes('commands'), 'cursor must have commands kind (#785 Cursor 1.6)');
  });

  test('claude global has only skills kind', () => {
    const layout = resolveRuntimeArtifactLayout('claude', '/tmp/x', 'global');
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('omp has commands, skills, agents, rules, and extensions kinds', () => {
    const layout = resolveRuntimeArtifactLayout('omp', '/tmp/x');
    assert.deepStrictEqual(layout.kinds.map(k => k.kind), ['commands', 'skills', 'agents', 'rules', 'extensions']);
  });

  test('unknown runtime grok throws TypeError containing runtime name', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('grok', '/tmp/x'),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(err.message.includes('grok'), 'error message must contain the runtime name');
        return true;
      }
    );
  });

  test('unknown runtime xyzunknown throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('xyzunknown', '/tmp/x'),
      TypeError
    );
  });

  test('empty configDir throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', ''),
      TypeError
    );
  });

  test('non-string configDir throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', null),
      TypeError
    );
  });

  test('bad scope throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', '/x', 'invalid'),
      TypeError
    );
  });
});

// ─── kind.stage() invocations ────────────────────────────────────────────────

const CORE_SKILLS = new Set(['help', 'phase', 'new-project']);
const CORE_AGENTS = new Set(['gsd-planner']);
const PROFILE_CORE = { skills: CORE_SKILLS, agents: CORE_AGENTS };
const PROFILE_FULL = { skills: '*', agents: new Set() };
const FAKE_STAGE_DIR = '/tmp/fake-config-dir-stage';

describe('stage — commands kind (gemini)', () => {
  test('stage returns a directory containing only the selected skill .md files', () => {
    const layout = resolveRuntimeArtifactLayout('gemini', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'should have a commands kind');

    const stagedDir = commandsKind.stage(PROFILE_CORE);
    const entries = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    for (const entry of entries) {
      const stem = entry.slice(0, -3);
      assert.ok(CORE_SKILLS.has(stem), `unexpected skill staged: ${stem}`);
    }
    assert.ok(entries.length >= 1, 'at least one skill file should be staged');
  });
});

describe('stage — agents kind (claude local)', () => {
  test('stage returns a valid directory for the agents kind', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'local');
    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'should have an agents kind');

    const stagedDir = agentsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    assert.ok(fs.statSync(stagedDir).isDirectory(), 'stagedDir must be a directory');
  });
});

describe('stage — skills kind (claude global)', () => {
  test('stage returns a directory containing gsd-<stem>/SKILL.md entries', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'should have a skills kind');

    const stagedDir = skillsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const entries = fs.readdirSync(stagedDir);
    for (const entry of entries) {
      assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
      const skillMd = path.join(stagedDir, entry, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `SKILL.md must exist in ${entry}`);
    }
    assert.ok(entries.length >= 1, 'at least one skill dir should be staged');
  });

  test('stage with skills="*" stages all commands/gsd/*.md as skills', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'should have a skills kind');

    const stagedDir = skillsKind.stage(PROFILE_FULL);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const entries = fs.readdirSync(stagedDir);
    assert.ok(entries.length > 10, `full profile should have many skills, got ${entries.length}`);
    for (const entry of entries) {
      assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
      const skillMd = path.join(stagedDir, entry, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `SKILL.md must exist in ${entry}`);
    }
  });
});

describe('stage — opencode commands kind', () => {
  test('opencode stage returns directory with .md files for selected skills', () => {
    const layout = resolveRuntimeArtifactLayout('opencode', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'should have a commands kind');

    const stagedDir = commandsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const entries = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    for (const entry of entries) {
      const stem = entry.slice(0, -3);
      assert.ok(CORE_SKILLS.has(stem), `unexpected skill staged: ${stem}`);
    }
  });
});

describe('stage — opencode/kilo skills kind (#784)', () => {
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime} skills stage writes gsd-<stem>/SKILL.md with name + description`, () => {
      const layout = resolveRuntimeArtifactLayout(runtime, FAKE_STAGE_DIR);
      const skillsKind = layout.kinds.find(k => k.kind === 'skills');
      assert.ok(skillsKind, 'should have a skills kind');

      const stagedDir = skillsKind.stage(PROFILE_CORE);
      assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
      const entries = fs.readdirSync(stagedDir);
      assert.ok(entries.length >= 1, 'at least one skill dir should be staged');
      for (const entry of entries) {
        assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
        const skillMd = path.join(stagedDir, entry, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `SKILL.md must exist in ${entry}`);
        const content = fs.readFileSync(skillMd, 'utf8');
        // OpenCode skill spec: name must match the dir, description required.
        assert.ok(content.startsWith('---\n'), 'SKILL.md must open with frontmatter');
        assert.match(content, new RegExp(`^name: ${entry}$`, 'm'), `name must equal dir ${entry}`);
        assert.match(content, /^description: /m, 'description frontmatter required');
        // No colon-namespace command leaks in the converted body.
        assert.ok(!/\/gsd:/.test(content), 'body must not contain /gsd: colon refs');
      }
    });
  }
});

describe('stage — cursor commands kind (#785)', () => {
  test('cursor commands kind stage returns directory with converted .md files', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'cursor should have a commands kind (#785)');

    const stagedDir = commandsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');

    const entries = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    assert.ok(entries.length >= 1, 'at least one command file should be staged');

    // Cursor commands are plain markdown — no YAML frontmatter
    for (const entry of entries) {
      const content = fs.readFileSync(path.join(stagedDir, entry), 'utf8');
      assert.ok(!content.startsWith('---'), `${entry}: cursor commands must not start with YAML frontmatter`);
    }
  });

  test('cursor commands stage applies Cursor-specific content transforms', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'cursor should have a commands kind (#785)');

    const stagedDir = commandsKind.stage(PROFILE_FULL);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');

    // Verify all staged files are .md only (no subdirectory SKILL.md layout)
    const entries = fs.readdirSync(stagedDir, { withFileTypes: true });
    for (const entry of entries) {
      assert.ok(entry.isFile(), `${entry.name}: cursor commands dir must contain only flat files`);
      assert.ok(entry.name.endsWith('.md'), `${entry.name}: must be .md file`);
    }
  });
});

describe('stage — omp commands, agents, rules, and extensions kinds', () => {
  test('omp stages converted command, agent, explicit rule markdown, and extension directory', () => {
    const layout = resolveRuntimeArtifactLayout('omp', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    const rulesKind = layout.kinds.find(k => k.kind === 'rules');
    const extensionsKind = layout.kinds.find(k => k.kind === 'extensions');

    const commandStage = commandsKind.stage(PROFILE_CORE);
    const agentStage = agentsKind.stage(PROFILE_CORE);
    const ruleStage = rulesKind.stage(PROFILE_CORE);
    const extensionStage = extensionsKind.stage(PROFILE_CORE);

    assert.ok(fs.existsSync(path.join(commandStage, 'help.md')));
    assert.ok(fs.existsSync(path.join(agentStage, 'gsd-planner.md')));
    assert.ok(fs.existsSync(path.join(ruleStage, 'planning-artifacts.md')));
    assert.ok(fs.existsSync(path.join(extensionStage, 'gsd-core', 'index.js')));
    assert.ok(fs.existsSync(path.join(extensionStage, 'gsd-core', 'package.json')));
  });
});
