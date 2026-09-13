/**
 * GSD Tools Tests - codex-config.cjs
 *
 * Tests for Codex adapter header, agent conversion, config.toml generation/merge,
 * per-agent .toml generation, and uninstall cleanup.
 */

// Enable test exports from install.js (skips main CLI logic)
process.env.GSD_TEST_MODE = '1';

const { test: _test, describe: _describe, before, beforeEach: _beforeEach, afterEach: _afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const _os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { cleanup: _cleanup } = require('./helpers.cjs');
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
  cleanupCodexSkillMetadataSidecars: _cleanupCodexSkillMetadataSidecars,
  generateCodexConfigBlock: _generateCodexConfigBlock,
  stripGsdFromCodexConfig: _stripGsdFromCodexConfig,
  migrateCodexHooksMapFormat: _migrateCodexHooksMapFormat,
  mergeCodexConfig: _mergeCodexConfig,
  install,
  GSD_CODEX_MARKER: _GSD_CODEX_MARKER,
  deriveCodexSandboxMode: _deriveCodexSandboxMode,
  // #3897 rung 3 (ADR-3473 §8.3, option 2 — HALT.md): anticipated new export
  // holding the 17 explicit read-only pins for roles whose tool contract would
  // otherwise derive workspace-write (16 measured by HALT.md + gsd-nyquist-auditor,
  // surfaced by the list-form parse fix). Does not exist on the current tree —
  // destructuring a non-existent key is `undefined`, not a throw, so requiring
  // this module still succeeds; every test below that touches it fails on its
  // own `typeof` guard instead.
  CODEX_SANDBOX_HOLDS: _CODEX_SANDBOX_HOLDS,
  parseTomlToObject: _parseTomlToObject,
  validateCodexConfigSchema: _validateCodexConfigSchema,
  uninstall: _uninstall,
  CODEX_EXTENDED_HOOK_EVENTS: _CODEX_EXTENDED_HOOK_EVENTS,
} = require('../bin/install.js');

const { resolveNodeRunner: _resolveNodeRunner } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
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

function _runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
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
// Folded from tests/bug-2760-codex-install-defensive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2760-codex-install-defensive (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #2760 — Codex install path corrupts existing config.toml.
 *
 * Three defects, three fixes (defensive triple):
 *
 *   Defect 3 (confirmed real) — Hooks AoT downgrade. When the user already has
 *     `[[hooks.SessionStart]]` (namespaced AoT) entries in their config, GSD
 *     used to append a `[[hooks]]` (top-level AoT) block that confuses
 *     round-trip writers and produces a config Codex refuses to load.
 *     Fix: detect the user's preferred shape and emit GSD's hook in the same
 *     namespaced form so both coexist cleanly.
 *
 *   Defects 1+2 (defensive) — Strip-step robustness. Pre-existing legacy
 *     `[agents]` (single-bracket) and `[[agents]]` (sequence) blocks are
 *     invalid in current Codex schema and break Codex even though GSD now
 *     emits the correct `[agents.<name>]` struct form. Fix: install-time
 *     stripping always purges these forms regardless of GSD marker presence
 *     so reinstall self-heals files where the marker was edited out or never
 *     existed (third-party tools).
 *
 *   Fix 3 (defensive) — Post-write validation. Parse the bytes we are about
 *     to commit, assert they match Codex's expected schema (no bare/sequence
 *     `agents`, no bare `hooks.<Event>`); on failure, restore the pre-install
 *     backup and abort so the user never gets a broken Codex CLI.
 */

// Scope GSD_TEST_MODE to module load only — restore prior value (or unset) so
// downstream tests in the same node process never see test-only behaviour
// leak through (#2760 CR4 finding 5).
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  install,
  validateCodexConfigSchema,
  hasUserNamespacedAotHooks,
  parseTomlToObject,
} = require('../bin/install.js');

const { cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

function runCodexInstall(codexHome, cwd = path.join(__dirname, '..')) {
  const previousCodeHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
  // $HOME/.agents/skills root (os.homedir()-relative, independent of
  // CODEX_HOME). Sandbox HOME (and USERPROFILE) to codexHome so this
  // in-process install never materializes skills under the developer/CI
  // machine's real home directory.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  try {
    process.chdir(cwd);
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodeHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodeHome;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function readCodexConfig(codexHome) {
  return fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

function readCodexHooksJson(codexHome) {
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (!fs.existsSync(hooksPath)) return {};
  const raw = fs.readFileSync(hooksPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function readHooksSessionStartCommands(codexHome) {
  const parsed = readCodexHooksJson(codexHome);
  const table = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? parsed.hooks
    : parsed;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) =>
    (Array.isArray(entry?.hooks) ? entry.hooks : [])
      .map((hook) => hook && hook.command)
      .filter((cmd) => typeof cmd === 'string')
  );
}

describe('#2760 defect 3 — Hooks AoT preservation across install/uninstall/reinstall', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-d3-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('fresh install emits the two-level nested AoT schema (#2773)', () => {
    // Codex 0.124.0+ requires [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]]
    // with type = "command". Neither the flat [[hooks]] + event field form nor
    // the single-block [[hooks.SessionStart]] form without .hooks is accepted.
    writeCodexConfig(codexHome, '');
    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    const sessionStartCommands = readHooksSessionStartCommands(codexHome);
    const managed = sessionStartCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.equal(managed.length, 1, 'hooks.json must contain exactly one managed gsd-check-update command');
    assert.ok(
      !parsed.hooks || !Array.isArray(parsed.hooks.SessionStart),
      'config.toml should not carry managed SessionStart hooks for GSD'
    );
  });

  test('preserves user [[hooks.SessionStart]] entries and registers managed GSD handler in hooks.json', () => {
    // Users may have their own [[hooks.SessionStart]] entries using the new schema.
    // GSD must append its own two-level block without disturbing theirs.
    const userConfig = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo first user hook"',
      '',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo second user hook"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userConfig);

    runCodexInstall(codexHome);
    const afterInstall = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(afterInstall);

    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'hooks.SessionStart must remain an array-of-tables after install'
    );

    // Collect all handler commands across all event entries.
    const allCommands = parsed.hooks.SessionStart.flatMap((entry) =>
      Array.isArray(entry.hooks) ? entry.hooks.map((h) => h.command) : []
    );

    assert.ok(
      allCommands.includes('echo first user hook'),
      'first user hook preserved: ' + JSON.stringify(allCommands)
    );
    assert.ok(
      allCommands.includes('echo second user hook'),
      'second user hook preserved: ' + JSON.stringify(allCommands)
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'GSD handler must appear in hooks.json SessionStart entries: ' + JSON.stringify(hooksJsonCommands)
    );
    assert.ok(!Array.isArray(parsed.hooks), 'no flat [[hooks]] entries');
  });

  test('reinstall replaces flat [[hooks]] + event form with nested schema', () => {
    // Upgrade path: user has a config written by GSD 1.38.x (flat [[hooks]] form).
    const legacyConfig = [
      '[features]',
      'codex_hooks = true',
      '',
      '# GSD Hooks',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/to/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, legacyConfig);

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // Old flat form must be gone.
    assert.ok(!Array.isArray(parsed.hooks), 'flat [[hooks]] must be stripped on upgrade');
    // Only one GSD hook entry must exist (no duplication) in hooks.json.
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed handler after upgrade');
  });

  test('reinstall replaces single-block [[hooks.SessionStart]] (no .hooks sub-table) with nested schema', () => {
    // Upgrade path: user has a config written by the PR #2802 shape —
    // [[hooks.SessionStart]] without a nested [[hooks.SessionStart.hooks]] sub-table.
    const prBranchConfig = [
      '[features]',
      'codex_hooks = true',
      '',
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      'command = "node /old/path/to/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, prBranchConfig);

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    parseTomlToObject(content);

    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed handler after upgrade from PR-#2802-shape');
  });

  test('reinstall is idempotent: correct nested schema is stripped and re-emitted cleanly', () => {
    writeCodexConfig(codexHome, '');
    runCodexInstall(codexHome);
    runCodexInstall(codexHome); // second install
    readCodexConfig(codexHome);

    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    const gsdHandlers = hooksJsonCommands.filter((cmd) => /gsd-check-update/.test(cmd));
    assert.strictEqual(gsdHandlers.length, 1, 'exactly one managed SessionStart handler after double install');
  });
});

describe('#2760 fix 2 — Strip purges invalid legacy [agents] / [[agents]] regardless of marker', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f2-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('strips bare [agents] single-bracket block (no GSD marker, arbitrary user keys)', () => {
    writeCodexConfig(codexHome, [
      '[agents]',
      'default = "custom-agent"',
      'extra_key = "value"',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // Bare [agents] would have left { default, extra_key } as scalar leaves
    // on parsed.agents. After strip + re-emit, only GSD's own managed
    // AgentsToml scalar (max_depth) remains — #2406 stopped emitting
    // [agents.<name>] role sub-tables entirely, so `agents` stays a flat
    // scalar-only object, not a table-of-tables.
    assert.ok(
      parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents),
      'agents must be an object in parsed structure, got: ' + typeof parsed.agents
    );
    assert.equal(parsed.agents.default, undefined, 'bare [agents] default key must be stripped');
    assert.equal(parsed.agents.extra_key, undefined, 'bare [agents] extra_key must be stripped');
    assert.equal(parsed.agents.max_depth, 1, 'GSD-managed max_depth is the only surviving [agents] key');
    const gsdAgents = Object.keys(parsed.agents).filter((k) => k.startsWith('gsd-'));
    assert.deepStrictEqual(
      gsdAgents, [],
      'no [agents.gsd-*] role sub-tables (#2406) — canonical registration lives only in the standalone TOMLs: ' + JSON.stringify(Object.keys(parsed.agents))
    );

    // User's unrelated [model] section preserved structurally.
    assert.ok(
      parsed.model && parsed.model.name === 'o3',
      'unrelated user [model] section preserved with name = "o3", got: ' + JSON.stringify(parsed.model)
    );
  });

  test('strips [[agents]] sequence-form block without GSD marker (third-party / marker-edited-out)', () => {
    writeCodexConfig(codexHome, [
      '[[agents]]',
      'name = "user-helper"',
      'description = "third-party agent"',
      '',
      '[[agents]]',
      'name = "another-helper"',
      'description = "second one"',
      '',
      '[projects."/tmp/x"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    runCodexInstall(codexHome);
    const content = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(content);

    // [[agents]] sequence form would parse to Array — after strip it must be
    // a plain object holding only GSD's own managed max_depth scalar (#2406
    // stopped emitting [agents.<name>] role sub-tables entirely).
    assert.ok(
      parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents),
      'agents must be an object in parsed structure (sequence form must be stripped), got: '
        + (Array.isArray(parsed.agents) ? 'array' : typeof parsed.agents)
    );
    assert.equal(parsed.agents.max_depth, 1, 'GSD-managed max_depth is the only surviving [agents] key');
    const gsdAgents = Object.keys(parsed.agents).filter((k) => k.startsWith('gsd-'));
    assert.deepStrictEqual(
      gsdAgents, [],
      'no [agents.gsd-*] role sub-tables (#2406) — canonical registration lives only in the standalone TOMLs: ' + JSON.stringify(Object.keys(parsed.agents))
    );

    // User's unrelated [projects."/tmp/x"] section preserved structurally.
    assert.ok(
      parsed.projects && parsed.projects['/tmp/x'] && parsed.projects['/tmp/x'].trust_level === 'trusted',
      'unrelated user [projects."/tmp/x"] section preserved with trust_level = "trusted", got: '
        + JSON.stringify(parsed.projects)
    );
  });
});

// concurrency: false — the third test mutates installModule.__codexSchemaValidator,
// a module-level test seam. Other tests in this file (and in bug-2153, etc.)
// also call runCodexInstall() and would observe the injected validator if
// node:test ran them in parallel. Serializing this describe block keeps the
// seam mutation invisible to siblings.
describe('#2760 fix 3 — Post-write Codex schema validation', { concurrency: false }, () => {
  test('passes a clean config produced by GSD install', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f3a-'));
    try {
      const codexHome = path.join(tmpDir, 'codex-home');
      runCodexInstall(codexHome);
      const content = readCodexConfig(codexHome);
      const result = validateCodexConfigSchema(content);
      assert.equal(result.ok, true, 'GSD-emitted config passes schema validation');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('rejects bare [agents] and bare [hooks.SessionStart] in arbitrary content', () => {
    const bareAgents = [
      '[agents]',
      'default = "x"',
      '',
    ].join('\n');
    const bareHooks = [
      '[hooks.SessionStart]',
      'command = "x"',
      '',
    ].join('\n');
    const sequenceAgents = [
      '[[agents]]',
      'name = "x"',
      '',
    ].join('\n');

    assert.equal(validateCodexConfigSchema(bareAgents).ok, false, 'bare [agents] rejected');
    assert.equal(validateCodexConfigSchema(bareHooks).ok, false, 'bare [hooks.SessionStart] rejected');
    assert.equal(validateCodexConfigSchema(sequenceAgents).ok, false, '[[agents]] sequence rejected');
  });

  test('aborts install and restores pre-install backup when post-write validation fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f3b-'));
    const installModule = require('../bin/install.js');
    try {
      const codexHome = path.join(tmpDir, 'codex-home');
      // Pre-install file the user wants protected.
      const preInstall = [
        '# user file',
        '[model]',
        'name = "o3"',
        '',
      ].join('\n');
      writeCodexConfig(codexHome, preInstall);

      // Force the post-write validator to fail via the documented test seam.
      // This simulates the writer producing legacy-form output that Codex
      // would reject — install MUST abort, restore the pre-install bytes,
      // and surface a clear error.
      installModule.__codexSchemaValidator = () => ({
        ok: false,
        reason: 'simulated invalid output for test',
      });

      let threw = false;
      try {
        runCodexInstall(codexHome);
      } catch (e) {
        threw = true;
        assert.match(
          e.message,
          /post-write Codex schema validation failed/,
          'thrown error names the validation failure'
        );
        assert.match(e.message, /simulated invalid output for test/, 'thrown error includes reason');
      }
      assert.equal(threw, true, 'install threw when validator failed');

      const afterInstall = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      assert.equal(
        afterInstall,
        preInstall,
        'pre-install file restored verbatim after validation failure'
      );
    } finally {
      delete installModule.__codexSchemaValidator;
      cleanup(tmpDir);
    }
  });
});

describe('#2760 — hasUserNamespacedAotHooks helper', () => {
  test('detects [[hooks.SessionStart]] AoT entries', () => {
    const content = [
      '[[hooks.SessionStart]]',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), true);
  });

  test('returns false when only top-level [[hooks]] entries exist', () => {
    const content = [
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), false);
  });

  test('returns false when only single-bracket [hooks.SessionStart] exists', () => {
    const content = [
      '[hooks.SessionStart]',
      'command = "x"',
      '',
    ].join('\n');
    assert.equal(hasUserNamespacedAotHooks(content, 'SessionStart'), false);
  });
});

