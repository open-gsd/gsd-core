/**
 * GSD Tools Tests - codex-config.cjs
 *
 * Tests for Codex adapter header, agent conversion, config.toml generation/merge,
 * per-agent .toml generation, and uninstall cleanup.
 */

// Enable test exports from install.js (skips main CLI logic)
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { cleanup } = require('./helpers.cjs');
const fc = require('fast-check');
const { CLAUDE_AGENT_ALIASES: _CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { escapeRegex: _escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
// #3241 — the intended new home for CLAUDE_AGENT_ALIASES + isAnthropicFlavoredModel
// (see .gsd/phase/feat-3241-codex-omit-model-by-default/40-design.md "The seam
// decision"). Neither export exists on model-catalog.cjs yet; requiring the
// module does not throw (it just has no such keys today), but calling
// isAnthropicFlavoredModel does — see the new describe block below.
const _modelCatalog = require('../gsd-core/bin/lib/model-catalog.cjs');
const _modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');

// #2153 follow-up: ensure hooks/dist/ exists before any install integration
// test runs. The Codex install path copies hook files from hooks/dist/, which
// is gitignored and only populated by `npm run build:hooks`. When one of the
// codex-config*.test.cjs files is run in isolation (`node --test
// tests/codex-config-agents.test.cjs`, for example) the build step from the
// npm-test pretest chain does not run, and the "Codex install copies hook
// file" regression silently fails because hooks/dist/ is empty.
// Build on demand so the test passes regardless of runner ordering.
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    throwIfFailed(
      runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS }),
      `node ${BUILD_HOOKS_SCRIPT}`,
    );
  }
});

const {
  getCodexSkillAdapterHeader: _getCodexSkillAdapterHeader,
  convertClaudeAgentToCodexAgent: _convertClaudeAgentToCodexAgent,
  convertClaudeCommandToCodexSkill: _convertClaudeCommandToCodexSkill,
  generateCodexAgentToml: _generateCodexAgentToml,
  _resetCodexWarningDedupeForTests: __resetCodexWarningDedupeForTests,
  cleanupCodexSkillMetadataSidecars: _cleanupCodexSkillMetadataSidecars,
  generateCodexConfigBlock: _generateCodexConfigBlock,
  stripGsdFromCodexConfig: _stripGsdFromCodexConfig,
  migrateCodexHooksMapFormat: _migrateCodexHooksMapFormat,
  mergeCodexConfig: _mergeCodexConfig,
  install,
  GSD_CODEX_MARKER: _GSD_CODEX_MARKER,
  deriveCodexSandboxMode: _deriveCodexSandboxMode,
  // #3897 rung 3 (ADR-3473 §8.3, option 2 — HALT.md): anticipated new export
  // which held the 17 explicit read-only pins until #4770 lifted them (now an empty frozen map) for roles whose tool contract would
  // otherwise derive workspace-write (16 measured by HALT.md + gsd-nyquist-auditor,
  // surfaced by the list-form parse fix). Does not exist on the current tree —
  // destructuring a non-existent key is `undefined`, not a throw, so requiring
  // this module still succeeds; every test below that touches it fails on its
  // own `typeof` guard instead.
  CODEX_SANDBOX_HOLDS: _CODEX_SANDBOX_HOLDS,
  parseTomlToObject: _parseTomlToObject,
  validateCodexConfigSchema: _validateCodexConfigSchema,
  uninstall,
  CODEX_EXTENDED_HOOK_EVENTS,
} = require('../bin/install.js');

const { resolveNodeRunner } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { resolveInstallPlan: _resolveInstallPlan } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
// #3897 fixup: deriveCodexSandboxMode's 2nd param is now the already-resolved
// `tools:` frontmatter VALUE, not raw agent content (codex-agent-toml.cjs no
// longer parses frontmatter at all — no third copy of that extraction).
const {
  extractFrontmatterAndBody: _extractFrontmatterAndBody,
  extractFrontmatterField: _extractFrontmatterField,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
// #3897 list-form parse fix: the ONE shared `tools:`-value reader both
// sandbox-feeding production paths (`bin/install.js`'s `generateCodexAgentToml`
// and `agent-install-check.cts`'s `checkCodexSandboxPosture`) now route
// through — handles inline (`tools: Read, Write`) AND YAML block-list
// (`tools:` + indented `- Item` lines) form. Used below by `realAgentToolsRaw`
// so the test's own measurement of "what does this role's tool contract
// declare" cannot silently disagree with production (the exact generative-
// fix-divergence shape this fix closes).
const { extractToolsValue: _extractToolsValue } = require('../gsd-core/bin/lib/codex-agent-toml.cjs');

function runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
  const previousCodeHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  process.env.CODEX_HOME = codexHome;
  // #2088: Codex skills now install to the canonical $HOME/.agents/skills root
  // (os.homedir()-relative, independent of CODEX_HOME — per codex core-skills
  // loader.rs). Sandbox HOME to codexHome so skills land under the temp dir
  // (codexHome/.agents/skills) instead of polluting the developer's real home.
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;

  try {
    process.chdir(cwd);
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodeHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}
// #2088: the canonical Codex skill-install root, sandboxed under codexHome.
function codexSkillsRoot(codexHome) {
  return path.join(codexHome, '.agents', 'skills');
}

function _readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function _writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function _readHooksSessionStartCommands(codexHome) {
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return [];
  const raw = fs.readFileSync(hooksPath, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const table = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? parsed.hooks
    : parsed;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) => [
    ...(typeof entry?.command === 'string' ? [entry.command] : []),
    ...(Array.isArray(entry?.hooks)
      ? entry.hooks.map((hook) => hook && hook.command).filter((cmd) => typeof cmd === 'string')
      : []),
  ]);
}

function _countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function _assertNoDraftRootKeys(content) {
  assert.ok(!content.includes('model = "gpt-5.6-terra"'), 'does not inject draft model default');
  assert.ok(!content.includes('model_reasoning_effort = "high"'), 'does not inject draft reasoning default');
  assert.ok(!content.includes('disable_response_storage = true'), 'does not inject draft storage default');
}

function _assertUsesOnlyEol(content, eol) {
  if (eol === '\r\n') {
    assert.ok(content.includes('\r\n'), 'contains CRLF line endings');
    assert.ok(!content.replace(/\r\r?\n/g, '').includes('\n'), 'does not contain bare LF line endings');
    return;
  }
  assert.ok(!content.includes('\r\n'), 'does not contain CRLF line endings');
}

