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
const _fc = require('fast-check');
const { CLAUDE_AGENT_ALIASES: _CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
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
  cleanupCodexSkillMetadataSidecars,
  generateCodexConfigBlock: _generateCodexConfigBlock,
  stripGsdFromCodexConfig,
  migrateCodexHooksMapFormat: _migrateCodexHooksMapFormat,
  mergeCodexConfig: _mergeCodexConfig,
  install,
  GSD_CODEX_MARKER,
  deriveCodexSandboxMode: _deriveCodexSandboxMode,
  // #3897 rung 3 (ADR-3473 §8.3, option 2 — HALT.md): anticipated new export
  // which held the 17 explicit read-only pins until #4770 lifted them (now an empty frozen map) for roles whose tool contract would
  // otherwise derive workspace-write (16 measured by HALT.md + gsd-nyquist-auditor,
  // surfaced by the list-form parse fix). Does not exist on the current tree —
  // destructuring a non-existent key is `undefined`, not a throw, so requiring
  // this module still succeeds; every test below that touches it fails on its
  // own `typeof` guard instead.
  CODEX_SANDBOX_HOLDS: _CODEX_SANDBOX_HOLDS,
  parseTomlToObject,
  validateCodexConfigSchema: _validateCodexConfigSchema,
  uninstall: _uninstall,
  CODEX_EXTENDED_HOOK_EVENTS: _CODEX_EXTENDED_HOOK_EVENTS,
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

function readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function readHooksSessionStartCommands(codexHome) {
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

function countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function assertNoDraftRootKeys(content) {
  assert.ok(!content.includes('model = "gpt-5.6-terra"'), 'does not inject draft model default');
  assert.ok(!content.includes('model_reasoning_effort = "high"'), 'does not inject draft reasoning default');
  assert.ok(!content.includes('disable_response_storage = true'), 'does not inject draft storage default');
}

function assertUsesOnlyEol(content, eol) {
  if (eol === '\r\n') {
    assert.ok(content.includes('\r\n'), 'contains CRLF line endings');
    assert.ok(!content.replace(/\r\r?\n/g, '').includes('\n'), 'does not contain bare LF line endings');
    return;
  }
  assert.ok(!content.includes('\r\n'), 'does not contain CRLF line endings');
}

function assertNoCodexBareGsdToolsInvocation(content, label) {
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
// Folded from tests/issue-2940-codex-config-merge-trailing.test.cjs — consolidation epic #1969 (H3 W4 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2940-codex-config-merge-trailing (consolidation epic #1969 H3 W4 #3336)", () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2940 — `gsd-update` overwrites `~/.codex/config.toml`,
 * removing any user/Codex-CLI settings added after the GSD-managed marker block.
 *
 * Root cause: `mergeCodexConfig`'s Case 2 (marker present) preserved content
 * BEFORE the marker but unconditionally discarded everything from the marker to
 * EOF, replacing it with a freshly generated GSD block. Since a fresh install
 * writes the GSD block as the file's entire content, any settings the user or
 * Codex CLI later adds (`[model]`, `[mcp_servers.*]`, `[profiles.*]`) land AFTER
 * the block, and every subsequent update wiped them.
 *
 * The fix preserves genuine trailing TOML by routing the post-marker region
 * through the existing `stripLeakedGsdCodexSections` (which removes GSD's own
 * managed/leaked sections while keeping user tables), then re-appending it after
 * the regenerated GSD block — without regressing #2406's de-dup.
 *
 * Matrix: .gsd/bug/fix/2940-codex-config-merge-preserves-trailing-content/50-test-matrix.md
 *
 * NOTE: this describe block covers trailing-content-after-the-marker preservation
 * ([model]/[mcp_servers.*]/[profiles.*] appended AFTER the GSD block) — a case the
 * pre-existing 'mergeCodexConfig' suite above does not exercise (that suite's cases
 * write user content BEFORE the marker/block, not after). Verified non-duplicate
 * against both the pre-existing target and the other three folded sources.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const {
  generateCodexConfigBlock,
  mergeCodexConfig,
  GSD_CODEX_MARKER,
} = require('../bin/install.js');

describe('mergeCodexConfig trailing-content preservation (#2940)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2940-merge-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** A GSD block with one agent (the shape installCodexConfig passes). */
  const block = () =>
    generateCodexConfigBlock([{ name: 'gsd-executor', description: 'Executes plans' }]);

  test('trailingUserModelSectionPreserved', () => {
    // Row 1 (failing-first regression): a config with the GSD block FIRST, then a user
    // [model] section after it (the real-world layout — fresh install fills the file,
    // user settings land after). Re-merge must preserve [model] byte-for-byte.
    const configPath = path.join(tmpDir, 'config.toml');
    const trailing = '[model]\nname = "gpt-5.4"\n';
    // First write: GSD block + user content after it (no content before the marker).
    fs.writeFileSync(configPath, block() + '\n' + trailing);

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'user [model] section preserved after re-merge');
    assert.ok(content.includes('name = "gpt-5.4"'), 'user model value preserved verbatim');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'GSD marker still present');
    const markerCount = (content.match(new RegExp(escapeRegex(GSD_CODEX_MARKER), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker (no duplication)');
    assert.ok(content.includes('max_depth ='), 'GSD-managed [agents] block regenerated');
  });

  test('multipleTrailingTablesPreserved', () => {
    // Row 2: multiple trailing user tables ([mcp_servers.*], [profiles.*]).
    const configPath = path.join(tmpDir, 'config.toml');
    const trailing = [
      '[mcp_servers.figma]',
      'command = "npx"',
      'args = ["-y", "figma-mcp"]',
      '',
      '[profiles.dev]',
      'model = "o3"',
      'sandbox_mode = "workspace-write"',
    ].join('\n');
    fs.writeFileSync(configPath, block() + '\n' + trailing + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[mcp_servers.figma]'), 'mcp_servers table preserved');
    assert.ok(content.includes('[profiles.dev]'), 'profiles table preserved');
    assert.ok(content.includes('sandbox_mode = "workspace-write"'), 'profile value preserved');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'GSD block regenerated');
  });

  test('reMergeIsIdempotent', () => {
    // Row 3 (acceptance #2): merging the result of a merge again yields identical content.
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, block() + '\n[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, block());
    const afterFirst = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, block());
    const afterSecond = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(afterSecond, afterFirst, 'second merge is idempotent (no further change)');
  });

  test('leakedGsdSectionAfterMarkerStillStripped', () => {
    // Row 4 (#2406 non-regression): a leaked GSD-managed [agents.gsd-*] section AFTER the
    // marker is still REMOVED (not regrown), while genuine user content after it is preserved.
    const configPath = path.join(tmpDir, 'config.toml');
    const leakedAndUser = [
      '[agents.gsd-executor]',
      'description = "stale leaked"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[model]',
      'name = "o3"',
    ].join('\n');
    fs.writeFileSync(configPath, block() + '\n' + leakedAndUser + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    const gsdStructCount = (content.match(/^\[agents\.gsd-executor\]\s*$/gm) || []).length;
    assert.strictEqual(gsdStructCount, 0, 'leaked [agents.gsd-executor] after marker is stripped (not regrown)');
    assert.ok(content.includes('[model]'), 'genuine user [model] after the leaked section still preserved');
  });

  test('bareAgentsAfterMarkerHandled', () => {
    // Row 5: a user AgentsToml scalar (max_threads) the user folded INTO the managed [agents]
    // block (the valid, realistic shape — two [agents] tables would be invalid TOML), PLUS a
    // separate trailing [model] section. The fix must preserve the user scalar via the existing
    // spliceCodexAgentsScalars path AND preserve the trailing [model] via the new trailing-region
    // logic, while regenerating exactly one managed [agents] table.
    const configPath = path.join(tmpDir, 'config.toml');
    // Simulate: fresh install wrote the GSD block; the user then added max_threads into the
    // [agents] table and added a [model] section after it.
    const existing = [
      GSD_CODEX_MARKER,
      '',
      '[agents]',
      'max_depth = 1',
      'max_threads = 4',
      '',
      '[model]',
      'name = "o3"',
    ].join('\n');
    fs.writeFileSync(configPath, existing + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    // The user's max_threads scalar is preserved (spliced into the regenerated managed [agents]);
    // there is exactly one [agents] table (the managed one).
    assert.ok(content.includes('max_threads = 4'), 'user AgentsToml scalar (max_threads) preserved in managed block');
    const agentsHeaders = (content.match(/^\[agents\]\s*$/gm) || []).length;
    assert.strictEqual(agentsHeaders, 1, 'exactly one [agents] table (the managed one)');
    assert.ok(content.includes('max_depth = 1'), 'GSD-managed max_depth still present');
    assert.ok(content.includes('[model]'), 'trailing [model] still preserved');
  });

  test('beforeAndAfterMarkerBothPreserved', () => {
    // Row 6: content both BEFORE and AFTER the marker is preserved; GSD block regenerated once.
    const configPath = path.join(tmpDir, 'config.toml');
    const before = '[profiles.work]\nmodel = "gpt-5.4"\n';
    const after = '[mcp_servers.github]\ncommand = "gh-mcp"\n';
    fs.writeFileSync(configPath, before + '\n' + block() + '\n' + after + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[profiles.work]'), 'content before marker preserved');
    assert.ok(content.includes('[mcp_servers.github]'), 'content after marker preserved');
    const markerCount = (content.match(new RegExp(escapeRegex(GSD_CODEX_MARKER), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('noTrailingContentUnchanged', () => {
    // Row 7 (zero-trailing boundary): a config with ONLY the GSD block (fresh-install case)
    // re-merges to just the regenerated block — no spurious blank-line artifacts introduced
    // by the trailing-preservation logic.
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, block() + '\n');

    mergeCodexConfig(configPath, block());

    const content = fs.readFileSync(configPath, 'utf8');
    // No spurious trailing blank lines beyond the single trailing newline. Use a CRLF-safe
    // pattern (\r?\n) so the assertion holds under Windows git-autocrlf line endings.
    assert.ok(!/(?:\r?\n){3,}$/.test(content), 'no spurious run of blank lines at end of file');
    assert.strictEqual(content.trim(), block().trim(), 'content is exactly the regenerated block (whitespace-trimmed)');
  });
});
  });
}


// ─── Integration: installCodexConfig ────────────────────────────────────────────

describe('installCodexConfig (integration)', () => {
  let tmpTarget;
  const agentsSrc = path.join(__dirname, '..', 'agents');

  beforeEach(() => {
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-install-'));
  });

  afterEach(() => {
    cleanup(tmpTarget);
  });

  // Only run if agents/ directory exists (not in CI without full checkout)
  const hasAgents = fs.existsSync(agentsSrc);

  (hasAgents ? test : test.skip)('generates config.toml and agent .toml files', () => {
    const { installCodexConfig } = require('../bin/install.js');
    const count = installCodexConfig(tmpTarget, agentsSrc);

    assert.ok(count >= 11, `installed ${count} agents (expected >= 11)`);

    // Verify config.toml
    const configPath = path.join(tmpTarget, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'config.toml exists');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(config.includes(GSD_CODEX_MARKER), 'has GSD marker');
    // #2406: config.toml must NOT register agent roles — the standalone
    // agents/<name>.toml (verified below) is the sole canonical source
    // Codex auto-discovers. A role table here would be a second,
    // duplicate registration of the same role.
    assert.ok(!config.includes('[agents.gsd-executor]'), 'no executor role table in config.toml');
    assert.strictEqual((config.match(/^\[agents\.gsd-/gm) || []).length, 0, 'zero [agents.gsd-*] role tables of any kind');
    assert.strictEqual((config.match(/^config_file = /gm) || []).length, 0, 'zero config_file lines');
    assert.ok(!config.includes('multi_agent'), 'no feature flags');

    // Verify per-agent .toml files
    const agentsDir = path.join(tmpTarget, 'agents');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-executor.toml')), 'executor .toml exists');
    assert.ok(fs.existsSync(path.join(agentsDir, 'gsd-plan-checker.toml')), 'plan-checker .toml exists');

    const executorToml = fs.readFileSync(path.join(agentsDir, 'gsd-executor.toml'), 'utf8');
    assert.ok(executorToml.includes('name = "gsd-executor"'), 'executor has name');
    assert.ok(executorToml.includes('description = "Executes GSD plans with atomic commits, deviation handling, checkpoint protocols, and state management. Spawned by execute-phase orchestrator or execute-plan command."'), 'executor has description');
    assert.ok(executorToml.includes('sandbox_mode = "workspace-write"'), 'executor is workspace-write');
    assert.ok(executorToml.includes('developer_instructions'), 'has developer_instructions');

    const checkerToml = fs.readFileSync(path.join(agentsDir, 'gsd-plan-checker.toml'), 'utf8');
    assert.ok(checkerToml.includes('name = "gsd-plan-checker"'), 'plan-checker has name');
    assert.ok(checkerToml.includes('sandbox_mode = "read-only"'), 'plan-checker is read-only');
  });

  // PATHS-01: no ~/.claude references should leak into generated .toml files (#2320)
  // Covers both trailing-slash and bare end-of-string forms, and scans all .toml
  // files (agents/ subdirectory + top-level config.toml if present).
  (hasAgents ? test : test.skip)('generated .toml files contain no leaked ~/.claude paths (PATHS-01)', () => {
    const { installCodexConfig } = require('../bin/install.js');
    installCodexConfig(tmpTarget, agentsSrc);

    // Collect all .toml files: per-agent files in agents/ plus top-level config.toml.
    // Not the shared listAgentFiles() helper: reads the INSTALLED target dir and
    // collects generated .toml (absolute paths), not the source .md roster.
    const agentsDir = path.join(tmpTarget, 'agents');
    const tomlFiles = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.toml'))
      .map(f => path.join(agentsDir, f));
    const topLevel = path.join(tmpTarget, 'config.toml');
    if (fs.existsSync(topLevel)) tomlFiles.push(topLevel);
    assert.ok(tomlFiles.length > 0, 'at least one .toml file generated');

    // Match ~/.claude, $HOME/.claude, or ./.claude with or without trailing slash
    const leakPattern = /(?:~|\$HOME|\.)\/\.claude(?:\/|$)/;
    const leaks = [];
    for (const filePath of tomlFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (leakPattern.test(content)) {
        leaks.push(path.relative(tmpTarget, filePath));
      }
    }
    assert.deepStrictEqual(leaks, [], `No .toml files should contain .claude paths; found leaks in: ${leaks.join(', ')}`);
  });

  (hasAgents ? test : test.skip)('generated Codex agent .toml files do not call bare gsd-tools', () => {
    const { installCodexConfig } = require('../bin/install.js');
    installCodexConfig(tmpTarget, agentsSrc);

    // Not the shared listAgentFiles() helper: reads the INSTALLED target dir and
    // filters generated gsd-*.toml output, not the source .md roster.
    const agentsDir = path.join(tmpTarget, 'agents');
    const tomlFiles = fs.readdirSync(agentsDir)
      .filter((file) => file.startsWith('gsd-') && file.endsWith('.toml'));
    assert.ok(tomlFiles.length > 0, 'expected generated Codex agent toml files');

    for (const file of tomlFiles) {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      assertNoCodexBareGsdToolsInvocation(content, `agents/${file}`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2834-codex-install-model-ordering.test.cjs — consolidation epic #1969 (H3 W4 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2834-codex-install-model-ordering (consolidation epic #1969 H3 W4 #3336)", () => {
// allow-test-rule: structural-implementation-guard (#2834)
'use strict';

// Regression guard for #2834: on a clean Codex install, agent TOMLs contained no
// model-routing fields because defaults.json (resolve_model_ids + runtime) was written
// AFTER installCodexConfig generated the TOMLs. The fix extracts writeNonClaudeDefaults
// and calls it BEFORE installCodexConfig. This test asserts the ordering invariant in
// the install source so a future edit can't silently re-introduce the gap.
//
// Verified non-duplicate: no existing coverage in this file asserts on
// writeNonClaudeDefaults / the install-flow call ordering (source-text guard), and
// none of the other three folded sources touch this.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');

test('writeNonClaudeDefaults is called before installCodexConfig in the Codex install flow (#2834)', () => {
  const src = fs.readFileSync(INSTALL_JS, 'utf8');

  // Find the call to writeNonClaudeDefaults that precedes installCodexConfig.
  const writeIdx = src.indexOf('writeNonClaudeDefaults(runtime);'); // allow-test-rule: structural-implementation-guard (#2834)
  assert.ok(writeIdx !== -1, 'writeNonClaudeDefaults(runtime) must be called in the install flow');

  // Find the FIRST installCodexConfig call AFTER the writeNonClaudeDefaults call.
  const codexGenIdx = src.indexOf('installCodexConfig(targetDir', writeIdx); // allow-test-rule: structural-implementation-guard (#2834)
  assert.ok(codexGenIdx !== -1 && codexGenIdx > writeIdx,
    'installCodexConfig must be called AFTER writeNonClaudeDefaults so defaults.json ' +
    '(resolve_model_ids + runtime) exists before agent TOML generation reads it (#2834)');

  // The #2834 comment must be present at the call site.
  const callSite = src.slice(writeIdx - 300, writeIdx + 100);
  assert.ok(/#2834/.test(callSite), 'the writeNonClaudeDefaults call must carry the #2834 rationale comment'); // allow-test-rule: structural-implementation-guard (#2834)
});

test('writeNonClaudeDefaults function exists and is a no-op for Claude (#2834)', () => {
  const src = fs.readFileSync(INSTALL_JS, 'utf8');
  const fnIdx = src.indexOf('function writeNonClaudeDefaults('); // allow-test-rule: structural-implementation-guard (#2834)
  assert.ok(fnIdx !== -1, 'writeNonClaudeDefaults must be defined as a function');
  // Bound the slice by the next top-level declaration rather than a fixed
  // character count, so adding a comment or a guard inside the function cannot
  // push the asserted tokens out of the window and red this test spuriously.
  const nextFnIdx = src.indexOf('\nfunction ', fnIdx + 1); // allow-test-rule: structural-implementation-guard (#2834)
  const fnBody = src.slice(fnIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
  // Source-text guard, not a behavioral call: writeNonClaudeDefaults() early-returns
  // as a no-op whenever process.env.GSD_TEST_MODE is set (see its own body), and this
  // suite sets GSD_TEST_MODE='1' file-wide (line 14), so invoking it here could never
  // observe the resolve_model_ids/runtime writes it is supposed to make (#2834).
  assert.ok(/nativeModelAliases/.test(fnBody), 'writeNonClaudeDefaults must early-return for Claude (nativeModelAliases check)'); // allow-test-rule: structural-implementation-guard (#2834)
  assert.ok(/resolve_model_ids/.test(fnBody), 'writeNonClaudeDefaults must write resolve_model_ids'); // allow-test-rule: structural-implementation-guard (#2834)
  assert.ok(/defaults\.runtime/.test(fnBody), 'writeNonClaudeDefaults must write runtime'); // allow-test-rule: structural-implementation-guard (#2834)
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2639-codex-toml-neutralization.test.cjs — consolidation epic #1969 (H3 W4 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2639-codex-toml-neutralization (consolidation epic #1969 H3 W4 #3336)", () => {
/**
 * Regression: issue #2639 — Codex install generated agent TOMLs with stale
 * Claude-specific references (CLAUDE.md, .claude/skills/, .claudeignore).
 *
 * RCA: `installCodexConfig()` applied a narrow path-only regex pass before
 * calling `generateCodexAgentToml()`, bypassing the full
 * `convertClaudeToCodexMarkdown()` + `neutralizeAgentReferences(..., 'AGENTS.md')`
 * pipeline used on the .md emit path. Fix routes the TOML path through the
 * same pipeline and extends the pipeline to cover bare `.claude/skills/`,
 * `.claude/commands/`, `.claude/agents/`, and `.claudeignore`.
 *
 * Verified non-duplicate: the pre-existing 'generateCodexAgentToml' suite covers
 * model_overrides/sandbox_mode/reasoning-effort, not CLAUDE.md/.claudeignore/skills-path
 * neutralization in the emitted TOML; the '#570 — Codex leak scanner sub-bugs' suite
 * covers ~/.claude path leaks via convertClaudeToCodexMarkdown but not the
 * installCodexConfig()-level TOML-emit pipeline this regression targets.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installCodexConfig } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2639-'));
}

function writeAgentFixture(agentsSrc, name, body) {
  const content = `---
name: ${name}
description: Test agent for #2639
---

${body}
`;
  fs.writeFileSync(path.join(agentsSrc, `${name}.md`), content);
}

describe('#2639 — Codex TOML emit routes through full neutralization pipeline', () => {
  let tmpDir;
  let agentsSrc;
  let targetDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    agentsSrc = path.join(tmpDir, 'agents');
    targetDir = path.join(tmpDir, 'codex');
    fs.mkdirSync(agentsSrc, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('strips CLAUDE.md, .claude/skills/, .claude/commands/, .claude/agents/, and .claudeignore from emitted TOML', () => {
    writeAgentFixture(agentsSrc, 'gsd-code-reviewer', [
      '**Project instructions:** Read `./CLAUDE.md` if it exists.',
      '',
      '**CLAUDE.md enforcement:** If `./CLAUDE.md` exists, treat it as hard constraints.',
      '',
      '**Project skills:** Check `.claude/skills/` or `.agents/skills/` directory.',
      '',
      'Also check `.claude/commands/` and `.claude/agents/` for definitions.',
      '',
      'DO respect .gitignore and .claudeignore. Do not review ignored files.',
      '',
      'Claude will refuse the task if policy violated.',
    ].join('\n'));

    installCodexConfig(targetDir, agentsSrc);

    const tomlPath = path.join(targetDir, 'agents', 'gsd-code-reviewer.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML written');
    const toml = fs.readFileSync(tomlPath, 'utf8');

    assert.ok(!toml.includes('CLAUDE.md'), 'no CLAUDE.md references remain in TOML');
    assert.ok(!toml.includes('.claude/skills/'), 'no .claude/skills/ references remain');
    assert.ok(!toml.includes('.claude/commands/'), 'no .claude/commands/ references remain');
    assert.ok(!toml.includes('.claude/agents/'), 'no .claude/agents/ references remain');
    assert.ok(!toml.includes('.claudeignore'), 'no .claudeignore references remain');

    assert.ok(toml.includes('AGENTS.md'), 'AGENTS.md substituted for CLAUDE.md');
    assert.ok(
      toml.includes('.codex/skills/') || toml.includes('.agents/skills/'),
      'skills path neutralized'
    );

    // Standalone "Claude" agent-name references replaced
    assert.ok(!/\bClaude\b(?! Code| Opus| Sonnet| Haiku| native| based)/.test(toml),
      'standalone Claude agent-name references replaced');
  });

  test('preserves Claude product/model names (Claude Code, Claude Opus) in TOML', () => {
    writeAgentFixture(agentsSrc, 'gsd-executor', [
      'This agent runs under Claude Code with the Claude Opus 4 model.',
      'Do not confuse with Claude Sonnet or Claude Haiku.',
    ].join('\n'));

    installCodexConfig(targetDir, agentsSrc);
    const toml = fs.readFileSync(path.join(targetDir, 'agents', 'gsd-executor.toml'), 'utf8');

    assert.ok(toml.includes('Claude Code'), 'Claude Code product name preserved');
    assert.ok(toml.includes('Claude Opus'), 'Claude Opus model name preserved');
  });
});
  });
}


// ─── Codex config.toml [features] safety (#1202) ─────────────────────────────

describe('codex features section safety', () => {
  test('non-boolean keys under [features] are moved to top level', () => {
    // Simulate the bug from #1202: model = "gpt-5.4" under [features]
    // causes "invalid type: string, expected a boolean in features"
    const configContent = `[features]\ncodex_hooks = true\n\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "medium"\n\n[agents.gsd-executor]\ndescription = "test"\n`;

    const featuresMatch = configContent.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');

    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 2, 'should detect 2 non-boolean keys');
    assert.ok(nonBooleanKeys.includes('model = "gpt-5.4"'), 'detects model key');
    assert.ok(nonBooleanKeys.includes('model_reasoning_effort = "medium"'), 'detects model_reasoning_effort key');
  });

  test('boolean keys under [features] are NOT flagged', () => {
    const configContent = `[features]\ncodex_hooks = true\nmulti_agent = false\n`;

    const featuresMatch = configContent.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/))
      .map(line => line.trim());

    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys in a clean config');
  });
});

describe('Codex install hook configuration (e2e)', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-e2e-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Codex install copies hook file that is referenced in hooks.json (#2153)', () => {
    // Regression test: Codex install writes gsd-check-update hook reference into
    // hooks.json and must also copy the hook file to ~/$CODEX_HOME/hooks/
    runCodexInstall(codexHome);

    const configContent = readCodexConfig(codexHome);
    const parsedConfig = parseTomlToObject(configContent);
    assert.ok(
      !parsedConfig.hooks || !Array.isArray(parsedConfig.hooks.SessionStart),
      'config.toml does not carry managed SessionStart hooks'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'hooks.json references gsd-check-update (.js on POSIX, .cmd on Windows)'
    );
    // The hook file must physically exist at the referenced path
    const hookFile = path.join(codexHome, 'hooks', 'gsd-check-update.js');
    assert.ok(
      fs.existsSync(hookFile),
      `gsd-check-update.js must exist at ${hookFile} — hooks.json references it (directly on POSIX, via .cmd shim on Windows) but file was not installed`
    );
  });

  test('fresh CODEX_HOME enables codex_hooks without draft root defaults', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('[features]\nhooks = true\n'), 'writes codex_hooks feature');
    const parsed = parseTomlToObject(content);
    assert.ok(!parsed.hooks || !Array.isArray(parsed.hooks.SessionStart), 'config.toml does not carry managed SessionStart hooks');
    // #3017 / #3426: on POSIX the handler command uses the absolute Node binary path
    //   "<absolute-node-path>" "<hook-path.js>"
    // On Windows (#3426) a .cmd shim is written instead; the command in hooks.json
    // is the quoted .cmd path (no node runner prefix — cmd.exe executes .cmd natively).
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdCommands = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdCommands.length, 1, 'writes one GSD update hook in hooks.json');
    if (process.platform === 'win32') {
      // On Windows, the command is the .cmd shim path (quoted).
      const expectedCmdPath = path.join(codexHome, 'hooks', 'gsd-check-update.cmd').replace(/\\/g, '/');
      assert.strictEqual(gsdCommands[0], JSON.stringify(expectedCmdPath), 'win32: handler command must be the .cmd shim path (#3426)');
    } else {
      // On POSIX, the command is the node runner + .js hook path.
      const expectedRunner = JSON.parse(resolveNodeRunner());
      const expectedHookPath = path.join(codexHome, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');
      const expectedCommand = `"${expectedRunner}" "${expectedHookPath}"`;
      assert.strictEqual(gsdCommands[0], expectedCommand, 'handler command must use absolute node runner pointing at gsd-check-update.js (#3017)');
    }
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'writes one codex_hooks key');
    assertNoDraftRootKeys(content);
    assertUsesOnlyEol(content, '\n');
  });

  test('#2406: config.toml carries no config_file entries — standalone agents/*.toml under CODEX_HOME are the sole canonical source', () => {
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    // config.toml previously carried a `config_file = "<absolute agents dir>/<name>.toml"`
    // line per role, pointing back at the standalone TOML Codex already
    // auto-discovers under $CODEX_HOME/agents/ — a second, duplicate
    // registration of the same role that produced one
    // "Ignoring malformed agent role definition: duplicate agent role name"
    // warning per agent. That line is gone entirely now.
    const configFileLines = content.split(/\r?\n/).filter(l => l.startsWith('config_file = '));
    assert.deepStrictEqual(configFileLines, [], 'config.toml has zero config_file entries');

    // The standalone per-agent TOMLs are still written under CODEX_HOME/agents/
    // and are what Codex auto-discovers.
    const agentsDir = path.join(codexHome, 'agents');
    const tomlFiles = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.toml'))
      : [];
    assert.ok(tomlFiles.length > 0, 'standalone gsd-*.toml files exist under CODEX_HOME/agents/');
  });

  test('re-install repairs non-boolean keys trapped under [features] by previous install (#1379)', () => {
    // Bug: a pre-#1346 install prepended [features] before bare top-level keys,
    // trapping model= under [features]. Re-installing with the fix must detect
    // and relocate those keys back to the top level so Codex can parse them.
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      '',
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/Users/oltmannk/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    // model= and model_reasoning_effort= must NOT be under [features]
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('model = "gpt-5.3-codex"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex !== -1, 'model key is present');
    assert.ok(reasoningIndex !== -1, 'model_reasoning_effort key is present');
    assert.ok(modelIndex < featuresIndex, 'model= relocated before [features]');
    assert.ok(reasoningIndex < featuresIndex, 'model_reasoning_effort= relocated before [features]');

    // [features] should only contain boolean keys
    const featuresMatch = content.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/));
    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys under [features]');

    // User content preserved
    assert.ok(content.includes('[projects."/Users/oltmannk/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'one codex_hooks key');
  });

  test('existing LF config without [features] gets one features block and preserves user content', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[model]',
      'name = "o3"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'creates one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'creates one codex_hooks key');
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\nname = "o3"'), 'preserves model section');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('bare top-level keys are NOT trapped under [features] (#1202)', () => {
    // Real-world config: model= and model_reasoning_effort= at root level,
    // followed by [projects] section. GSD must not prepend [features] before
    // these keys, which would make Codex reject them as "expected a boolean".
    writeCodexConfig(codexHome, [
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
      '[projects."/home/user/myproject"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);

    // [features] must come AFTER bare top-level keys
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('model = "gpt-5.4"');
    const reasoningIndex = content.indexOf('model_reasoning_effort = "high"');
    assert.ok(modelIndex < featuresIndex, 'model= stays before [features]');
    assert.ok(reasoningIndex < featuresIndex, 'model_reasoning_effort= stays before [features]');

    // [features] should only contain boolean keys
    const featuresMatch = content.match(/\[features\]\r?\n([\s\S]*?)(?=\n\[|$)/);
    assert.ok(featuresMatch, 'features section found');
    const featuresBody = featuresMatch[1];
    const nonBooleanKeys = featuresBody.split(/\r?\n/)
      .filter(line => line.match(/^\s*\w+\s*=/) && !line.match(/=\s*(true|false)\s*(#.*)?$/));
    assert.strictEqual(nonBooleanKeys.length, 0, 'no non-boolean keys under [features]');

    // User content preserved
    assert.ok(content.includes('[projects."/home/user/myproject"]'), 'preserves project section');
    assert.ok(content.includes('trust_level = "trusted"'), 'preserves project trust level');
  });

  test('existing CRLF config without [features] preserves CRLF and adds codex_hooks', () => {
    writeCodexConfig(codexHome, '# user comment\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'creates one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'creates one codex_hooks key');
    assert.ok(content.includes('# user comment'), 'preserves user comment');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves model section');
    // [features] should be inserted between top-level lines and [model], not prepended
    const featuresIndex = content.indexOf('[features]');
    const modelIndex = content.indexOf('[model]');
    assert.ok(featuresIndex < modelIndex, '[features] comes before [model]');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF [features] comment-only table gets codex_hooks without losing adjacent text', () => {
    writeCodexConfig(codexHome, [
      '# user comment',
      '[features]',
      '# keep me',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features]\r\n# keep me\r\n\r\nhooks = true\r\n'), 'adds codex_hooks within comment-only table');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves following table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] with trailing comment gets one codex_hooks without a second table', () => {
    writeCodexConfig(codexHome, [
      '[features] # keep comment',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\s*\[features\](?:\s*#.*)?$/gm), 1, 'keeps one commented [features] header');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features] # keep comment\nother_feature = true'), 'preserves commented features table');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('[features] # keep comment'), 'adds codex_hooks within existing features table');
    assert.ok(content.indexOf('hooks = true') < content.indexOf('[model]'), 'does not create a second features table before model');
    assertNoDraftRootKeys(content);
  });

  test('existing [features] at EOF without trailing newline is updated in place', () => {
    writeCodexConfig(codexHome, '[model]\nname = "o3"\n\n[features]');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('[features]'), 'adds codex_hooks after the existing EOF features header');
    // In this EOF-without-trailing-newline edge case, the pre-existing
    // [features] header has no blank-line boundary to close it, so the
    // appended GSD marker/ownership comment textually falls *inside* what
    // reads as the [features] section body, and `hooks = true` is inserted
    // at the end of that body — after the marker, not before it. That
    // ordering is unrelated to #2406 (verified unchanged against
    // origin/next's install.js) and #2406 removed the [agents.<name>] role
    // tables that used to anchor this assertion, so anchor on the bare
    // [agents] dispatch-tuning table instead — codex_hooks always lands
    // before it.
    assert.ok(content.indexOf('hooks = true') < content.indexOf('[agents]'), 'keeps codex_hooks before the [agents] dispatch-tuning table');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] and codex_hooks = false are normalized and remain idempotent', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = false',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "echo custom"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'normalizes to one codex_hooks = true');
    assert.ok(!content.includes('codex_hooks = false'), 'removes false codex_hooks value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.ok(content.includes('command = "echo custom"'), 'preserves custom hook');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'does not duplicate GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('quoted codex_hooks keys inside [features] are normalized without adding a bare duplicate', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 1, 'normalizes the quoted key to true');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 0, 'does not append a bare duplicate codex_hooks key');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('quoted [features] headers are recognized as the existing features table', () => {
    writeCodexConfig(codexHome, [
      '["features"]',
      '"codex_hooks" = false',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[(?:"features"|'features'|features)\]\s*$/gm), 1, 'keeps one features table');
    assert.strictEqual(countMatches(content, /^"codex_hooks" = true$/gm), 1, 'normalizes the quoted codex_hooks key to true');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a second bare features table');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'keeps one GSD update hook in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('quoted table headers containing # are parsed without treating # as a comment start', () => {
    writeCodexConfig(codexHome, [
      '[features."a#b"]',
      'enabled = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('[features."a#b"]\nenabled = true'), 'preserves the quoted nested features table');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'adds one real top-level features table');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('existing dotted features config stays dotted and does not grow a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\.hooks = true$/gm), 1, 'adds one dotted codex_hooks key');
    assert.ok(content.includes('features.other_feature = true'), 'preserves existing dotted features key');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook for dotted codex_hooks and remains idempotent');
    assertNoDraftRootKeys(content);
  });

  test('root inline-table features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = { other_feature = true }',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = { other_feature = true }'), 'preserves the root inline-table assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    // #2406: config.toml no longer carries an [agents.<name>] role table —
    // it still installs the managed [agents] dispatch-tuning block.
    assert.ok(content.includes(GSD_CODEX_MARKER), 'still installs the managed GSD block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assertNoDraftRootKeys(content);
  });

  test('root scalar features assignments are left untouched without appending invalid dotted keys or hooks', () => {
    writeCodexConfig(codexHome, [
      'features = "disabled"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features = "disabled"'), 'preserves the root scalar assignment');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append an invalid dotted codex_hooks key');
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not prepend a features table');
    assert.strictEqual(countMatches(content, /gsd-check-update\.js/g), 0, 'does not add the GSD hook block when codex_hooks cannot be enabled safely');
    // #2406: config.toml no longer carries an [agents.<name>] role table —
    // it still installs the managed [agents] dispatch-tuning block.
    assert.ok(content.includes(GSD_CODEX_MARKER), 'still installs the managed GSD block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assertNoDraftRootKeys(content);
  });

  test('quoted dotted codex_hooks keys stay dotted and are normalized without duplication', () => {
    writeCodexConfig(codexHome, [
      'features."codex_hooks" = false',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 0, 'does not add a [features] table');
    assert.strictEqual(countMatches(content, /^features\."codex_hooks" = true$/gm), 1, 'normalizes the quoted dotted key to true');
    assert.strictEqual(countMatches(content, /^features\.codex_hooks = true$/gm), 0, 'does not append a bare dotted duplicate');
    assert.ok(content.includes('features.other_feature = true'), 'preserves other dotted features keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds one GSD update hook for quoted dotted codex_hooks and remains idempotent');
    assertNoDraftRootKeys(content);
  });

  test('multiline dotted features assignments insert codex_hooks after the full assignment block', () => {
    writeCodexConfig(codexHome, [
      'features.notes = """',
      'keep-me',
      '"""',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.ok(content.includes('features.notes = """\nkeep-me\n"""'), 'preserves the multiline dotted assignment');
    assert.strictEqual(countMatches(content, /^features\.hooks = true$/gm), 1, 'adds one dotted codex_hooks key');
    assert.ok(content.indexOf('features.hooks = true') > content.indexOf('"""'), 'inserts codex_hooks after the multiline assignment closes');
    assert.ok(content.indexOf('features.hooks = true') < content.indexOf('[model]'), 'inserts codex_hooks before the next table');
    assertNoDraftRootKeys(content);
  });

  test('existing empty [features] table is populated with one codex_hooks key', () => {
    writeCodexConfig(codexHome, '[features]\r\n\r\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds one codex_hooks key');
    assert.ok(content.includes('[features]\r\n\r\nhooks = true\r\n'), 'adds codex_hooks to empty table');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('multiline strings inside [features] do not create fake tables or fake codex_hooks matches', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'notes = \'\'\'',
      '[model]',
      'codex_hooks = false',
      '\'\'\'',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'adds a real codex_hooks key once');
    assert.ok(content.includes('notes = \'\'\'\n[model]\ncodex_hooks = false\n\'\'\''), 'preserves multiline string content');
    assert.strictEqual(countMatches(content, /^codex_hooks = false$/gm), 1, 'does not rewrite codex_hooks text inside multiline string');
    assert.ok(content.indexOf('hooks = true') > content.indexOf('other_feature = true'), 'does not stop the features section at multiline string content');
    // Parse structurally — verify codex_hooks and migrated AfterCommand hook via parsed object
    const parsed = parseTomlToObject(content);
    assert.equal(parsed.features?.hooks, true, 'writes a real hooks boolean key (#3566)');
    assert.ok(Array.isArray(parsed.hooks?.AfterCommand), 'AfterCommand flat [[hooks]] migrated to namespaced AoT');
    const afterCmds = parsed.hooks.AfterCommand.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((h) => h.command).filter(Boolean) : []
    );
    assert.ok(afterCmds.includes('echo custom-after-command'), 'preserves AfterCommand user hook command');
    assertNoDraftRootKeys(content);
  });

  test('non-boolean codex_hooks assignments are normalized to true without duplication', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = "sometimes"',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'normalizes to one true value');
    assert.ok(!content.includes('codex_hooks = "sometimes"'), 'removes non-boolean value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('multiline basic-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """',
      'multiline-basic-sentinel',
      'still-in-string',
      '"""',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline basic-string assignment with one true value');
    assert.ok(!content.includes('multiline-basic-sentinel'), 'removes multiline basic-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('multiline literal-string codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = \'\'\'',
      'multiline-literal-sentinel',
      'still-in-literal',
      '\'\'\'',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline literal-string assignment with one true value');
    assert.ok(!content.includes('multiline-literal-sentinel'), 'removes multiline literal-string continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('multiline array codex_hooks assignments are fully normalized without leaving trailing lines behind', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = [',
      '  "array-sentinel-1",',
      '  "array-sentinel-2",',
      ']',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'replaces the multiline array assignment with one true value');
    assert.ok(!content.includes('array-sentinel-1'), 'removes multiline array continuation lines');
    assert.ok(!content.includes('array-sentinel-2'), 'removes multiline array continuation lines');
    assert.ok(content.includes('other_feature = true'), 'preserves following feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'remains idempotent for the GSD hook block in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('triple-quoted codex_hooks values keep inline comments when normalized', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = """sometimes""" # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 1, 'normalizes to true and preserves inline comment');
    assert.ok(!content.includes('"""sometimes"""'), 'removes the old triple-quoted value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assertNoDraftRootKeys(content);
  });

  test('existing CRLF codex_hooks = true stays single and preserves non-GSD hooks', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true$/gm), 1, 'keeps one codex_hooks = true');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(content, /echo custom-after-command/g), 1, 'preserves non-GSD hook exactly once');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'keeps one GSD update hook in hooks.json');
    assertUsesOnlyEol(content, '\r\n');
    assertNoDraftRootKeys(content);
  });

  test('codex_hooks = true with an inline comment is treated as enabled for hook installation', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true # keep me',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    assert.strictEqual(countMatches(content, /^\[features\]\s*$/gm), 1, 'keeps one [features] section');
    assert.strictEqual(countMatches(content, /^codex_hooks = true # keep me$/gm), 1, 'preserves the commented true value');
    assert.ok(content.includes('other_feature = true'), 'preserves other feature keys');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'adds the GSD update hook once in hooks.json');
    assertNoDraftRootKeys(content);
  });

  test('mixed-EOL configs use the first newline style for inserted Codex content', () => {
    writeCodexConfig(codexHome, '# first line wins\n[model]\r\nname = "o3"\r\n');

    runCodexInstall(codexHome);
    runCodexInstall(codexHome);

    const content = readCodexConfig(codexHome);
    // [features] is inserted after top-level lines, before [model] — not prepended
    assert.ok(content.includes('# first line wins\n\n[features]\nhooks = true\n'), 'inserts features after top-level lines using first newline style');
    assert.ok(content.includes(`# GSD Agent Configuration — managed by gsd-core installer\n`), 'writes the managed agent block using the first newline style');
    // Structural check: managed SessionStart hooks live in hooks.json.
    const parsedMixed = parseTomlToObject(content);
    assert.ok(!parsedMixed.hooks || !Array.isArray(parsedMixed.hooks.SessionStart), 'does not write managed SessionStart hooks to config.toml');
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdEntries = hooksJsonCommands.filter((cmd) => cmd.includes('gsd-check-update'));
    assert.strictEqual(gsdEntries.length, 1, 'writes one managed SessionStart hook to hooks.json');
    assert.ok(content.includes('[model]\r\nname = "o3"'), 'preserves the existing CRLF model lines');
    assert.strictEqual(countMatches(content, /^hooks = true$/gm), 1, 'remains idempotent on repeated installs');
    assertNoDraftRootKeys(content);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2695-codex-hook-set.test.cjs — consolidation epic #1969 (H3 W4 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2695-codex-hook-set (consolidation epic #1969 H3 W4 #3336)", () => {
// Regression tests for #2695 — Codex native updates omit the update-hook worker
// and the managed-hooks registry.
//
// The Codex install branch in bin/install.js used to allowlist only two of the
// four hook files the shipped build emitted at the time (gsd-check-update.js +
// gsd-context-monitor.js — the latter permanently removed by #2586, see below),
// and gated the entire branch on !isMinimalMode so the
// `core` profile installed none of them. The parent SessionStart hook spawn()s
// the worker, which require()s the registry — so Codex was wired to a dependency
// chain the same installer never delivered.
//
// These tests drive the real installer (bin/install.js) behaviorally into an
// isolated temp config dir and assert the complete three-file set is delivered
// for both profiles, the registry is byte-for-byte, the version stamps resolve
// to the installed package version, and unrelated user files are preserved.
//
// #2586 reduced the set back to three: gsd-context-monitor.js read a Claude-only
// statusline bridge file Codex never writes, so it was a guaranteed silent no-op
// on every Codex hook event and was dropped from CODEX_HOOKS_TO_COPY for good.
//
// Verified non-duplicate: the pre-existing 'Codex install hook configuration
// (e2e)' suite above only asserts gsd-check-update.js delivery/wiring — it never
// asserts on gsd-check-update-worker.js, managed-hooks-registry.cjs, the
// core/full profile matrix, upgrade-refresh, byte-for-byte registry copy,
// idempotency of the three-file set, user-file preservation, or the
// core-profile negative-space (no agent files) — all genuinely distinct
// assertions this fold adds.

'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { cleanup } = require('./helpers.cjs');
const {
  INSTALL_SCRIPT,
  BUILD_SCRIPT,
  HOOKS_DIST,
  installerEnv,
} = require('./helpers/install-shared.cjs');

const PKG_VERSION = require('../package.json').version;

// #3145: class-norm timeouts, not per-suite values — see helpers/timeouts.cjs.
const {
  BUILD_TIMEOUT_MS: BUILD_HOOKS_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
} = require('./helpers/timeouts.cjs');

// The three-file hook set the Codex surface must deliver together (#2695).
// gsd-context-monitor.js was removed from this set by #2586: it read a
// Claude-only statusline bridge file Codex never writes, so it was a
// guaranteed silent no-op on every Codex hook event.
const CODEX_HOOK_FILES = [
  'gsd-check-update.js',
  'gsd-check-update-worker.js',
  'managed-hooks-registry.cjs',
];

// Build hooks/dist before any install runs (the installer copies from there).
before(() => {
  const r = runNode([BUILD_SCRIPT], { timeoutMs: BUILD_HOOKS_TIMEOUT_MS });
  throwIfFailed(r, `node ${BUILD_SCRIPT}`);
});

function hooksDirOf(configDir) {
  return path.join(configDir, 'hooks');
}

/** Run the Codex installer into an isolated temp config dir. */
function runCodexInstall({ profile, preseed }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2695-${profile}-`));
  if (preseed) {
    const hooksDest = hooksDirOf(configDir);
    fs.mkdirSync(hooksDest, { recursive: true });
    for (const [name, body] of Object.entries(preseed)) {
      fs.writeFileSync(path.join(hooksDest, name), body);
    }
  }
  // Sandbox HOME/USERPROFILE to configDir: Codex's skills-kind `home: ".agents"`
  // override resolves via os.homedir(); sandboxing keeps the spawn self-contained
  // (mirrors tests/install-minimal-hooks.test.cjs Codex downgrade test).
  const result = runNode(
    [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', configDir, `--profile=${profile}`],
    { env: installerEnv({ HOME: configDir, USERPROFILE: configDir }), timeoutMs: INSTALL_TIMEOUT_MS },
  );
  return { configDir, result };
}

// Older-version stamp used to pre-seed an "upgrade" scenario.
const OLDER_VERSION = '1.7.0';

describe('#2695: fresh Codex installs deliver the complete three-file hook set', () => {
  for (const profile of ['core', 'full']) {
    test(`fresh --profile=${profile} installs all three hook files`, (t) => {
      const { configDir, result } = runCodexInstall({ profile });
      t.after(() => cleanup(configDir));

      const hooksDir = hooksDirOf(configDir);
      for (const file of CODEX_HOOK_FILES) {
        assert.ok(
          fs.existsSync(path.join(hooksDir, file)),
          `expected ${file} under <config>/hooks for --profile=${profile}\n` +
            `installer stdout: ${result.stdout}\ninstaller stderr: ${result.stderr}`,
        );
      }
    });
  }
});

describe('#2695: Codex upgrades refresh all three hook files to the current version', () => {
  // Pre-seed all three files stamped at OLDER_VERSION so an upgrade must overwrite them.
  function olderSeed() {
    const seed = {};
    for (const name of CODEX_HOOK_FILES) {
      // Registry carries no version token; seed it with a stale sentinel body.
      if (name.endsWith('.cjs')) {
        seed[name] = `// stale registry ${OLDER_VERSION}\nmodule.exports = {};\n`;
      } else {
        seed[name] = `// gsd-hook-version: ${OLDER_VERSION}\n// stale\n`;
      }
    }
    return seed;
  }

  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} upgrade refreshes all three hook files`, (t) => {
      const { configDir, result } = runCodexInstall({ profile, preseed: olderSeed() });
      t.after(() => cleanup(configDir));

      const hooksDir = hooksDirOf(configDir);
      // All three must now carry the current version stamp where one exists, and
      // the registry must no longer be the stale sentinel.
      for (const name of CODEX_HOOK_FILES) {
        const dest = path.join(hooksDir, name);
        assert.ok(
          fs.existsSync(dest),
          `expected refreshed ${name} for --profile=${profile}\n` +
            `installer stdout: ${result.stdout}\ninstaller stderr: ${result.stderr}`,
        );
      }
      // The registry must be REFRESHED on upgrade, not merely present: assert it no
      // longer carries the stale sentinel and now matches the shipped dist byte-for-byte
      // (the raw-copy fallback must overwrite an existing dest, not skip it).
      const registryDest = path.join(hooksDir, 'managed-hooks-registry.cjs');
      const registryBytes = fs.readFileSync(registryDest, 'utf8');
      assert.ok(
        !registryBytes.includes(`stale registry ${OLDER_VERSION}`),
        `registry must be refreshed on upgrade for --profile=${profile} (still carries the stale sentinel)`,
      );
      assert.deepStrictEqual(
        fs.readFileSync(registryDest),
        fs.readFileSync(path.join(HOOKS_DIST, 'managed-hooks-registry.cjs')),
        `refreshed registry must match hooks/dist byte-for-byte for --profile=${profile}`,
      );
      // Version stamps resolved (acceptance #2/#3).
      const workerStamp = readHookVersionLine(path.join(hooksDir, 'gsd-check-update-worker.js'));
      assert.strictEqual(
        workerStamp, PKG_VERSION,
        `worker gsd-hook-version stamp must be the installed package version (${PKG_VERSION}), ` +
          `got "${workerStamp}" for --profile=${profile}`,
      );
      const parentStamp = readHookVersionLine(path.join(hooksDir, 'gsd-check-update.js'));
      assert.strictEqual(
        parentStamp, PKG_VERSION,
        `parent gsd-check-update stamp must be the installed package version (${PKG_VERSION}), ` +
          `got "${parentStamp}" for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: managed-hooks-registry.cjs is copied byte-for-byte', () => {
  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} registry matches hooks/dist byte-for-byte`, (t) => {
      const { configDir, result } = runCodexInstall({ profile });
      t.after(() => cleanup(configDir));

      const dest = path.join(hooksDirOf(configDir), 'managed-hooks-registry.cjs');
      assert.ok(fs.existsSync(dest), `registry missing for --profile=${profile}\nstdout: ${result.stdout}`);
      const distBytes = fs.readFileSync(path.join(HOOKS_DIST, 'managed-hooks-registry.cjs'));
      const destBytes = fs.readFileSync(dest);
      assert.deepStrictEqual(
        destBytes, distBytes,
        `managed-hooks-registry.cjs must be copied byte-for-byte (no version/path transform) for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: worker hook-version stamp is a literal install-time value', () => {
  test('the stamp is the literal package version, never a placeholder or a runtime lookup', (t) => {
    const { configDir } = runCodexInstall({ profile: 'full' });
    t.after(() => cleanup(configDir));

    const workerPath = path.join(hooksDirOf(configDir), 'gsd-check-update-worker.js');
    const content = fs.readFileSync(workerPath, 'utf8');
    // The placeholder must have been replaced — a leftover {{GSD_VERSION}} is the bug shape.
    assert.ok(
      !content.includes('{{GSD_VERSION}}'),
      'worker still carries an unresolved {{GSD_VERSION}} placeholder — stamping did not run',
    );
    // And the resolved value must be the literal version, present on the version-comment line.
    const stamp = readHookVersionLine(workerPath);
    assert.strictEqual(stamp, PKG_VERSION, `worker stamp must equal package.json version, got "${stamp}"`);
  });
});

describe('#2695: unrelated user-owned hook files are preserved', () => {
  for (const profile of ['core', 'full']) {
    test(`--profile=${profile} leaves a pre-existing user hook untouched`, (t) => {
      const userOwned = 'my-custom-hook.js';
      const userBody = '// user-owned hook — do not touch\nconsole.log("mine");\n';
      const { configDir, result } = runCodexInstall({ profile, preseed: { [userOwned]: userBody } });
      t.after(() => cleanup(configDir));

      const dest = path.join(hooksDirOf(configDir), userOwned);
      assert.ok(fs.existsSync(dest), `user-owned ${userOwned} must be preserved for --profile=${profile}\nstdout: ${result.stdout}`);
      assert.strictEqual(
        fs.readFileSync(dest, 'utf8'), userBody,
        `user-owned ${userOwned} bytes must be unchanged for --profile=${profile}`,
      );
    });
  }
});

describe('#2695: re-running the installer is idempotent for the three-file set', () => {
  test('a second full install leaves all three files present and correctly stamped', (t) => {
    const first = runCodexInstall({ profile: 'full' });
    t.after(() => cleanup(first.configDir));
    // Second run into the SAME config dir.
    const result2 = runNode(
      [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', first.configDir, '--profile=full'],
      { env: installerEnv({ HOME: first.configDir, USERPROFILE: first.configDir }), timeoutMs: INSTALL_TIMEOUT_MS },
    );
    assert.ok(result2.stdout || result2.stderr);

    const hooksDir = hooksDirOf(first.configDir);
    for (const name of CODEX_HOOK_FILES) {
      assert.ok(fs.existsSync(path.join(hooksDir, name)), `${name} must survive a second install`);
    }
    assert.strictEqual(
      readHookVersionLine(path.join(hooksDir, 'gsd-check-update-worker.js')),
      PKG_VERSION,
      'worker stamp must remain correct after a second install',
    );
  });
});

describe('#2695: the core profile enables the hook feature and wires SessionStart (intended)', () => {
  // For the update-check/context-monitor hooks to actually fire, Codex needs both
  // the feature flag in config.toml AND the hooks.json routing — copying inert
  // files alone would leave `core` with scripts Codex never invokes. Entering the
  // codex-toml branch for `core` (the #2695 gate change) synthesizes `[features]
  // hooks = true` via ensureCodexHooksFeature, writes config.toml, and registers
  // the hooks. This is the intended behavior of the fix, not a side effect — these
  // assertions pin it so a future re-gating cannot silently regress it.
  test('--profile=core writes config.toml enabling the hooks feature', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    const configPath = path.join(configDir, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'core must write config.toml so the hooks feature is enabled');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(/^\s*hooks\s*=\s*true\s*$/m.test(config), 'config.toml must enable hooks = true for core');
  });

  test('--profile=core wires the SessionStart update-check hook in hooks.json', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    const hooksJsonPath = path.join(configDir, 'hooks.json');
    assert.ok(fs.existsSync(hooksJsonPath), 'core must write hooks.json');
    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const sessionStartCmds = collectHookCommands(hooksJson, 'SessionStart');
    // The command points at the gsd-check-update hook script. Its extension is
    // platform-specific — Windows routes through a .cmd shim, POSIX through .js —
    // so assert on the basename prefix, not a hardcoded extension (Windows parity).
    const routedToUpdateHook = sessionStartCmds.some((c) => {
      const token = c.replace(/"/g, '').replace(/\\/g, '/');
      const segs = token.split('/');
      const last = segs[segs.length - 1];
      return last.startsWith('gsd-check-update.');
    });
    assert.ok(
      routedToUpdateHook,
      `core must route SessionStart to the gsd-check-update hook in hooks.json; got: ${JSON.stringify(sessionStartCmds)}`,
    );
  });
});

describe('#2695: the core profile still installs no agent files (negative space)', () => {
  test('--profile=core delivers hooks but no gsd-* agent files', (t) => {
    const { configDir } = runCodexInstall({ profile: 'core' });
    t.after(() => cleanup(configDir));

    // Hooks delivered (the fix)…
    for (const name of CODEX_HOOK_FILES) {
      assert.ok(fs.existsSync(path.join(hooksDirOf(configDir), name)), `${name} delivered for core`);
    }
    // …but the full agent surface is still absent (core stays minimal). Codex agents
    // are .toml ([agents.gsd-*] in config.toml + agents/gsd-*.toml), so check both
    // extensions — a .md-only filter would miss a Codex agent-surface regression.
    const agentsDir = path.join(configDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      const gsdAgents = fs.readdirSync(agentsDir).filter(
        (f) => f.startsWith('gsd-') && (f.endsWith('.md') || f.endsWith('.toml')),
      );
      assert.deepStrictEqual(gsdAgents, [], 'core must not install the full agent surface');
    }
    // And config.toml must carry no agent role sections.
    const configPath = path.join(configDir, 'config.toml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf8');
      assert.ok(
        !/^\[agents\.gsd-/m.test(config),
        'core config.toml must not declare [agents.gsd-*] roles (full agent surface stays a full-profile concern)',
      );
    }
  });
});

/**
 * Read the `// gsd-hook-version: <value>` comment value from a hook file.
 * Returns the trimmed literal. Used so tests assert on the structured stamp,
 * not on raw `.includes()` prose (CONTRIBUTING raw-text-matching rule).
 */
function readHookVersionLine(hookPath) {
  const content = fs.readFileSync(hookPath, 'utf8');
  const m = content.match(/^\/\/ gsd-hook-version:\s*(.+?)\s*$/m);
  return m ? m[1] : null;
}

/**
 * Collect every hook command string registered under a given Codex hooks.json
 * event key. Used so the SessionStart-wiring test asserts on the structured
 * hook entries (commands), not on raw text matching against the whole file.
 */
function collectHookCommands(hooksJson, eventName) {
  const entries = (hooksJson && hooksJson.hooks && Array.isArray(hooksJson.hooks[eventName]))
    ? hooksJson.hooks[eventName]
    : [];
  return entries.flatMap((entry) =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map((h) => (h && typeof h.command === 'string' ? h.command : null))
      .filter(Boolean),
  );
}
  });
}


describe('Codex uninstall symmetry for hook-enabled configs', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-uninstall-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fresh install removes the GSD-added codex_hooks feature on uninstall', () => {
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.strictEqual(cleaned, null, 'fresh GSD-only config strips back to nothing');
  });

  test('install then uninstall removes [features].codex_hooks while preserving other feature keys, comments, hooks, and CRLF', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '# keep me',
      'other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned, 'preserves user config after uninstall cleanup');
    assert.strictEqual(countMatches(cleaned, /^\[features\](?:\s*#.*)?$/gm), 1, 'keeps the existing features table');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the GSD-added codex_hooks key');
    assert.ok(cleaned.includes('# keep me'), 'preserves user comments in [features]');
    assert.ok(cleaned.includes('other_feature = true'), 'preserves other feature keys');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes only the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
    assertUsesOnlyEol(cleaned, '\r\n');
  });

  test('install then uninstall removes dotted features.codex_hooks without creating a [features] table', () => {
    writeCodexConfig(codexHome, [
      'features.other_feature = true',
      '',
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom-after-command"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.other_feature = true'), 'preserves other dotted feature keys');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 0, 'removes the dotted GSD codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /^\[features\]\s*$/gm), 0, 'does not leave behind a [features] table');
    assert.strictEqual(countMatches(cleaned, /echo custom-after-command/g), 1, 'preserves non-GSD hooks');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
  });

  test('install then uninstall preserves a pre-existing [features].codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      'codex_hooks = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\ncodex_hooks = true\nother_feature = true'), 'preserves the user-authored codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 1, 'keeps the pre-existing codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing quoted [features]."codex_hooks" = true', () => {
    writeCodexConfig(codexHome, [
      '[features]',
      '"codex_hooks" = true',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('[features]\n"codex_hooks" = true\nother_feature = true'), 'preserves the user-authored quoted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^"codex_hooks" = true$/gm), 1, 'keeps the pre-existing quoted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall preserves a pre-existing root dotted features.codex_hooks = true', () => {
    writeCodexConfig(codexHome, [
      'features.codex_hooks = true',
      'features.other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('features.codex_hooks = true\nfeatures.other_feature = true'), 'preserves the user-authored dotted codex_hooks assignment');
    assert.strictEqual(countMatches(cleaned, /^features\.codex_hooks = true$/gm), 1, 'keeps the pre-existing dotted codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });

  test('install then uninstall leaves short-circuited root features assignments untouched', () => {
    const cases = [
      'features = { other_feature = true }\n\n[model]\nname = "o3"\n',
      'features = "disabled"\n\n[model]\nname = "o3"\n',
    ];

    for (const initialContent of cases) {
      writeCodexConfig(codexHome, initialContent);
      runCodexInstall(codexHome);

      const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
      assert.strictEqual(cleaned, initialContent, `preserves short-circuited root features assignment: ${initialContent.split(/\r?\n/)[0]}`);

      cleanup(codexHome);
      fs.mkdirSync(codexHome, { recursive: true });
    }
  });

  test('install then uninstall keeps mixed-EOL user content stable while removing GSD hook state', () => {
    const initialContent = [
      '# first line wins',
      '[features]',
      'other_feature = true',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\r\n').replace(/^# first line wins\r\r?\n/, '# first line wins\n');

    writeCodexConfig(codexHome, initialContent);
    runCodexInstall(codexHome);

    const cleaned = stripGsdFromCodexConfig(readCodexConfig(codexHome));
    assert.ok(cleaned.includes('# first line wins\n[features]\r\nother_feature = true\r\n\r\n[model]\r\nname = "o3"'), 'preserves the original mixed-EOL user content');
    assert.strictEqual(countMatches(cleaned, /^codex_hooks = true$/gm), 0, 'removes the injected codex_hooks key');
    assert.strictEqual(countMatches(cleaned, /gsd-check-update\.js/g), 0, 'removes the GSD update hook');
    assert.strictEqual(countMatches(cleaned, /\[agents\.gsd-/g), 0, 'removes managed GSD agent sections');
  });
});

// ─── #1326: cleanupCodexSkillMetadataSidecars (replaces #774 writeCodexSkillMetadataFiles) ──

describe('cleanupCodexSkillMetadataSidecars (#1326)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-sidecar-cleanup-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Codex install does not emit managed agents/openai.yaml sidecars and removes stale ones (#1326)', () => {
    // gsd-foo: managed skill with stale sidecar → sidecar removed, empty agents/ pruned
    const fooAgents = path.join(tmpDir, 'gsd-foo', 'agents');
    fs.mkdirSync(fooAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-foo', 'SKILL.md'), '---\nname: gsd-foo\n---\nBody.\n');
    fs.writeFileSync(path.join(fooAgents, 'openai.yaml'), 'interface:\n  display_name: "foo"\n');

    // gsd-dev-preferences: user-owned → sidecar PRESERVED
    const prefAgents = path.join(tmpDir, 'gsd-dev-preferences', 'agents');
    fs.mkdirSync(prefAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-dev-preferences', 'SKILL.md'), '---\nname: gsd-dev-preferences\n---\nBody.\n');
    const userYaml = 'interface:\n  display_name: "my prefs"\n  short_description: "User-authored"\n';
    fs.writeFileSync(path.join(prefAgents, 'openai.yaml'), userYaml);

    // gsd-bar: managed skill with sidecar + another file in agents/ → sidecar removed, agents/ kept (has other.txt)
    const barAgents = path.join(tmpDir, 'gsd-bar', 'agents');
    fs.mkdirSync(barAgents, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-bar', 'SKILL.md'), '---\nname: gsd-bar\n---\nBody.\n');
    fs.writeFileSync(path.join(barAgents, 'openai.yaml'), 'interface:\n  display_name: "bar"\n');
    fs.writeFileSync(path.join(barAgents, 'other.txt'), 'some other content\n');

    // helper: non-gsd dir with openai.yaml → UNTOUCHED
    const helperAgents = path.join(tmpDir, 'helper', 'agents');
    fs.mkdirSync(helperAgents, { recursive: true });
    fs.writeFileSync(path.join(helperAgents, 'openai.yaml'), 'interface:\n  display_name: "helper"\n');

    cleanupCodexSkillMetadataSidecars(tmpDir);

    // gsd-foo: sidecar removed and empty agents/ pruned
    assert.ok(!fs.existsSync(path.join(fooAgents, 'openai.yaml')),
      'gsd-foo/agents/openai.yaml must be removed (managed stale sidecar)');
    assert.ok(!fs.existsSync(fooAgents),
      'gsd-foo/agents/ must be pruned when empty after sidecar removal');

    // gsd-dev-preferences: user-owned, sidecar preserved
    assert.ok(fs.existsSync(path.join(prefAgents, 'openai.yaml')),
      'gsd-dev-preferences/agents/openai.yaml must be preserved (user-owned)');
    assert.strictEqual(fs.readFileSync(path.join(prefAgents, 'openai.yaml'), 'utf8'), userYaml,
      'gsd-dev-preferences/agents/openai.yaml content must be unchanged');

    // gsd-bar: sidecar removed but agents/ kept (still has other.txt)
    assert.ok(!fs.existsSync(path.join(barAgents, 'openai.yaml')),
      'gsd-bar/agents/openai.yaml must be removed');
    assert.ok(fs.existsSync(barAgents),
      'gsd-bar/agents/ must NOT be pruned (still contains other.txt)');
    assert.ok(fs.existsSync(path.join(barAgents, 'other.txt')),
      'gsd-bar/agents/other.txt must be preserved');

    // helper: non-gsd dir untouched
    assert.ok(fs.existsSync(path.join(helperAgents, 'openai.yaml')),
      'helper/agents/openai.yaml must be untouched (non-gsd dir)');
  });

  test('is a no-op when skillsDir does not exist (#1326)', () => {
    assert.doesNotThrow(() => {
      cleanupCodexSkillMetadataSidecars(path.join(tmpDir, 'nonexistent'));
    }, 'must not throw when skillsDir does not exist');
  });

  test('is a no-op for managed gsd-* dirs with no agents/openai.yaml (#1326)', () => {
    // No sidecar present — should not throw, should not create anything
    const skillDir = path.join(tmpDir, 'gsd-baz');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: gsd-baz\n---\nBody.\n');

    assert.doesNotThrow(() => {
      cleanupCodexSkillMetadataSidecars(tmpDir);
    }, 'must not throw when no sidecar exists');
    assert.ok(!fs.existsSync(path.join(skillDir, 'agents')),
      'must not create agents/ dir when no sidecar was present');
  });

  test('does not delete through a symlinked agents/ directory (#1326)', { skip: process.platform === 'win32' }, () => {
    // Setup: a skills dir with gsd-foo/ whose agents/ is a SYMLINK to an external dir.
    // The cleanup must not delete files through the symlink.
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-symlink-ext-'));
    try {
      // Place openai.yaml and a sentinel in the external dir.
      fs.writeFileSync(path.join(externalDir, 'openai.yaml'), 'interface:\n  display_name: "external"\n');
      fs.writeFileSync(path.join(externalDir, 'keep.txt'), 'sentinel\n');

      // Create gsd-foo/ in the skills dir and make agents/ a symlink to externalDir.
      const skillDir = path.join(tmpDir, 'gsd-foo');
      fs.mkdirSync(skillDir, { recursive: true });
      const agentsLink = path.join(skillDir, 'agents');
      fs.symlinkSync(externalDir, agentsLink, 'dir');

      cleanupCodexSkillMetadataSidecars(tmpDir);

      // Nothing in the external dir must have been deleted.
      assert.ok(fs.existsSync(path.join(externalDir, 'openai.yaml')),
        'external/openai.yaml must still exist — cleanup must not delete through a symlinked agents/ dir');
      assert.ok(fs.existsSync(path.join(externalDir, 'keep.txt')),
        'external/keep.txt must still exist — cleanup must not delete through a symlinked agents/ dir');
      // The symlink itself must still be present.
      assert.ok(fs.existsSync(agentsLink),
        'gsd-foo/agents symlink must still exist');
    } finally {
      cleanup(externalDir);
    }
  });

  test('Codex install does not create agents/openai.yaml sidecars for any managed skill (#1326)', () => {
    // Integration test: full Codex install must NOT produce any managed gsd-*/agents/openai.yaml
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    runCodexInstall(codexHome);
    const skillsDir = codexSkillsRoot(codexHome);
    assert.ok(fs.existsSync(skillsDir), 'Codex install must create a skills/ directory');
    const gsdSkillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-') && e.name !== 'gsd-dev-preferences');
    assert.ok(gsdSkillDirs.length > 0, 'install must create at least one managed gsd-* skill directory');
    for (const skillEntry of gsdSkillDirs) {
      const yamlPath = path.join(skillsDir, skillEntry.name, 'agents', 'openai.yaml');
      assert.ok(!fs.existsSync(yamlPath),
        `${skillEntry.name}/agents/openai.yaml must NOT exist after install (#1326 sidecar dedup)`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2698-crlf-install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2698-crlf-install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #2698)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2698: CRLF line endings break agent-block strip regexes
 *
 * The legacy `gsd-update-check` hook migration in bin/install.js uses two
 * separate .replace() calls:
 *   1. LF-only regex: /\n# GSD Hooks\n\[\[hooks\]\]\nevent = ...\n/
 *   2. CRLF-only regex: /\r\n# GSD Hooks\r\n\[\[hooks\]\]\r\nevent = ...\r\n/
 *
 * These patterns fail when config.toml has mixed line endings — e.g. the
 * "# GSD Hooks" header uses LF but the body uses CRLF, or vice versa. This
 * can happen when the file is created cross-platform (Windows/Linux), when
 * editors convert only part of the file, or when a previous GSD version wrote
 * the block with different EOL than the file's dominant EOL.
 *
 * Fix: consolidate to a single \r?\n-aware regex that handles LF, CRLF, and
 * any mix in a single pass, making the migration robust regardless of the
 * platform the file was last written on.
 *
 * Test approach: write a `.codex/config.toml` with a stale gsd-update-check
 * block that uses mixed line endings (header in LF, body in CRLF), then run
 * install() and assert the stale block is gone.
 *
 * Note: The local Codex install writes to `.codex/` in the current directory.
 * Tests `process.chdir(tmpDir)` and write fixtures to `tmpDir/.codex/`.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { install, GSD_CODEX_MARKER } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// Ensure hooks/dist/ is populated before install tests
before(() => {
  throwIfFailed(
    runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
    `node ${BUILD_SCRIPT}`,
  );
});

describe('#2698: CRLF stale gsd-update-check block is removed on Codex reinstall', () => {
  let tmpDir;
  let _previousHome;
  let _previousUserProfile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-crlf-install-2698-'));
    // #2088 (ADR-1239 upgrade 3): Codex's skills-kind `home: ".agents"` override
    // applies to BOTH global and local scope and resolves via os.homedir(). This
    // describe block calls install(false, 'codex') (local scope) directly —
    // without sandboxing HOME/USERPROFILE to tmpDir, that in-process install
    // would materialize a full gsd-* skill set into the developer/CI machine's
    // REAL $HOME/.agents/skills instead of the temp dir.
    _previousHome = process.env.HOME;
    _previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(() => {
    if (_previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = _previousHome;
    if (_previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = _previousUserProfile;
    // Use the shared 5s Windows-EBUSY retry budget instead of inline 1s.
    cleanup(tmpDir);
  });

  // Helper: pre-populate .codex/config.toml with a GSD marker + stale hooks block
  // using the given line ending for the stale hooks block header, and a potentially
  // different EOL for the hooks body. This exercises the cross-platform mixed scenario.
function writeCodexConfigWithStaleHooks(dir, headerEol, bodyEol) {
    // Build the stale block with header EOL for the "# GSD Hooks" line, but body EOL
    // for the content lines (simulates a file edited by two different platforms).
    const staleBlock = [
      '# GSD Hooks',           // line that starts the stale section
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/gsd-update-check.js"',
    ].join(bodyEol);

    // Put the stale block in user content BEFORE the GSD marker. The GSD marker area
    // will be regenerated by mergeCodexConfig during install(); the stale block in
    // the user area is what the hooks migration must remove.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
    ].join(headerEol) + headerEol + staleBlock + headerEol + headerEol + GSD_CODEX_MARKER + headerEol;

    const codexDir = path.join(dir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configPath, content, 'utf-8');
    return configPath;
  }

  function readHooksSessionStartCommands(codexHome) {
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

  test('LF config.toml: stale gsd-update-check block removed on reinstall', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    writeCodexConfigWithStaleHooks(tmpDir, '\n', '\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      'Stale gsd-update-check entry must be removed from LF config.toml (#2698)'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(path.join(tmpDir, '.codex'));
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'New gsd-check-update hook must appear in hooks.json after reinstall'
    );
  });

  test('CRLF config.toml: stale gsd-update-check block removed on reinstall', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    writeCodexConfigWithStaleHooks(tmpDir, '\r\n', '\r\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      'Stale gsd-update-check entry must be removed from CRLF config.toml (#2698)'
    );
    const hooksJsonCommands = readHooksSessionStartCommands(path.join(tmpDir, '.codex'));
    assert.equal(
      hooksJsonCommands.some((cmd) => cmd.includes('gsd-check-update')),
      true,
      'New gsd-check-update hook must appear in hooks.json after reinstall'
    );
  });

  test('mixed-EOL config.toml: stale block with LF header but CRLF body removed on reinstall', (t) => {
    // This is the primary failure case: header line uses LF but the body uses CRLF.
    // The old LF-only regex requires all-\n separators; the old CRLF-only regex requires
    // all-\r\n separators. Neither matches a block with mixed endings, so the stale
    // block survives reinstall with the old code (#2698).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // headerEol='\n' (file dominant), bodyEol='\r\n' (hook block from another platform)
    writeCodexConfigWithStaleHooks(tmpDir, '\n', '\r\n');
    install(false, 'codex');

    const configPath = path.join(tmpDir, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');

    assert.ok(
      !content.includes('gsd-update-check'),
      [
        'Stale gsd-update-check block with mixed LF/CRLF endings must be removed (#2698).',
        'Old code used two separate LF-only and CRLF-only regexes; neither matched mixed content.',
        'Fix consolidates to a single \\r?\\n-aware regex.',
      ].join(' ')
    );
  });
});
  });
}