// concurrency: false — these tests monkey-patch fs.writeFileSync, a global
// shared with every other suite running in parallel. Serializing prevents
// stray writes from sibling tests landing in the stub.
describe('#2760 fix 4 — Write-failure rollback (atomic write + snapshot restore)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalWriteFileSync;
  // #2760 CR5 finding 5 — symmetric snapshot/restore for fs.renameSync. The
  // first test below monkey-patches renameSync; without a beforeEach/afterEach
  // pair, only the local `finally` restores it, which is fragile to future
  // edits that add early-return paths.
  let originalRenameSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-f4-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalWriteFileSync = fs.writeFileSync;
    originalRenameSync = fs.renameSync;
  });

  afterEach(() => {
    fs.renameSync = originalRenameSync;
    fs.writeFileSync = originalWriteFileSync;
    cleanup(tmpDir);
  });

  test('pre-install config bytes survive when fs.renameSync throws over configPath', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    // After fs is restored we'll re-read the file. Capture the byte buffer
    // exactly so the comparison is bit-for-bit.
    const preInstallBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));

    const configPath = path.join(codexHome, 'config.toml');
    const tempPattern = new RegExp('^' + escapeRegex(configPath) + '\\.tmp-');

    // Stub: allow writes to atomic temp files (which renameSync overwrites
    // the target, never truncating it directly) but throw on any direct
    // write to the canonical configPath. This simulates either:
    //   (a) an older code path doing a non-atomic write, or
    //   (b) a downstream module bypassing atomicWriteFileSync.
    // Either way the snapshot must be restored. We let the temp write go
    // through, then make renameSync throw to simulate the partial write
    // never landing.
    // #2760 CR5 finding 5 — fs.renameSync is restored by the suite-level
    // afterEach; no local finally needed.
    fs.renameSync = (src, dst) => {
      if (dst === configPath) {
        throw new Error('simulated rename failure mid-install');
      }
      return originalRenameSync(src, dst);
    };

    let threw = false;
    let thrownErr = null;
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownErr = e;
      assert.ok(/rename failure|simulated|post-write/.test(e.message),
        'thrown error must surface the simulated failure or its post-write wrapper: ' + e.message);
    }
    // #2760 CR5 finding 4 — tighten contract per finding #1: ALL pre-write
    // and write failures must be fatal. This test previously accepted either
    // throw OR warn — sibling tests already require throw, so lock parity.
    assert.equal(threw, true, 'rename failure must be fatal: ' + (thrownErr && thrownErr.message));

    const afterBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    assert.deepStrictEqual(
      afterBytes,
      preInstallBytes,
      'pre-install config.toml bytes must survive a mid-install write/rename failure'
    );

    // And the parsed structure of the surviving file must still be the
    // user's [model] section, not a half-written GSD block.
    const parsed = parseTomlToObject(afterBytes.toString('utf8'));
    assert.equal(parsed.model && parsed.model.name, 'o3',
      'surviving file must still be the user pre-install content');
    assert.equal(parsed.agents, undefined,
      'no GSD agents block may have leaked into the surviving file');

    // No stray .tmp-* siblings left behind in the codex home.
    const stray = fs.readdirSync(codexHome).filter((f) => tempPattern.test(path.join(codexHome, f)));
    assert.equal(stray.length, 0,
      'atomic write must clean up its temp file on failure: ' + stray.join(', '));
  });

  test('pre-install config bytes survive when fs.writeFileSync throws on the .tmp- target', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    const preInstallBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    const configPath = path.join(codexHome, 'config.toml');
    const tempPattern = new RegExp('^' + escapeRegex(configPath) + '\\.tmp-');

    // Stub: fault writes targeting the atomic temp file (the pre-rename branch
    // of atomicWriteFileSync). Other writes (agent .toml files in CODEX_HOME)
    // pass through. This exercises the failure path where the temp write itself
    // throws, not the rename — the case the prior test left untested.
    // #2760 CR5 finding 5 — fs.writeFileSync is restored by the suite-level
    // afterEach (via originalWriteFileSync); no local finally needed.
    const captured = originalWriteFileSync;
    fs.writeFileSync = function patchedWriteFileSync(target, data, options) {
      if (typeof target === 'string' && tempPattern.test(target)) {
        throw new Error('simulated writeFileSync failure on .tmp- target');
      }
      return captured.call(this, target, data, options);
    };

    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      assert.ok(/simulated writeFileSync failure|post-write Codex install failed|pre-write/.test(e.message),
        'thrown error must surface the simulated failure or its post-write wrapper: ' + e.message);
    }
    // Per #2760 CR4 finding 1 / CR5 finding 1, write failures must abort install (not warn).
    assert.equal(threw, true, 'install must throw when atomic temp-write fails');

    const afterBytes = fs.readFileSync(path.join(codexHome, 'config.toml'));
    assert.deepStrictEqual(
      afterBytes,
      preInstallBytes,
      'pre-install config.toml bytes must survive a temp-write failure'
    );

    const parsed = parseTomlToObject(afterBytes.toString('utf8'));
    assert.equal(parsed.model && parsed.model.name, 'o3',
      'surviving file must still be the user pre-install content');
    assert.equal(parsed.agents, undefined,
      'no GSD agents block may have leaked into the surviving file');

    const stray = fs.readdirSync(codexHome).filter((f) => tempPattern.test(path.join(codexHome, f)));
    assert.equal(stray.length, 0,
      'atomic write must clean up its temp file on failure: ' + stray.join(', '));
  });
});

// concurrency: false — these tests rely on the same install path and module-
// level pre-install snapshot that the fix-3/fix-4 suites exercise. Serializing
// keeps state mutations from leaking across parallel siblings.
describe('#2760 CR4 finding 2 — Legacy flat [[hooks]] block migrates to namespaced AoT on reinstall', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr4-f2-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('pre-install legacy flat [[hooks]] gsd-check-update + user namespaced [[hooks.SessionStart]] → post-install converges on namespaced AoT', () => {
    // Reproduce the upgrade scenario:
    //   - User has [[hooks.SessionStart]] entry of their own (signal that GSD
    //     should emit in the namespaced shape).
    //   - A previous GSD install left the legacy flat [[hooks]] managed block
    //     for gsd-check-update. The pre-CR4 strip step would short-circuit
    //     the namespaced emit and leave the user stuck in the mixed layout.
    const userPlusLegacy = [
      '[[hooks.SessionStart]]',
      'command = "echo user hook"',
      '',
      '# GSD Hooks',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /old/path/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userPlusLegacy);

    runCodexInstall(codexHome);
    const afterInstall = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(afterInstall);

    // After CR4 finding 2: the legacy flat [[hooks]] managed block is stripped
    // and the GSD entry is re-emitted in the namespaced AoT shape so the two
    // forms do not coexist.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'hooks.SessionStart must be an array-of-tables, got: '
        + (parsed.hooks ? typeof parsed.hooks.SessionStart : 'no hooks table')
    );

    // Migration now handles stale [[hooks.SessionStart]] entries with handler
    // fields at event-entry level (pre-#2773 shape), promoting them to the
    // two-level nested form. Every entry must carry a .hooks sub-array after
    // migration, so collect from nested handlers only.
    assert.ok(
      parsed.hooks.SessionStart.every((entry) => Array.isArray(entry.hooks)),
      'every hooks.SessionStart entry must use nested [[hooks.SessionStart.hooks]] handlers after migration'
    );
    const allSessionStartCommands = parsed.hooks.SessionStart.flatMap((entry) =>
      entry.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      allSessionStartCommands.includes('echo user hook'),
      'user [[hooks.SessionStart]] entry preserved: ' + JSON.stringify(allSessionStartCommands)
    );
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'GSD entry must appear in hooks.json SessionStart entries: '
        + JSON.stringify(hooksJsonCommands)
    );

    // The legacy top-level [[hooks]] AoT must NOT coexist with the namespaced
    // form after migration. parseTomlToObject distinguishes via Array.isArray.
    assert.ok(
      !Array.isArray(parsed.hooks) || parsed.hooks.length === 0,
      'no top-level [[hooks]] AoT entries may remain after legacy migration: '
        + JSON.stringify(parsed.hooks)
    );

    // No duplicate gsd-check-update entries — exactly one managed entry.
    const gsdEntries = hooksJsonCommands.filter((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd));
    assert.equal(gsdEntries.length, 1,
      'exactly one gsd-check-update entry after migration, got: ' + gsdEntries.length);
  });
});

describe('#2760 CR4 finding 3 / #3245 — parseTomlToObject handles edge-case value types (floats accepted; dates/trailing-garbage rejected)', () => {
  // #3245 inverts the float-rejection requirement: Codex CLI's serde schema
  // requires f64 for tool_timeout_sec/startup_timeout_sec, so GSD's parser
  // must now ACCEPT floats. The original guard (from #2760 CR4 finding 3) was
  // "don't silently truncate 0.5 to integer 0" — that goal is still met
  // because we parse the full float as a JS Number (not truncate to prefix).
  test('accepts TOML floats (timeout = 0.5) — #3245 fix', () => {
    const content = [
      '[server]',
      'timeout = 0.5',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.server.timeout, 0.5,
      'float values must be accepted as JS Number (not truncated to 0) — #3245');
  });

  test('rejects date values (created = 1979-05-27)', () => {
    const content = [
      '[meta]',
      'created = 1979-05-27',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value|trailing bytes/,
      'date values must be rejected, not silently truncated'
    );
  });

  test('rejects trailing garbage after a string value (key = "x" junk)', () => {
    const content = [
      '[section]',
      'key = "x" junk',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /trailing bytes/,
      'trailing bytes after a complete value must be rejected'
    );
  });

  test('accepts trailing whitespace and # comment after a value', () => {
    const content = [
      '[section]',
      'key = "x"   # an inline comment',
      'flag = true',
      'count = 7   ',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.equal(parsed.section.key, 'x');
    assert.equal(parsed.section.flag, true);
    assert.equal(parsed.section.count, 7);
  });
});

// concurrency: false — see the fix-3 suite above for the same rationale.
describe('#2760 CR4 finding 1 — atomicWriteFileSync failure aborts install (post-write fatal)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalRenameSync;
  let originalConsoleLog;
  let consoleOutput;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr4-f1-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalRenameSync = fs.renameSync;
    originalConsoleLog = console.log;
    consoleOutput = [];
    console.log = (...args) => { consoleOutput.push(args.join(' ')); };
  });

  afterEach(() => {
    fs.renameSync = originalRenameSync;
    console.log = originalConsoleLog;
    cleanup(tmpDir);
  });

  test('install throws and never prints "Done!" when atomicWriteFileSync fails on configPath', () => {
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    const configPath = path.join(codexHome, 'config.toml');
    // Only fault the hook-block atomic rename — earlier writes to config.toml
    // happen via mergeCodexConfig (agent-block emit). We want to exercise the
    // post-write Codex install branch specifically. Detect by reading the temp
    // file's contents and only faulting when the hook block is present.
    fs.renameSync = (src, dst) => {
      if (dst === configPath) {
        let isHookWrite = false;
        try {
          const data = fs.readFileSync(src, 'utf8');
          isHookWrite = /GSD codex_hooks ownership/.test(data);
        } catch (_) { /* ignore */ }
        if (isHookWrite) {
          throw new Error('simulated rename failure');
        }
      }
      return originalRenameSync(src, dst);
    };

    let threw = false;
    let thrownMessage = '';
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownMessage = e.message;
    }

    assert.equal(threw, true, 'install must throw when atomic write fails');
    assert.match(
      thrownMessage,
      /post-write Codex install failed/,
      'thrown error must use the post-write prefix so the outer catch treats it as fatal'
    );

    // Critical: install must NOT have printed any "Done!" success banner.
    const printedDone = consoleOutput.some(
      (line) => typeof line === 'string' && /Done!/i.test(line)
    );
    assert.equal(printedDone, false,
      'install must NOT print "Done!" after a write failure: ' + JSON.stringify(consoleOutput.filter((l) => /Done|✓/.test(l))));

    // And the user's pre-install bytes are intact (snapshot restore).
    const after = fs.readFileSync(configPath, 'utf8');
    assert.equal(after, preInstall, 'pre-install bytes preserved after fatal abort');
  });
});