function _assertNoCodexBareGsdToolsInvocation(content, label) {
  const patterns = [
    /(^|\r?\n)[ \t]*gsd-tools\s/,
    /\$\(\s*gsd-tools\s/,
    /`\s*gsd-tools\s/,
    /(?:&&|\|\||[;|])\s*gsd-tools\s/,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(
      content,
      pattern,
      `${label} must not contain a command-position bare gsd-tools invocation`,
    );
  }
}

// ─── getCodexSkillAdapterHeader ─────────────────────────────────────────────────





// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3562-codex-install-skill-surface.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3562-codex-install-skill-surface (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for bug #3562 — Codex global install must create a
 * discoverable $gsd-* skill surface.
 *
 * Codex CLI 0.130.0 (the version in the issue report) does NOT auto-discover
 * commands from gsd-core/workflows/*.md or agents/*.md. It only registers
 * commands from skills/<name>/SKILL.md. Prior installer logic ("Codex now
 * discovers official skills from .agents/skills") was based on an assumption
 * that does not match the shipping Codex CLI behavior, leaving users with
 * workflows on disk and no $gsd-* entrypoints after `npx @opengsd/gsd-core
 * --codex --global`.
 *
 * Fix: re-wire copyCommandsAsCodexSkills() back into the install dispatch path
 * so the same skill-shape that Claude / Copilot / Antigravity / Cursor /
 * Windsurf / Augment / Trae installs produce is also produced for Codex.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { install } = require('../bin/install.js');
const { createTempDir, cleanup, parseFrontmatter } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

describe('#3562 — Codex install produces discoverable $gsd-* skill surface', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      throwIfFailed(
        runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
        `node ${BUILD_HOOKS_SCRIPT}`,
      );
    }
    tmpRoot = createTempDir('gsd-3562-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('global install creates skills/gsd-help/SKILL.md', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    // #2088: skills now install to the canonical $HOME/.agents/skills root.
    // withCodexHome fakes $HOME to tmpRoot (codexHome's parent) above.
    const skillPath = path.join(codexSkillsRoot(tmpRoot), 'gsd-help', 'SKILL.md');
    assert.ok(
      fs.existsSync(skillPath),
      `Codex install must create ${skillPath} so $gsd-help is discoverable. ` +
        'Without this, Codex CLI 0.130.0 does not expose any $gsd-* command.',
    );
  });

  test('SKILL.md content has frontmatter expected by Codex skill discovery', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const skillPath = path.join(codexSkillsRoot(tmpRoot), 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'precondition: SKILL.md exists');

    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    assert.equal(frontmatter.name, 'gsd-help', 'SKILL.md frontmatter must declare name: gsd-help so $gsd-help resolves');
  });

  test('multiple core $gsd-* skills are produced (not just gsd-help)', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const skillsDir = codexSkillsRoot(tmpRoot);
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must exist after install');

    const gsdSkills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
      .map((e) => e.name);

    // Lower bound — exact count depends on the current command surface. The
    // commands/gsd/ directory holds dozens of *.md files; expecting more than
    // 10 generated skills is a conservative floor that catches "we generated
    // nothing" or "we only generated one accidentally" regressions.
    assert.ok(
      gsdSkills.length >= 10,
      `Expected >= 10 generated gsd-* skill directories, found ${gsdSkills.length}: ${gsdSkills.join(', ')}`,
    );
  });

  test('install preserves existing user skills (does not remove unrelated dirs)', () => {
    fs.mkdirSync(path.join(codexHome, 'skills', 'custom-user-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md'),
      '---\nname: custom-user-skill\n---\n# user skill\n',
    );

    withCodexHome(codexHome, () => install(true, 'codex'));

    const userSkill = path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md');
    assert.ok(
      fs.existsSync(userSkill),
      'Codex install must preserve existing non-gsd user skill directories',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3566-codex-hooks-feature-canonical-key.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3566-codex-hooks-feature-canonical-key (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for bug #3566 — Codex installer must emit canonical
 * [features].hooks (not the legacy [features].codex_hooks).
 *
 * Codex itself marks `codex_hooks` as a `legacy_key` in
 * codex-rs/features/src/legacy.rs. The canonical current feature flag is
 * `hooks`. The GSD installer was still writing `codex_hooks` on every fresh
 * install / reinstall, leaving deprecated config behind. This file pins:
 *
 *   1. Fresh install writes canonical `[features].hooks = true` and never
 *      emits `codex_hooks` (section, root-dotted, or block-fallback forms).
 *   2. Reinstall over a GSD-owned section-form legacy
 *      `[features].codex_hooks = true` migrates forward to
 *      `[features].hooks = true` (legacy line removed); user-owned legacy
 *      entries are preserved per #2760.
 *   3. Reinstall over a GSD-owned root-dotted legacy
 *      `features.codex_hooks = true` migrates forward to
 *      `features.hooks = true`; user-owned legacy entries are preserved.
 *   4. Reinstall over a user-owned `[features].hooks = true` (no GSD
 *      ownership marker) preserves the user line; no double-write, no
 *      ownership stamp.
 *   5. The `hasEnabledCodexHooksFeature` recognizer treats both canonical
 *      `hooks` AND legacy `codex_hooks` as "enabled" so existing installs
 *      keep working across the migration window.
 *   6. Uninstall removes either GSD-owned `hooks` or GSD-owned legacy
 *      `codex_hooks`; user-owned `hooks` is preserved.
 *
 * All assertions use parseTomlToObject — never substring-match on raw TOML
 * text (per RULESET.TESTS.no-source-grep). The product surface is the
 * parsed config shape, not the file's lexical layout.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { install, uninstall, parseTomlToObject } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

function readConfig(codexHome) {
  const text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  return { text, parsed: parseTomlToObject(text) };
}

function featuresHooks(parsed) {
  return parsed?.features?.hooks;
}

function featuresCodexHooks(parsed) {
  return parsed?.features?.codex_hooks;
}

describe('#3566 — Codex feature flag is canonical "hooks" (not legacy "codex_hooks")', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      throwIfFailed(
        runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
        `node ${BUILD_HOOKS_SCRIPT}`,
      );
    }
    tmpRoot = createTempDir('gsd-3566-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('fresh install writes [features].hooks = true and never emits codex_hooks', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'fresh install must write canonical [features].hooks = true',
    );
    assert.strictEqual(
      featuresCodexHooks(parsed),
      undefined,
      'fresh install must NOT write legacy [features].codex_hooks',
    );
  });

  test('install over a pre-existing legacy [features].codex_hooks line preserves it (user-owned, #2760 defensive)', () => {
    // A user who hand-wrote `codex_hooks = true` keeps the legacy key.
    // Codex itself maps it via the runtime legacy_key alias, so this is
    // forward-compatible without GSD rewriting user-authored content.
    const legacy = [
      '[features]',
      'codex_hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), legacy);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresCodexHooks(parsed),
      true,
      'user-owned legacy codex_hooks line must be preserved verbatim',
    );
  });

  test('install over a pre-existing legacy root-dotted features.codex_hooks line preserves it', () => {
    const legacy = 'features.codex_hooks = true\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), legacy);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresCodexHooks(parsed),
      true,
      'user-owned root-dotted legacy line must be preserved verbatim',
    );
  });

  test('reinstall preserves user-owned [features].hooks = true (no GSD ownership marker)', () => {
    const userOwned = [
      '[features]',
      'hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), userOwned);

    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'user-owned hooks=true must be preserved',
    );
  });

  test('uninstall removes GSD-owned canonical hooks line but preserves user-owned hooks', () => {
    // Phase 1: fresh GSD install — writes GSD-owned hooks line.
    withCodexHome(codexHome, () => install(true, 'codex'));
    const { parsed: afterInstall } = readConfig(codexHome);
    assert.strictEqual(
      featuresHooks(afterInstall),
      true,
      'precondition: install wrote canonical hooks',
    );

    withCodexHome(codexHome, () => uninstall(true, 'codex'));
    const configPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configPath)) {
      // Uninstall may delete config.toml entirely when nothing user-owned
      // remains — that is the strongest possible "feature flag removed"
      // signal and counts as success.
      return;
    }
    const { parsed: afterUninstall } = readConfig(codexHome);
    assert.notStrictEqual(
      featuresHooks(afterUninstall),
      true,
      'uninstall must remove GSD-owned canonical hooks line',
    );
  });

  test('uninstall preserves user-owned hooks=true when GSD never owned it', () => {
    const userOwned = [
      '[features]',
      'hooks = true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), userOwned);

    withCodexHome(codexHome, () => uninstall(true, 'codex'));
    const { parsed } = readConfig(codexHome);

    assert.strictEqual(
      featuresHooks(parsed),
      true,
      'uninstall must NOT touch a hooks line GSD never claimed ownership of (#2760 defensive principle)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3582-codex-skills-materialized.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3582-codex-skills-materialized (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3582 — Codex install must materialize the skill
 * surface under `~/.codex/skills/<name>/SKILL.md`.
 *
 * Background: GSD 1.42.2 reported the user-visible failure
 *   > Skipped Codex skill-copy generation (Codex discovers official skills directly)
 * which left users with a "successful" install but no routable `$gsd-*`
 * entrypoints in Codex CLI 0.130.0. Codex CLI does NOT auto-discover
 * commands from `~/.codex/gsd-core/workflows/*.md` or `agents/*.md`;
 * it only registers slash commands derived from `~/.codex/skills/<name>/SKILL.md`.
 * The "Codex discovers official skills directly" assumption was wrong.
 *
 * The current installer (#3562 / current main) calls
 * `copyCommandsAsCodexSkills()` to materialize one SKILL.md per
 * commands/gsd/*.md, with Claude-flavored command frontmatter rewritten
 * into Codex skill frontmatter and the `<codex_skill_adapter>` body
 * produced by `getCodexSkillAdapterHeader()`.
 *
 * This test locks the install contract so the 1.42.2 regression cannot
 * silently come back. It asserts the full expected skill-name set
 * (deepStrictEqual, not just count), the full adapter block (using
 * the exported `getCodexSkillAdapterHeader` IR as the expected value,
 * not raw substring search), and the success/skip log invariant.
 */
// allow-test-rule: source-text-is-the-product (see #3582)
// This assertion validates the generated adapter block that is shipped to
// users in SKILL.md; matching exact emitted text is the contract under test.

'use strict';

// GSD_TEST_MODE neutralizes side-effecting branches (auto-detection, etc.).
// Must be set BEFORE requiring bin/install.js; scoped to module load only
// so downstream tests don't see it. Mirrors the bug-2760 codex harness.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { install, getCodexSkillAdapterHeader } = require('../bin/install.js');
const { parseFrontmatter, createTempDir, cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

// Strip ANSI color codes so log assertions don't depend on TTY detection.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function assertNoBareGsdToolsInvocation(content, label) {
  const patterns = [
    /(^|\n)[ \t]*gsd-tools\s/,
    /\$\(\s*gsd-tools\s/,
    /`\s*gsd-tools\s/,
    /(?:&&|\|\||[;|])\s*gsd-tools\s/,
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(
      content,
      pattern,
      `${label} must not contain a command-position bare gsd-tools invocation`,
    );
  }
}

/**
 * Walk commands/gsd/**\/*.md and return the set of skill names the installer
 * is contractually obligated to produce. Naming rule mirrors
 * `copyCommandsAsCodexSkills` in bin/install.js: nested dirs collapse to
 * `gsd-<dir>-<file>` with the .md stripped.
 */
function expectedSkillNames() {
  const names = new Set();
  function recurse(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        recurse(path.join(dir, entry.name), `${prefix}-${entry.name}`);
      } else if (entry.name.endsWith('.md')) {
        const base = entry.name.slice(0, -3);
        names.add(`${prefix}-${base}`);
      }
    }
  }
  recurse(COMMANDS_DIR, 'gsd');
  return names;
}

/**
 * Run a Codex global install into a temp CODEX_HOME and capture stdout/stderr.
 * Cleans up codexHome on throw so a partial-install failure never leaks
 * temp directories.
 */
function runCodexInstallCaptured() {
  const codexHome = createTempDir('gsd-3582-codex-');
  const logs = [];
  const warnings = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.warn = (...a) => { warnings.push(a.join(' ')); };

  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at os.homedir() ($HOME/.agents), independent of CODEX_HOME.
  // Sandbox $HOME (and $USERPROFILE) to codexHome too — otherwise this
  // in-process install would materialize skills under the developer/CI
  // machine's REAL home directory instead of the temp dir.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  process.env.GSD_TEST_MODE = '1';
  try {
    process.chdir(ROOT);
    install(true, 'codex');
    return { codexHome, logs, warnings };
  } catch (err) {
    // Always reclaim the temp dir if install throws — otherwise the
    // describe-level afterEach can't see codexHome and it leaks.
    try { cleanup(codexHome); } catch { /* best-effort */ }
    throw err;
  } finally {
    process.chdir(previousCwd);
    console.log = origLog;
    console.warn = origWarn;
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    if (previousGsdTestMode === undefined) {
      delete process.env.GSD_TEST_MODE;
    } else {
      process.env.GSD_TEST_MODE = previousGsdTestMode;
    }
  }
}

// concurrency:false — harness mutates console.* / process.env / process.cwd().
// Matches the convention used by tests/bug-3562-codex-install-skill-surface.test.cjs.
describe('bug-3582: Codex global install materializes the skill surface', { concurrency: false }, () => {
  let installRun;

  beforeEach(() => {
    installRun = runCodexInstallCaptured();
  });

  afterEach(() => {
    if (installRun && installRun.codexHome) {
      cleanup(installRun.codexHome);
    }
  });

  test('writes the exact expected set of gsd-*/SKILL.md skills (deepEqual on name set)', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    assert.ok(
      fs.existsSync(skillsDir),
      `Codex install must create ${skillsDir} (the 1.42.2 regression skipped this entirely)`,
    );

    const actualNames = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    // deepStrictEqual on the sorted full set — not just count — so a
    // partial install that drops a real command and substitutes a bogus
    // same-count `gsd-*` directory cannot pass.
    const expected = [...expectedSkillNames()].sort();
    assert.deepStrictEqual(
      [...actualNames].sort(),
      expected,
      `installed Codex skills must exactly match commands/gsd/**/*.md (one skill per command)`,
    );

    // Every skill dir contains a non-empty SKILL.md file. Empty dirs or
    // empty SKILL.md bodies would defeat Codex's slash-command
    // registration as silently as the 1.42.2 "skipped" branch did.
    for (const name of actualNames) {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      const stat = fs.statSync(skillMd);
      assert.ok(stat.isFile(), `${skillMd} must be a regular file`);
      assert.ok(stat.size > 0, `${skillMd} must not be empty`);
    }
  });

  test('SKILL.md frontmatter declares hyphen-form name matching the directory', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      // Uses the shared `parseFrontmatter` from tests/helpers.cjs per the
      // CONTRIBUTING.md "tests parse, never grep" convention.
      const fm = parseFrontmatter(content);
      assert.strictEqual(
        fm.name,
        name,
        `SKILL.md name field must match directory name for ${name} (got ${JSON.stringify(fm.name)})`,
      );
      assert.ok(
        typeof fm.description === 'string' && fm.description.length > 0,
        `SKILL.md description must be a non-empty string for ${name}`,
      );
    }
  });

  test('SKILL.md body contains the full <codex_skill_adapter> block produced by the exported builder', () => {
    // Structural check against the production builder's output — NOT a
    // raw substring grep on the rendered file. `getCodexSkillAdapterHeader`
    // is the typed IR exported by bin/install.js (#3582 PR #3609 codex
    // review); the file on disk must contain its full output verbatim
    // (open tag, body, closing `</codex_skill_adapter>`). A truncated,
    // empty, or missing-closing-tag adapter cannot satisfy this assertion.
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const expectedAdapter = getCodexSkillAdapterHeader(name);
      // Sanity: the builder itself must produce a closed block for the
      // assertion below to be meaningful.
      assert.ok(
        expectedAdapter.startsWith('<codex_skill_adapter>'),
        `getCodexSkillAdapterHeader(${name}) must start with the opening tag`,
      );
      assert.ok(
        expectedAdapter.trimEnd().endsWith('</codex_skill_adapter>'),
        `getCodexSkillAdapterHeader(${name}) must end with the closing tag`,
      );

      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      assert.ok(
        content.includes(expectedAdapter),
        `${name}/SKILL.md must contain the full adapter block produced by getCodexSkillAdapterHeader(${name}); Codex routes $${name} via this exact body`,
      );
    }
  });

  test('representative skills named in the issue report are present', () => {
    // The bug report and triage explicitly named these. Locking them as a
    // representative set so a future dispatch / filter / profile change
    // cannot drop just the commands the original user was trying to run.
    const representative = [
      'gsd-map-codebase',     // the literal command from the bug report
      'gsd-execute-phase',
      'gsd-plan-phase',
      'gsd-new-project',
      'gsd-health',
    ];
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    for (const name of representative) {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      assert.ok(
        fs.existsSync(skillMd),
        `${name}/SKILL.md must exist after Codex install (was unrouteable in 1.42.2)`,
      );
    }
  });

  test('installed Codex skills do not ask agents to run bare gsd-tools commands', () => {
    const skillsDir = codexSkillsRoot(installRun.codexHome);
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
      .map(e => e.name);

    for (const name of skillDirs) {
      const content = fs.readFileSync(
        path.join(skillsDir, name, 'SKILL.md'),
        'utf-8',
      );
      assertNoBareGsdToolsInvocation(content, `${name}/SKILL.md`);
    }
  });

  test('installer success log mentions skills/ — never claims success while skipping', () => {
    // The 1.42.2 user-visible failure mode was a successful install that
    // printed "Skipped Codex skill-copy generation (Codex discovers
    // official skills directly)" while leaving the user with no
    // entrypoints. Lock that the broken strings can NEVER coexist with a
    // success indicator. Current main prints "✓ Installed N skills".
    const cleanLogs = installRun.logs.map(stripAnsi);
    const cleanWarnings = installRun.warnings.map(stripAnsi);
    const allOutput = [...cleanLogs, ...cleanWarnings].join('\n');

    assert.ok(
      !/Skipped Codex skill-copy generation/i.test(allOutput),
      `installer must never print "Skipped Codex skill-copy generation" (1.42.2 failure). Output:\n${allOutput}`,
    );
    assert.ok(
      !/Codex discovers official skills directly/i.test(allOutput),
      `installer must never claim "Codex discovers official skills directly" (1.42.2 incorrect assumption). Output:\n${allOutput}`,
    );

    // Positive proof — at least one log line acknowledges the skills install.
    const hasSkillsInstalledLog = cleanLogs.some(line => /Installed\s+\d+\s+skills\s+to\s+skills\//.test(line));
    assert.ok(
      hasSkillsInstalledLog,
      `installer must print a success line of the form "Installed N skills to skills/". Logs:\n${cleanLogs.join('\n')}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3808-codex-adapter-text-mode-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3808-codex-adapter-text-mode-fallback (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3808.
 *
 * When Codex runs in Default mode, `request_user_input` is reported as
 * unavailable. The Codex skill adapter must tell the agent to activate the
 * workflow's built-in TEXT_MODE mechanism (`--text` flag) rather than either:
 *   (a) silently picking a default value — the #3018 failure mode, or
 *   (b) ad-hoc plain-text fallback that bypasses the workflow's own branching.
 *
 * Workflows (e.g. plan-phase.md) already have TEXT_MODE logic:
 *   "Set TEXT_MODE=true if `--text` is present in $ARGUMENTS OR text_mode
 *    from init JSON is true."
 * The adapter must tell the agent to USE that mechanism when
 * `request_user_input` is unavailable instead of inventing its own fallback
 * or silently continuing with defaults.
 *
 * Test design: mirrors the typed-semantic-flag pattern from bug #3018 so that
 * prose rewording doesn't break tests as long as the semantics stay correct.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { getCodexSkillAdapterHeader } = INSTALL;
const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

/**
 * Extract the "Execute mode fallback" section text from the adapter header.
 * Returns null if the section is missing. Section runs from the
 * "Execute mode fallback:" label up to the next heading or </codex_skill_adapter> tag.
 */
function extractExecuteModeFallback(header) {
  const label = 'Execute mode fallback:';
  const labelIdx = header.indexOf(label);
  if (labelIdx === -1) return null;
  const bodyStart = header.indexOf('\n', labelIdx + label.length);
  if (bodyStart === -1) return null;

  // End at whichever comes first: the next "## " heading (via the canonical
  // heading tokenizer, not an ad-hoc regex) or the closing adapter tag.
  const headings = tokenizeHeadings(header).filter((h) => h.level === 2 && h.offset > bodyStart);
  const nextHeadingOffset = headings.length > 0 ? headings[0].offset - 1 : Infinity; // -1 for the leading \n
  const closeTagIdx = header.indexOf('</codex_skill_adapter>', bodyStart);
  const closeTagOffset = closeTagIdx === -1 ? Infinity : closeTagIdx - 1; // -1 for the leading \n
  const bodyEnd = Math.min(nextHeadingOffset, closeTagOffset);
  if (bodyEnd === Infinity) return null;

  return header.slice(bodyStart + 1, bodyEnd).trim();
}

/**
 * Parse the Execute-mode-fallback section into a typed semantic-flag record.
 *
 * Flags for bug #3808 (TEXT_MODE activation):
 *   activatesTextMode       — does the prose tell the agent to activate TEXT_MODE / use --text?
 *   instructsStop           — does the prose tell the agent to stop/halt/wait?
 *   presentsPlainText       — does the prose mention plain-text / numbered-list presentation?
 *   silentlyPicksDefaults   — (anti-pattern) does the prose instruct silent-default picking?
 */
function parseExecuteModeFallbackFor3808(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      activatesTextMode: false,
      instructsStop: false,
      presentsPlainText: false,
      silentlyPicksDefaults: false,
    };
  }

  const lower = section.toLowerCase();

  // (a) TEXT_MODE activation — adapter must tell the agent to use the workflow's
  // built-in text mode mechanism when request_user_input is unavailable.
  // Accept either: explicit "--text" flag mention OR "text_mode" / "text mode"
  // paired with context showing it is being SET/ACTIVATED (not just referenced).
  const mentionsTextFlag   = section.includes('--text');
  const mentionsTextModeOn = /text_mode\s*=\s*true|set\s+text_mode|activate\s+text.?mode|enable\s+text.?mode|text.?mode.*active|text.?mode.*on\b/i.test(section);
  const activatesTextMode  = mentionsTextFlag || mentionsTextModeOn;

  // (b) STOP/WAIT directive — the agent must halt instead of proceeding silently.
  const instructsStop = /\b(stop|halt|wait)\b/.test(lower);

  // (c) Plain-text fallback presentation.
  const presentsPlainText = /plain.?text|numbered list/.test(lower);

  // Anti-pattern guard — the prose that caused #3018 and resurfaces in #3808.
  const silentlyPicksDefaults = /pick (a |the )?(reasonable|sensible|sane) default/i.test(section);

  return {
    ok: true,
    sectionLength: section.length,
    activatesTextMode,
    instructsStop,
    presentsPlainText,
    silentlyPicksDefaults,
  };
}

describe('bug #3808: codex skill adapter activates TEXT_MODE when request_user_input is unavailable', () => {
  const SKILL_NAMES = ['gsd-plan-phase', 'gsd-discuss-phase', 'gsd-execute-phase', 'gsd-verify-work'];

  test('getCodexSkillAdapterHeader is exported', () => {
    assert.equal(typeof getCodexSkillAdapterHeader, 'function');
  });

  test('Execute mode fallback section exists for all key skills', () => {
    for (const skillName of SKILL_NAMES) {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      assert.ok(section !== null && section.length > 0,
        `${skillName}: Execute mode fallback section must exist and have content`);
    }
  });

  for (const skillName of SKILL_NAMES) {
    test(`${skillName}: fallback activates TEXT_MODE (--text flag or text_mode=true) when request_user_input is unavailable`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.activatesTextMode, true,
        `${skillName}: fallback must instruct the agent to activate TEXT_MODE (mention --text flag or text_mode=true/active) when request_user_input is unavailable (#3808). Section was:\n${section}`);
    });

    test(`${skillName}: fallback instructs STOP/WAIT (not silent continuation)`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.instructsStop, true,
        `${skillName}: fallback must include stop/halt/wait instruction. Section was:\n${section}`);
    });

    test(`${skillName}: fallback does NOT contain silent-default anti-pattern`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.silentlyPicksDefaults, false,
        `${skillName}: regression — fallback must NOT instruct the agent to pick defaults autonomously (#3018 / #3808). Section was:\n${section}`);
    });
  }

  test('typed semantic-record snapshot for gsd-plan-phase — full contract', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-plan-phase'));
    const parsed = parseExecuteModeFallbackFor3808(section);
    assert.deepStrictEqual(
      {
        ok: parsed.ok,
        activatesTextMode: parsed.activatesTextMode,
        instructsStop: parsed.instructsStop,
        presentsPlainText: parsed.presentsPlainText,
        silentlyPicksDefaults: parsed.silentlyPicksDefaults,
      },
      {
        ok: true,
        activatesTextMode: true,
        instructsStop: true,
        presentsPlainText: true,
        silentlyPicksDefaults: false,
      },
      `gsd-plan-phase: full TEXT_MODE fallback contract violated (#3808). Section was:\n${section}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-570-codex-leak-scanner.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-570-codex-leak-scanner (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #570)
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #570 — three related sub-bugs in the Codex leak
 * scanner and supporting infrastructure.
 *
 * SUB-BUG A: scanForLeakedPaths recursively scans the entire targetDir,
 *   including pre-existing unrelated files that contain ~/.claude references.
 *   Fix: scan only files listed in gsd-file-manifest.json.
 *
 * SUB-BUG B: convertClaudeToCodexMarkdown replaces "~/.claude/" (with trailing
 *   slash) but NOT bare "~/.claude" (no slash). The scanner regex
 *   /(?:~|\$HOME)\/\.claude\b/ matches without trailing slash.
 *   Fix: add bare word-boundary replacement.
 *
 * SUB-BUG C: writeManifest checks file.endsWith('.md') for the agents/
 *   directory. Codex installs .toml agent files, so they are invisible to the
 *   manifest and thus to any manifest-based scan fix.
 *   Fix: also check .toml.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const {
  install,
  convertClaudeCommandToCodexSkill,
} = require('../bin/install.js');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

function withCodexHome(codexHome, fn) {
  const prev = process.env.CODEX_HOME;
  // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
  // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
  // CODEX_HOME. Fake $HOME (and $USERPROFILE) too — using the sandbox root
  // (codexHome's parent, since codexHome is conventionally `<tmpRoot>/.codex`
  // in this file) — so this in-process install never touches the developer/CI
  // machine's real home directory. tmpRoot is reclaimed by the caller's afterEach.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fakeHome = path.dirname(codexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

describe('#570 — Codex leak scanner sub-bugs', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      throwIfFailed(
        runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
        `node ${BUILD_HOOKS_SCRIPT}`,
      );
    }
    tmpRoot = createTempDir('gsd-570-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  // SUB-BUG B
  test('convertClaudeToCodexMarkdown replaces bare ~/.claude (no trailing slash)', () => {
    // convertClaudeToCodexMarkdown is not exported directly; exercise it via
    // convertClaudeCommandToCodexSkill which calls it internally.
    const input = 'configDir = ~/.claude\npath = ~/.claude/hooks/\ndir = $HOME/.claude';
    const out = convertClaudeCommandToCodexSkill(input, 'gsd-test');

    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `Expected no leaked ~/.claude reference after conversion, got:\n${out}`,
    );
  });

  // SUB-BUG C
  test('writeManifest includes .toml agent files for Codex', () => {
    withCodexHome(codexHome, () => install(true, 'codex'));

    const agentsDir = path.join(codexHome, 'agents');
    // Not the shared listAgentFiles() helper: this reads the INSTALLED Codex
    // dest dir and filters .toml (not source .md), so its semantics differ.
    // Confirm that Codex actually wrote .toml agent files — if none exist the
    // test is vacuous and we should fail loudly.
    const tomlFiles = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.toml'))
      : [];
    assert.ok(
      tomlFiles.length > 0,
      `Precondition: Codex install must write at least one gsd-*.toml in agents/; found none in ${agentsDir}`,
    );

    const manifestPath = path.join(codexHome, 'gsd-file-manifest.json');
    assert.ok(
      fs.existsSync(manifestPath),
      `gsd-file-manifest.json must exist after install; not found at ${manifestPath}`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestKeys = Object.keys(manifest.files || {});

    const tomlManifestKeys = manifestKeys.filter(
      (k) => k.startsWith('agents/gsd-') && k.endsWith('.toml'),
    );
    assert.ok(
      tomlManifestKeys.length > 0,
      `Expected at least one 'agents/gsd-*.toml' key in manifest.files, but found none.\n` +
        `agents/ toml files on disk: ${tomlFiles.join(', ')}\n` +
        `All manifest keys (agents/): ${manifestKeys.filter((k) => k.startsWith('agents/')).join(', ')}`,
    );
  });

  // SUB-BUG A
  test('scanForLeakedPaths does not warn for pre-existing unrelated files in ~/.codex', () => {
    // Write a pre-existing file with ~/.claude references BEFORE install.
    const memoriesDir = path.join(codexHome, 'memories');
    fs.mkdirSync(memoriesDir, { recursive: true });
    const preExistingFile = path.join(memoriesDir, 'raw_memories.md');
    fs.writeFileSync(
      preExistingFile,
      '# Old memories\nI used to work in ~/.claude and $HOME/.claude regularly.\n',
    );

    let captured;
    withCodexHome(codexHome, () => {
      captured = captureConsole(() => install(true, 'codex'));
    });

    const combinedOutput = captured.stderr;

    assert.ok(
      !combinedOutput.includes('memories/raw_memories.md'),
      `scanForLeakedPaths must not warn about pre-existing unrelated file memories/raw_memories.md.\n` +
        `Actual warnings:\n${combinedOutput}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-704-codex-launcher-path-corruption.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-704-codex-launcher-path-corruption (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #704)
'use strict';

/**
 * Regression test for issue #704:
 * "v1.3.1 global install ships literal $gsd-core launcher paths in workflows"
 *
 * ROOT CAUSE: `convertSlashCommandsToCodexSkillMentions` had a regex
 *   /(?<![a-zA-Z0-9./])\/gsd-([a-z0-9-]+)/
 * The lookbehind did NOT include `}`, so shell variable expressions like
 *   `${_GSD_RUNTIME_ROOT}/gsd-core/bin/...`
 * had their `/gsd-core` matched (the char before `/` was `}`, not in the
 * exclusion set), converting it to `$gsd-core` and breaking all Codex
 * workflow launcher paths.
 *
 * FIX: Add `}` to the lookbehind set so `${VAR}/gsd-core/` is excluded.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  convertClaudeCommandToCodexSkill,
  convertSlashCommandsToCodexSkillMentions,
} = require('../bin/install.js');

// The canonical launcher snippet path that was being corrupted
const RUNTIME_ROOT_PATH = '${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}';
// The exact bad token reported in issue #704
const BAD_TOKEN = '$gsd-core';

describe('#704 — Codex global install launcher path corruption', () => {
  test('convertClaudeCommandToCodexSkill does not corrupt ${VAR}/gsd-core/ or $(cmd)/gsd-* paths', () => {
    // Minimal fixture with the launcher snippet and command-substitution patterns
    // that were being corrupted (#704).
    const input = [
      '---',
      'description: Test skill',
      '---',
      '',
      '```bash',
      '_GSD_SHIM_NAME="gsd-tools.cjs"',
      '_GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"',
      'GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"',
      'if [ -f "$GSD_TOOLS" ]; then',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'fi',
      '# Command-substitution path form (reapply-patches pattern)',
      'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"',
      '```',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*` from shell variable expressions `${VAR}/gsd-*`
    //   - `)$gsd-*` from command-substitution paths `$(cmd)/gsd-*`
    const shellCorruptionPatterns = [
      { pattern: '}' + BAD_TOKEN, description: 'shell-variable }$gsd-core' },
      { pattern: ')$gsd-local', description: 'command-substitution )$gsd-local-patches' },
    ];
    for (const { pattern, description } of shellCorruptionPatterns) {
      assert.ok(
        !output.includes(pattern),
        `Codex skill conversion must not produce "${pattern}" (${description}). ` +
          `Offending fragment: ${
            output.includes(pattern)
              ? output.substring(output.indexOf(pattern) - 50, output.indexOf(pattern) + 80)
              : '(not found)'
          }`,
      );
    }

    // The correct path forms must be preserved — the canonical launcher path
    // (RUNTIME_ROOT_PATH) must survive Codex conversion intact.
    assert.ok(
      output.includes(RUNTIME_ROOT_PATH),
      `Expected canonical launcher path "${RUNTIME_ROOT_PATH}" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
    assert.ok(
      output.includes(')/gsd-local-patches'),
      `Expected ")/gsd-local-patches" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
  });

  test('convertClaudeCommandToCodexSkill preserves all shell path forms (}, ) closers)', () => {
    // All these paths appear after a shell-closing character (} or )) and must
    // NOT be converted to $gsd-* by the Codex slash-command converter.
    const shellPaths = [
      // Shell variable expression forms (} closer)
      { path: '"${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      // Command-substitution forms () closer) — reapply-patches pattern
      { path: 'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
      { path: 'candidate="$(dirname "$(expand_home "$OPENCODE_CONFIG")")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
    ];

    for (const { path: p, corruptedForm } of shellPaths) {
      const input = `---\ndescription: Test\n---\n\n\`\`\`bash\n${p}\n\`\`\``;
      const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-paths');
      assert.ok(
        !output.includes(corruptedForm),
        `Path "${p}" was corrupted to contain "${corruptedForm}" after Codex conversion.\n` +
          `Got:\n${output}`,
      );
    }
  });

  test('convertClaudeCommandToCodexSkill still converts legitimate /gsd-<cmd> slash mentions', () => {
    // Slash-command mentions (not preceded by }) should still be converted
    const input = [
      '---',
      'description: Test',
      '---',
      '',
      'Use /gsd-discuss-phase to start a discussion.',
      'Or use /gsd-plan-phase for planning.',
      'Also: /gsd:capture --backlog adds items.',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-cmds');

    assert.ok(
      output.includes('$gsd-discuss-phase'),
      'Expected /gsd-discuss-phase to be converted to $gsd-discuss-phase',
    );
    assert.ok(
      output.includes('$gsd-plan-phase'),
      'Expected /gsd-plan-phase to be converted to $gsd-plan-phase',
    );
    assert.ok(
      output.includes('$gsd-capture'),
      'Expected /gsd:capture to be converted to $gsd-capture',
    );
  });

  test('actual shipped workflow files: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk gsd-core/workflows/ and assert that no file produces $gsd-core
    // inside a shell variable expansion context after Codex conversion.
    //
    // NOTE: The backtick-wrapped prose-path case (`/gsd-core/workflows/update.md`)
    // was a pre-existing gap with the #704 lookbehind fix and is now addressed by
    // the positive-boundary regex introduced in #712. That case is covered by the
    // "#712" describe block below.
    //
    // We probe for the specific shell-context pattern from the issue report:
    //   BAD:  ${_GSD_RUNTIME_ROOT}$gsd-core/bin/
    //   GOOD: ${_GSD_RUNTIME_ROOT}/gsd-core/bin/
    const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      // If the directory doesn't exist, skip gracefully (non-standard layout)
      return;
    }

    const files = fs.readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(workflowsDir, f));

    assert.ok(files.length > 0, 'Expected at least one workflow .md file');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*`: closing brace from `${VAR}/gsd-*` shell variable expressions
    //   - `)$gsd-*`: closing paren from `$(cmd)/gsd-*` command substitutions
    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(workflowsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted workflow files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });

  test('commands/gsd/*.md: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk commands/gsd/ and assert that no command file produces the shell-context
    // }$gsd-core corruption — since commands also go through
    // convertClaudeCommandToCodexSkill when installed globally for Codex.
    const commandsDir = path.join(__dirname, '..', 'commands', 'gsd');
    if (!fs.existsSync(commandsDir)) return;

    const files = fs.readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(commandsDir, f));

    assert.ok(files.length > 0, 'Expected at least one command .md file');

    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(commandsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted command files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });
});

describe('#712: positive-boundary slash-command conversion', () => {
  // Tests call convertSlashCommandsToCodexSkillMentions directly so the regex
  // is exercised in isolation — no frontmatter wrapping, no ADAPTER_CLOSE
  // stripping, no .claude→.codex rewrite masking the result.

  // ── MUST-NOT-CONVERT (negative) cases ─────────────────────────────────────
  // These inputs must be returned UNCHANGED — no $gsd-* substitution.

  test('backtick-wrapped path: `/gsd-core/workflows/update.md` is NOT converted (THE new fix)', () => {
    const input = 'See `/gsd-core/workflows/update.md` for details.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected backtick-wrapped path to be unchanged. Got: ${result}`,
    );
  });

  test('backtick-wrapped path deeper: `/gsd-pi/bin/foo.cjs` is NOT converted', () => {
    const input = 'Run `/gsd-pi/bin/foo.cjs` directly.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected deep backtick-wrapped path to be unchanged. Got: ${result}`,
    );
  });

  test('shell var expansion: ${_GSD_RUNTIME_ROOT}/gsd-core/bin/x is NOT converted (regression guard)', () => {
    const input = 'PATH="${_GSD_RUNTIME_ROOT}/gsd-core/bin/x"';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes('$gsd-core'),
      `Expected no $gsd-core substitution in shell var path. Got: ${result}`,
    );
    assert.ok(
      result.includes('/gsd-core/bin/x'),
      `Expected original path to be preserved. Got: ${result}`,
    );
  });

  test('command substitution: $(expand_home ~/.claude)/gsd-local-patches is NOT converted (regression guard)', () => {
    const input = 'candidate="$(expand_home ~/.claude)/gsd-local-patches"';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes(')$gsd-local'),
      `Expected no )$gsd-local substitution. Got: ${result}`,
    );
    assert.ok(
      result.includes(')/gsd-local-patches'),
      `Expected original path to be preserved. Got: ${result}`,
    );
  });

  test('plain path segment: bin/gsd-tools.cjs is NOT converted', () => {
    const input = 'node bin/gsd-tools.cjs --help';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.strictEqual(
      result,
      input,
      `Expected plain path segment to be unchanged. Got: ${result}`,
    );
  });

  test('plain path segment: .claude/gsd-core/agents — /gsd-core portion is NOT slash-command converted', () => {
    // Tests the regex in isolation: the .claude→.codex path rewrite that happens
    // inside convertClaudeToCodexMarkdown does NOT run here. We assert directly
    // that the slash-command regex leaves /gsd-core after the slash intact —
    // i.e. the `e` in `/gsd-core` is NOT treated as a command boundary.
    const input = 'Look in .claude/gsd-core/agents for the agent files.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      !result.includes('$gsd-core'),
      `Expected no $gsd-core substitution in .claude/gsd-core path. Got: ${result}`,
    );
    assert.ok(
      result.includes('/gsd-core/agents'),
      `Expected /gsd-core/agents to remain as a path segment. Got: ${result}`,
    );
  });

  // ── MUST-CONVERT (positive) cases ─────────────────────────────────────────
  // These inputs contain legitimate /gsd-<cmd> mentions that MUST be converted.

  test('space-preceded prose: Use /gsd-discuss-phase to start. → $gsd-discuss-phase', () => {
    const input = 'Use /gsd-discuss-phase to start.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('$gsd-discuss-phase'),
      `Expected /gsd-discuss-phase to be converted. Got: ${result}`,
    );
    assert.ok(
      !result.includes('/gsd-discuss-phase'),
      `Expected original /gsd-discuss-phase to be replaced. Got: ${result}`,
    );
  });

  test('backtick-WRAPPED MENTION (single segment): Run `/gsd-execute-phase` now → `$gsd-execute-phase`', () => {
    // A backtick-wrapped COMMAND (single segment, no path continuation) MUST
    // still be converted — this guards against a naive whitespace-only fix.
    const input = 'Run `/gsd-execute-phase` now.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('`$gsd-execute-phase`'),
      `Expected backtick-wrapped command to be converted to \`$gsd-execute-phase\`. Got: ${result}`,
    );
    assert.ok(
      !result.includes('`/gsd-execute-phase`'),
      `Expected original \`/gsd-execute-phase\` to be replaced. Got: ${result}`,
    );
  });

  test('parenthetical/backtick list like CONTEXT.md:59: (`/gsd-plan-phase`, `/gsd-progress`) → converted', () => {
    const input = 'Available commands: (`/gsd-plan-phase`, `/gsd-progress`) — pick one.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('`$gsd-plan-phase`'),
      `Expected /gsd-plan-phase to be converted. Got: ${result}`,
    );
    assert.ok(
      result.includes('`$gsd-progress`'),
      `Expected /gsd-progress to be converted. Got: ${result}`,
    );
  });

  test('start-of-string: /gsd-manager runs → $gsd-manager runs (exercises the ^ branch of lookbehind)', () => {
    // This case is IMPOSSIBLE to test through the frontmatter-wrapping pipeline
    // (the body always has preceding chars). Direct call exercises the ^ branch.
    const input = '/gsd-manager runs the pipeline.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('$gsd-manager'),
      `Expected /gsd-manager to be converted. Got: ${result}`,
    );
    assert.ok(
      !result.includes('/gsd-manager'),
      `Expected original /gsd-manager to be replaced. Got: ${result}`,
    );
  });

  test('double-quote wrapped: "/gsd-resume" → "$gsd-resume"', () => {
    const input = 'Call "/gsd-resume" to continue.';
    const result = convertSlashCommandsToCodexSkillMentions(input);
    assert.ok(
      result.includes('"$gsd-resume"'),
      `Expected "/gsd-resume" to be converted to "$gsd-resume". Got: ${result}`,
    );
    assert.ok(
      !result.includes('"/gsd-resume"'),
      `Expected original "/gsd-resume" to be replaced. Got: ${result}`,
    );
  });

  // ── End-to-end: headline #712 bug through the real install pipeline ────────

  test('end-to-end: backtick-wrapped path `/gsd-core/workflows/update.md` survives full Codex install pipeline', () => {
    // Uses convertClaudeCommandToCodexSkill (same pattern as #704 tests above)
    // to prove the real install path does not corrupt prose references to repo paths.
    const input = [
      '---',
      'description: Test',
      '---',
      '',
      'See `/gsd-core/workflows/update.md` for the update workflow.',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-712-e2e');

    assert.ok(
      !output.includes('$gsd-core'),
      `Expected no $gsd-core in converted output. Got:\n${output}`,
    );
    assert.ok(
      output.includes('/gsd-core/workflows/update.md'),
      `Expected backtick-wrapped path to survive conversion. Got:\n${output}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-851-codex-quick-adapter-agent-type-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-851-codex-quick-adapter-agent-type-fallback (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #851)
// Tests assert on text in bin/install.js (Codex adapter header prose) —
// the adapter text IS the product loaded by Codex agents at runtime.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');
const src = fs.readFileSync(INSTALL_JS, 'utf8');

// Helper: extract Section C from the raw source text.
// Anchors on the heading and ends at </codex_skill_adapter>.
function getSectionC() {
  // allow-test-rule: source-text-is-the-product (see #851)
  const headingIdx = src.indexOf('## C. Task() → spawn_agent Mapping'); // allow-test-rule: source-text-is-the-product (see #851)
  assert.ok(headingIdx >= 0, 'Section C heading must exist in bin/install.js');
  const closeTag = src.indexOf('</codex_skill_adapter>', headingIdx); // allow-test-rule: source-text-is-the-product (see #851)
  assert.ok(closeTag >= 0, 'Section C must be followed by </codex_skill_adapter>');
  return src.slice(headingIdx, closeTag);
}

describe('bug #851: Codex adapter documents multi_agent_v1 schema limitation and fallback', () => {

  // (a) Schema-detection step: the adapter must require the agent to inspect
  //     spawn_agent's parameter schema BEFORE deciding how to dispatch.
  test('(a) schema-detection: adapter requires inspecting spawn_agent schema before dispatching', () => {
    const sectionC = getSectionC();

    // Must name BOTH schema variants so the agent knows what to look for
    assert.ok(
      sectionC.includes('multi_agent_v1'),
      'Section C must name the multi_agent_v1 schema to identify the limited form',
    );
    assert.ok(
      sectionC.includes('multi_agent_v2') || sectionC.includes('agent_type-capable'),
      'Section C must name the typed schema (multi_agent_v2 or agent_type-capable) as the capable form',
    );

    // Must instruct schema inspection before spawning
    assert.ok(
      sectionC.includes('tool_search') || sectionC.includes('inspect') || sectionC.includes('schema'),
      'Section C must instruct the agent to inspect the spawn_agent schema (via tool_search or similar)',
    );

    // All three requirements together (AND):
    assert.ok(
      sectionC.includes('multi_agent_v1') &&
      (sectionC.includes('multi_agent_v2') || sectionC.includes('agent_type-capable')) &&
      (sectionC.includes('tool_search') || sectionC.includes('inspect') || sectionC.includes('schema')),
      'Section C must require schema-detection: name both schema variants AND instruct inspection before spawning',
    );
  });

  // (b) Active-config-root resolution: the TOML path must describe how to
  //     resolve the config root (honoring $CODEX_HOME / --config-dir / --local),
  //     not imply a single fixed path.
  test('(b) active-config-root: fallback TOML path resolves the active Codex config root', () => {
    const sectionC = getSectionC();

    // Must mention the agents/<agent-name>.toml relative path
    assert.ok(
      sectionC.includes('agents/<agent-name>.toml'),
      'Section C must reference agents/<agent-name>.toml for the TOML extraction step',
    );

    // Must describe dynamic config-root resolution (at least two of the three
    // override mechanisms, plus the word "config" to anchor context)
    const mentionsCodexHome = sectionC.includes('$CODEX_HOME') || sectionC.includes('CODEX_HOME');
    const mentionsConfigDir = sectionC.includes('--config-dir') || sectionC.includes('config-dir');
    const mentionsLocal = sectionC.includes('--local') || sectionC.includes('.codex') || sectionC.includes('local');
    const mentionsConfigRoot = sectionC.includes('config root') || sectionC.includes('config.toml') || sectionC.includes('config directory');

    assert.ok(
      mentionsCodexHome,
      'Section C fallback must mention $CODEX_HOME for config-root resolution',
    );
    assert.ok(
      mentionsConfigDir,
      'Section C fallback must mention --config-dir for config-root resolution',
    );
    assert.ok(
      mentionsLocal,
      'Section C fallback must mention --local / .codex for config-root resolution',
    );
    assert.ok(
      mentionsConfigRoot,
      'Section C fallback must describe the concept of an active config root (config.toml or config root/directory)',
    );

    // AND: all four required elements together
    assert.ok(
      mentionsCodexHome && mentionsConfigDir && mentionsLocal && mentionsConfigRoot,
      'Section C fallback must describe active-config-root resolution: $CODEX_HOME + --config-dir + --local + config-root concept (AND logic)',
    );

    // Must NOT contain the literal ~/.codex/ (would be rewritten by _applyRuntimeRewrites
    // and cause bug-3582 to diverge)
    assert.ok(
      !sectionC.includes('~/.codex/'),
      'Section C must NOT contain the literal ~/.codex/ substring (breaks bug-3582 materialization test)',
    );
  });

  // (c) "NOT equivalent" label: the workaround must be explicitly labeled as
  //     not equivalent to typed gsd-planner/gsd-executor execution.
  test('(c) not-equivalent label: generic-agent workaround is labeled as NOT equivalent to typed dispatch', () => {
    const sectionC = getSectionC();

    // Must name at least one typed agent
    const namesTypedAgent =
      sectionC.includes('gsd-planner') ||
      sectionC.includes('gsd-executor') ||
      sectionC.includes('typed GSD agent') ||
      sectionC.includes('typed gsd-');

    // Must contain explicit "not equivalent" / "NOT equivalent" / negation language
    const hasNotEquivalent =
      sectionC.toLowerCase().includes('not equivalent') ||
      sectionC.includes('NOT equivalent') ||
      sectionC.includes('is NOT possible');

    // Must name the workaround as a workaround, not a first-class path
    const hasWorkaroundLabel =
      sectionC.includes('workaround') ||
      sectionC.includes('fallback');

    assert.ok(
      namesTypedAgent,
      'Section C must name at least one typed GSD agent (gsd-planner, gsd-executor, or "typed GSD agent")',
    );
    assert.ok(
      hasNotEquivalent,
      'Section C must contain explicit "not equivalent" / "NOT equivalent" language for the generic-agent path',
    );
    assert.ok(
      hasWorkaroundLabel,
      'Section C must label the generic-agent path as a workaround or fallback',
    );

    // AND: all three together
    assert.ok(
      namesTypedAgent && hasNotEquivalent && hasWorkaroundLabel,
      'Section C must AND: name a typed agent + label it NOT equivalent + call the generic path a workaround/fallback',
    );
  });

  // (d) Fail-closed rule: when typed dispatch is mandatory, the adapter must
  //     instruct the agent to fail closed and report the limitation, not silently degrade.
  test('(d) fail-closed: adapter requires failing closed when typed dispatch is mandatory', () => {
    const sectionC = getSectionC();

    const hasFailClosed =
      sectionC.includes('fail closed') ||
      sectionC.includes('fail-closed') ||
      sectionC.includes('fail_closed');

    const hasReportLimitation =
      sectionC.includes('schema limitation') ||
      sectionC.includes('report') ||
      sectionC.includes('not silently') ||
      sectionC.includes('silently degrading') ||
      sectionC.includes('silently');

    const hasMandatoryContext =
      sectionC.includes('mandatory') ||
      sectionC.includes('required') ||
      sectionC.includes('worktree isolation') ||
      sectionC.includes('isolation');

    assert.ok(
      hasFailClosed,
      'Section C must instruct fail-closed behavior (the phrase "fail closed" or equivalent)',
    );
    assert.ok(
      hasReportLimitation,
      'Section C must instruct reporting the schema limitation rather than silently degrading',
    );
    assert.ok(
      hasMandatoryContext,
      'Section C must identify a context where typed dispatch is mandatory (e.g. worktree isolation)',
    );

    // AND: all three together
    assert.ok(
      hasFailClosed && hasReportLimitation && hasMandatoryContext,
      'Section C must AND: instruct fail-closed + report limitation + identify mandatory-typed-dispatch contexts',
    );
  });

  // Regression guard: typed mapping for capable schema must still be present.
  test('adapter still documents typed agent_type spawn for sessions that support it', () => {
    const sectionC = getSectionC();

    assert.ok(
      sectionC.includes('agent_type-capable') || sectionC.includes('multi_agent_v2'),
      'Section C must still document the typed schema (agent_type-capable / multi_agent_v2)',
    );
    assert.ok(
      sectionC.includes('spawn_agent(agent_type=') || sectionC.includes('agent_type="X"'),
      'Section C must still show a typed spawn_agent(agent_type=...) example for capable sessions',
    );
  });

  // Regression guard: deferred tool discovery must remain (bug-279 contract).
  test('adapter deferred tool discovery instruction is preserved', () => {
    // The pre-existing bug-279 contract must remain intact
    // allow-test-rule: source-text-is-the-product (see #851)
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'), // allow-test-rule: source-text-is-the-product (see #851)
      'Adapter must still instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-772-codex-hook-events.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-772-codex-hook-events (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #772: Adopt new stable Codex hook events + commandWindows for
 * Windows parity.
 *
 * Codex CLI (rust-v0.137.0) stabilised the full hook-event set. This suite
 * asserts that a Codex install:
 *
 * (a) Registers the 3 new high-value hook events in hooks.json:
 *   - SubagentStart — inject context / GSD_AGENT_NAME awareness at subagent open
 *   - Stop          — post-session context headroom tracking
 *   - PostToolUse   — mirror the Claude Code PostToolUse context monitor
 *
 * (b) Emits `commandWindows` in the SessionStart hooks.json entry so that
 *   Windows users get the .cmd shim path and non-Windows users get the POSIX
 *   node runner command. Both fields are present in the same entry; Codex picks
 *   the right one per its HookHandlerConfig schema
 *   (codex-rs/config/src/hook_config.rs: commandWindows / command_windows alias).
 *
 * Note: UserPromptSubmit is NOT wired (same rationale as Qwen #788 — the
 * gsd-prompt-guard handler exits unless tool_name is Write|Edit, so it would be
 * a silent no-op for the UserPromptSubmit payload shape).
 *
 * Test strategy:
 *   - Test new event registration via ensureCodexHooksJsonEvent() directly
 *     (mirrors the #3426 pattern of testing ensureCodexHooksJsonSessionStart
 *     directly with a stub hook file — avoids full install() migration dance).
 *   - Test commandWindows via ensureCodexHooksJsonSessionStart() directly.
 *   - IR-first discipline: assert on the structured result, not rendered text.
 *
 * Verified hook event schema:
 *   https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 *   https://github.com/openai/codex/blob/main/codex/codex-rs/config/src/hook_config.rs
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ensureCodexHooksJsonSessionStart,
  ensureCodexHooksJsonEvent,
  removeCodexHooksJsonEvent,
  reconcileCodexHooksJsonEvent,
} = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract all hook handler entries (full objects with type/command/etc.) for
 * `eventName` from a hooks.json object (flat or nested-hooks shape).
 */
function hooksJsonHandlersForEvent(hooksJson, eventName) {
  if (!hooksJson || typeof hooksJson !== 'object') return [];
  const table =
    hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)
      ? hooksJson.hooks
      : hooksJson;
  if (!Array.isArray(table[eventName])) return [];
  return table[eventName].flatMap(entry =>
    Array.isArray(entry && entry.hooks) ? entry.hooks : []
  );
}

function readHooksJson(targetDir) {
  const p = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stubHookFile(targetDir, hookName) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  const dest = path.join(hooksDest, hookName);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

// ─── Suite 1: ensureCodexHooksJsonEvent export surface ───────────────────────

describe('enh-772: export surface — new functions are exported', () => {
  test('ensureCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof ensureCodexHooksJsonEvent, 'function',
      'ensureCodexHooksJsonEvent must be exported from runtime-hooks-surface.cjs');
  });

  test('removeCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof removeCodexHooksJsonEvent, 'function',
      'removeCodexHooksJsonEvent must be exported from runtime-hooks-surface.cjs');
  });

  test('reconcileCodexHooksJsonEvent is a function', () => {
    assert.strictEqual(typeof reconcileCodexHooksJsonEvent, 'function',
      'reconcileCodexHooksJsonEvent must be exported from runtime-hooks-surface.cjs');
  });
});

