'use strict';
/**
 * Regression tests for bug #782 — Cline skills emission.
 *
 * gsd now emits skills to ~/.cline/skills/<name>/SKILL.md for Cline >= v3.48.
 * Skills discovery: https://docs.cline.bot/customization/skills
 *
 * (a) Converter unit test: convertClaudeCommandToClineSkill
 * (b) Integration test: installRuntimeArtifacts for cline writes SKILL.md files
 * (c) .clinerules/gsd.md still written by the install path (#787 dir form)
 * (d) Idempotency: running install twice leaves skills + .clinerules/ intact
 * (e) Full install() global: both skills AND .clinerules/gsd.md are written
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const {
  convertClaudeCommandToClineSkill,
  convertClaudeToCliineMarkdown,
  installRuntimeArtifacts,
  install,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const { nestedSkillPath } = require('./helpers/nested-layout.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── (a) Converter unit test ─────────────────────────────────────────────────

const SAMPLE_COMMAND = `---
name: gsd:execute-phase
description: Execute all tasks in the current phase using Cline tools.
allowed-tools:
  - Read
  - Write
  - Bash
---

## Objective

Run all tasks in the current phase.

See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use \`/gsd-help\` or Claude Code for details.
`;

// A command that exercises all three Claude-specific frontmatter fields that
// must NOT leak into the emitted Cline SKILL.md.
const RICH_COMMAND = `---
name: gsd:validate-phase
description: Retroactively audit and fill Nyquist validation gaps for a completed phase
argument-hint: "[phase number]"
agent: researcher
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

## Objective

Audit Nyquist validation coverage. See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use Claude Code for details.
`;

/**
 * Extract frontmatter block (between --- delimiters) from output.
 * Returns the raw text between the first --- and the closing ---.
 * Uses \r?\n to handle both LF and CRLF line endings (Windows parity).
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('convertClaudeCommandToClineSkill — unit', () => {
  test('emits frontmatter with name: gsd-<stem>', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'frontmatter must contain name field');
    assert.ok(nameMatch[1].includes('gsd-execute-phase'), 'name must start with gsd-execute-phase');
  });

  test('emits non-empty description in frontmatter', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'frontmatter must contain description field');
    assert.ok(descMatch[1].trim().length > 0, 'description must not be empty');
  });

  test('body uses .cline/ paths not .claude/', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // The body reference to ~/.claude/ should be rewritten to ~/.cline/
    assert.ok(!result.includes('~/.claude/skills'), 'body must not contain ~/.claude/skills');
    assert.ok(result.includes('.cline/skills'), 'body must contain .cline/skills');
  });

  test('body replaces "Claude Code" with "Cline"', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    assert.ok(!result.includes('Claude Code'), 'Claude Code must be replaced with Cline');
    assert.ok(result.includes('Cline'), 'result must contain Cline branding');
  });

  test('no stray .claude/ paths in frontmatter or body', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // Should not contain .claude/ anywhere (except inside CLAUDE.md→.clinerules rewrites
    // but those are already handled by convertClaudeToCliineMarkdown)
    assert.ok(!result.includes('/.claude/'), 'no /.claude/ paths in output');
  });

  // ── Fix 1 (code-review): frontmatter must be ONLY name + description ──────

  test('frontmatter emits ONLY name and description — no allowed-tools (SAMPLE_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('frontmatter emits ONLY name and description — no allowed-tools/argument-hint/agent (RICH_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('name == gsd-validate-phase for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    // yamlIdentifier may quote the value; strip surrounding quotes for comparison
    const nameVal = nameMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.strictEqual(nameVal, 'gsd-validate-phase', `name must be gsd-validate-phase, got: ${nameVal}`);
  });

  test('description is non-empty and <= 1024 chars for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'must have description field');
    const desc = descMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.ok(desc.length > 0, 'description must be non-empty');
    assert.ok(desc.length <= 1024, `description must be <= 1024 chars, got ${desc.length}`);
  });

  test('description truncated to <=1024 chars when source description is very long', () => {
    const longDesc = 'A'.repeat(2000);
    const longDescCommand = `---\nname: gsd:test\ndescription: ${longDesc}\n---\n\nBody text.\n`;
    const result = convertClaudeCommandToClineSkill(longDescCommand, 'gsd-test');
    const descMatch = result.match(/^description:\s*'?(.*?)'?$/m);
    assert.ok(descMatch, 'must have description field');
    // The raw description value (unquoted) should be <=1024 chars
    // The result string after the --- block will have the quoted form; check raw length
    // by checking the whole result doesn't have the full 2000-char string
    assert.ok(!result.includes('A'.repeat(1025)), 'description must be truncated to 1024 chars');
  });

  test('returns content unchanged when source has no frontmatter', () => {
    const noFm = 'Just a body, no frontmatter here.\n';
    const result = convertClaudeCommandToClineSkill(noFm, 'gsd-test');
    assert.strictEqual(result, noFm, 'content without frontmatter must be returned unchanged');
  });

  test('RICH_COMMAND body uses .cline/ paths and Cline branding', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    assert.ok(!result.includes('~/.claude/'), 'body must not contain ~/.claude/');
    assert.ok(result.includes('.cline/'), 'body must contain .cline/ paths');
    assert.ok(!result.includes('Claude Code'), 'body must not contain "Claude Code"');
    assert.ok(result.includes('Cline'), 'body must reference Cline');
  });
});

// ─── (b) + (c) + (d) Integration tests ────────────────────────────────────────

describe('installRuntimeArtifacts — cline skills emission', () => {
  test('cline global: writes gsd-prefixed skill dirs under skills/', (t) => {
    const configDir = createTempDir('gsd-cline-skills-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const layout = resolveRuntimeArtifactLayout('cline', configDir, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'cline must have a skills kind after #782');

    const skillsDir = path.join(configDir, skillsKind.destSubpath);
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must be created');

    const helpSkillDir = path.join(skillsDir, `${skillsKind.prefix}help`);
    assert.ok(
      fs.existsSync(path.join(helpSkillDir, 'SKILL.md')),
      `gsd-help/SKILL.md must exist under ${skillsKind.destSubpath}/`
    );
  });

  test('cline global: SKILL.md has valid cline frontmatter (name + description)', (t) => {
    const configDir = createTempDir('gsd-cline-fm-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const helpSkill = path.join(skillsDir, 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(helpSkill), 'gsd-help/SKILL.md must exist');

    const content = fs.readFileSync(helpSkill, 'utf8');
    // Must have YAML frontmatter
    assert.ok(content.startsWith('---'), 'SKILL.md must start with YAML frontmatter');
    assert.ok(content.includes('name:'), 'frontmatter must have name field');
    assert.ok(content.includes('description:'), 'frontmatter must have description field');
    // name must be gsd-help
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    assert.ok(nameMatch[1].includes('gsd-help'), `name must include gsd-help, got: ${nameMatch[1]}`);
  });

  test('cline global: SKILL.md uses .cline/ paths not .claude/', (t) => {
    const configDir = createTempDir('gsd-cline-paths-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    // Check all installed skill files for stray .claude/ references
    const skills = fs.readdirSync(skillsDir).filter(n => n.startsWith('gsd-'));
    assert.ok(skills.length > 0, 'at least one gsd- skill must be installed');

    for (const skillName of skills) {
      const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf8');
      assert.ok(
        !content.includes('~/.claude/'),
        `${skillName}/SKILL.md must not contain ~/.claude/ — found stray path`
      );
      assert.ok(
        !content.includes('/.claude/'),
        `${skillName}/SKILL.md must not contain /.claude/ — found stray path`
      );
    }
  });

  test('cline global: skill count matches resolved profile', (t) => {
    const configDir = createTempDir('gsd-cline-count-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const count = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    if (RESOLVED_CORE.skills !== '*') {
      assert.strictEqual(count, RESOLVED_CORE.skills.size,
        `installed skill count (${count}) must match profile size (${RESOLVED_CORE.skills.size})`);
    } else {
      assert.ok(count > 0, 'must install at least 1 skill');
    }
  });
});

describe('installRuntimeArtifacts — cline idempotency', () => {
  test('cline: running install twice leaves skills intact (idempotency)', (t) => {
    const configDir = createTempDir('gsd-cline-idempotent-');
    t.after(() => cleanup(configDir));

    // First install
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const countAfterFirst = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    // Second install (upgrade over existing)
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const countAfterSecond = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    assert.strictEqual(countAfterFirst, countAfterSecond,
      `skill count must be stable across installs: first=${countAfterFirst} second=${countAfterSecond}`);
  });
});

// ─── (e) Full install() global — coexistence regression ───────────────────────
//
// Issue #782 explicitly requires that a global Cline install writes BOTH:
//   - skills/<gsd-*>/SKILL.md     (skills for Cline >= v3.48)
//   - .clinerules/gsd.md          (rules dir form introduced by #787)
//
// installRuntimeArtifacts() tests cover skills in isolation; this test exercises
// the FULL install() code path to ensure neither artifact is silently dropped.

describe('install() global cline — coexistence: skills AND .clinerules', () => {
  let tmpGlobalDir;
  let originalClineConfigDir;

  beforeEach(() => {
    originalClineConfigDir = process.env.CLINE_CONFIG_DIR;
    tmpGlobalDir = createTempDir('gsd-cline-global-');
    // Redirect CLINE_CONFIG_DIR to the temp dir so install() never touches ~/.cline
    process.env.CLINE_CONFIG_DIR = tmpGlobalDir;
  });

  afterEach(() => {
    if (originalClineConfigDir !== undefined) {
      process.env.CLINE_CONFIG_DIR = originalClineConfigDir;
    } else {
      delete process.env.CLINE_CONFIG_DIR;
    }
    cleanup(tmpGlobalDir);
  });

  test('global cline install writes at least one gsd-* SKILL.md under skills/', () => {
    captureConsole(() => install(true, 'cline'));

    const skillsDir = path.join(tmpGlobalDir, 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      `skills/ directory must exist under ${tmpGlobalDir} after global cline install`
    );

    // full profile: gsd-help is nested under gsd-ns-manage/skills/help/SKILL.md
    const helpSkillFile = nestedSkillPath(skillsDir, 'gsd-', 'help');
    assert.ok(
      fs.existsSync(helpSkillFile),
      `${path.relative(tmpGlobalDir, helpSkillFile)} must exist under ${tmpGlobalDir} — skills emission broken for global cline`
    );
  });

  test('global cline install writes .clinerules/gsd.md to the global config dir', () => {
    captureConsole(() => install(true, 'cline'));

    // For a global Cline install, targetDir = getGlobalDir('cline') = CLINE_CONFIG_DIR.
    // The cline-rules surface (#787) writes the .clinerules/ DIRECTORY form:
    //   .clinerules/gsd.md  (rule file)
    //   .clinerules/hooks/PreToolUse  (lifecycle hook)
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(
      fs.existsSync(clinerulesMd),
      `.clinerules/gsd.md must exist at ${clinerulesMd} — coexistence with skills broken for global cline (#782+#787)`
    );
  });

  test('global cline .clinerules/gsd.md contains GSD instructions', () => {
    captureConsole(() => install(true, 'cline'));

    // #787 dir form: rule content lives in .clinerules/gsd.md, not a flat .clinerules file
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(fs.existsSync(clinerulesMd), '.clinerules/gsd.md must exist');
    const content = fs.readFileSync(clinerulesMd, 'utf8');
    assert.ok(
      content.includes('GSD') || content.includes('gsd'),
      '.clinerules/gsd.md must reference GSD'
    );
  });
});

// ─── Fix 3 regression: converter rewrites bare ~/.claude and CLAUDE_CONFIG_DIR ──
//
// convertClaudeToCliineMarkdown must also handle bare ~/.claude (no trailing
// slash) and the CLAUDE_CONFIG_DIR env-var name. surface.md contains these;
// the emitted Cline SKILL.md must contain no such stale Claude refs.

describe('convertClaudeToCliineMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (Fix 3)', () => {
  const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');

  test('no bare ~/.claude in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    // ~/.claude followed by a word-boundary (not a /) must be gone
    assert.ok(
      !/~\/\.claude\b/.test(result),
      'converted surface.md must not contain bare ~/.claude'
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR'
    );
  });

  test('CLAUDE_CONFIG_DIR rewritten to CLINE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(result.includes('CLINE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must become CLINE_CONFIG_DIR');
    assert.ok(!result.includes('CLAUDE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must be gone');
  });

  test('bare ~/.claude rewritten to ~/.cline', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(!result.includes('~/.claude'), 'bare ~/.claude must be rewritten');
    assert.ok(result.includes('~/.cline'), 'must rewrite to ~/.cline');
  });

  test('installRuntimeArtifacts cline global: gsd-surface SKILL.md has no bare ~/.claude or CLAUDE_CONFIG_DIR', (t) => {
    const configDir = createTempDir('gsd-cline-surface-fix3-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist for full profile`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    assert.ok(
      !/~\/\.claude\b/.test(content),
      'gsd-surface SKILL.md must not contain bare ~/.claude (Fix 3)'
    );
    assert.ok(
      !content.includes('CLAUDE_CONFIG_DIR'),
      'gsd-surface SKILL.md must not contain CLAUDE_CONFIG_DIR (Fix 3)'
    );
  });
});

// ─── Fix 1 regression: custom CLINE_CONFIG_DIR → embedded paths use custom dir ──
//
// _applyRuntimeRewrites for cline must rewrite ~/.cline/ → pathPrefix.
// For default global installs, pathPrefix = "$HOME/.cline/" (unchanged).
// For custom installs (CLINE_CONFIG_DIR=/custom), pathPrefix = "/custom/" and
// all embedded ~/.cline/ refs in SKILL.md must become /custom/...

describe('_applyRuntimeRewrites — cline custom-dir embedded path (Fix 1)', () => {
  test('default pathPrefix ($HOME/.cline/) leaves ~/.cline refs as $HOME/.cline', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '$HOME/.cline/');
    assert.ok(result.includes('$HOME/.cline/'), 'default prefix must map ~/.cline/ to $HOME/.cline/');
    assert.ok(!result.includes('~/.cline'), 'no tilde form should remain after rewrite');
  });

  test('custom pathPrefix rewrites ~/.cline/ → custom path in SKILL.md body', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'custom prefix must appear in output');
    assert.ok(!result.includes('~/.cline'), 'no tilde cline form should remain after custom rewrite');
  });

  test('custom pathPrefix rewrites residual ~/.claude/ safety net', () => {
    const content = 'Residual: ~/.claude/skills\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'safety-net ~/.claude/ also rewritten to custom prefix');
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ should remain');
  });

  test('installRuntimeArtifacts cline with CLINE_CONFIG_DIR custom: SKILL.md embeds custom path', (t) => {
    const configDir = createTempDir('gsd-cline-custom-dir-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // gsd-surface SKILL.md references config paths; with a custom configDir
    // (not under $HOME), pathPrefix will be the absolute custom path.
    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    // With a custom dir (path under /tmp, not ~/.cline), the output must NOT
    // contain ~/.cline/ or $HOME/.cline/ — it must embed the actual configDir path.
    assert.ok(
      !content.includes('~/.cline/'),
      `gsd-surface SKILL.md must not contain ~/.cline/ when configDir=${configDir} (Fix 1)`
    );
    // The custom path must appear somewhere in the file
    // (configDir is a /tmp/... path so pathPrefix = configDir+'/').
    // Production normalizes backslashes to forward slashes via
    // path.resolve(configDir).replace(/\\/g, '/'), so compare against that
    // form — otherwise this assertion fails on Windows where mkdtempSync
    // returns a backslash path (e.g. C:\Users\...) but the emitted content
    // already has forward slashes (C:/Users/...).
    const expectedPath = path.resolve(configDir).replace(/\\/g, '/');
    assert.ok(
      content.includes(expectedPath),
      `gsd-surface SKILL.md must embed custom configDir path ${expectedPath} (Fix 1)`
    );
  });
});

// ─── Fix 4 regression: description truncation is code-point-aware ────────────
//
// Naive UTF-16 slicing (`str.slice(0, 1021)`) can split a surrogate pair when
// the cut falls between the high and low surrogate of a multibyte character
// (e.g. emoji U+1F600, which is encoded as two UTF-16 code units).  The fix
// uses Array.from() to split by code point, guaranteeing that the truncated
// value never contains a lone surrogate.

describe('convertClaudeCommandToClineSkill — code-point-aware truncation (Fix 4)', () => {
  /**
   * Build a frontmatter+body command string whose description is:
   *   - exactly `prefixLen` ASCII chars
   *   - followed by `emojiCount` repetitions of '😀' (U+1F600, 2 UTF-16 units)
   *   - total UTF-16 length is prefixLen + emojiCount * 2
   */
  function makeEmojiCommand(prefixLen, emojiCount) {
    const desc = 'A'.repeat(prefixLen) + '😀'.repeat(emojiCount);
    return `---\nname: gsd:emoji-test\ndescription: ${desc}\n---\n\nBody.\n`;
  }

  test('emitted description is <= 1024 code points when source overflows', () => {
    // 1020 ASCII chars + 4 emoji = 1020 + 8 UTF-16 units = 1028 UTF-16 units > 1024.
    // Code-point count = 1020 + 4 = 1024 — exactly at the boundary BEFORE adding '...'.
    // After truncation to 1021 code points + '...' → 1024 code points total.
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    // Extract raw description value (strip surrounding YAML quotes if present)
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const codePoints = Array.from(rawDesc);
    assert.ok(
      codePoints.length <= 1024,
      `emitted description must be <= 1024 code points, got ${codePoints.length}`
    );
  });

  test('emitted description ends with "..." when truncated', () => {
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(rawDesc.endsWith('...'), `truncated description must end with "...", got: ${rawDesc.slice(-10)}`);
  });

  test('emitted description has no lone surrogate (no split emoji)', () => {
    // Place emojis exactly at positions 1021–1025 (code points) so that a naive
    // UTF-16 slice at 1021 code units would cut inside the second emoji's surrogate pair.
    // 1019 ASCII chars + 6 emoji = 1025 code points (>1024, triggers truncation).
    // UTF-16 length = 1019 + 12 = 1031.  Naive slice(0,1021) yields 1019 ASCII +
    // the HIGH surrogate of emoji[0] — a lone surrogate.
    const cmd = makeEmojiCommand(1019, 6);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    // Verify no lone surrogate: every char's code point must be outside [0xD800, 0xDFFF].
    const hasLoneSurrogate = [...rawDesc].some(c => {
      const cp = c.codePointAt(0);
      return cp >= 0xD800 && cp <= 0xDFFF;
    });
    assert.ok(!hasLoneSurrogate, 'emitted description must not contain a lone surrogate');

    // Also round-trip through Buffer to confirm the string is valid UTF-8 encodable.
    assert.doesNotThrow(
      () => Buffer.from(rawDesc, 'utf8').toString('utf8'),
      'emitted description must round-trip through Buffer without error'
    );
  });

  test('short description (<= 1024 code points) is not truncated', () => {
    // 10 ASCII + 5 emoji = 15 code points — well under the limit.
    const cmd = makeEmojiCommand(10, 5);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(!rawDesc.endsWith('...'), 'short description must NOT be truncated with "..."');
    // Must contain the original emoji characters intact
    assert.ok(rawDesc.includes('😀'), 'short description must preserve emoji characters');
  });
});

// ─── Fix 2 regression: cline local scope emits no skills ─────────────────────
//
// resolveRuntimeArtifactLayout('cline', dir, 'local') must return 0 kinds.
// installRuntimeArtifacts('cline', dir, 'local') must not write any skills.

describe('resolveRuntimeArtifactLayout — cline scope-aware (Fix 2)', () => {
  test('cline local: kinds.length === 0 (no skills for local scope)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'local');
    assert.strictEqual(layout.kinds.length, 0, 'cline local must have 0 kinds');
  });

  test('cline global: kinds.length === 1 (skills kind)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'global');
    assert.strictEqual(layout.kinds.length, 1, 'cline global must have 1 skills kind');
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('installRuntimeArtifacts cline local: no skills/ dir created', (t) => {
    const configDir = createTempDir('gsd-cline-local-noskills-');
    t.after(() => cleanup(configDir));

    assert.doesNotThrow(() => installRuntimeArtifacts('cline', configDir, 'local', RESOLVED_CORE));
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(
      !fs.existsSync(skillsDir),
      `skills/ must NOT be created for cline local install (Fix 2), but found ${skillsDir}`
    );
  });
});