// concurrency: false — patches module.exports.__codexSchemaValidator, a
// shared test seam. Serializing prevents stray patches from sibling tests.
describe('#2760 CR5 finding 1 — pre-write failures abort install (outer catch fatal)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;
  let originalConsoleLog;
  let consoleOutput;
  const installModule = require('../bin/install.js');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr5-f1-'));
    codexHome = path.join(tmpDir, 'codex-home');
    originalConsoleLog = console.log;
    consoleOutput = [];
    console.log = (...args) => { consoleOutput.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    delete installModule.__codexSchemaValidator;
    cleanup(tmpDir);
  });

  test('pre-write throw (validator throws, not returns {ok:false}) is fatal and restores snapshot', () => {
    // A validator that THROWS (vs returning {ok:false}) bypasses the
    // validation branch and exits the inner try via the catch at the outer
    // level. Pre-CR5, that catch downgraded to console.warn and let the
    // install print "Done!" with no Codex hooks. Post-CR5 it must rethrow.
    const preInstall = [
      '# user file',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    installModule.__codexSchemaValidator = () => {
      throw new Error('synthetic validator-throw simulating a pre-write helper failure');
    };

    let threw = false;
    let thrownMsg = '';
    try {
      runCodexInstall(codexHome);
    } catch (e) {
      threw = true;
      thrownMsg = e.message;
    }

    assert.equal(threw, true,
      'install must rethrow when a pre-write step throws (CR5 finding 1)');
    assert.match(thrownMsg, /pre-write|synthetic validator-throw/,
      'thrown error must surface the pre-write wrapper or original message: ' + thrownMsg);

    const printedDone = consoleOutput.some(
      (line) => typeof line === 'string' && /Done!/i.test(line)
    );
    assert.equal(printedDone, false,
      'install must NOT print "Done!" after a pre-write failure: ' +
      JSON.stringify(consoleOutput.filter((l) => /Done|✓/.test(l))));

    // Pre-install bytes intact (snapshot restored).
    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.equal(after, preInstall,
      'pre-install bytes must survive a pre-write helper throw');
  });
});