// ─── Suite 2: ensureCodexHooksJsonEvent registers new events ─────────────────

describe('enh-772: ensureCodexHooksJsonEvent registers SubagentStart, Stop, PostToolUse', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-events-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: ensureCodexHooksJsonEvent writes hooks.json`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const result = ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      assert.ok(result && result.path, `result must have path for ${eventName}`);
      assert.ok(result.wrote || result.changed,
        `ensureCodexHooksJsonEvent must write or change hooks.json for ${eventName}`);
      assert.ok(fs.existsSync(path.join(tmpDir, 'hooks.json')),
        `hooks.json must exist after registering ${eventName}`);
    });

    test(`${eventName}: hooks.json contains the event entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0,
        `Expected ${eventName} entry in hooks.json; got: ${JSON.stringify(hooksJson)}`);
    });

    test(`${eventName}: hook entry uses gsd-context-monitor`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(
        handlers.some(h => h.command && h.command.includes('gsd-context-monitor')),
        `${eventName} hook must use gsd-context-monitor; got: ${JSON.stringify(handlers)}`
      );
    });

    test(`${eventName}: hook entry has type: 'command'`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.type, 'command',
        `${eventName} hook entry must have type 'command'`);
    });

    test(`${eventName}: hook entry has timeout: 10`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      const entry = handlers.find(h => h.command && h.command.includes('gsd-context-monitor'));
      assert.strictEqual(entry && entry.timeout, 10,
        `${eventName} hook entry must have timeout 10`);
    });
  }

  test('null absoluteRunner returns unchanged result without writing', () => {
    const result = ensureCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false,
      'null runner must return changed: false');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'hooks.json')),
      'hooks.json must NOT be written when runner is null');
  });
});