describe('#2760 CR5 finding 2 — parseTomlToObject rejects duplicate keys and shape-mismatched headers', () => {
  test('rejects duplicate scalar key in same table ([a]\\nx=1\\nx=2)', () => {
    const content = [
      '[a]',
      'x = 1',
      'x = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate key/,
      'real TOML 1.0 rejects duplicate keys in the same table'
    );
  });

  test('rejects duplicate scalar key in root table', () => {
    const content = [
      'x = 1',
      'x = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate key/,
      'duplicate root-table keys must be rejected'
    );
  });

  test('rejects re-declared [a] table header ([a] then [a] again)', () => {
    const content = [
      '[a]',
      'x = 1',
      '',
      '[a]',
      'y = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate or shape-mismatched table header/,
      'real TOML 1.0 rejects re-declaring the same [a] header twice'
    );
  });

  test('rejects [[arr]] then [arr] for same path (array-of-tables → table)', () => {
    const content = [
      '[[arr]]',
      'x = 1',
      '',
      '[arr]',
      'y = 2',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /duplicate or shape-mismatched table header/,
      'cannot redeclare an array-of-tables path as a plain table'
    );
  });

  test('accepts repeated [[arr]] (genuine array-of-tables)', () => {
    const content = [
      '[[arr]]',
      'x = 1',
      '',
      '[[arr]]',
      'x = 2',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.ok(Array.isArray(parsed.arr));
    assert.strictEqual(parsed.arr.length, 2);
    assert.strictEqual(parsed.arr[0].x, 1);
    assert.strictEqual(parsed.arr[1].x, 2);
  });

  test('accepts disjoint nested headers (not duplicates)', () => {
    const content = [
      '[a.b]',
      'x = 1',
      '',
      '[a.c]',
      'y = 2',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.a.b.x, 1);
    assert.strictEqual(parsed.a.c.y, 2);
  });
});

// concurrency: false — drives the same install pipeline as the other f-suites.
describe('#2760 CR5 finding 3 — migration emits namespaced AoT (no flat/namespaced mixing)', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2760-cr5-f3-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('user has [[hooks.AfterTool]] AND legacy [hooks.SessionStart] → post-install both namespaced, no flat AoT', () => {
    // Reproduces the mixed-form scenario from finding 3:
    //  - User pre-config has both a namespaced AoT entry [[hooks.AfterTool]]
    //    AND a legacy single-bracket [hooks.SessionStart].
    //  - Pre-CR5 migration converts the legacy section to flat [[hooks]]
    //    with event="SessionStart", leaving a mixed flat+namespaced layout.
    //  - Post-CR5 migration emits [[hooks.SessionStart]] directly so both
    //    of the user's hooks coexist in the namespaced shape, and the
    //    GSD-managed entry converges on namespaced too.
    const userPlusLegacy = [
      '[[hooks.AfterTool]]',
      'command = "x"',
      '',
      '[hooks.SessionStart]',
      'command = "y"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, userPlusLegacy);

    runCodexInstall(codexHome);
    const after = readCodexConfig(codexHome);
    const parsed = parseTomlToObject(after);

    // The pre-existing [[hooks.AfterTool]] entry is preserved.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.AfterTool),
      'pre-existing [[hooks.AfterTool]] must remain a namespaced AoT array'
    );
    // AfterTool was in [[hooks.AfterTool]] with command at event-entry level
    // (pre-#2773 stale namespaced AoT shape). Migration now promotes these to
    // the two-level nested form, so every entry must have a .hooks sub-array.
    assert.ok(
      parsed.hooks.AfterTool.every((e) => Array.isArray(e.hooks)),
      'every AfterTool entry must use nested [[hooks.AfterTool.hooks]] handlers after migration'
    );
    const afterToolCommands = parsed.hooks.AfterTool.flatMap((e) =>
      e.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      afterToolCommands.includes('x'),
      'user AfterTool entry must be preserved: ' + JSON.stringify(afterToolCommands)
    );

    // The migrated SessionStart entry is now namespaced AoT with nested .hooks sub-table.
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'migrated SessionStart must be namespaced AoT (not flat [[hooks]])'
    );
    // After migration, [hooks.SessionStart] map-format is promoted to nested AoT.
    // Command lives in [[hooks.SessionStart.hooks]][0].command (nested schema).
    assert.ok(
      parsed.hooks.SessionStart.every((e) => Array.isArray(e.hooks)),
      'every SessionStart entry must use nested [[hooks.SessionStart.hooks]] handlers after migration'
    );
    const ssCommands = parsed.hooks.SessionStart.flatMap((e) =>
      e.hooks.map((h) => h.command).filter(Boolean)
    );
    assert.ok(
      ssCommands.includes('y'),
      'user SessionStart command "y" must be preserved in namespaced array: ' +
        JSON.stringify(ssCommands)
    );
    // GSD's managed gsd-check-update entry also lives in the namespaced array.
    const hooksJsonCommands = readHooksSessionStartCommands(codexHome);
    assert.ok(
      hooksJsonCommands.some((cmd) => typeof cmd === 'string' && /gsd-check-update/.test(cmd)),
      'managed gsd-check-update entry must appear in hooks.json SessionStart entries: ' +
        JSON.stringify(hooksJsonCommands)
    );

    // No flat top-level [[hooks]] AoT may remain.
    assert.ok(
      !Array.isArray(parsed.hooks) || parsed.hooks.length === 0,
      'no flat top-level [[hooks]] AoT entries may remain after migration: ' +
        JSON.stringify(parsed.hooks)
    );

    // No synthetic event field on the migrated SessionStart entries — the
    // namespace IS the event.
    for (const entry of parsed.hooks.SessionStart) {
      assert.equal(entry.event, undefined,
        'no synthetic event field — namespace [[hooks.SessionStart]] encodes the event: ' +
          JSON.stringify(entry));
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-279-codex-agent-mapping.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-279-codex-agent-mapping (consolidation epic #1969 B1 #1970)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');
const src = fs.readFileSync(INSTALL_JS, 'utf8');

describe('bug #279: Codex adapter documents Agent() and deferred tool discovery', () => {
  test('adapter mapping section includes explicit Agent(...) -> spawn_agent mapping', () => {
    // allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)
    assert.ok(
      /Task\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src) && // allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)
      /Agent\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src), // allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)
      'Codex adapter must explicitly map both Task(...) and Agent(...) to spawn_agent',
    );
  });

  test('adapter includes deferred tool_search discovery guidance before inline fallback', () => {
    // allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'), // allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js] (see #279)
      'Codex adapter must instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3017-codex-hook-absolute-node.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3017-codex-hook-absolute-node (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3017: Codex SessionStart hook still emits bare `node` after #3002.
 *
 * PR #3002 fixed #2979 for settings.json-based managed JS hooks (Claude
 * Code, Gemini, Antigravity) by routing through buildHookCommand() →
 * resolveNodeRunner(), which emits the absolute Node binary path. But the
 * Codex install path writes its SessionStart hook directly into a
 * config.toml string, bypassing both helpers:
 *
 *   command = "node ${updateCheckScript}"
 *
 * Under a GUI/minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) where node
 * is not resolvable, the hook fails with `/bin/sh: node: command not
 * found` (exit 127). The same failure mode #2979 was meant to fix —
 * just on the codex toml branch instead of the settings.json branch.
 *
 * The fix exposes two pure helpers and tests them as typed records,
 * not by grepping install.js content:
 *
 *   buildCodexHookBlock(targetDir, { absoluteRunner }) → toml string
 *     - emits `command = "<absoluteRunner> <quoted hook path>"` so the
 *       hook resolves under minimal PATH.
 *     - returns null when absoluteRunner is null (caller skips with warn,
 *       matching settings.json branch behavior).
 *
 *   rewriteLegacyCodexHookBlock(tomlContent, absoluteRunner) → { content, changed }
 *     - rewrites an existing bare-node managed-hook command on reinstall
 *       (matches the rewriteLegacyManagedNodeHookCommands shape from #3002).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HOOKS_SURFACE = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-hooks-surface.cjs'));
const projection = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'shell-command-projection.cjs'));
const { buildCodexHookBlock, rewriteLegacyCodexHookBlock, resolveNodeRunner } = HOOKS_SURFACE;
const { projectCodexHookTomlCommand } = projection;

/**
 * Parse the toml hook block into a typed record so tests can assert on
 * the structured shape (what's the runner, what's the hook path, what's
 * the type) rather than substring-matching the toml text.
 */
function parseCodexHookBlock(block) {
  if (!block) return { ok: false, reason: 'empty' };
  // The block always carries the "# GSD Hooks" marker, the AoT tables,
  // a type=command, and a command="<runner> <quoted-hook-path>" line.
  const hasMarker = /^# GSD Hooks$/m.test(block);
  const hasEvent = /^\[\[hooks\.SessionStart\]\]$/m.test(block);
  const hasHandler = /^\[\[hooks\.SessionStart\.hooks\]\]$/m.test(block);
  const typeMatch = block.match(/^type\s*=\s*"([^"]+)"$/m);
  // command = "<runner> <hookpath>" — runner may itself be a quoted absolute path.
  // Match the whole RHS as one toml double-quoted string, then split into runner + hookpath.
  const cmdLine = block.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"$/m);
  if (!cmdLine) return { ok: false, reason: 'no command line' };
  const cmdValue = cmdLine[1];
  // Inside the command value, the runner is either a quoted string (escaped \" in toml)
  // or a bare token, followed by a space and the hook path (quoted).
  // toml escapes interior " as \", so the cmdValue contains literal \" sequences.
  const cmdParsed = cmdValue.match(/^(\\".+?\\"|node|bash|\S+)\s+\\"([^\\]+)\\"\s*$/);
  return {
    ok: true,
    hasMarker,
    hasEvent,
    hasHandler,
    type: typeMatch ? typeMatch[1] : null,
    command: cmdValue,
    runner: cmdParsed ? cmdParsed[1] : null,
    hookPath: cmdParsed ? cmdParsed[2] : null,
  };
}

// Strip the toml-escape (\") and JSON-quote (") layers from the parsed
// runner token to compare against the raw absolute path the caller
// supplied. parsed.runner round-trips through TWO escape layers:
//   1. JSON.stringify in resolveNodeRunner adds outer "..." quotes
//   2. toml escapes the interior " to \" inside the command field
// After both, parsed.runner ends in `\"` and starts with `\"`.
function unescapeRunner(token) {
  if (!token) return token;
  let t = token.replace(/^\\"/, '').replace(/\\"$/, '');
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t;
}

describe('Bug #3017 / #3440: Codex hook projection seam', () => {
  test('projectCodexHookTomlCommand renders escaped command value from shared projection module', () => {
    const commandValue = projectCodexHookTomlCommand({
      absoluteRunner: '"/usr/local/bin/node"',
      scriptPath: '/tmp/codex-test/.codex/hooks/gsd-check-update.js',
      platform: 'linux',
    });
    assert.equal(
      commandValue,
      '\\"/usr/local/bin/node\\" \\"/tmp/codex-test/.codex/hooks/gsd-check-update.js\\"',
    );
  });
});

describe('Bug #3017: buildCodexHookBlock emits absolute node runner', () => {
  test('exported as a function', () => {
    assert.equal(typeof buildCodexHookBlock, 'function');
  });

  test('emits the EXACT absolute node runner the caller supplied (#3022 CR)', () => {
    const targetDir = '/tmp/codex-test/.codex';
    const expectedRunnerPath = '/usr/local/bin/node';
    const absoluteRunner = `"${expectedRunnerPath}"`;
    const block = buildCodexHookBlock(targetDir, { absoluteRunner });
    const parsed = parseCodexHookBlock(block);
    assert.equal(parsed.ok, true, `parse failed: ${block}`);
    assert.equal(parsed.hasMarker, true, '# GSD Hooks marker present');
    assert.equal(parsed.hasEvent, true, '[[hooks.SessionStart]] AoT entry present');
    assert.equal(parsed.hasHandler, true, '[[hooks.SessionStart.hooks]] handler entry present');
    assert.equal(parsed.type, 'command', 'handler is type=command');
    // Strict: parsed runner must match the supplied absolute path EXACTLY
    // (after stripping toml/JSON escape layers). A loose substring like
    // '/node' would let an unrelated absolute token containing '/node'
    // pass — e.g. '/Users/x/notnode/foo'.
    assert.equal(unescapeRunner(parsed.runner), expectedRunnerPath,
      `parsed runner must equal supplied absolute path: got ${parsed.runner}, want ${expectedRunnerPath}`);
    // On Windows, path.resolve prepends the current drive letter ("D:") to
    // the POSIX-shaped fixture path. Accept either form.
    const expectedHookSuffix = '/tmp/codex-test/.codex/hooks/gsd-check-update.js';
    assert.ok(
      parsed.hookPath === expectedHookSuffix ||
        parsed.hookPath.replace(/^[A-Za-z]:/, '') === expectedHookSuffix,
      `hook path equality, got: ${parsed.hookPath}, want suffix: ${expectedHookSuffix}`,
    );
  });

  test('returns null when absoluteRunner is null (caller skips registration)', () => {
    const block = buildCodexHookBlock('/tmp/x/.codex', { absoluteRunner: null });
    assert.equal(block, null,
      'must return null on missing runner so caller can warn-and-skip instead of writing a broken hook');
  });

  test('integrates with resolveNodeRunner() in the live process — runner equals resolved node runner (#3022 CR)', () => {
    const runner = resolveNodeRunner();
    assert.ok(runner, 'resolveNodeRunner returns a usable value in this test env');
    const block = buildCodexHookBlock('/tmp/x/.codex', { absoluteRunner: runner });
    const parsed = parseCodexHookBlock(block);
    assert.equal(parsed.ok, true);
    // Strict canonical-runner equality: the parsed runner (after stripping
    // toml + JSON escape layers) must be exactly the normalized runner that
    // resolveNodeRunner selected. Homebrew Cellar execPath values intentionally
    // normalize to the stable Homebrew symlink (#3181).
    const expected = JSON.parse(runner);
    assert.equal(unescapeRunner(parsed.runner), expected,
      `parsed runner must equal resolveNodeRunner(), got: ${parsed.runner}, want: ${expected}`);
  });
});

describe('Bug #3017: rewriteLegacyCodexHookBlock migrates bare-node on reinstall', () => {
  test('exported as a function', () => {
    assert.equal(typeof rewriteLegacyCodexHookBlock, 'function');
  });

  test('rewrites a bare-node managed-hook command to the absolute runner', () => {
    const before = [
      '[model]',
      'name = "o3"',
      '',
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /Users/x/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const expectedRunnerPath = '/usr/local/bin/node';
    const runner = `"${expectedRunnerPath}"`;
    const result = rewriteLegacyCodexHookBlock(before, runner);
    assert.equal(result.changed, true, 'must report change=true');
    // The migrated command must use the EXACT absolute runner the caller
    // supplied (#3022 CR — was previously asserting a loose '/node'
    // substring which let unrelated absolute paths pass).
    const parsed = parseCodexHookBlock(result.content);
    assert.equal(parsed.ok, true);
    assert.equal(unescapeRunner(parsed.runner), expectedRunnerPath,
      `runner must equal supplied absolute path: ${parsed.runner}`);
    assert.equal(parsed.hookPath, '/Users/x/.codex/hooks/gsd-check-update.js');
    // Non-GSD content (the [model] block) must be preserved verbatim.
    assert.ok(result.content.includes('[model]'));
    assert.ok(result.content.includes('name = "o3"'));
  });

  test('decodes TOML-escaped quoted script paths before projection', () => {
    const before = [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node \\"C:\\\\Users\\\\x\\\\.codex\\\\hooks\\\\gsd-check-update.js\\""',
      '',
    ].join('\n');
    const runner = '"/usr/local/bin/node"';
    const result = rewriteLegacyCodexHookBlock(before, runner, { platform: 'win32' });
    assert.equal(result.changed, true);
    const parsed = parseCodexHookBlock(result.content);
    assert.equal(parsed.ok, true, 'hook block must parse correctly');
    const expected = projectCodexHookTomlCommand({
      absoluteRunner: runner,
      scriptPath: 'C:\\Users\\x\\.codex\\hooks\\gsd-check-update.js',
      platform: 'win32',
    });
    assert.equal(parsed.command, expected,
      'rewritten command must project from decoded Windows path (not TOML-escaped token text)');
    assert.equal(unescapeRunner(parsed.runner), '/usr/local/bin/node',
      'runner must equal supplied absolute path');
    assert.equal(parsed.hookPath, 'C:/Users/x/.codex/hooks/gsd-check-update.js',
      'hook path must equal decoded Windows path after projection normalization');
  });

  test('does NOT touch a managed-hook entry that already uses an absolute runner', () => {
    const already = [
      '# GSD Hooks',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "\\"/usr/local/bin/node\\" /Users/x/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = rewriteLegacyCodexHookBlock(already, '"/usr/local/bin/node"');
    assert.equal(result.changed, false);
    assert.equal(result.content, already);
  });

  test('does NOT touch user-authored bare-node hooks (filename not in managed allowlist)', () => {
    const userOwned = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /home/me/my-custom-codex-hook.js"',
      '',
    ].join('\n');
    const result = rewriteLegacyCodexHookBlock(userOwned, '"/usr/local/bin/node"');
    assert.equal(result.changed, false,
      'user-authored hooks must be left alone; only managed gsd-* hooks are migrated');
    assert.equal(result.content, userOwned);
  });

  test('returns content unchanged when absoluteRunner is null', () => {
    const before = 'command = "node /path/to/gsd-check-update.js"';
    const result = rewriteLegacyCodexHookBlock(before, null);
    assert.equal(result.changed, false);
    assert.equal(result.content, before);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3018-codex-discuss-fallback.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3018-codex-discuss-fallback (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3018.
 *
 * @jon-hendry: running `$gsd-discuss-phase 81` in Codex Default mode (where
 * `request_user_input` is rejected) caused the agent to pick "reasonable
 * defaults" and proceed straight into writing CONTEXT.md / DISCUSSION-LOG.md
 * checkpoints — without ever surfacing the questions to the user. The
 * generated Codex skill adapter explicitly told it to do that:
 *
 *   "When `request_user_input` is rejected (Execute mode), present a
 *    plain-text numbered list and pick a reasonable default."
 *
 * Discuss-mode is the wrong place for that fallback. The contract should be:
 * stop, render the questions as plain text, wait for the user's answer.
 * Defaults may only be picked when the user has authorized non-interactive
 * mode (--auto / --all) or has explicitly approved them.
 *
 * Test design (#3027 CR follow-up): instead of grepping the prose with
 * regex, parse the fallback section into a typed semantic-flag record and
 * assert on those booleans. This adheres to CONTRIBUTING.md "no-source-grep"
 * — the test names a behavioral invariant, the parser walks the prose
 * once and exposes the invariants as named flags, and the prose can be
 * reworded freely as long as the flags stay true.
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
 * Parse the Execute-mode-fallback section into a typed semantic-flag
 * record. Each flag answers a single behavioral question that the #3018
 * fix is contractually required to encode in the prose. Tests assert on
 * the booleans, not the wording — so the prose can evolve without test
 * churn as long as the semantics stay correct.
 *
 * The flags are derived from a single pass over the section text: each
 * one looks for any of a small set of synonym phrases that a correct
 * implementation would use. The negative anti-pattern flag
 * (`silentlyPicksDefaults`) is the regression guard — the prose under
 * #3018 told the agent to "pick a reasonable default" autonomously,
 * which is exactly what this fix removes.
 */
function parseExecuteModeFallback(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      instructsStop: false,
      presentsPlainTextQuestions: false,
      namesPermissionPath: false,
      forbidsWritingArtifactsBeforeAnswer: false,
      silentlyPicksDefaults: false,
    };
  }
  const lower = section.toLowerCase();
  // (a) STOP/WAIT directive — the agent must halt instead of proceeding.
  const instructsStop = /\b(stop|halt|wait)\b/.test(lower);
  // (b) Plain-text fallback presentation — the agent must surface the
  // questions in some inspectable form (numbered list / plain text).
  const presentsPlainTextQuestions = /plain.?text|numbered list/.test(lower);
  // (c) Permission path that DOES allow defaults — must name at least
  // one (--auto / --all / explicit user approval / autonomous workflow).
  const namesPermissionPath =
    /--auto|--all/.test(section) ||
    /explicit(ly)? (approv|authoriz|consent)/i.test(section) ||
    /user (has )?approv|user (has )?authoriz|user (has )?consent/i.test(section) ||
    /autonomous (lifecycle|workflow|paths?)/i.test(section);
  // (d) Artifact-write ban — the agent must not produce workflow files
  // (CONTEXT.md, DISCUSSION-LOG.md, PLAN.md, checkpoints) before the
  // user answers or one of the permission-path conditions applies.
  // Require BOTH a "do not write" intent AND a named artifact class so
  // generic "do not write" prose elsewhere can't satisfy the flag.
  const forbidsWriteIntent = /do not write|don'?t write|must not write|shall not write/i.test(section);
  const namesArtifactClass = /artifact|checkpoint|context\.md|discussion.?log|plan\.md/i.test(section);
  const forbidsWritingArtifactsBeforeAnswer = forbidsWriteIntent && namesArtifactClass;
  // Anti-pattern guard — the prose that caused #3018. This MUST be false.
  const silentlyPicksDefaults = /pick (a |the )?(reasonable|sensible|sane) default/i.test(section);
  return {
    ok: true,
    sectionLength: section.length,
    instructsStop,
    presentsPlainTextQuestions,
    namesPermissionPath,
    forbidsWritingArtifactsBeforeAnswer,
    silentlyPicksDefaults,
  };
}

describe('bug #3018: codex skill adapter encodes the discuss-mode fallback contract', () => {
  test('exports the adapter generator', () => {
    assert.equal(typeof getCodexSkillAdapterHeader, 'function');
  });

  test('Execute mode fallback section exists and has content', () => {
    const header = getCodexSkillAdapterHeader('gsd-discuss-phase');
    const section = extractExecuteModeFallback(header);
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.ok, true, `section must parse, got header:\n${header}`);
    assert.ok(parsed.sectionLength > 0, 'section must be non-empty');
  });

  test('fallback instructs STOP/WAIT (not silent continuation)', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.instructsStop, true,
      `must instruct stop/halt/wait — section was:\n${section}`);
  });

  test('fallback prescribes plain-text question presentation', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.presentsPlainTextQuestions, true,
      `must mention plain-text / numbered-list presentation — section was:\n${section}`);
  });

  test('fallback names a permission path under which defaults ARE allowed (--auto / --all / explicit approval / autonomous)', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.namesPermissionPath, true,
      `must name at least one permission path — section was:\n${section}`);
  });

  test('fallback forbids writing workflow artifacts before user answers', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.forbidsWritingArtifactsBeforeAnswer, true,
      `must encode write-ban + named artifact class — section was:\n${section}`);
  });

  test('fallback does NOT contain the #3018 anti-pattern ("pick a reasonable default")', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    assert.equal(parsed.silentlyPicksDefaults, false,
      `regression — fallback must NOT instruct the agent to pick defaults autonomously, section was:\n${section}`);
  });

  test('all four positive flags + the negative anti-pattern flag — typed-record snapshot', () => {
    // Single assertion that the whole semantic record matches the contract.
    // If any flag flips, the test fails with a structured diff naming the
    // exact invariant that broke.
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-discuss-phase'));
    const parsed = parseExecuteModeFallback(section);
    const semanticContract = {
      ok: parsed.ok,
      instructsStop: parsed.instructsStop,
      presentsPlainTextQuestions: parsed.presentsPlainTextQuestions,
      namesPermissionPath: parsed.namesPermissionPath,
      forbidsWritingArtifactsBeforeAnswer: parsed.forbidsWritingArtifactsBeforeAnswer,
      silentlyPicksDefaults: parsed.silentlyPicksDefaults,
    };
    assert.deepStrictEqual(semanticContract, {
      ok: true,
      instructsStop: true,
      presentsPlainTextQuestions: true,
      namesPermissionPath: true,
      forbidsWritingArtifactsBeforeAnswer: true,
      silentlyPicksDefaults: false,
    }, `discuss-mode fallback contract violated — section was:\n${section}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3245-codex-toml-floats.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3245-codex-toml-floats (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3245 — Codex install rejects valid TOML floats.
 *
 * Two defects, two fixes:
 *
 *   Defect 1 — parseTomlValue rejects TOML floats (e.g. tool_timeout_sec = 20.0).
 *     Codex CLI's serde schema requires f64 for tool_timeout_sec / startup_timeout_sec
 *     (integers fail with "invalid type: integer"). GSD's strict-integer-only parser
 *     was the inverse of what Codex requires — any float triggers the rejection branch.
 *     Fix: extend parseTomlValue to accept TOML 1.0 float literals and return them as
 *     JS Number. The merged config.toml preserves the float form verbatim so
 *     round-trip writes don't coerce 20.0 → 20.
 *
 *   Defect 2 — Partial rollback leaves install in hybrid state.
 *     restoreCodexSnapshot only knew about config.toml, but skills/, agents/, and VERSION
 *     are written earlier in the install sequence. A post-install validation failure
 *     aborts with new agent text on disk, config.toml reverted, and .tmp files
 *     potentially orphaned.
 *     Fix: capture pre-install state of skills/, agents/, and VERSION before any
 *     Codex-specific mutation, and extend the rollback to cover all of them.
 */

// GSD_TEST_MODE must be set before require('../bin/install.js') so the module
// skips the main CLI entry point and exports its internals.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { cleanup } = require('./helpers.cjs');

const { parseTomlToObject, validateCodexConfigSchema, install } = require('../bin/install.js');
const installModule = require('../bin/install.js');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

// Ensure hooks/dist/ is populated — mirrors the shared hooks/dist bootstrap pattern at the top of this file.
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    throwIfFailed(
      runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
      `node ${BUILD_HOOKS_SCRIPT}`,
    );
  }
});

function runCodexInstall(codexHome) {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCwd = process.cwd();
  // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
  // $HOME/.agents/skills root (os.homedir()-relative, independent of
  // CODEX_HOME). Sandbox HOME (and USERPROFILE) to codexHome so this
  // in-process install never materializes skills under the developer/CI
  // machine's real home directory.
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = codexHome;
  process.env.USERPROFILE = codexHome;
  try {
    process.chdir(path.join(__dirname, '..'));
    return install(true, 'codex');
  } finally {
    process.chdir(previousCwd);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
}

function writeCodexConfig(codexHome, content) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Defect 1 — parseTomlValue must accept TOML floats
// ---------------------------------------------------------------------------

describe('#3245 — parseTomlToObject accepts TOML floats', () => {
  test('parses bare decimal float (20.0)', () => {
    const content = [
      'tool_timeout_sec = 20.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(typeof parsed.tool_timeout_sec, 'number',
      'tool_timeout_sec should be a JS number');
    assert.strictEqual(parsed.tool_timeout_sec, 20.0,
      'value must equal 20.0');
  });

  test('parses startup_timeout_sec = 60.0', () => {
    const content = [
      'startup_timeout_sec = 60.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.startup_timeout_sec, 60.0);
  });

  test('parses positive exponent notation (1e10)', () => {
    const content = [
      'x = 1e10',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1e10);
  });

  test('parses negative exponent (1.5e-3)', () => {
    const content = [
      'x = 1.5e-3',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.ok(Math.abs(parsed.x - 1.5e-3) < 1e-15, 'must be approximately 1.5e-3');
  });

  test('parses signed positive float (+1.0)', () => {
    const content = [
      'x = +1.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1.0);
  });

  test('parses signed negative float (-0.5)', () => {
    const content = [
      'x = -0.5',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, -0.5);
  });

  test('parses float with underscore separators (1_000.0)', () => {
    const content = [
      'x = 1_000.0',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 1000.0);
  });

  test('integer (no decimal) still parses as integer', () => {
    const content = [
      'x = 42',
      '',
    ].join('\n');
    const parsed = parseTomlToObject(content);
    assert.strictEqual(parsed.x, 42);
  });

  test('still rejects bare date (1979-05-27)', () => {
    const content = [
      'x = 1979-05-27',
      '',
    ].join('\n');
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value/,
      'date literals must remain unsupported'
    );
  });

  test('still rejects bare time (07:32:00)', () => {
    const content = [
      'x = 07:32:00',
      '',
    ].join('\n');
    // With leading-zero rejection (CR4 fix) the parser stops at `0`, and
    // `7:32:00` is "trailing bytes". Either error form is acceptable — the
    // key invariant is that time literals are never silently accepted.
    assert.throws(
      () => parseTomlToObject(content),
      /unsupported TOML value|trailing bytes/,
      'time literals must remain unsupported'
    );
  });

  test('still rejects hex literal (0x1A)', () => {
    const content = [
      'x = 0x1A',
      '',
    ].join('\n');
    // 0 is parsed, then 'x1A' is trailing garbage — rejected with "trailing bytes"
    // or "unsupported value" depending on where the parser catches it.
    assert.throws(
      () => parseTomlToObject(content),
      /trailing bytes|unsupported (TOML value|value)/,
      'hex literals must remain unsupported'
    );
  });

  test('validateCodexConfigSchema passes a config with tool_timeout_sec = 20.0', () => {
    const content = [
      '[model]',
      'name = "o3"',
      '',
      'tool_timeout_sec = 20.0',
      'startup_timeout_sec = 60.0',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'schema validation must pass for a config containing TOML floats: ' + result.reason);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — full install must succeed and preserve float verbatim
// ---------------------------------------------------------------------------

// concurrency: false — drives the live install pipeline (shared CODEX_HOME env,
// process.chdir). Serialise to prevent stray mutations across parallel siblings.
describe('#3245 — install succeeds with TOML float in pre-existing config', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3245-float-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('install completes when config.toml contains tool_timeout_sec = 20.0', () => {
    // Floats at the root level (before any table header) — this is where Codex
    // CLI reads tool_timeout_sec / startup_timeout_sec according to its serde schema.
    const preInstall = [
      'tool_timeout_sec = 20.0',
      'startup_timeout_sec = 60.0',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    // Must not throw — pre-#3245 this threw "unsupported TOML value … floats … not supported".
    assert.doesNotThrow(
      () => runCodexInstall(codexHome),
      'install must not throw when config.toml contains TOML floats'
    );

    // The merged config.toml must still contain the float values at root scope.
    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const parsed = parseTomlToObject(after);
    assert.strictEqual(parsed.tool_timeout_sec, 20.0,
      'tool_timeout_sec must be preserved as a number after install');
    assert.strictEqual(parsed.startup_timeout_sec, 60.0,
      'startup_timeout_sec must be preserved as a number after install');
  });

  test('post-install config round-trips tool_timeout_sec as numeric 20', () => {
    const preInstall = [
      'tool_timeout_sec = 20.0',
      '',
    ].join('\n');
    writeCodexConfig(codexHome, preInstall);

    runCodexInstall(codexHome);

    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    // The value must survive round-trip as a float-compatible representation.
    // Parse structurally — don't grep for the literal string "20.0".
    const parsed = parseTomlToObject(after);
    assert.strictEqual(parsed.tool_timeout_sec, 20,
      'tool_timeout_sec must round-trip as numeric 20 (=== 20.0 in JS)');
  });
});

// ---------------------------------------------------------------------------
// CR round-4 finding — TOML 1.0 disallows leading zeros in integer part
// ---------------------------------------------------------------------------
//
// TOML 1.0 §2: integer literals follow decimal-integer rules, which disallow
// leading zeros except the value `0` itself. `01`, `01.5`, `00e2`, `+01.0`
// are therefore invalid. The `parseTomlValue` integer-part regex is tightened
// from `\d(?:_?\d)*` to `(0|[1-9](?:_?\d)*)`.

describe('#3245 CR4 — parseTomlValue rejects leading zeros in float integer part', () => {
  function parseValue(raw) {
    // Wrap in a minimal TOML assignment so parseTomlToObject drives the test.
    return parseTomlToObject(`x = ${raw}`).x;
  }

  function assertRejects(raw, label) {
    let threw = false;
    try { parseValue(raw); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, `expected rejection for ${label}: ${raw}`);
  }

  function assertAccepts(raw, expected, label) {
    let val;
    let threw = false;
    try { val = parseValue(raw); } catch (e) { threw = true; }
    assert.strictEqual(threw, false, `expected acceptance for ${label}: ${raw}`);
    if (expected !== undefined) {
      assert.ok(Math.abs(val - expected) < 1e-12, `${label}: expected ${expected}, got ${val}`);
    }
  }

  // --- rejection cases: leading zeros in the integer part ---

  test('rejects 01 (leading zero on bare integer)', () => assertRejects('01', '01'));
  test('rejects 00 (double-zero bare integer)', () => assertRejects('00', '00'));
  test('rejects 01.5 (leading zero before decimal point)', () => assertRejects('01.5', '01.5'));
  test('rejects 00.5 (double-zero before decimal)', () => assertRejects('00.5', '00.5'));
  test('rejects +01 (leading zero with sign)', () => assertRejects('+01', '+01'));
  test('rejects -01 (negative leading zero)', () => assertRejects('-01', '-01'));
  test('rejects 00e2 (leading zero with exponent)', () => assertRejects('00e2', '00e2'));
  test('rejects +01.0 (leading zero in positive float)', () => assertRejects('+01.0', '+01.0'));
  test('rejects -01.0 (leading zero in negative float)', () => assertRejects('-01.0', '-01.0'));
  test('rejects 01.5e10 (leading zero, decimal, and exponent)', () => assertRejects('01.5e10', '01.5e10'));

  // --- acceptance cases: valid TOML 1.0 numeric forms ---

  test('accepts 0 (single zero)', () => assertAccepts('0', 0, 'single zero'));
  test('accepts 0.5 (zero before decimal)', () => assertAccepts('0.5', 0.5, 'zero.decimal'));
  test('accepts 0.0 (zero.zero)', () => assertAccepts('0.0', 0.0, 'zero.zero'));
  test('accepts 0e1 (zero with exponent)', () => assertAccepts('0e1', 0, '0e1'));
  test('accepts +0.5 (positive zero-decimal)', () => assertAccepts('+0.5', 0.5, '+0.5'));
  test('accepts -0.5 (negative zero-decimal)', () => assertAccepts('-0.5', -0.5, '-0.5'));
  test('accepts 1 (single non-zero digit)', () => assertAccepts('1', 1, '1'));
  test('accepts 12 (two digits)', () => assertAccepts('12', 12, '12'));
  test('accepts 1.5 (simple float)', () => assertAccepts('1.5', 1.5, '1.5'));
  test('accepts 1_000 (underscored integer)', () => assertAccepts('1_000', 1000, '1_000'));
  test('accepts 1_000.5 (underscored float)', () => assertAccepts('1_000.5', 1000.5, '1_000.5'));
  test('accepts +1.5 (positive float)', () => assertAccepts('+1.5', 1.5, '+1.5'));
  test('accepts -2.0 (negative float)', () => assertAccepts('-2.0', -2.0, '-2.0'));
  test('accepts 1.5e-3 (float with negative exponent)', () => assertAccepts('1.5e-3', 1.5e-3, '1.5e-3'));
  test('accepts 1.05e10 (fractional part may start with zero)', () => assertAccepts('1.05e10', 1.05e10, '1.05e10'));
});

// ---------------------------------------------------------------------------
// Defect 2 — idempotent rollback covers skills, agents, VERSION
// ---------------------------------------------------------------------------

// concurrency: false — patches module.exports.__codexSchemaValidator and drives
// the install pipeline. Serialise to prevent cross-test pollution.
describe('#3245 — idempotent rollback reverts skills/, agents/, and VERSION', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3245-rollback-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    delete installModule.__codexSchemaValidator;
    cleanup(tmpDir);
  });

  test('validation failure rolls back skills/, agents/, and VERSION to pre-install state', () => {
    // Start from a clean codexHome with no pre-existing GSD content — the dirs
    // do not exist yet. After a failed install they must be absent (or contain
    // only what was there before, i.e. nothing).
    fs.mkdirSync(codexHome, { recursive: true });

    // Force schema validation to fail so we can observe the rollback without
    // needing a genuinely broken config.
    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure for #3245 rollback test',
    });

    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (_) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'install must throw when validation fails');

    // skills/ — GSD writes gsd-* subdirs here. All must be absent after rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    if (fs.existsSync(skillsDir)) {
      const gsdSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.strictEqual(
        gsdSkills.length,
        0,
        'rollback must remove all gsd-* skill directories: ' + gsdSkills.map(e => e.name).join(', ')
      );
    }

    // agents/ — GSD writes gsd-*.md and gsd-*.toml here. All must be absent.
    // Not the shared listAgentFiles() helper: reads the INSTALLED Codex dest
    // dir and is .toml-inclusive, so its semantics differ from the source roster.
    const agentsDir = path.join(codexHome, 'agents');
    if (fs.existsSync(agentsDir)) {
      const gsdAgents = fs.readdirSync(agentsDir)
        .filter(f => f.startsWith('gsd-') && (f.endsWith('.md') || f.endsWith('.toml')));
      assert.strictEqual(
        gsdAgents.length,
        0,
        'rollback must remove all gsd-* agent files: ' + gsdAgents.join(', ')
      );
    }

    // VERSION — GSD writes gsd-core/VERSION. Must be absent (wasn't there before).
    const versionPath = path.join(codexHome, 'gsd-core', 'VERSION');
    assert.strictEqual(
      fs.existsSync(versionPath),
      false,
      'rollback must remove the VERSION file written during install'
    );
  });

  test('rollback is safe when fired before any snapshots were captured (very early failure)', () => {
    // If the validator is injected before ANY install writes happen, the rollback
    // must not throw — it should be idempotent when nothing was written yet.
    fs.mkdirSync(codexHome, { recursive: true });

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'very early simulated failure',
    });

    // The install must throw (validation failure), but the rollback that runs
    // internally must not throw — it must be idempotent when nothing was written.
    let threw = false;
    try {
      runCodexInstall(codexHome);
    } catch (_) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'install must throw when validation fails (very early failure)');
    // Rollback removes all gsd-* skill dirs it wrote. Even if skills/ was
    // created during the install, no gsd-* dirs should survive after rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    const remainingGsdSkills = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'))
          .map((e) => e.name)
      : [];
    assert.deepStrictEqual(
      remainingGsdSkills,
      [],
      'rollback must remove all gsd-* skill dirs even when fired after minimal writes'
    );
  });

  test('rollback does not remove pre-existing user skills that GSD did not write', () => {
    // If the user has a custom skill dir (not gsd-*) it must survive rollback.
    const skillsDir = codexSkillsRoot(codexHome);
    const userSkill = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# Custom\n', 'utf8');

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure — user skill must survive',
    });

    let threw = false;
    try { runCodexInstall(codexHome); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, 'expected runCodexInstall to throw under simulated validation failure (user-skill-survives scenario)');

    assert.strictEqual(
      fs.existsSync(path.join(userSkill, 'SKILL.md')),
      true,
      'pre-existing non-gsd-* skill must survive rollback'
    );
  });

  test('rollback removes orphaned atomic-write temp files', () => {
    // Any <file>.tmp-<pid>-<n> files created during aborted atomic writes
    // must be cleaned up by the rollback so targetDir is not left with stray
    // temp files consuming disk space.
    fs.mkdirSync(codexHome, { recursive: true });

    installModule.__codexSchemaValidator = () => ({
      ok: false,
      reason: 'simulated failure for temp-file cleanup test',
    });

    let threw = false;
    try { runCodexInstall(codexHome); } catch (_) { threw = true; }
    assert.strictEqual(threw, true, 'expected runCodexInstall to throw under simulated validation failure (temp-file cleanup scenario)');

    // Scan for any *.tmp-* files left in codexHome after rollback.
    const tmpPattern = /\.tmp-\d+-\d+$/;
    function findTmpFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findTmpFiles(full));
        } else if (tmpPattern.test(entry.name)) {
          results.push(full);
        }
      }
      return results;
    }
    const stray = findTmpFiles(codexHome);
    assert.strictEqual(
      stray.length,
      0,
      'rollback must clean up orphaned atomic-write temp files: ' + stray.join(', ')
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4249 — install() exposes the full snapshot restore, not just migrations rollback
// ────────────────────────────────────────────────────────────────────────
{
  const { test, describe, beforeEach, afterEach } = require('node:test');
  const os = require('os');
  const { cleanup } = require('./helpers.cjs');
  const previousGsdTestMode = process.env.GSD_TEST_MODE;
  process.env.GSD_TEST_MODE = '1';
  const { install } = require('../bin/install.js');
  if (previousGsdTestMode === undefined) {
    delete process.env.GSD_TEST_MODE;
  } else {
    process.env.GSD_TEST_MODE = previousGsdTestMode;
  }

  // concurrency: false — drives the real install pipeline like the block above.
  describe('#4249 — install() exposes the full snapshot restore, not just migrations rollback', { concurrency: false }, () => {
    let tmpDir;
    let codexHome;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4249-codex-rollback-'));
      codexHome = path.join(tmpDir, 'codex-home');
      fs.mkdirSync(codexHome, { recursive: true });
    });

    afterEach(() => cleanup(tmpDir));

    test('result.rollbackPreInstallSnapshot() reverts skills/, agents/, and VERSION', () => {
      // Skills resolve $HOME-relative independent of CODEX_HOME (#2088), so the
      // rollback closure must run before this sandboxing is torn down — inline
      // runCodexInstall's env dance instead of using the auto-restoring helper,
      // matching how installAllRuntimes' real aggregate gate calls it: in the
      // same process env install() itself ran in, never after it's restored.
      const previousHome = process.env.HOME;
      const previousUserProfile = process.env.USERPROFILE;
      const previousCodexHome = process.env.CODEX_HOME;
      const previousCwd = process.cwd();
      process.env.HOME = codexHome;
      process.env.USERPROFILE = codexHome;
      process.env.CODEX_HOME = codexHome;
      process.chdir(path.join(__dirname, '..'));
      try {
        const result = install(true, 'codex');

        // A configured-entrypoint validation failure discovered outside install()
        // (installAllRuntimes' aggregate assertConfiguredEntrypoints, run after
        // this function already returned) reaches for this field. Before #4249
        // the only rollback Codex exposed was rollbackInstallerMigrations, which
        // reverts installer-migration state only and leaves the skills/agents/
        // VERSION this successful install just wrote untouched.
        result.rollbackPreInstallSnapshot();

        const skillsDir = codexSkillsRoot(codexHome);
        const gsdSkills = fs.existsSync(skillsDir)
          ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('gsd-'))
          : [];
        assert.strictEqual(gsdSkills.length, 0, 'rollback must remove all gsd-* skill directories: ' + gsdSkills.map(e => e.name).join(', '));

        const versionPath = path.join(codexHome, 'gsd-core', 'VERSION');
        assert.strictEqual(fs.existsSync(versionPath), false, 'rollback must remove gsd-core/VERSION');

        // #4249 (agy adversarial review): the whole point of this describe block
        // is that rollback covers the full pre-install snapshot, not just
        // installer migrations — config.toml/hooks.json must revert too. Both
        // were absent before this fresh install, so rollback must remove them.
        assert.strictEqual(
          fs.existsSync(path.join(codexHome, 'config.toml')),
          false,
          'rollback must remove config.toml (absent before this fresh install)'
        );
        assert.strictEqual(
          fs.existsSync(path.join(codexHome, 'hooks.json')),
          false,
          'rollback must remove hooks.json (absent before this fresh install)'
        );
      } finally {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3285-codex-hooks-state-allowed.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3285-codex-hooks-state-allowed (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3285 — Codex install fails when config.toml contains
 * hooks.state entries.
 *
 * Root cause: validateCodexConfigSchema walks every `hooks.*` table section
 * and asserts array-of-tables (AoT) shape, without distinguishing the
 * `hooks.state.*` namespace (Codex-managed per-hook trust persistence, a
 * regular table) from `hooks.<EVENT>` (event handlers like SessionStart,
 * which DO require AoT shape via [[hooks.SessionStart]]).
 *
 * Fix: add a carve-out so that any table whose path starts with `hooks.state`
 * is validated as a regular table (not AoT). All `hooks.<EVENT>` paths still
 * require AoT.
 */

// GSD_TEST_MODE must be set before require('../bin/install.js') so the module
// skips the main CLI entry point and exports its internals.
const previousGsdTestMode = process.env.GSD_TEST_MODE;
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { validateCodexConfigSchema, install } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

if (previousGsdTestMode === undefined) {
  delete process.env.GSD_TEST_MODE;
} else {
  process.env.GSD_TEST_MODE = previousGsdTestMode;
}

// Ensure hooks/dist/ is populated — mirrors the shared hooks/dist bootstrap pattern at the top of this file.
const { before, beforeEach, afterEach } = require('node:test');
const HOOKS_DIST = path.join(__dirname, '..', 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
// scripts/build-hooks.js copies pre-built hook files into hooks/dist and
// syntax-checks them with vm — it does not compile/bundle anything. See
// tests/helpers/timeouts.cjs for the class-norm justification.
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
before(() => {
  if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
    throwIfFailed(
      runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
      `node ${BUILD_HOOKS_SCRIPT}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Validator unit tests (no install, just validateCodexConfigSchema)
// ---------------------------------------------------------------------------

describe('#3285 — validateCodexConfigSchema: hooks.state is a regular table (not AoT)', () => {
  test('bare [hooks.state] table header passes validation', () => {
    const content = [
      '[hooks.state]',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'bare [hooks.state] must be allowed (regular-table namespace): ' + result.reason);
  });

  test('bare [hooks.state.<project-key>] table header passes validation', () => {
    // Mirrors the exact shape Codex CLI 0.130.0+ writes for per-hook trust entries.
    // The key contains slashes and colons — must be quoted in TOML.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'bare [hooks.state.<key>] with trust fields must be allowed: ' + result.reason);
  });

  test('hooks.state alongside [[hooks.SessionStart]] AoT both pass', () => {
    // The real-world fixture: user has both Codex trust state AND GSD-managed
    // event hooks in the same config.toml.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123"',
      '',
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "/usr/local/bin/gsd-check-update"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'mixed hooks.state (regular table) + [[hooks.SessionStart]] (AoT) must pass: ' + result.reason);
  });

  test('[[hooks.SessionStart]] AoT still requires array-of-tables shape', () => {
    // Regression guard: the fix must NOT relax AoT requirements for event hooks.
    // [hooks.SessionStart] (single-bracket) must still fail.
    const content = [
      '[hooks.SessionStart]',
      'type = "command"',
      'command = "/some/command"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[hooks.SessionStart] bare table (not AoT) must still be rejected');
    assert.ok(
      result.reason.includes('hooks.SessionStart'),
      'rejection reason must mention hooks.SessionStart, got: ' + result.reason
    );
  });

  test('hooks.state object in parsed structure does not trigger non-array rejection', () => {
    // The parsed-object check loops over Object.entries(parsed.hooks) and
    // asserts !Array.isArray(value) → error. hooks.state is an object, not
    // an array. The fix must skip hooks.state in that loop too.
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'some-key']",
      'enabled = true',
      'trusted_hash = "sha256:deadbeef"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'parsed hooks.state object must not trigger "hooks.state must be an array" rejection: ' + result.reason);
  });

  test('multiple hooks.state sub-keys all pass validation', () => {
    const content = [
      '[hooks.state]',
      '',
      "[hooks.state.'/project/a/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:aaa"',
      '',
      "[hooks.state.'/project/b/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = false',
      'trusted_hash = "sha256:bbb"',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, true,
      'multiple hooks.state sub-keys must all pass: ' + result.reason);
  });

  test('[[hooks.state]] AoT form is rejected', () => {
    // hooks.state must be a regular table — array-of-tables shape is invalid.
    const content = [
      '[[hooks.state]]',
      'enabled = true',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[[hooks.state]] (AoT) must be rejected');
    assert.ok(
      result.reason.includes('hooks.state'),
      'rejection reason must mention hooks.state, got: ' + result.reason
    );
  });

  test('[[hooks.state.foo]] AoT sub-key form is rejected', () => {
    // hooks.state.* sub-keys must be regular tables — AoT sub-key shape is invalid.
    const content = [
      '[[hooks.state.foo]]',
      'enabled = true',
      '',
    ].join('\n');
    const result = validateCodexConfigSchema(content);
    assert.strictEqual(result.ok, false,
      '[[hooks.state.foo]] (AoT sub-key) must be rejected');
    assert.ok(
      result.reason.includes('hooks.state'),
      'rejection reason must mention hooks.state, got: ' + result.reason
    );
  });
});

// ---------------------------------------------------------------------------
// Full install integration test
// ---------------------------------------------------------------------------

describe('#3285 — install succeeds when config.toml contains hooks.state entries', { concurrency: false }, () => {
  let tmpDir;
  let codexHome;

  function writeCodexConfig(content) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), content, 'utf8');
  }

  function runCodexInstall() {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousCwd = process.cwd();
    // #2088 (ADR-1239 upgrade 3): Codex skills now install to the canonical
    // $HOME/.agents/skills root (os.homedir()-relative, independent of
    // CODEX_HOME). Sandbox HOME (and USERPROFILE) to tmpDir so this
    // in-process install never materializes skills under the developer/CI
    // machine's real home directory.
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    try {
      process.chdir(path.join(__dirname, '..'));
      return install(true, 'codex');
    } finally {
      process.chdir(previousCwd);
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3285-'));
    codexHome = path.join(tmpDir, 'codex-home');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('install does not throw when config.toml contains hooks.state trust entries', () => {
    // This is the exact failure scenario reported in #3285.
    const preInstall = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123def456"',
      '',
    ].join('\n');
    writeCodexConfig(preInstall);

    assert.doesNotThrow(
      () => runCodexInstall(),
      'install must not throw when config.toml contains hooks.state trust entries'
    );
  });

  test('hooks.state entries are preserved in post-install config.toml', () => {
    const preInstall = [
      '[hooks.state]',
      '',
      "[hooks.state.'/home/user/.codex/hooks.json:pre_tool_use:0:0']",
      'enabled = true',
      'trusted_hash = "sha256:abc123def456"',
      '',
    ].join('\n');
    writeCodexConfig(preInstall);

    runCodexInstall();

    const after = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    // Verify structurally: the trust hash key must survive the install.
    // Do NOT grep for the literal string — parse the TOML structure.
    const { parseTomlToObject } = require('../bin/install.js');
    const parsed = parseTomlToObject(after);
    assert.ok(
      parsed.hooks && typeof parsed.hooks.state === 'object' && parsed.hooks.state !== null,
      'post-install config.toml must have hooks.state as an object'
    );
    // Verify the actual trust entry survives — not just that hooks.state is an object.
    const trustKey = "/home/user/.codex/hooks.json:pre_tool_use:0:0";
    assert.ok(
      parsed.hooks.state[trustKey] != null,
      `post-install must preserve the original trust entry for key: ${trustKey}`
    );
    assert.strictEqual(
      parsed.hooks.state[trustKey].enabled,
      true,
      'preserved trust entry must have enabled = true'
    );
    assert.strictEqual(
      parsed.hooks.state[trustKey].trusted_hash,
      'sha256:abc123def456',
      'preserved trust entry must have the original trusted_hash'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3346-codex-aot-toml-key.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3346-codex-aot-toml-key (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression: issue #3346 — Codex install fails on Windows when the legacy
 * Codex `[hooks]` config uses a `<file>:<event>:<line>:<col>` location tuple
 * as the table key (with the actual event name carried in an `event = "..."`
 * body field). `migrateCodexHooksMapFormat` re-emitted the location tuple
 * verbatim as the leaf TOML key, producing a header like
 *
 *   [[hooks."C:\Users\helen\.codex\config.toml:session_start:0:0"]]
 *
 * which Codex 0.124.0+ refuses to load (the leaf key segment is supposed to
 * be the event name, not a diagnostic location identifier).
 *
 * Expected behaviour: when the legacy `[hooks.<X>]` body declares an
 * `event = "..."` field, the migrator must use that event name as the leaf
 * TOML key for the emitted `[[hooks.<EVENT>]]` two-level nested AoT block.
 *
 * Test discipline: parse the migrated TOML with the project's own
 * `parseTomlToObject` and assert on the resulting object shape — never
 * grep the raw string.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateCodexHooksMapFormat,
  parseTomlToObject,
} = require('../bin/install.js');

describe('#3346 — Codex AoT hooks migration emits event-name leaf key, not location tuple', () => {
  test('legacy [hooks."<location-tuple>"] with event="..." body migrates to [[hooks.<event>]]', () => {
    // Pre-install fixture: a legacy `[hooks.<quoted-key>]` block whose key is
    // a `<config-path>:<event>:<line>:<col>` location identifier. The actual
    // event name lives in the body as `event = "session_start"`.
    const legacy = [
      '[hooks."C:\\\\Users\\\\helen\\\\.codex\\\\config.toml:session_start:0:0"]',
      'event = "session_start"',
      'command = "echo hi"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    // The migrated hooks object must be keyed by the event name, not by the
    // location tuple. This is the core assertion of #3346.
    assert.ok(parsed.hooks, 'migrated TOML must define a hooks table');
    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['session_start'],
      `migrated hooks must be keyed by event name only; got: ${JSON.stringify(Object.keys(parsed.hooks))}`
    );

    // The handler body must survive the migration and live under the two-level
    // nested AoT shape (hooks.<event>[0].hooks[0].command).
    const eventEntries = parsed.hooks.session_start;
    assert.ok(Array.isArray(eventEntries) && eventEntries.length >= 1,
      'hooks.session_start must be an array of tables');
    const handlers = eventEntries[0].hooks;
    assert.ok(Array.isArray(handlers) && handlers.length >= 1,
      'hooks.session_start[0].hooks must be an array of handler tables');
    assert.equal(handlers[0].command, 'echo hi',
      'handler command must be preserved through migration');
    assert.equal(handlers[0].type, 'command',
      'handler type must default to "command" when no explicit type given');
    assert.equal(handlers[0].event, undefined,
      'handler body must not retain legacy `event` field after migration');
  });

  test('legacy [hooks."<location>"] with explicit type and event survives migration cleanly', () => {
    // Same as above but with an explicit `type` field — the migrator must not
    // duplicate it when re-emitting the handler.
    const legacy = [
      '[hooks."/home/user/.codex/config.toml:tool_call_pre:5:0"]',
      'event = "tool_call_pre"',
      'type = "command"',
      'command = "node /path/to/hook.js"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['tool_call_pre'],
      'leaf key must be the event name from the `event = "..."` body field'
    );
    const handler = parsed.hooks.tool_call_pre[0].hooks[0];
    assert.equal(handler.command, 'node /path/to/hook.js');
    assert.equal(handler.type, 'command');
    assert.equal(handler.event, undefined,
      'handler body must not retain legacy `event` field after migration');
  });

  test('legacy [hooks.<bare-event>] without location-tuple key continues to work unchanged', () => {
    // Regression guard: the fix must not break the canonical legacy-map case
    // ([hooks.<event-name>] with handler-fields-only body, no `event` key).
    const legacy = [
      '[hooks.session_start]',
      'command = "echo hi"',
      '',
    ].join('\n');

    const migrated = migrateCodexHooksMapFormat(legacy);
    const parsed = parseTomlToObject(migrated);

    assert.deepEqual(
      Object.keys(parsed.hooks),
      ['session_start'],
      'bare-event legacy shape must continue to migrate to event-named leaf key'
    );
    assert.equal(parsed.hooks.session_start[0].hooks[0].command, 'echo hi');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3360-codex-execute-phase-worktrees.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3360-codex-execute-phase-worktrees (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #3360.
 *
 * Codex does not have a direct equivalent of Claude Code's
 * `Agent(... isolation="worktree")`. The execute-phase workflow must fail
 * closed for Codex + workflow.use_worktrees=true instead of spawning
 * workspace-write executors in the main checkout.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md');
const { getCodexSkillAdapterHeader } = require('../bin/install.js');

function parseWorkflowSteps(content) {
  return [...content.matchAll(/<step name="([^"]+)"[^>]*>([\s\S]*?)<\/step>/g)]
    .map((match) => {
      const body = match[2];
      return {
        name: match[1],
        // After #3797 architectural fix, callsites use gsd_run
        readsRuntimeConfig: body.includes('RUNTIME=$(gsd_run query config-get runtime --default claude'),
        // #1521 generalized the guard from Codex-specific to all non-Claude
        // runtimes; #2584 Phase 3 (#2627) generalized it again — off runtime
        // identity entirely and onto the negotiated `dispatch.isolation`
        // capability. The step now resolves ISOLATION (delegating the block to
        // the isolation-dispatch fragment) and fails closed when a host
        // declares no primitive, which is what #3360 actually protects.
        resolvesIsolationCapability: body.includes('Resolve ISOLATION'),
        // Worktree dispatch guidance is no longer a hardcoded Claude flag —
        // step 3 emits the host's DECLARED harness flag.
        worktreeDispatchGuidance: body.includes('{harnessFlag}')
          || body.includes('executor-isolation-dispatch.md'),
      };
    });
}

function executePhaseWorktreeContract(content) {
  const steps = parseWorkflowSteps(content);
  const initializeIndex = steps.findIndex((step) => step.name === 'initialize');
  const firstWorktreeDispatchIndex = steps.findIndex((step) => step.worktreeDispatchGuidance);
  assert.notEqual(initializeIndex, -1, 'workflow must have an initialize step');
  assert.notEqual(firstWorktreeDispatchIndex, -1, 'workflow must still document worktree dispatch guidance');

  const initialize = steps[initializeIndex];
  return {
    initializeReadsRuntimeConfig: initialize.readsRuntimeConfig,
    initializeResolvesIsolationCapability: initialize.resolvesIsolationCapability,
    guardStepPrecedesWorktreeDispatch: initializeIndex <= firstWorktreeDispatchIndex,
  };
}

describe('#3360 — execute-phase fails closed for unsupported worktree isolation', () => {
  // #2584 Phase 3 (#2627) moved this from "Codex is blocked by name" to "a host
  // with no declared isolation primitive is blocked". Codex now DECLARES
  // orchestrator-worktree and gets a real isolated path, so the guard can no
  // longer key on its name — but #3360's actual protection (never run executors
  // unisolated against the main checkout) is unchanged and asserted below.
  const ISOLATION_FRAGMENT = path.join(
    ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
  );

  test('execute-phase resolves the isolation capability before any worktree dispatch', () => {
    const workflow = fs.readFileSync(EXECUTE_PHASE, 'utf8');
    const contract = executePhaseWorktreeContract(workflow);

    assert.deepEqual(contract, {
      initializeReadsRuntimeConfig: true,
      initializeResolvesIsolationCapability: true,
      guardStepPrecedesWorktreeDispatch: true,
    });
  });

  test('a host declaring no isolation primitive still fails closed', () => {
    const fragment = fs.readFileSync(ISOLATION_FRAGMENT, 'utf8');
    assert.match(fragment, /ISOLATION="?none"?/,
      'fragment must resolve the none case');
    assert.match(fragment, /FATAL[^\n]*no executor-isolation primitive/,
      'a host with dispatch.isolation=none must fail closed before dispatch (#3360)');
    assert.match(fragment, /use_worktrees=false/,
      'the fail-closed message must tell the user how to proceed');
  });

  test('the scheduler never gates worktree dispatch on a runtime name', () => {
    const workflow = fs.readFileSync(EXECUTE_PHASE, 'utf8');
    const fragment = fs.readFileSync(ISOLATION_FRAGMENT, 'utf8');
    for (const [label, src] of [['execute-phase.md', workflow], ['isolation fragment', fragment]]) {
      assert.ok(
        !/\[\s*"\$RUNTIME"\s*(?:!=|=)\s*"(?:codex|claude)"\s*\]\s*&&\s*\[\s*"\$USE_WORKTREES"/.test(src),
        `${label}: worktree dispatch must branch on dispatch.isolation, not a runtime name (ADR-1239)`,
      );
    }
  });

  test('Codex adapter documents the orchestrator-managed worktree mapping', () => {
    const header = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.match(header, /isolation="worktree"/);
    assert.match(header, /orchestrator-worktree/i,
      'the adapter header must no longer claim Codex has no worktree mapping — #2584 Phase 3 gave it one');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3426-codex-windows-hooks.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3426-codex-windows-hooks (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Bug #3426 — Codex on Windows: SessionStart/PostToolUse hooks fail with exit code 1
 *
 * After PRs #3396/#3397 fixed bare-bash and quote-escaping issues, a new failure
 * mode appeared on v1.42.3+:
 *
 *   Failed with non-blocking status code:
 *   C:/Program Files/Git/bin/bash.exe: C:/Program Files/Git/bin/bash.exe: cannot execute binary file
 *
 * Root cause: Codex on Windows runs hook commands from a PowerShell/cmd
 * execution environment (see install.js comment at buildHookCommand).  The
 * command string written to hooks.json was:
 *
 *   "C:/Program Files/nodejs/node.exe" "C:/path/.codex/hooks/gsd-check-update.js"
 *
 * When Codex's hook runner passes this to its subprocess spawner, the quoted
 * path resolves through Git Bash (MSYS), which then tries to POSIX-exec
 * node.exe — a Windows PE binary — via the MSYS exec layer.  The MSYS exec
 * path calls execvp() on the PE binary directly, which fails with ENOEXEC,
 * reported as "cannot execute binary file".  The "bash.exe: bash.exe:" prefix
 * appears because the error propagates through the bash.exe process that Codex
 * uses as its hook-dispatch shell.
 *
 * Fix: on Windows, write a .cmd shim (using the same buildWindowsShimTriple
 * IR pattern as gsd-sdk.cmd) and put the .cmd path as the hooks.json command.
 * cmd.exe executes .cmd files natively via CreateProcess — no POSIX exec layer,
 * no MSYS shebang walk.
 *
 * Test strategy:
 * - Assert on the typed IR returned by buildCodexHookWindowsShimIR — not on
 *   rendered .cmd text (per CONTRIBUTING.md L558-L565 IR-first discipline).
 * - Counter-tests confirm darwin/linux paths are unchanged.
 *
 * NOTE: Windows wall-clock verification depends on Docker matrix Windows
 * runners.  Local test exercises the generator IR shape only.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL = require('../bin/install.js');
const HOOKS_SURFACE = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const PROJECTION = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  uninstall,
} = INSTALL;

const {
  buildCodexHookWindowsShimIR,
  ensureCodexHooksJsonSessionStart,
  resolveNodeRunner,
} = HOOKS_SURFACE;

const { projectManagedHookCommand } = PROJECTION;

/**
 * Extract hook handler objects for `eventName` from a hooks.json object.
 * Handles both the legacy top-level shape { SessionStart: [...] } and the
 * canonical nested shape { hooks: { SessionStart: [...] } } (bug #1348).
 */
function hookHandlersForEvent(hooksJson, eventName) {
  if (!hooksJson || typeof hooksJson !== 'object') return [];
  const table =
    hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)
      ? hooksJson.hooks
      : hooksJson;
  if (!Array.isArray(table[eventName])) return [];
  return table[eventName].flatMap((e) => Array.isArray(e && e.hooks) ? e.hooks : []);
}

// ─── Step 1: Export surface check ────────────────────────────────────────────

describe('#3426 — export surface: buildCodexHookWindowsShimIR must be exported', () => {
  test('buildCodexHookWindowsShimIR is a function', () => {
    assert.equal(typeof buildCodexHookWindowsShimIR, 'function',
      'buildCodexHookWindowsShimIR must be exported from runtime-hooks-surface.cjs');
  });

  test('ensureCodexHooksJsonSessionStart is a function', () => {
    assert.equal(typeof ensureCodexHooksJsonSessionStart, 'function',
      'ensureCodexHooksJsonSessionStart must be exported from runtime-hooks-surface.cjs');
  });
});

// ─── Step 2: Typed IR shape for Windows Codex hook shim ──────────────────────

describe('#3426 — buildCodexHookWindowsShimIR: typed IR (not rendered text)', () => {
  const FAKE_SCRIPT = 'C:/Users/me/.codex/hooks/gsd-check-update.js';
  const FAKE_RUNNER = '"C:/Program Files/nodejs/node.exe"';

  test('returns typed IR with invocation, cmdPath, and render factory', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // IR shape assertion — per CONTRIBUTING.md L558 IR-first discipline
    assert.ok(ir && typeof ir === 'object', 'must return an object');
    assert.ok(typeof ir.invocation === 'object', 'must have invocation record');
    assert.ok(typeof ir.cmdPath === 'string', 'must have cmdPath string');
    assert.ok(typeof ir.hookCommand === 'string', 'must have hookCommand string (written to hooks.json)');
    assert.ok(typeof ir.render === 'object', 'must have render factory');
    assert.ok(typeof ir.render.cmd === 'function', 'must have render.cmd() factory');
  });

  test('invocation.target equals the resolved script path', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // invocation.target is the JS file being wrapped — same IR contract as buildWindowsShimTriple
    assert.ok(
      ir.invocation.target.includes('gsd-check-update.js'),
      `invocation.target must reference the hook script, got: ${ir.invocation.target}`,
    );
  });

  test('invocation.interpreter is the node runner (not bash)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // The shim must invoke node, never bash — bash is not a valid Codex hook runner on Windows
    const interp = ir.invocation.interpreter;
    assert.ok(
      typeof interp === 'string' && (interp.includes('node') || interp === 'node'),
      `invocation.interpreter must be a node path, not bash. Got: ${interp}`,
    );
    assert.ok(
      !interp.toLowerCase().includes('bash'),
      `invocation.interpreter must NOT be bash — bash is the source of the #3426 failure. Got: ${interp}`,
    );
  });

  test('cmdPath ends with .cmd extension', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.ok(
      ir.cmdPath.endsWith('.cmd'),
      `cmdPath must end with .cmd for cmd.exe native execution, got: ${ir.cmdPath}`,
    );
  });

  test('hookCommand is the .cmd path (not a "runner script.js" string)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    // The hook command written to hooks.json must be the .cmd path, not "node.exe script.js"
    // because cmd.exe executes .cmd natively without POSIX exec layer
    assert.ok(
      ir.hookCommand.includes('.cmd'),
      `hookCommand must reference the .cmd shim, got: ${ir.hookCommand}`,
    );
    // hookCommand must NOT contain bash — this was the failure mode
    assert.ok(
      !ir.hookCommand.toLowerCase().includes('bash'),
      `hookCommand must NOT reference bash, got: ${ir.hookCommand}`,
    );
  });

  test('returns null when absoluteRunnerToken is null (caller skips registration)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, null);
    assert.equal(ir, null,
      'must return null when runner is unavailable so caller can warn-and-skip');
  });
});

// ─── Step 2b: Typed IR — eol / quoting / passthroughArgs ─────────────────────
// Per CONTRIBUTING.md L558-L565: assert on the typed IR, not on rendered text.
// These assertions cover the three bug-critical render semantics that
// text-matching tests would miss (silent EOL/quoting/passthrough regressions).

describe('#3426 — buildCodexHookWindowsShimIR: typed IR eol / quoting / passthroughArgs', () => {
  const FAKE_SCRIPT = 'C:/Users/me/.codex/hooks/gsd-check-update.js';
  const FAKE_RUNNER = '"C:/Program Files/nodejs/node.exe"';

  test('eol.cmd is CRLF (\\r\\n) — canonical for cmd.exe .cmd files', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.ok(ir && typeof ir.eol === 'object', 'IR must expose an eol field');
    assert.strictEqual(
      ir.eol.cmd,
      '\r\n',
      'eol.cmd must be CRLF (\\r\\n) — LF-only .cmd files risk silent parse failures on some Windows versions',
    );
  });

  test('invocation.target has no shell-metachar leakage (clean absolute path)', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    const target = ir.invocation.target;
    assert.ok(typeof target === 'string' && target.length > 0, 'invocation.target must be a non-empty string');
    // The target stored in the IR is the raw unquoted path — quoting happens at
    // render time. A metachar in the raw value means the IR is already corrupted.
    assert.ok(
      !target.includes('"') && !target.includes("'") && !target.includes('`'),
      `invocation.target must be the raw path without shell quoting, got: ${target}`,
    );
    assert.ok(
      target.endsWith('.js'),
      `invocation.target must resolve to the .js script, got: ${target}`,
    );
  });

  test('passthroughArgs is true — shim forwards all args via %*', () => {
    const ir = buildCodexHookWindowsShimIR(FAKE_SCRIPT, FAKE_RUNNER);
    assert.strictEqual(
      ir.passthroughArgs,
      true,
      'passthroughArgs must be true: the .cmd shim must forward all arguments to the node script via %*',
    );
  });
});

// ─── Step 3: Counter-test — non-Windows platforms use node-runner command ────

describe('#3426 counter-test: darwin/linux Codex paths use node-runner command (not .cmd shim)', () => {
  test('projectManagedHookCommand on darwin emits node-runner command, not .cmd', () => {
    const runner = resolveNodeRunner() || '"/usr/local/bin/node"';
    const cmd = projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: '/Users/me/.codex/hooks/gsd-check-update.js',
      runtime: 'codex',
      platform: 'darwin',
    });
    assert.ok(typeof cmd === 'string', 'must return a string on darwin');
    assert.ok(!cmd.endsWith('.cmd'), 'darwin command must NOT reference a .cmd shim');
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `darwin command must reference the .js hook directly, got: ${cmd}`,
    );
  });

  test('projectManagedHookCommand on linux emits node-runner command, not .cmd', () => {
    const runner = resolveNodeRunner() || '"/usr/local/bin/node"';
    const cmd = projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: '/home/me/.codex/hooks/gsd-check-update.js',
      runtime: 'codex',
      platform: 'linux',
    });
    assert.ok(typeof cmd === 'string', 'must return a string on linux');
    assert.ok(!cmd.endsWith('.cmd'), 'linux command must NOT reference a .cmd shim');
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `linux command must reference the .js hook directly, got: ${cmd}`,
    );
  });
});