// ─── Suite 3: commandWindows parity in SessionStart ──────────────────────────

describe('enh-772: commandWindows parity — ensureCodexHooksJsonSessionStart emits commandWindows', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-cmdwin-');
    stubHookFile(tmpDir, 'gsd-check-update.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // commandWindows is ONLY emitted on win32 platform (where the .cmd shim is also
  // written). On POSIX platforms, commandWindows is omitted to avoid pointing Windows
  // Codex at a non-existent .cmd file (the shim is only present after a native Windows
  // install that runs buildCodexHookWindowsShimIR and atomicWriteFileSync).

  test('POSIX platform: commandWindows is NOT emitted (shim not written on POSIX)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    assert.ok(result && result.wrote, 'must write hooks.json on linux');

    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    assert.ok(handlers.length > 0, `Expected SessionStart handlers; got: ${JSON.stringify(hooksJson)}`);

    const entry = handlers[0];
    assert.ok(
      entry.commandWindows === undefined,
      `commandWindows must NOT be emitted on POSIX (shim not written); got: ${JSON.stringify(entry)}`
    );
  });

  test('POSIX platform: command references gsd-check-update.js (not .cmd)', () => {
    const fakeRunner = '"/usr/local/bin/node"';
    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });
    const hooksJson = readHooksJson(tmpDir);
    const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
    const entry = handlers[0];
    assert.ok(
      entry.command && entry.command.includes('gsd-check-update'),
      `POSIX command must reference gsd-check-update; got: ${entry.command}`
    );
    assert.ok(
      !entry.command.endsWith('.cmd') && !entry.command.endsWith('.cmd"'),
      `POSIX command must not end with .cmd; got: ${entry.command}`
    );
  });

  test('null absoluteRunner: no commandWindows emitted, no write', () => {
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: null,
      platform: 'linux',
    });
    assert.strictEqual(result.changed, false, 'null runner must return changed: false');
    const hooksJson = readHooksJson(tmpDir);
    if (hooksJson) {
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      for (const h of handlers) {
        assert.ok(!h.commandWindows,
          `commandWindows must not be present when runner is null; got: ${JSON.stringify(h)}`);
      }
    }
  });

  test('Windows platform: SessionStart hook is written with commandWindows pointing to .cmd shim', () => {
    // On win32, both `command` and `commandWindows` use the .cmd shim path
    // (because managedCommand = shimIR.hookCommand = .cmd path, and
    // commandWindows = same .cmd path). This ensures Codex picks the .cmd
    // on Windows regardless of which field it reads.
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';
    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });
    // The shim write and hooks.json write should succeed in the tmp dir.
    if (result.wrote) {
      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, 'SessionStart');
      assert.ok(handlers.length > 0,
        `SessionStart must be registered on Windows path; got: ${JSON.stringify(hooksJson)}`);
      const entry = handlers[0];
      assert.ok(typeof entry.commandWindows === 'string',
        `commandWindows must be present on Windows path; got: ${JSON.stringify(entry)}`);
      // commandWindows should reference the .cmd shim
      assert.ok(
        entry.commandWindows.includes('gsd-check-update') && entry.commandWindows.includes('.cmd'),
        `commandWindows must reference gsd-check-update.cmd on win32; got: ${entry.commandWindows}`
      );
    }
  });
});

// ─── Suite 4: idempotency ────────────────────────────────────────────────────

describe('enh-772: ensureCodexHooksJsonEvent is idempotent', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-idem-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: calling twice does not duplicate hook entries`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      const opts = { absoluteRunner: fakeRunner, platform: 'linux' };

      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);
      ensureCodexHooksJsonEvent(tmpDir, eventName, opts);

      const hooksJson = readHooksJson(tmpDir);
      const handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.strictEqual(handlers.length, 1,
        `${eventName} should have exactly 1 hook handler after idempotent re-register; got ${handlers.length}: ${JSON.stringify(handlers)}`);
    });
  }
});

// ─── Suite 5: removeCodexHooksJsonEvent ──────────────────────────────────────

describe('enh-772: removeCodexHooksJsonEvent removes managed entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-remove-');
    stubHookFile(tmpDir, 'gsd-context-monitor.js');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const eventName of ['SubagentStart', 'Stop', 'PostToolUse']) {
    test(`${eventName}: removeCodexHooksJsonEvent removes the managed entry`, () => {
      const fakeRunner = '"/usr/local/bin/node"';
      ensureCodexHooksJsonEvent(tmpDir, eventName, {
        absoluteRunner: fakeRunner,
        platform: 'linux',
      });

      // Verify it was registered
      let hooksJson = readHooksJson(tmpDir);
      let handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
      assert.ok(handlers.length > 0, `${eventName} must be registered before removal`);

      // Remove
      const result = removeCodexHooksJsonEvent(tmpDir, eventName);
      assert.ok(result.changed || result.wrote,
        `removeCodexHooksJsonEvent must change hooks.json for ${eventName}`);

      hooksJson = readHooksJson(tmpDir);
      if (hooksJson) {
        handlers = hooksJsonHandlersForEvent(hooksJson, eventName);
        assert.strictEqual(handlers.length, 0,
          `After removal, ${eventName} should have 0 handlers; got: ${JSON.stringify(handlers)}`);
      }
    });
  }
});

// ─── Suite 6: reconcileCodexHooksJsonEvent preserves user entries ─────────────

describe('enh-772: reconcileCodexHooksJsonEvent preserves user-owned entries', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-772-preserve-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('user-owned SubagentStart entry is preserved when GSD entry is registered', () => {
    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    const userEntry = {
      hooks: [{ type: 'command', command: 'my-custom-hook.sh' }]
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify({
      SubagentStart: [userEntry]
    }, null, 2) + '\n');

    reconcileCodexHooksJsonEvent(tmpDir, 'SubagentStart', {
      managedCommand: '"/usr/local/bin/node" "/home/me/.codex/hooks/gsd-context-monitor.js"',
    });

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const table = hooksJson.hooks || hooksJson;
    const entries = Array.isArray(table.SubagentStart) ? table.SubagentStart : [];
    // Should have 2 entries: user entry + GSD entry
    assert.ok(entries.length >= 2,
      `User entry must be preserved; got entries: ${JSON.stringify(entries)}`);
    // User entry must still be present
    const userEntryStillPresent = entries.some(e =>
      Array.isArray(e.hooks) && e.hooks.some(h => h.command === 'my-custom-hook.sh')
    );
    assert.ok(userEntryStillPresent,
      `User entry must survive GSD registration; entries: ${JSON.stringify(entries)}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2866-codex-strip-no-trailing-newline.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2866-codex-strip-no-trailing-newline (consolidation epic #1969 B8 #1977)", () => {
/**
 * Bug #2866: Codex Installer (RC.7) fails to strip legacy flat hooks if
 * trailing newline is missing.
 *
 * The cleanup regexes in `bin/install.js` matched stale GSD hook blocks
 * via `\r?\n` at the end. When a stale block sat at end-of-file without
 * a trailing newline (very common — many editors strip them, and the
 * legacy installer never wrote one), no shape stripped, the installer
 * saw `gsd-check-update` already present, skipped writing the new
 * Nested-AoT block, and Codex 0.125+ refused to load with
 *   "invalid type: map, expected a sequence in `hooks`"
 *
 * Fix: every shape's terminator is now `(?:\r?\n|$)` so end-of-file
 * counts as a valid terminator. The strip logic was lifted into a pure
 * helper, `stripStaleGsdHookBlocks(configContent)`, exported from
 * `bin/install.js` for direct test coverage.
 *
 * This test parses `package.json` to require `bin/install.js`
 * structurally (not by hardcoded path), then drives each historical
 * shape through the helper twice — once with a trailing newline, once
 * without — and asserts both are stripped.
 */
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const installPath = path.resolve(REPO_ROOT, pkg.bin['gsd-core']);
const { stripStaleGsdHookBlocks } = require(installPath);

/**
 * Parse the TOML output line-structurally so assertions check shape, not
 * substring presence in raw text. Comments are dropped, table headers are
 * recorded, and string-valued keys are captured. Sufficient for the small,
 * well-formed TOML produced by these tests.
 */
function parseTomlShape(text) {
  const tableHeaders = [];
  const keys = new Map(); // dotted path → string value (last-write-wins, fine for these inputs)
  let currentTable = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(?:^|\s)#.*$/, '').trim();
    if (!line) continue;
    const tableMatch = line.match(/^\[(\[)?([^\]]+)\]?\]$/);
    if (tableMatch) {
      currentTable = tableMatch[2];
      tableHeaders.push((tableMatch[1] ? '[[' : '[') + currentTable + (tableMatch[1] ? ']]' : ']'));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = currentTable ? `${currentTable}.${kvMatch[1]}` : kvMatch[1];
      const value = kvMatch[2].replace(/^"(.*)"$/, '$1');
      keys.set(key, value);
    }
  }
  return { tableHeaders, keys };
}