// ─── Step 4: Integration — ensureCodexHooksJsonSessionStart on win32 writes .cmd shim ──

describe('#3426 integration: ensureCodexHooksJsonSessionStart on win32 writes .cmd shim', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    // Stub the hook file that must exist for the hook to be registered
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('win32: hooks.json command references .cmd shim (not "node.exe script.js")', () => {
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';

    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    assert.ok(result.wrote || result.changed, 'must write hooks.json on win32');

    const hooksJsonPath = path.join(tmpDir, 'hooks.json');
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json must exist after install');

    const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    assert.ok(commands.length > 0, 'must have at least one SessionStart hook command');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'must have a gsd-check-update hook command');

    // KEY ASSERTION: on win32, the command must reference a .cmd file — not bash
    assert.ok(
      cmd.includes('.cmd'),
      `win32 hook command must reference a .cmd shim to avoid bash.exe exec failure (#3426). Got: ${cmd}`,
    );
    assert.ok(
      !cmd.toLowerCase().includes('bash'),
      `win32 hook command must NOT reference bash.exe — this was the #3426 failure. Got: ${cmd}`,
    );
  });

  test('win32: .cmd shim file is written to the hooks directory', () => {
    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';

    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(
      fs.existsSync(cmdShimPath),
      `win32: .cmd shim must be written at ${cmdShimPath}`,
    );
    // File must be non-empty — structure check only (IR-first discipline)
    const size = fs.statSync(cmdShimPath).size;
    assert.ok(size > 0, '.cmd shim must have non-zero content');
  });

  test('non-Windows (darwin): hooks.json command is "node.exe script.js" (no .cmd shim)', () => {
    const fakeRunner = '"/usr/local/bin/node"';

    const result = ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'darwin',
    });

    assert.ok(result.wrote || result.changed, 'must write hooks.json on darwin');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'),
    );
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'must have a gsd-check-update hook command on darwin');

    // Counter-test: darwin must NOT use a .cmd shim
    assert.ok(
      !cmd.endsWith('.cmd'),
      `darwin hook command must NOT reference a .cmd shim, got: ${cmd}`,
    );
    assert.ok(
      cmd.includes('gsd-check-update.js'),
      `darwin hook command must reference the .js file directly, got: ${cmd}`,
    );

    // .cmd shim must NOT be written on darwin
    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(
      !fs.existsSync(cmdShimPath),
      'darwin must NOT write a .cmd shim',
    );
  });

  test('non-Windows (linux): same as darwin — no .cmd shim', () => {
    const fakeRunner = '"/usr/local/bin/node"';

    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'linux',
    });

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'),
    );
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const cmd = commands.find((c) => c.includes('gsd-check-update'));
    assert.ok(cmd, 'linux must have a gsd-check-update hook command');
    assert.ok(!cmd.endsWith('.cmd'), 'linux must NOT use a .cmd shim');

    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(!fs.existsSync(cmdShimPath), 'linux must NOT write a .cmd shim');
  });
});

// ─── Step 5: Uninstall cleanup — .cmd shim removed from disk ─────────────────

describe('#3426 uninstall: gsd-check-update.cmd is removed from hooks dir on uninstall', () => {
  let tmpDir;

  function withCodexHome(dir, fn) {
    const prev = process.env.CODEX_HOME;
    // #2088 (ADR-1239 upgrade 3): Codex skills now resolve an alternate install
    // home rooted at the REAL os.homedir() ($HOME/.agents), independent of
    // CODEX_HOME. Fake $HOME (and $USERPROFILE) too so this in-process install
    // never touches the developer/CI machine's real home directory — confined
    // entirely to `dir`, which the caller cleans up.
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.CODEX_HOME = dir;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    try { return fn(); }
    finally {
      if (prev == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile == null) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
    }
  }

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-uninstall-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    // Write the .js hook (required by install) and a pre-existing .cmd shim
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.cmd'),
      '@ECHO OFF\r\n@SETLOCAL\r\n@"C:/node.exe" "C:/path/gsd-check-update.js" %*\r\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('uninstall removes gsd-check-update.cmd from hooks directory', () => {
    const cmdShimPath = path.join(tmpDir, 'hooks', 'gsd-check-update.cmd');
    assert.ok(fs.existsSync(cmdShimPath), 'pre-condition: .cmd shim exists before uninstall');

    withCodexHome(tmpDir, () => uninstall(true, 'codex'));

    assert.ok(
      !fs.existsSync(cmdShimPath),
      `gsd-check-update.cmd must be removed from disk on uninstall — orphaned .cmd shim would cause stale hook references. Path: ${cmdShimPath}`,
    );
  });
});