const SHAPES = {
  'Shape 1 (legacy gsd-update-check)': [
    '# GSD Hooks',
    '[[hooks]]',
    'event = "SessionStart"',
    'command = "node /Users/USER/.codex/hooks/gsd-update-check.js"',
  ].join('\n'),
  'Shape 2 (flat [[hooks]] + gsd-check-update)': [
    '# GSD Hooks',
    '[[hooks]]',
    'event = "SessionStart"',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
  'Shape 3 ([[hooks.SessionStart]] without nested .hooks)': [
    '# GSD Hooks',
    '[[hooks.SessionStart]]',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
  'Shape 4 (nested [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]])': [
    '# GSD Hooks',
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
  ].join('\n'),
};

describe('bug-2866: stripStaleGsdHookBlocks handles end-of-file without trailing newline', () => {
  test('stripStaleGsdHookBlocks is exported from bin/install.js', () => {
    assert.strictEqual(typeof stripStaleGsdHookBlocks, 'function',
      'bin/install.js must export stripStaleGsdHookBlocks');
  });

  function assertStripped(out, shape, scenario) {
    const shape_ = parseTomlShape(out);
    const hooksTable = shape_.tableHeaders.find((h) => /^\[\[?hooks(\.|]\])/.test(h));
    assert.strictEqual(hooksTable, undefined,
      `(${shape}, ${scenario}) no hooks table header may remain after strip, got tables: ${shape_.tableHeaders.join(', ')}`);
    const staleCmd = [...shape_.keys.entries()].find(([_, v]) =>
      /gsd-(update-check|check-update)/.test(v));
    assert.strictEqual(staleCmd, undefined,
      `(${shape}, ${scenario}) no key may carry a stale gsd-*-update command, got: ${staleCmd && staleCmd.join('=')}`);
    assert.strictEqual(shape_.keys.get('history.persistence'), 'save-all',
      `(${shape}, ${scenario}) history.persistence must be preserved as "save-all"`);
  }

  for (const [shape, block] of Object.entries(SHAPES)) {
    test(`${shape}: stripped when terminated by trailing newline`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}\n`;
      assertStripped(stripStaleGsdHookBlocks(input), shape, 'with trailing newline');
    });

    test(`${shape}: stripped when at end-of-file without trailing newline`, () => {
      // The reporter's repro: stale block sits at the very end with no \n.
      const input = `[history]\npersistence = "save-all"\n${block}`;
      assertStripped(stripStaleGsdHookBlocks(input), shape, 'no trailing newline');
    });
  }

  test('returns input unchanged when no GSD hook block is present', () => {
    const benign = '[history]\npersistence = "save-all"\n';
    const out = stripStaleGsdHookBlocks(benign);
    assert.strictEqual(out, benign, 'helper must be a no-op when no GSD reference exists');
    const benignShape = parseTomlShape(out);
    assert.strictEqual(benignShape.keys.get('history.persistence'), 'save-all',
      'parsed shape must preserve history.persistence');
    assert.deepStrictEqual(benignShape.tableHeaders, ['[history]'],
      'parsed shape must contain only the [history] table');
  });

  // The structural rewrite (TOML-AST-driven, not regex-driven) must handle
  // whitespace and key-ordering variations that the previous regex missed.
  // These cases were silently leaked by the old implementation; one
  // (V3) actually corrupted the file by leaving an orphaned key=value line
  // outside any table.
  const VARIATIONS = {
    'extra blank line in Shape 4': [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
    ].join('\n'),
    'keys reordered (command before event in Shape 2)': [
      '# GSD Hooks',
      '[[hooks]]',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
      'event = "SessionStart"',
    ].join('\n'),
    'extra key alongside command (Shape 3 + timeout)': [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      'command = "node /Users/USER/.codex/hooks/gsd-check-update.js"',
      'timeout = 5000',
    ].join('\n'),
    'tight whitespace (no spaces around `=`)': [
      '# GSD Hooks',
      '[[hooks]]',
      'event="SessionStart"',
      'command="node /Users/USER/.codex/hooks/gsd-check-update.js"',
    ].join('\n'),
  };

  for (const [variation, block] of Object.entries(VARIATIONS)) {
    test(`variation stripped: ${variation}`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}\n`;
      assertStripped(stripStaleGsdHookBlocks(input), variation, 'with trailing newline');
    });
    test(`variation stripped at EOF without trailing newline: ${variation}`, () => {
      const input = `[history]\npersistence = "save-all"\n${block}`;
      assertStripped(stripStaleGsdHookBlocks(input), variation, 'no trailing newline');
    });
  }

  test('user-authored [[hooks.UserPromptSubmit]] is preserved', () => {
    // The structural strip must not touch hook tables that don't carry a
    // GSD-managed `gsd-(check-update|update-check).js` command.
    const input = [
      '[history]',
      'persistence = "save-all"',
      '[[hooks.UserPromptSubmit]]',
      'command = "node /Users/USER/my-hook.js"',
      '',
    ].join('\n');
    const out = stripStaleGsdHookBlocks(input);
    const shape = parseTomlShape(out);
    assert.ok(
      shape.tableHeaders.includes('[[hooks.UserPromptSubmit]]'),
      `user-authored [[hooks.UserPromptSubmit]] must survive, got: ${shape.tableHeaders.join(', ')}`,
    );
    assert.strictEqual(
      shape.keys.get('hooks.UserPromptSubmit.command'),
      'node /Users/USER/my-hook.js',
      'user-authored command value must be preserved verbatim',
    );
  });

  test('Shape 4 strip does not leave an orphaned [[hooks.SessionStart]] header', () => {
    // Shape 4 is stripped before Shape 3 specifically to avoid this.
    const block = SHAPES['Shape 4 (nested [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]])'];
    const out = stripStaleGsdHookBlocks(`[history]\npersistence = "save-all"\n${block}`);
    const outShape = parseTomlShape(out);
    const orphan = outShape.tableHeaders.find((h) => /hooks\.SessionStart/.test(h));
    assert.strictEqual(orphan, undefined,
      `Shape 4 strip must remove the parent [[hooks.SessionStart]] header too, got tables: ${outShape.tableHeaders.join(', ')}`);
  });
});
  });
}