// ─── Step 6: Upgrade path — existing win32 hooks.json with node-runner command ─

describe('#3426 upgrade: reinstall on win32 migrates existing "node script.js" to .cmd shim', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-3426-upgrade-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'gsd-check-update.js'),
      '#!/usr/bin/env node\nconsole.log("ok");\n',
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('replaces old "node.exe script.js" command with .cmd shim on win32 reinstall', () => {
    const managedHookPath = path.join(tmpDir, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');
    // Pre-existing stale hooks.json with node-runner command (v1.42.3 shape)
    const staleLegacyCommand = `"C:/Program Files/nodejs/node.exe" "${managedHookPath}"`;
    fs.writeFileSync(
      path.join(tmpDir, 'hooks.json'),
      JSON.stringify({
        SessionStart: [{ hooks: [{ type: 'command', command: staleLegacyCommand }] }],
      }, null, 2),
    );

    const fakeRunner = '"C:/Program Files/nodejs/node.exe"';
    ensureCodexHooksJsonSessionStart(tmpDir, {
      absoluteRunner: fakeRunner,
      platform: 'win32',
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    // #1348: hooks.json is now always written in nested { hooks: { ... } } shape
    const commands = hookHandlersForEvent(hooksJson, 'SessionStart')
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string');

    const gsdCmds = commands.filter((c) => c.includes('gsd-check-update'));
    // Exactly one managed hook after migration — no duplicates
    assert.equal(gsdCmds.length, 1, `must have exactly 1 gsd-check-update command after migration, got: ${JSON.stringify(gsdCmds)}`);

    // Must be the .cmd shim
    assert.ok(
      gsdCmds[0].includes('.cmd'),
      `migrated command must reference .cmd shim, got: ${gsdCmds[0]}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3427-3433-codex-install-shape.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3427-3433-codex-install-shape (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const { install, uninstall, parseTomlToObject } = require('../bin/install.js');
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

function extractSessionStartCommandsFromHooksJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const table = (value.hooks && typeof value.hooks === 'object' && !Array.isArray(value.hooks))
    ? value.hooks
    : value;
  const sessionStart = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  return sessionStart.flatMap((entry) => {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.map((h) => h && h.command).filter((cmd) => typeof cmd === 'string');
  });
}

describe('#3427 + #3433 — Codex installer avoids duplicate skills and mixed hook representation', { concurrency: false }, () => {
  let tmpRoot;
  let codexHome;

  beforeEach(() => {
    if (!fs.existsSync(HOOKS_DIST) || fs.readdirSync(HOOKS_DIST).length === 0) {
      throwIfFailed(
        runNode([BUILD_HOOKS_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
        `node ${BUILD_HOOKS_SCRIPT}`,
      );
    }
    tmpRoot = createTempDir('gsd-3427-3433-');
    codexHome = path.join(tmpRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpRoot);
  });

  test('regenerates managed gsd-* skill copies and preserves unrelated user skills (#3562 reverses prior #3427/#3433 behaviour)', () => {
    // Stale legacy body — fresh install must overwrite this so Codex sees the
    // current SKILL.md, not whatever was last on disk.
    const legacySkillBody = '# old managed\n';
    fs.mkdirSync(path.join(codexHome, 'skills', 'gsd-help'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'gsd-help', 'SKILL.md'), legacySkillBody);
    const legacyHash = crypto.createHash('sha256').update(legacySkillBody).digest('hex');
    fs.writeFileSync(path.join(codexHome, 'gsd-file-manifest.json'), JSON.stringify({
      version: 1,
      files: {
        'skills/gsd-help/SKILL.md': legacyHash,
      },
    }, null, 2));

    fs.mkdirSync(path.join(codexHome, 'skills', 'custom-user-skill'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md'), '# user skill\n');

    withCodexHome(codexHome, () => install(true, 'codex'));

    // #2088: the managed gsd-* skill surface now regenerates at the
    // canonical $HOME/.agents/skills root (fakeHome === tmpRoot here — see
    // withCodexHome above), not under the legacy $CODEX_HOME/skills.
    const newSkillsDir = codexSkillsRoot(tmpRoot);
    const newEntries = fs.existsSync(newSkillsDir)
      ? fs.readdirSync(newSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];

    // #3562: $gsd-* commands are discoverable only when
    // .agents/skills/gsd-*/SKILL.md exists. The installer must regenerate
    // (not remove) the managed gsd-* directories.
    assert.equal(newEntries.includes('gsd-help'), true);
    const refreshedBody = fs.readFileSync(path.join(newSkillsDir, 'gsd-help', 'SKILL.md'), 'utf8');
    assert.notEqual(refreshedBody, legacySkillBody, 'stale legacy body must be overwritten');
    const frontmatter = parseFrontmatter(refreshedBody);
    assert.equal(frontmatter.name, 'gsd-help', 'refreshed SKILL.md frontmatter must declare name: gsd-help');

    // #2088 migration: the installer cleans stale gsd-* dirs out of the old
    // $CODEX_HOME/skills location on a pre-move install.
    const legacyHelpDir = path.join(codexHome, 'skills', 'gsd-help');
    assert.equal(fs.existsSync(legacyHelpDir), false, 'migration must remove the stale legacy gsd-help skill dir from $CODEX_HOME/skills');

    // Unrelated user skills are preserved in place — migration only removes
    // `gsd-*` dirs from the old location; non-gsd-* user dirs are untouched.
    const userSkill = path.join(codexHome, 'skills', 'custom-user-skill', 'SKILL.md');
    assert.equal(fs.existsSync(userSkill), true, 'unrelated user skill must survive the #2088 migration');
  });

  test('stores managed SessionStart update hook in hooks.json and removes inline gsd hook from config.toml', () => {
    const configToml = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "node /tmp/legacy/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml);

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => install(true, 'codex'));

    const parsedToml = parseTomlToObject(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    const tomlSessionStart = parsedToml.hooks?.SessionStart ?? [];
    const tomlCommands = tomlSessionStart.flatMap((entry) =>
      (Array.isArray(entry?.hooks) ? entry.hooks : []).map((hook) => hook.command).filter((cmd) => typeof cmd === 'string')
    );
    assert.equal(tomlCommands.some((cmd) => cmd.includes('gsd-check-update.js')), false);

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    const gsdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gsd-check-update'));

    assert.equal(gsdCommands.length, 1);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });

  test('uninstall removes managed SessionStart hook from hooks.json but preserves user hooks', () => {
    const hooksDir = path.join(codexHome, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// managed hook\n');
    const managedHookPath = path.join(codexHome, 'hooks', 'gsd-check-update.js').replace(/\\/g, '/');

    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: `node "${managedHookPath}"` },
            { type: 'command', command: 'node "/Users/example/bin/user-hook.js"' },
          ],
        },
      ],
    }, null, 2));

    withCodexHome(codexHome, () => uninstall(true, 'codex'));

    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    const sessionStartCommands = extractSessionStartCommandsFromHooksJson(hooksJson);
    // On Windows the managed hook is the .cmd shim path; on POSIX it is the .js node-runner command.
    // Either way the managed hook is gone after uninstall — only the user hook remains.
    const gsdCommands = sessionStartCommands.filter((cmd) => cmd.includes('gsd-check-update'));

    assert.equal(gsdCommands.length, 0);
    assert.equal(sessionStartCommands.includes('node "/Users/example/bin/user-hook.js"'), true);
  });
});
  });
}