// ─── #2586: stop installing Codex context-monitor hooks without metrics ────
// gsd-context-monitor.js reads a statusline bridge file Codex never writes,
// so every registered event was a guaranteed silent no-op. These tests drive
// the REAL install()/uninstall() entry points against a real temp CODEX_HOME
// — never a hand-fabricated manifest (see PR #2709's Blocker 1: its cleanup
// path was unreachable in production because its tests only exercised a
// fixture, not real installer state).
describe('#2586 Codex context-monitor: stop installing, clean up on reinstall', () => {
  const {
    cleanupOrphanedCodexContextMonitorScript,
    isGsdOwnedCodexContextMonitorScript,
    hooksJsonReferencesCodexContextMonitor,
  } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

  let codexHome;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-2586-'));
  });

  afterEach(() => {
    cleanup(codexHome);
    delete process.env.GSD_ALLOW_SYMLINKED_DEST;
  });

  function hooksJsonPath(home) {
    return path.join(home, 'hooks.json');
  }

  function readHooksJson(home) {
    const raw = fs.readFileSync(hooksJsonPath(home), 'utf8');
    return JSON.parse(raw);
  }

  function monitorScriptPath(home) {
    return path.join(home, 'hooks', 'gsd-context-monitor.js');
  }

  function monitorCmdShimPath(home) {
    return path.join(home, 'hooks', 'gsd-context-monitor.cmd');
  }

  // uninstall(), unlike install(), does not sandbox CODEX_HOME/HOME itself —
  // runCodexInstall's own env-restore in its `finally` means those are back
  // to the real environment by the time a bare `uninstall(true, 'codex')`
  // would run. Mirrors runCodexInstall's own sandboxing exactly so uninstall
  // operates on the temp fixture, never the real ~/.codex.
  function runCodexUninstall(codexHome, cwd = path.join(__dirname, '..')) {
    const previousCodeHome = process.env.CODEX_HOME;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousCwd = process.cwd();
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = codexHome;
    process.env.USERPROFILE = codexHome;
    try {
      process.chdir(cwd);
      return uninstall(true, 'codex');
    } finally {
      process.chdir(previousCwd);
      if (previousCodeHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodeHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  }

  // The exact shape a real pre-#2586 install would have written: the shipped
  // gsd-context-monitor.js content (with its ownership markers intact) plus
  // hooks.json registrations for every CODEX_EXTENDED_HOOK_EVENTS member,
  // using the same command-projection shape ensureCodexHooksJsonEvent used
  // to write. Built from the real resolveNodeRunner() output, not a literal
  // guess at the command string, so a drift in projectManagedHookCommand's
  // output shape cannot make this fixture silently stop matching reality.
  function seedPreExisting2586Install(home) {
    fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
    // A literal fixture carrying the same ownership markers
    // isGsdOwnedCodexContextMonitorScript looks for, built as a string
    // (never read+string-matched from the real shipped source file — see
    // this repo's "no source grep" test rule).
    const fixtureContent = [
      '#!/usr/bin/env node',
      '// gsd-hook-version: 1.12.0',
      '// Context Monitor - PostToolUse/AfterTool hook',
      'process.exit(0);',
      '',
    ].join('\n');
    fs.writeFileSync(monitorScriptPath(home), fixtureContent, 'utf8');
    const runner = resolveNodeRunner();
    const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
    for (const eventName of CODEX_EXTENDED_HOOK_EVENTS) {
      hooksSurface.ensureCodexHooksJsonEvent(home, eventName, {
        absoluteRunner: runner,
        platform: process.platform,
      });
    }
  }

  test('fresh install does not copy gsd-context-monitor.js or register any extended event', () => {
    runCodexInstall(codexHome);
    assert.strictEqual(fs.existsSync(monitorScriptPath(codexHome)), false,
      'gsd-context-monitor.js must not be copied on a fresh Codex install');
    assert.strictEqual(fs.existsSync(monitorCmdShimPath(codexHome)), false);
    assert.strictEqual(fs.existsSync(path.join(codexHome, 'hooks', 'lib', 'hook-exit.js')), false,
      'hook-exit.js is only required by gsd-context-monitor.js — nothing else staged should pull it in');
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'gsd-check-update.js')),
      'gsd-check-update.js must still be staged');
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'gsd-check-update-worker.js')));
    assert.ok(fs.existsSync(path.join(codexHome, 'hooks', 'managed-hooks-registry.cjs')));
    if (fs.existsSync(hooksJsonPath(codexHome))) {
      assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), false);
    }
  });

  test('reinstall removes exact pre-#2586 registrations for every extended event and deletes the orphaned script', () => {
    runCodexInstall(codexHome);
    seedPreExisting2586Install(codexHome);
    assert.ok(fs.existsSync(monitorScriptPath(codexHome)), 'fixture sanity: script seeded');
    assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), true, 'fixture sanity: registered');

    runCodexInstall(codexHome);

    assert.strictEqual(fs.existsSync(monitorScriptPath(codexHome)), false,
      'orphaned gsd-context-monitor.js must be removed once unreferenced and GSD-owned');
    assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), false,
      'no hooks.json entry may still reference gsd-context-monitor after reinstall');
    // gsd-check-update's own SessionStart registration must survive untouched.
    const hooks = readHooksJson(codexHome);
    const sessionStart = (hooks.hooks && hooks.hooks.SessionStart) || [];
    const hasCheckUpdate = sessionStart.some((entry) =>
      (entry.hooks || []).some((h) => typeof h.command === 'string' && /gsd-check-update/.test(h.command)));
    assert.ok(hasCheckUpdate, 'gsd-check-update SessionStart registration must remain after cleanup');
  });

  test('reinstall preserves a hand-customized registration and does not delete a still-referenced script', () => {
    runCodexInstall(codexHome);
    seedPreExisting2586Install(codexHome);
    // Hand-edit ONE event's entry to a shape isManagedHookCommand will not
    // recognize (wraps the invocation in a shell script it does not know).
    const before = readHooksJson(codexHome);
    before.hooks.Stop = [{ hooks: [{ type: 'command', command: 'bash -c "/opt/custom/my-wrapper.sh"' }] }];
    fs.writeFileSync(hooksJsonPath(codexHome), JSON.stringify(before, null, 2) + '\n', 'utf8');

    runCodexInstall(codexHome);

    const after = readHooksJson(codexHome);
    assert.deepStrictEqual(after.hooks.Stop, before.hooks.Stop,
      'a hand-customized registration must survive verbatim');
  });

  test('reinstall leaves unrelated hooks.json events and config.toml keys untouched', () => {
    runCodexInstall(codexHome);
    let hooks = fs.existsSync(hooksJsonPath(codexHome)) ? readHooksJson(codexHome) : { hooks: {} };
    if (!hooks.hooks) hooks.hooks = {};
    hooks.hooks.UnrelatedEvent = [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }];
    fs.writeFileSync(hooksJsonPath(codexHome), JSON.stringify(hooks, null, 2) + '\n', 'utf8');
    const configPath = path.join(codexHome, 'config.toml');
    const configBefore = fs.readFileSync(configPath, 'utf8') + '\n[my_unrelated_section]\nfoo = "bar"\n';
    fs.writeFileSync(configPath, configBefore, 'utf8');

    runCodexInstall(codexHome);

    const after = readHooksJson(codexHome);
    assert.deepStrictEqual(after.hooks.UnrelatedEvent, hooks.hooks.UnrelatedEvent,
      'an unrelated event array must be untouched');
    const configAfter = fs.readFileSync(configPath, 'utf8');
    assert.ok(configAfter.includes('[my_unrelated_section]\nfoo = "bar"'),
      'unrelated config.toml section must survive a Codex reinstall');
  });

  test('a user-owned pre-existing EMPTY event array is preserved, not deleted', () => {
    runCodexInstall(codexHome);
    fs.writeFileSync(hooksJsonPath(codexHome), JSON.stringify({ hooks: { Stop: [] } }, null, 2) + '\n', 'utf8');

    runCodexInstall(codexHome);

    const after = readHooksJson(codexHome);
    assert.ok(Array.isArray(after.hooks.Stop) && after.hooks.Stop.length === 0,
      'an empty array the user already had must not be dropped by cleanup that found nothing GSD-owned to remove');
  });

  test('symlinked hooks.json aborts before any Codex change, without GSD_ALLOW_SYMLINKED_DEST', () => {
    runCodexInstall(codexHome);
    const configPath = path.join(codexHome, 'config.toml');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const realHooksJson = path.join(codexHome, 'real-hooks.json');
    fs.writeFileSync(realHooksJson, JSON.stringify({ hooks: {} }, null, 2) + '\n', 'utf8');
    fs.unlinkSync(hooksJsonPath(codexHome));
    fs.symlinkSync(realHooksJson, hooksJsonPath(codexHome));

    assert.throws(() => runCodexInstall(codexHome), /symlink/i);

    assert.ok(fs.lstatSync(hooksJsonPath(codexHome)).isSymbolicLink(),
      'the symlink itself must survive an aborted install — never replaced by a plain file');
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), configBefore,
      'config.toml must be restored to its pre-attempt snapshot on abort');
  });

  test('symlinked hooks.json is followed when GSD_ALLOW_SYMLINKED_DEST=1', () => {
    runCodexInstall(codexHome);
    const realHooksJson = path.join(codexHome, 'real-hooks.json');
    fs.writeFileSync(realHooksJson, JSON.stringify({ hooks: {} }, null, 2) + '\n', 'utf8');
    fs.unlinkSync(hooksJsonPath(codexHome));
    fs.symlinkSync(realHooksJson, hooksJsonPath(codexHome));
    process.env.GSD_ALLOW_SYMLINKED_DEST = '1';

    assert.doesNotThrow(() => runCodexInstall(codexHome));

    assert.ok(fs.lstatSync(hooksJsonPath(codexHome)).isSymbolicLink(), 'still a symlink afterward');
    assert.ok(fs.existsSync(realHooksJson), 'the symlink target must have been written through');
  });

  test('cleanupOrphanedCodexContextMonitorScript keeps the hooks.json deregistration when script deletion fails', () => {
    runCodexInstall(codexHome);
    seedPreExisting2586Install(codexHome);
    for (const eventName of CODEX_EXTENDED_HOOK_EVENTS) {
      require('../gsd-core/bin/lib/runtime-hooks-surface.cjs').removeCodexHooksJsonEvent(codexHome, eventName);
    }
    assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), false, 'deregistration committed first');

    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = (target, ...rest) => {
      if (typeof target === 'string' && target.includes('gsd-context-monitor')) {
        throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      }
      return originalUnlinkSync.call(fs, target, ...rest);
    };
    // Determine which GSD-owned candidates actually exist BEFORE the mocked
    // deletion attempt — on Windows, ensureCodexHooksJsonEvent also staged a
    // .cmd shim alongside the .js file (see buildCodexHookWindowsShimIR), so
    // both deletions fail under the mock above; on POSIX only the .js file
    // exists. Asserting against this rather than a hardcoded 1 keeps the row
    // meaningful on both platforms instead of just loosening it to "at least
    // one" (see CI failure: Windows reported 2 warnings, not 1).
    const cmdShimPath = monitorCmdShimPath(codexHome);
    const cmdShimExisted = fs.existsSync(cmdShimPath);
    let result;
    try {
      result = cleanupOrphanedCodexContextMonitorScript(codexHome);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    const expectedWarningCount = cmdShimExisted ? 2 : 1;
    assert.strictEqual(result.warnings.length, expectedWarningCount);
    assert.ok(result.warnings.some((w) => /gsd-context-monitor\.js$/.test(w.path)),
      'a warning must name the .js script');
    if (cmdShimExisted) {
      assert.ok(result.warnings.some((w) => /gsd-context-monitor\.cmd$/.test(w.path)),
        'a warning must name the .cmd shim when Windows staged one');
      assert.ok(fs.existsSync(cmdShimPath), 'the .cmd shim remains on disk since its deletion failed too');
    }
    assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), false,
      'the already-safe hooks.json deregistration must not be reverted by a script-deletion failure');
    assert.ok(fs.existsSync(monitorScriptPath(codexHome)), 'the file remains on disk since deletion failed');
  });

  test('isGsdOwnedCodexContextMonitorScript rejects a user file at the same path', () => {
    runCodexInstall(codexHome);
    fs.mkdirSync(path.join(codexHome, 'hooks'), { recursive: true });
    fs.writeFileSync(monitorScriptPath(codexHome), '#!/usr/bin/env node\nconsole.log("my own script");\n', 'utf8');
    assert.strictEqual(isGsdOwnedCodexContextMonitorScript(monitorScriptPath(codexHome)), false);
  });

  test('uninstall removes recognized registrations and the orphaned script symmetrically with install', () => {
    runCodexInstall(codexHome);
    seedPreExisting2586Install(codexHome);

    runCodexUninstall(codexHome);

    assert.strictEqual(fs.existsSync(monitorScriptPath(codexHome)), false);
    if (fs.existsSync(hooksJsonPath(codexHome))) {
      assert.strictEqual(hooksJsonReferencesCodexContextMonitor(codexHome), false);
    }
  });

  test('uninstall does not throw on an unmodeled hooks.json event-value shape', () => {
    runCodexInstall(codexHome);
    fs.writeFileSync(hooksJsonPath(codexHome), JSON.stringify({ hooks: { Stop: 'not-an-array' } }, null, 2) + '\n', 'utf8');
    assert.doesNotThrow(() => runCodexUninstall(codexHome));
  });

  test('property: reconcileCodexHooksJsonEvent never removes a non-managed-shape command', () => {
    const { reconcileCodexHooksJsonEvent } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/gsd-context-monitor|gsd-check-update/.test(s)), { minLength: 1, maxLength: 5 }),
        (customCommands) => {
          const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-2586-prop-'));
          try {
            const seeded = { hooks: { Stop: [{ hooks: customCommands.map((c) => ({ type: 'command', command: c })) }] } };
            fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(seeded, null, 2) + '\n', 'utf8');
            reconcileCodexHooksJsonEvent(home, 'Stop', { managedCommand: null });
            const after = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
            const survivingCommands = ((after.hooks && after.hooks.Stop) || [])
              .flatMap((entry) => (entry.hooks || []).map((h) => h.command));
            for (const c of customCommands) {
              assert.ok(survivingCommands.includes(c), `non-managed command "${c}" must survive removal`);
            }
          } finally {
            cleanup(home);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
