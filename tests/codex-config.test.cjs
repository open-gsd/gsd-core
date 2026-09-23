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
const { CLAUDE_AGENT_ALIASES } = require('../gsd-core/bin/lib/model-resolver.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
// #3241 — the intended new home for CLAUDE_AGENT_ALIASES + isAnthropicFlavoredModel
// (see .gsd/phase/feat-3241-codex-omit-model-by-default/40-design.md "The seam
// decision"). Neither export exists on model-catalog.cjs yet; requiring the
// module does not throw (it just has no such keys today), but calling
// isAnthropicFlavoredModel does — see the new describe block below.
const modelCatalog = require('../gsd-core/bin/lib/model-catalog.cjs');
const modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');

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
  getCodexSkillAdapterHeader,
  convertClaudeAgentToCodexAgent,
  convertClaudeCommandToCodexSkill,
  generateCodexAgentToml,
  _resetCodexWarningDedupeForTests,
  cleanupCodexSkillMetadataSidecars: _cleanupCodexSkillMetadataSidecars,
  generateCodexConfigBlock,
  stripGsdFromCodexConfig,
  migrateCodexHooksMapFormat,
  mergeCodexConfig,
  install,
  GSD_CODEX_MARKER,
  deriveCodexSandboxMode,
  // #3897 rung 3 (ADR-3473 §8.3, option 2 — HALT.md): anticipated new export
  // holding the 17 explicit read-only pins for roles whose tool contract would
  // otherwise derive workspace-write (16 measured by HALT.md + gsd-nyquist-auditor,
  // surfaced by the list-form parse fix). Does not exist on the current tree —
  // destructuring a non-existent key is `undefined`, not a throw, so requiring
  // this module still succeeds; every test below that touches it fails on its
  // own `typeof` guard instead.
  CODEX_SANDBOX_HOLDS,
  parseTomlToObject,
  validateCodexConfigSchema,
  uninstall: _uninstall,
  CODEX_EXTENDED_HOOK_EVENTS: _CODEX_EXTENDED_HOOK_EVENTS,
} = require('../bin/install.js');

const { resolveNodeRunner: _resolveNodeRunner } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { resolveInstallPlan } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
// #3897 fixup: deriveCodexSandboxMode's 2nd param is now the already-resolved
// `tools:` frontmatter VALUE, not raw agent content (codex-agent-toml.cjs no
// longer parses frontmatter at all — no third copy of that extraction).
const {
  extractFrontmatterAndBody,
  extractFrontmatterField,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
// #3897 list-form parse fix: the ONE shared `tools:`-value reader both
// sandbox-feeding production paths (`bin/install.js`'s `generateCodexAgentToml`
// and `agent-install-check.cts`'s `checkCodexSandboxPosture`) now route
// through — handles inline (`tools: Read, Write`) AND YAML block-list
// (`tools:` + indented `- Item` lines) form. Used below by `realAgentToolsRaw`
// so the test's own measurement of "what does this role's tool contract
// declare" cannot silently disagree with production (the exact generative-
// fix-divergence shape this fix closes).
const { extractToolsValue } = require('../gsd-core/bin/lib/codex-agent-toml.cjs');

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
function _codexSkillsRoot(codexHome) {
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

function countMatches(content, pattern) {
  return (content.match(pattern) || []).length;
}

function _assertNoDraftRootKeys(content) {
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


describe('getCodexSkillAdapterHeader', () => {
  test('contains all three sections', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('<codex_skill_adapter>'), 'has opening tag');
    assert.ok(result.includes('</codex_skill_adapter>'), 'has closing tag');
    assert.ok(result.includes('## A. Skill Invocation'), 'has section A');
    assert.ok(result.includes('## B. AskUserQuestion'), 'has section B');
    assert.ok(result.includes('## C. Task() → spawn_agent'), 'has section C');
  });

  test('includes correct invocation syntax', () => {
    const result = getCodexSkillAdapterHeader('gsd-plan-phase');
    assert.ok(result.includes('`$gsd-plan-phase`'), 'has $skillName invocation');
    assert.ok(result.includes('{{GSD_ARGS}}'), 'has GSD_ARGS variable');
  });

  test('section B maps AskUserQuestion parameters', () => {
    const result = getCodexSkillAdapterHeader('gsd-discuss-phase');
    assert.ok(result.includes('request_user_input'), 'maps to request_user_input');
    assert.ok(result.includes('header'), 'maps header parameter');
    assert.ok(result.includes('question'), 'maps question parameter');
    assert.ok(result.includes('label'), 'maps options label');
    assert.ok(result.includes('description'), 'maps options description');
    assert.ok(result.includes('multiSelect'), 'documents multiSelect workaround');
    assert.ok(result.includes('Execute mode'), 'documents Execute mode fallback');
  });

  test('section C maps Task to spawn_agent', () => {
    const result = getCodexSkillAdapterHeader('gsd-execute-phase');
    assert.ok(result.includes('spawn_agent'), 'maps to spawn_agent');
    assert.ok(result.includes('agent_type'), 'maps subagent_type to agent_type');
    // #4270: resolve-model exposes the portable field as `effort`; the Codex
    // adapter must fetch it and translate it to spawn_agent.reasoning_effort.
    assert.match(
      result,
      /query resolve-model <subagent_type> --pick effort/,
      'retrieves the unified effort for the dispatched role',
    );
    assert.match(
      result,
      /unified `effort` field maps to the Codex spawn argument\s+`reasoning_effort`/,
      'documents reasoning_effort transport',
    );
    assert.ok(result.includes('do not invent one-off effort literals'), 'keeps effort policy centralized');
    assert.ok(result.includes('fork_context'), 'documents fork_context default');
    // #3004: collaboration tool vocabulary must match Codex's actual schema.
    assert.ok(result.includes('wait_agent'), 'documents the real collaboration wait tool (wait_agent, not wait(ids))');
    assert.ok(!result.includes('wait(ids)'), 'must NOT contain the obsolete wait(ids) spelling');
    assert.ok(result.includes('functions.wait'), 'disambiguates from the unrelated exec-cell functions.wait tool');
    assert.ok(result.includes('task_name'), 'documents the required task_name field');
    assert.ok(result.includes('fork_turns'), 'documents the fork_turns parameter');
    assert.ok(result.includes('close_agent'), 'documents close_agent cleanup');
    assert.ok(result.includes('tool_search'), 'gates close_agent on tool visibility (schema detection)');
    assert.ok(result.includes('CHECKPOINT'), 'documents result markers');
  });
});

// ─── convertClaudeAgentToCodexAgent ─────────────────────────────────────────────

describe('convertClaudeAgentToCodexAgent', () => {
  test('adds codex_agent_role header and cleans frontmatter', () => {
    const input = `---
name: gsd-executor
description: Executes GSD plans with atomic commits
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

    const result = convertClaudeAgentToCodexAgent(input);

    // Frontmatter rebuilt with only name and description
    assert.ok(result.startsWith('---\n'), 'starts with frontmatter');
    assert.ok(result.includes('"gsd-executor"'), 'has quoted name');
    assert.ok(result.includes('"Executes GSD plans with atomic commits"'), 'has quoted description');
    assert.ok(!result.includes('color: yellow'), 'drops color field');
    // Tools should be in <codex_agent_role> but NOT in frontmatter
    const fmEnd = result.indexOf('---', 4);
    const frontmatterSection = result.substring(0, fmEnd);
    assert.ok(!frontmatterSection.includes('tools:'), 'drops tools from frontmatter');

    // Has codex_agent_role block
    assert.ok(result.includes('<codex_agent_role>'), 'has role header');
    assert.ok(result.includes('role: gsd-executor'), 'role matches agent name');
    assert.ok(result.includes('tools: Read, Write, Edit, Bash, Grep, Glob'), 'tools in role block');
    assert.ok(result.includes('purpose: Executes GSD plans with atomic commits'), 'purpose from description');
    assert.ok(result.includes('</codex_agent_role>'), 'has closing tag');

    // Body preserved
    assert.ok(result.includes('<role>'), 'body content preserved');
  });

  test('converts slash commands in body', () => {
    const input = `---
name: gsd-test
description: Test agent
tools: Read
---

Run /gsd:execute-phase to proceed.`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$gsd-execute-phase'), 'converts slash commands');
    assert.ok(!result.includes('/gsd:execute-phase'), 'original slash command removed');
  });

  test('handles content without frontmatter', () => {
    const input = 'Just some content without frontmatter.';
    const result = convertClaudeAgentToCodexAgent(input);
    assert.strictEqual(result, input, 'returns input unchanged');
  });

  test('replaces .claude paths with .codex paths (#1430)', () => {
    const input = `---
name: gsd-debugger
description: Debugs issues
tools: Read, Bash
---

INIT=$(node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state load)
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" commit "docs: resolve"`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(result.includes('$HOME/.codex/gsd-core/bin/gsd-tools.cjs'), 'replaces $HOME/.claude/ with $HOME/.codex/');
    assert.ok(!result.includes('$HOME/.claude/'), 'no .claude paths remain');
  });

  test('rewrites bare gsd-tools invocations to the Codex shim path', () => {
    const input = `---
name: gsd-planner
description: Plans phases
tools: Read, Bash
---

INIT=$(gsd-tools query init.plan-phase "\${PHASE}")
gsd-tools query state.load 2>/dev/null
if command -v gsd-tools >/dev/null 2>&1; then echo "path fallback"; fi
Use \`gsd-tools query history-digest\` for history.`;

    const result = convertClaudeAgentToCodexAgent(input);
    assert.ok(
      result.includes('INIT=$(node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query init.plan-phase'),
      'rewrites command substitution',
    );
    assert.ok(
      result.includes('node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query state.load'),
      'rewrites line-start command',
    );
    assert.ok(
      result.includes('`node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query history-digest`'),
      'rewrites inline command example',
    );
    assert.ok(result.includes('command -v gsd-tools'), 'keeps PATH resolver probe intact');
    assertNoCodexBareGsdToolsInvocation(result, 'converted Codex agent');
  });
});

// ─── Codex command prefix conversion ────────────────────────────────────────────

describe('Codex hyphen-style command prefix conversion', () => {
  test('adapter distinguishes an interim mailbox wakeup from a terminal child result', () => {
    const header = getCodexSkillAdapterHeader('gsd-test');

    assert.match(
      header,
      /mailbox wakeup, NOT a completion oracle/,
      'a wait completion must not be treated as an agent completion',
    );
    assert.match(
      header,
      /Only a FINAL_ANSWER or a terminal agent status\s+\(completed, failed, or cancelled\) ends the foreground handoff/,
      'only terminal evidence may release a foreground parent',
    );
    assert.match(
      header,
      /On an interim MESSAGE or any non-terminal status, do not report an outcome, send a\s+continuation, start parent work, or end the parent turn/,
      'progress mail must keep the parent in its wait loop',
    );
  });

  test('converts /gsd-command in workflow output to $gsd-command', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/gsd-discuss-phase 1 — gather context
/gsd-plan-phase 2 — create plan
/gsd-execute-phase 3 — run it`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-discuss-phase'), 'converts /gsd-discuss-phase');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts /gsd-plan-phase');
    assert.ok(result.includes('$gsd-execute-phase'), 'converts /gsd-execute-phase');
    assert.ok(!result.includes('/gsd-discuss-phase'), 'no /gsd-discuss-phase remains');
  });

  test('converts backtick-wrapped /gsd- commands', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

Run \`/gsd-plan-phase 1\` to plan.`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('$gsd-plan-phase'), 'converts backtick-wrapped command');
  });

  test('does not convert /gsd- in file paths', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" init`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(result.includes('gsd-tools.cjs'), 'gsd-tools.cjs preserved in path');
    assert.ok(!result.includes('$gsd-tools'), 'no $gsd-tools in file path');
  });

  test('rewrites bare gsd-tools commands in generated Codex skills', () => {
    const input = `---
name: gsd:quick
description: Quick task
---

\`\`\`bash
gsd-tools query frontmatter.get .planning/quick/example/SUMMARY.md status
INIT=$(gsd-tools query init.quick)
if command -v gsd-tools >/dev/null 2>&1; then echo ok; fi
\`\`\`

Status fields read via \`gsd-tools query frontmatter.get\`.`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-quick');
    assert.ok(
      result.includes('node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query frontmatter.get'),
      'rewrites line-start command in a shell block',
    );
    assert.ok(
      result.includes('INIT=$(node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query init.quick)'),
      'rewrites command substitution in a shell block',
    );
    assert.ok(
      result.includes('`node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query frontmatter.get`'),
      'rewrites inline command example',
    );
    assert.ok(result.includes('command -v gsd-tools'), 'keeps resolver probe intact');
    assertNoCodexBareGsdToolsInvocation(result, 'converted Codex skill');
  });

  test('removes /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

\`/clear\` then:

\`$gsd-plan-phase 1\``;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-plan-phase'), 'command preserved after /clear removal');
  });

  test('removes bare /clear then: for Codex', () => {
    const input = `---
name: gsd-test
description: Test
tools: Read
---

/clear then:
/gsd-execute-phase 2`;

    const result = convertClaudeCommandToCodexSkill(input, 'gsd-test');
    assert.ok(!result.includes('/clear'), 'no /clear remains');
    assert.ok(result.includes('$gsd-execute-phase'), 'command converted');
  });
});

// ─── generateCodexAgentToml ─────────────────────────────────────────────────────

describe('generateCodexAgentToml', () => {
  const sampleAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write, Edit
color: yellow
---

<role>You are an executor.</role>`;

  test('sets workspace-write for executor', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'has workspace-write');
  });

  test('sets read-only for plan-checker', () => {
    const checker = `---
name: gsd-plan-checker
description: Checks plans
tools: Read, Grep, Glob
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', checker);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'has read-only');
  });

  test('includes developer_instructions from body', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes("developer_instructions = '''"), 'has literal triple-quoted instructions');
    assert.ok(result.includes('<role>You are an executor.</role>'), 'body content in instructions');
    assert.ok(result.includes("'''"), 'has closing literal triple quotes');
  });

  test('includes required name and description fields', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('name = "gsd-executor"'), 'has name');
    assert.ok(result.includes('description = "Executes plans"'), 'has description');
  });

  test('falls back to generated description when frontmatter is missing fields', () => {
    const minimalAgent = `<role>You are an unknown agent.</role>`;
    const result = generateCodexAgentToml('gsd-unknown', minimalAgent);
    assert.ok(result.includes('name = "gsd-unknown"'), 'falls back to agent name');
    assert.ok(result.includes('description = "GSD agent gsd-unknown"'), 'falls back to synthetic description');
  });

  // #3897 CAUSE B fix: this used to assert the deleted name-based fallback
  // (an unknown agent NAME defaulted to read-only regardless of its tool
  // contract). Under derivation, identity no longer determines the sandbox —
  // the tool contract does (S6: "a new writing role gets the contract, not
  // the pin"). Split into the two rows the old single assertion conflated:
  // absence of a `tools:` grant (N8) vs. an unknown role that legitimately
  // declares a writing tool (S6).
  test('unknown agent with no tools: frontmatter derives read-only (N8: absence is not a grant)', () => {
    const noToolsAgent = `---
name: gsd-unknown
description: An unknown agent with no declared tools
---

<role>You are an unknown agent.</role>`;
    const result = generateCodexAgentToml('gsd-unknown', noToolsAgent);
    assert.ok(result.includes('sandbox_mode = "read-only"'), 'no tools: frontmatter -> read-only');
  });

  test('unknown agent declaring Write/Edit derives workspace-write (S6: the tool contract, not the pin, decides)', () => {
    const result = generateCodexAgentToml('gsd-unknown', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'declares Write/Edit -> workspace-write');
  });

  // ─── #2256: model_overrides support ───────────────────────────────────────

  test('emits model field when modelOverrides contains an entry for the agent (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(result.includes('model = "gpt-5.3-codex"'), 'model field must be present in TOML');
  });

  test('does not emit model field when modelOverrides is null (#2256)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null);
    assert.ok(!result.includes('model ='), 'model field must be absent when no override');
  });

  test('does not emit reasoning effort when Codex model is inherited (#838)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null);
    assert.ok(!result.includes('model ='), 'model field must be absent when Codex should inherit');
    assert.ok(
      !result.includes('model_reasoning_effort ='),
      'reasoning effort must stay absent when the model is inherited'
    );
  });

  test('emits reasoning effort when model override pins Codex model (#838)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(result.includes('model = "gpt-5.3-codex"'), 'model override must pin model');
    assert.ok(
      result.includes('model_reasoning_effort ='),
      'reasoning effort is safe to emit when GSD also pins model'
    );
  });

  test('omits model and reasoning effort when only the runtime resolver would have pinned one (#838, #3241)', () => {
    // #3241 flips this test: the runtime-resolver auto-embed block (D1) was
    // removed, so a resolver alone (no explicit model_overrides) no longer
    // pins a model at install time, and #838's model/effort coupling means
    // neither line survives.
    const runtimeResolver = { resolve: () => ({ model: 'gpt-5.5' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!result.includes('model = "gpt-5.5"'), 'runtime resolver alone must not pin model (#3241)');
    assert.ok(
      !result.includes('model_reasoning_effort ='),
      'reasoning effort must not survive an omitted resolver model (#838 coupling)'
    );
  });

  test('does not emit model field when modelOverrides has no entry for this agent (#2256)', () => {
    const overrides = { 'gsd-planner': 'gpt-5.4' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    assert.ok(!result.includes('model ='), 'model field must be absent for agents not in overrides');
  });

  test('model field appears before developer_instructions (#2256)', () => {
    const overrides = { 'gsd-executor': 'gpt-5.3-codex' };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, overrides);
    const modelIdx = result.indexOf('model = "gpt-5.3-codex"');
    const instrIdx = result.indexOf("developer_instructions = '''");
    assert.ok(modelIdx !== -1, 'model field present');
    assert.ok(instrIdx !== -1, 'developer_instructions present');
    assert.ok(modelIdx < instrIdx, 'model field must appear before developer_instructions');
  });

  // ─── #2310: never leak an Anthropic-flavored model into the Codex .toml ─────

  test('omits a bare GSD tier alias in model_overrides (Codex passive/session-only) (#2310)', () => {
    // ADR-1239: Codex is a passive/session-only model host. A tier alias cannot be
    // honored per-agent, so it is dropped and the agent inherits the session model (no 400).
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = /m.test(result), `alias "${alias}" must be omitted (no model pinned)`);
    }
  });

  test('never emits a bare Anthropic tier alias as the Codex model (#2310)', () => {
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = "(opus|sonnet|haiku|fable)"$/m.test(result), `must not emit model = "${alias}"`);
    }
  });

  test('drops a claude-* model_overrides id instead of leaking it into the Codex .toml (#2310)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'claude-sonnet-5' });
    assert.ok(!result.includes('claude-'), 'a claude-* id must never appear as the Codex model');
    // No runtime resolver → nothing to fall through to → no model line at all.
    assert.ok(!result.includes('model ='), 'unmappable Anthropic override falls through to Codex default (no model pinned)');
  });

  test('a dropped claude-* override no longer falls through to the runtime resolver (#2310, #3241)', () => {
    // #3241 (D1) removed the runtime-resolver fallback embed entirely, so a
    // dropped alias/claude-* override now has nothing left to fall through to
    // — it is simply omitted, same as the claude id never leaking.
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-terra' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'claude-opus-4-8' }, runtimeResolver);
    assert.ok(!result.includes('model = "gpt-5.6-terra"'), 'resolver fallback no longer fires (#3241 D1)');
    assert.ok(!result.includes('claude-'), 'claude id must not leak even with a resolver present');
  });

  test('final gate blocks an Anthropic model from the runtime-resolver path too (#2310)', () => {
    // Simulate a defaults.json runtime that does not match the codex install target:
    // the resolver hands back a Claude id, which must still never reach the Codex .toml.
    const runtimeResolver = { runtime: 'claude', resolve: () => ({ model: 'claude-sonnet-5' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!result.includes('claude-'), 'runtime-resolver Claude id must be gated out of the Codex .toml');
    assert.ok(!result.includes('model ='), 'no valid Codex model available → none pinned');
  });

  test('still emits a real Codex/OpenAI model_overrides id verbatim (#2310 preserves #2256)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'gpt-5.6-sol' });
    assert.ok(result.includes('model = "gpt-5.6-sol"'), 'a real gpt-* override must still pass through unchanged');
  });

  test('gates a provider-namespaced anthropic/claude-* model from the runtime-resolver path (#2310 review)', () => {
    // Catalog assigns anthropic/claude-* to opencode/hermes/kilo. A mixed-runtime config
    // (runtime: opencode) + Codex install resolves those; they must NOT reach the .toml.
    const runtimeResolver = { runtime: 'opencode', resolve: () => ({ model: 'anthropic/claude-opus-4-8' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!/claude/i.test(result.split('\n').find((l) => /^model = /.test(l)) || ''), 'no claude-bearing model may be emitted');
    assert.ok(!/^model = /m.test(result), 'anthropic/claude-* is gated out → no model pinned');
  });

  test('omits a provider-namespaced anthropic/claude-* model_overrides pin (#2310 review)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'anthropic/claude-sonnet-5' });
    assert.ok(!result.includes('claude'), 'anthropic/claude-* must be omitted, never emitted');
    assert.ok(!/^model = /m.test(result), 'no model pinned');
  });

  test('every canonical Claude tier alias is omitted (single-source guard, #2310 review)', () => {
    // Iterates the CANONICAL set so a future alias is covered automatically (no divergence).
    for (const alias of CLAUDE_AGENT_ALIASES) {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': alias });
      assert.ok(!/^model = /m.test(result), `canonical alias "${alias}" must be omitted`);
    }
  });

  test('drops the fable alias (Claude Agent alias with no Codex mapping) (#2310)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': 'fable' });
    assert.ok(!result.includes('model = "fable"'), 'fable must never be emitted as the Codex model');
    assert.ok(!result.includes('model ='), 'fable has no Codex mapping → dropped, no model pinned');
  });

  test('property: no model_overrides value ever yields an Anthropic-flavored Codex model (#2310)', () => {
    const anthropicish = fc.oneof(
      fc.constantFrom('opus', 'sonnet', 'haiku', 'fable'),
      fc.string().map((s) => `claude-${s}`),
      fc.string().map((s) => `anthropic/claude-${s}`),
      fc.string().map((s) => `us.anthropic.claude-${s}`),
      fc.string(),
    );
    fc.assert(fc.property(anthropicish, (v) => {
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': v });
      const m = result.split('\n').find((l) => /^model = /.test(l));
      if (!m) return true; // no model pinned is always safe
      return !/claude/i.test(m) && !/^model = "(opus|sonnet|haiku|fable)"$/.test(m);
    }), { numRuns: 400 });
  });

  // ─── #3241: omit the Codex per-agent model by default (resolver-only path) ────
  // Phase 1 removes the runtime-resolver auto-embed. These tests drive the
  // shipping default shape — runtime set + model_profile:"balanced" (mocked
  // here as a resolver object, matching the existing #2517/#838 tests above,
  // e.g. L514-522) — with NO model_overrides, and assert the model line (and
  // its coupled model_reasoning_effort, #838) are omitted.

  test('omits model and model_reasoning_effort when only the runtime resolver would have supplied one (#3241)', () => {
    // RED (pre-fix): today this resolver-only path still embeds the tier
    // model (see L514-522's "runtime resolver pins Codex model" test, which
    // asserts the opposite of this on purpose and is left untouched per the
    // Phase 1 rollout plan). Both assertions below fail against the current
    // tree: `model = "gpt-5.6-sol"` and `model_reasoning_effort = "high"`
    // are both present in `result` today.
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-sol' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!/^model = /m.test(result),
      'a resolver-only tier model must not be embedded by default (#3241)');
    assert.ok(!result.includes('model_reasoning_effort ='),
      'reasoning effort must not survive an omitted resolver model (#838 coupling)');
  });

  test('resolver is null (inherit profile or no runtime configured) emits no model and no warning (#3241)', (t) => {
    // Regression guard — PASSES today already: readGsdRuntimeProfileResolver
    // already returns null for both "no runtime" and model_profile:"inherit"
    // (bin/install.js:1632, :1635), and generateCodexAgentToml already omits
    // the model when runtimeResolver is null. Nothing in Phase 1 touches this
    // branch; this test exists to prove it keeps holding after the fix lands.
    const origWrite = process.stderr.write;
    const stderrChunks = [];
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = origWrite; });
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, null);
    assert.ok(!/^model = /m.test(result), 'no model when the resolver is null');
    assert.strictEqual(stderrChunks.join(''), '', 'inherit/no-runtime users must never be warned — nothing was lost');
  });

  test('resolver present but resolve() yields nothing emits no model and no warning (#3241)', (t) => {
    // Regression guard — PASSES today already: entry?.model is undefined when
    // resolve() returns null, so pinnedModel stays null and no warning branch
    // is reachable in current code. Nothing was lost, so nothing should warn,
    // before or after the fix (negative-space row in 40-design.md).
    const origWrite = process.stderr.write;
    const stderrChunks = [];
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = origWrite; });
    const runtimeResolver = { runtime: 'codex', resolve: () => null };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!/^model = /m.test(result), 'no model when resolve() yields nothing');
    assert.strictEqual(stderrChunks.join(''), '', 'a resolver that would not have pinned anything must never warn');
  });

  test('empty-string and whitespace-only model_overrides are not pins and not warnings (#3241)', (t) => {
    // '' — regression guard, PASSES today: '' is falsy, so the pin branch is
    // never entered at all (no pin, no warning either old or new).
    //
    // '   ' (whitespace-only) — RED (pre-fix, live defect, fixed in this
    // phase per maintainer direction): a whitespace-only override is a
    // truthy JS string, is not Anthropic-flavored per `_isAnthropicFlavoredModel`,
    // and is CURRENTLY pinned verbatim (`model = "   "`) with no guard —
    // the same class of bug the #2310 guard exists to stop (a non-model
    // value reaching the .toml and 400-ing the Codex agent). Must be
    // silently dropped, matching how '' already behaves — NOT routed through
    // `_warnCodexModelOverrideDropped` (that warning's "is not a valid Codex
    // model (Anthropic alias/id)" text would misdescribe a blank field), so
    // no warning of any kind is expected for it either.
    const origWrite = process.stderr.write;
    const stderrChunks = [];
    process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = origWrite; });
    const emptyResult = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': '' });
    const whitespaceResult = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': '   ' });
    assert.ok(!/^model = /m.test(emptyResult), 'empty-string override must not be pinned');
    assert.ok(!/^model = /m.test(whitespaceResult), 'whitespace-only override must not be pinned (#3241 fix)');
    assert.strictEqual(stderrChunks.join(''), '', 'empty-string/whitespace overrides must never warn');
  });

  test('non-string model_overrides values are ignored without throwing (#3241)', () => {
    // Regression guard — PASSES today already: none of these ever reach the
    // string-pin branch (`typeof rawModelOverride === 'string'` gates it), so
    // no value here is ever emitted as `model =`, and none of them throw.
    // Some truthy non-string values (42, {}, true, []) DO hit the existing
    // `_warnCodexModelOverrideDropped` warn branch today — that is pre-2310
    // behavior this phase does not touch, so no assertion is made on warning
    // presence/absence here, only "no pin" and "no crash" per the matrix.
    const hostileValues = [42, {}, null, true, [], 0, NaN];
    for (const value of hostileValues) {
      assert.doesNotThrow(() => {
        const result = generateCodexAgentToml('gsd-executor', sampleAgent, { 'gsd-executor': value });
        assert.ok(!/^model = /m.test(result), `non-string override ${JSON.stringify(value)} must not be pinned`);
      }, `non-string override ${JSON.stringify(value)} must not throw`);
    }
  });

  // 50-test-matrix.md row 15 (oversized warning value truncated at 64 chars)
  // is deliberately NOT covered here. Maintainer-confirmed pinned wording
  // (see the describe block below) interpolates no user-controlled value —
  // no agent name, no model string — so there is nothing in the message that
  // could ever exhibit truncation. A test asserting truncation against a
  // message with no interpolated value would be vacuous by construction.

  test('light-tier service_tier/model_verbosity survive independent of whether a model is pinned (#3241, #774 decoupling guard)', () => {
    // Regression guard — PASSES today already: the light-tier emission block
    // (bin/install.js ~L4198-4203) reads AGENT_DEFAULT_TIERS unconditionally
    // and never inspects pinnedModel/hasPinnedModel. This test exists to
    // catch a FUTURE implementation that wrongly couples these fields to
    // hasPinnedModel while implementing #3241 — if that coupling is ever
    // introduced, this is the test that turns red. It is not expected to be
    // red before the #3241 fix lands, and per 50-test-matrix.md's own
    // "Red-before-green" note this is the row most likely to be accidentally
    // vacuous — flagged explicitly here rather than mis-classified.
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-sol' }) };
    const lightAgent = `---
name: gsd-plan-checker
description: Checks plans quickly
tools: Read, Grep
---

<role>You check plans.</role>`;
    const lightResult = generateCodexAgentToml('gsd-plan-checker', lightAgent, null, runtimeResolver);
    assert.ok(lightResult.includes('service_tier = "flex"'), 'service_tier must not be coupled to whether a model is pinned');
    assert.ok(lightResult.includes('model_verbosity = "low"'), 'model_verbosity must not be coupled to whether a model is pinned');

    // Other direction: a non-light agent with no model at all must still gain
    // neither field (duplicates the existing #774 coverage at L647-652
    // intentionally — 50-test-matrix.md row 18 folds this into row 17 as the
    // same independence guard, viewed from the opposite direction).
    const standardResult = generateCodexAgentToml('gsd-executor', sampleAgent, null, null);
    assert.ok(!standardResult.includes('service_tier'), 'standard-tier agent must not gain service_tier just because no model is pinned');
    assert.ok(!standardResult.includes('model_verbosity'), 'standard-tier agent must not gain model_verbosity just because no model is pinned');
  });

  // ─── #3241 review: gate the deprecation notice on "would have been EMBEDDED",
  // not "would have been returned" ────────────────────────────────────────────
  // The resolver-would-have-supplied-a-model check above (L652-665) doesn't
  // inspect stderr, so it couldn't catch this: the notice must not fire when
  // the would-be resolver model would ALSO have been rejected by the #2310
  // Anthropic-flavored gate (L4192) pre-Phase-1 — that user never had the pin
  // in the first place, so telling them to set model_overrides is false. The
  // notice's one-time dedupe is a module-level boolean shared across every
  // test in this file (an earlier test in this describe block, e.g.
  // L652-665, may have already latched it), so each test here resets it via
  // the documented test seam (_resetCodexWarningDedupeForTests) instead of
  // busting require.cache — a cache bust would create a second module
  // instance and break every other test in this file that assumes a single
  // shared instance.

  function captureStderr(t) {
    const origWrite = process.stderr.write;
    const chunks = [];
    process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
    t.after(() => { process.stderr.write = origWrite; });
    return () => chunks.join('').split(/\r?\n/).filter((l) => l.length > 0);
  }

  test('no deprecation notice when the resolver would only have produced an Anthropic-flavored model (#3241 review — defect fix)', (t) => {
    _resetCodexWarningDedupeForTests();
    const getLines = captureStderr(t);
    // Mixed-runtime config (runtime: opencode) resolving against a Codex
    // install target — the #2310 gate (bin/install.js:4192) rejects this
    // model BEFORE Phase 1 too, so this user never had the pin. Bare alias
    // form covered too, since both routes hit the same gate.
    for (const model of ['anthropic/claude-opus-4-8', 'sonnet']) {
      const runtimeResolver = { runtime: 'opencode', resolve: () => ({ model }) };
      const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
      assert.ok(!/^model = /m.test(result), `no model pinned for would-be resolver model "${model}"`);
    }
    const noticeLines = getLines().filter((l) => l.startsWith('gsd: notice — '));
    assert.strictEqual(noticeLines.length, 0,
      'no notice: the resolver model would never have survived the #2310 gate pre-Phase-1 either, so nothing was lost');
  });

  test('deprecation notice still fires when the resolver would have produced a legal Codex model (#3241 review)', (t) => {
    _resetCodexWarningDedupeForTests();
    const getLines = captureStderr(t);
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-sol' }) };
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, runtimeResolver);
    assert.ok(!/^model = /m.test(result), 'no model pinned by default (#3241 D1)');
    const noticeLines = getLines().filter((l) => l.startsWith('gsd: notice — '));
    assert.strictEqual(noticeLines.length, 1,
      'exactly one notice: a legal gpt-5.6-sol model would have been embedded pre-Phase-1, and now is not — the fix must not over-correct into silence');
  });

  test('both the override-dropped warning and the resolver-omitted notice fire for an Anthropic override plus a legal resolver model (#3241 review — intentional, do NOT collapse to one message)', (t) => {
    // NOT a defect. Two distinct true facts, two distinct prefixes:
    // - model_overrides:"sonnet" is Anthropic-flavored → dropped pre-Phase-1
    //   too (#2310 gate on the override path) → `gsd: warning — ` fires.
    // - With the override dropped, execution falls through to the runtime
    //   resolver, which WOULD have supplied "gpt-5.6-sol" (a legal Codex
    //   model) and that pin WOULD have been embedded pre-Phase-1 → this user
    //   genuinely lost a pin → `gsd: notice — ` fires too.
    // A future reader must not "fix" this down to one message.
    _resetCodexWarningDedupeForTests();
    const getLines = captureStderr(t);
    const runtimeResolver = { runtime: 'codex', resolve: () => ({ model: 'gpt-5.6-sol' }) };
    const result = generateCodexAgentToml(
      'gsd-executor', sampleAgent, { 'gsd-executor': 'sonnet' }, runtimeResolver,
    );
    assert.ok(!/^model = /m.test(result), 'no model pinned (Anthropic override dropped, resolver model not auto-embedded)');
    const lines = getLines();
    const warningLines = lines.filter((l) => l.startsWith('gsd: warning — '));
    const noticeLines = lines.filter((l) => l.startsWith('gsd: notice — '));
    assert.strictEqual(warningLines.length, 1, 'exactly one warning: the Anthropic override was dropped');
    assert.strictEqual(noticeLines.length, 1, 'exactly one notice: the legal resolver model would have been embedded and now is not');
  });

  // ─── #774: service_tier / model_verbosity for light-tier agents ───────────────

  test('emits service_tier="flex" and model_verbosity="low" for light-tier agents (#774)', () => {
    // gsd-plan-checker has routingTier:"light" in model-catalog.json
    const lightAgent = `---
name: gsd-plan-checker
description: Checks plans quickly
tools: Read, Grep
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', lightAgent);
    assert.ok(result.includes('service_tier = "flex"'), 'light-tier agent must have service_tier = "flex"');
    assert.ok(result.includes('model_verbosity = "low"'), 'light-tier agent must have model_verbosity = "low"');
  });

  test('does not emit service_tier or model_verbosity for standard-tier agents (#774)', () => {
    // gsd-executor has routingTier:"standard" in model-catalog.json
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(!result.includes('service_tier'), 'standard-tier agent must not have service_tier');
    assert.ok(!result.includes('model_verbosity'), 'standard-tier agent must not have model_verbosity');
  });

  test('does not emit service_tier or model_verbosity for heavy-tier agents (#774)', () => {
    // gsd-planner has routingTier:"heavy" in model-catalog.json
    const heavyAgent = `---
name: gsd-planner
description: Creates plans
tools: Read, Write, Edit
---

<role>You plan.</role>`;
    const result = generateCodexAgentToml('gsd-planner', heavyAgent);
    assert.ok(!result.includes('service_tier'), 'heavy-tier agent must not have service_tier');
    assert.ok(!result.includes('model_verbosity'), 'heavy-tier agent must not have model_verbosity');
  });

  test('service_tier and model_verbosity appear before developer_instructions (#774)', () => {
    const lightAgent = `---
name: gsd-plan-checker
description: Checks plans
---

<role>You check plans.</role>`;
    const result = generateCodexAgentToml('gsd-plan-checker', lightAgent);
    const stIdx = result.indexOf('service_tier = "flex"');
    const mvIdx = result.indexOf('model_verbosity = "low"');
    const instrIdx = result.indexOf("developer_instructions = '''");
    assert.ok(stIdx !== -1, 'service_tier present');
    assert.ok(mvIdx !== -1, 'model_verbosity present');
    assert.ok(instrIdx !== -1, 'developer_instructions present');
    assert.ok(stIdx < instrIdx, 'service_tier must appear before developer_instructions');
    assert.ok(mvIdx < instrIdx, 'model_verbosity must appear before developer_instructions');
  });

  test('emitted TOML is parseable and contains correct field values for light-tier agents (#774)', () => {
    const lightAgent = `---
name: gsd-codebase-mapper
description: Maps the codebase
---

<role>You map the codebase.</role>`;
    const toml = generateCodexAgentToml('gsd-codebase-mapper', lightAgent);
    const parsed = parseTomlToObject(toml);
    assert.strictEqual(parsed.service_tier, 'flex', 'service_tier must parse to "flex"');
    assert.strictEqual(parsed.model_verbosity, 'low', 'model_verbosity must parse to "low"');
  });
});

// ─── #3897 rung 3 (ADR-3473 §8.3, HALT.md option 2): sandbox_mode derives from
// the tool contract, with 17 widening roles held at read-only ────────────────
//
// Spec: .gsd/phase/feat-3897-adr3473-83-rungs/{40-design,50-test-matrix}.md,
// rows S1-S9 / T20-T30. Measured against `next` @ ad6abc896 (HALT.md):
// deriving `workspace-write` iff an agent's frontmatter `tools:` declares
// `Write` or `Edit` reproduces all 11 CODEX_AGENT_SANDBOX map entries exactly,
// and would additionally widen 16 fallback roles that the map never covered.
// HALT.md's 16 was measured against a `tools:`-VALUE reader that only handled
// inline form; the #3897 list-form parse fix corrected `gsd-nyquist-auditor`'s
// YAML block-list `tools:` (previously misread as `"- Read"`, no Write/Edit
// found), which genuinely derives `workspace-write` and adds a 17th widening
// role. `CODEX_SANDBOX_HOLDS` (destructured above; `undefined` on the current
// tree) is this rung's pin list for those 17 — every row below that depends
// on it fails on its own `typeof` guard until it lands.
//
// Deriving-from-real-content is deliberate for T20/T21/T26/T27/T30: a
// synthetic `tools:` fixture cannot prove the CURRENT tree's byte output is
// preserved, only that the derivation LOGIC agrees with a made-up example.

// #3897 rung 3 — bin/install.js's `CODEX_AGENT_SANDBOX` map is DELETED
// (ADR-3473 §8.3): HALT.md measured that deriving `workspace-write` iff an
// agent's `tools:` frontmatter declares Write/Edit reproduces every one of
// these 11 entries exactly, with zero disagreements, making the hand-
// maintained map fully redundant. This literal is the pre-#3897
// `CODEX_AGENT_SANDBOX` contents, preserved here as a regression baseline —
// the only surviving copy of these 11 role -> mode pairs. T21 below and the
// `CODEX_AGENT_SANDBOX (deleted map, derivation regression baseline)` describe
// block both reference this ONE literal rather than duplicating it.
const PRE_3897_CODEX_AGENT_SANDBOX = {
  'gsd-executor': 'workspace-write',
  'gsd-planner': 'workspace-write',
  'gsd-phase-researcher': 'workspace-write',
  'gsd-project-researcher': 'workspace-write',
  'gsd-research-synthesizer': 'workspace-write',
  'gsd-verifier': 'workspace-write',
  'gsd-codebase-mapper': 'workspace-write',
  'gsd-roadmapper': 'workspace-write',
  'gsd-debugger': 'workspace-write',
  'gsd-plan-checker': 'read-only',
  'gsd-integration-checker': 'read-only',
};

describe('#3897 rung 3: sandbox_mode derivation and the hold list', () => {
  const AGENTS_DIR = path.join(__dirname, '..', 'agents');

  // #3897 rung 4 (isolated correctness review, MINOR finding 6): T20/N6 used
  // to iterate `Object.keys(EXPECTED_SANDBOX_BY_ROLE)` and then pin
  // `assert.equal(checked, 35)` — that pins the FIXTURE, not the roster, so a
  // 36th agent added to `agents/` would be silently unchecked by the entire
  // rung-3 block instead of failing loudly. Driven from the real roster
  // instead; a dedicated parity test below fails loudly, naming any file
  // present in one set and not the other, the moment the two diverge.
  // #4407: .compact.md variant siblings carry byte-identical `tools:`
  // frontmatter to their canonical agent (verified mechanically elsewhere —
  // see tests/agent-skills-compact-variant.test.cjs), so deriveCodexSandboxMode
  // produces the same, correct sandbox_mode for both — confirmed directly
  // against generateCodexAgentToml, not assumed. Excluded from this roster so
  // EXPECTED_SANDBOX_BY_ROLE doesn't need a redundant second entry per agent
  // that could only ever match its canonical sibling's value or be a bug.
  const AGENT_ROSTER_ROLES = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md') && !f.endsWith('.compact.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();

  function realAgentToolsRaw(agentName) {
    const content = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');
    // #3897 list-form parse fix: route through the SAME shared extractor
    // production uses, rather than a naive single-line regex here — a
    // second, test-local reimplementation of "read the tools: value" is
    // exactly the generative-fix-divergence shape that let this test's own
    // `measuredWideningRoles` silently miss `gsd-nyquist-auditor` (YAML
    // list-form `tools:`) before this fix.
    return extractToolsValue(content) ?? '';
  }

  // #3897 rung 4 (isolated correctness review, NIT finding 7): this used to
  // be a SEPARATE, simpler reimplementation of the real, private
  // `_codexToolsDeclareWriteOrEdit` (codex-agent-toml.cts) — a naive
  // comma-split-and-includes check that does not handle the real predicate's
  // "except" negation form (F5). That is exactly the generative-fix-
  // divergence shape CLAUDE.md warns about: a future change to the real
  // predicate this copy does not mirror would silently disagree with it
  // forever. `_codexToolsDeclareWriteOrEdit` is intentionally not exported
  // (module-internal), so rather than reimplementing it a second time, this
  // delegates to the REAL implementation through the public
  // `deriveCodexSandboxMode`, pinned to an identity guaranteed to never be
  // held or "suspicious" (F3) — with no hold in play,
  // `deriveCodexSandboxMode(identity, toolsRaw) === 'workspace-write'` IS
  // `_codexToolsDeclareWriteOrEdit(toolsRaw)`, byte for byte, because there is
  // no second copy left to drift.
  const PARITY_PROBE_IDENTITY = 'zzz-parity-probe-never-a-real-or-held-role';
  function declaresWriteOrEdit(toolsRaw) {
    return deriveCodexSandboxMode(PARITY_PROBE_IDENTITY, toolsRaw) === 'workspace-write';
  }

  test('sanity: the parity-probe identity used by declaresWriteOrEdit is never itself held or suspicious', () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(CODEX_SANDBOX_HOLDS, PARITY_PROBE_IDENTITY),
      false,
      'the probe identity must not collide with a real hold, or every T20/T21/T24 verdict derived from it would be silently wrong',
    );
    assert.equal(
      deriveCodexSandboxMode(PARITY_PROBE_IDENTITY, 'Read, Write, Edit'),
      'workspace-write',
      'sanity: an unheld identity that declares Write/Edit must derive workspace-write',
    );
  });

  // T20 (LOAD-BEARING, N6): frozen fixture of TODAY's real, per-role emitted
  // sandbox_mode for all 35 roles in agents/ — captured from the CURRENT build
  // by running the REAL generateCodexAgentToml against the REAL agent .md
  // content (never a synthetic fixture) and committed here. This is the
  // safety net for the refactor: it is true today (nothing has changed yet)
  // and MUST remain true, per role, after sandbox_mode moves from the map to a
  // derivation — an aggregate "35 roles emitted" count would pass even if one
  // role silently widened; asserting per role (one test per role, mirroring
  // codex-agent-toml.test.cjs's A14 round-trip pattern) does not let that hide.
  const EXPECTED_SANDBOX_BY_ROLE = {
    'gsd-advisor-researcher': 'read-only',
    'gsd-ai-researcher': 'workspace-write',
    'gsd-assumptions-analyzer': 'read-only',
    'gsd-code-fixer': 'workspace-write',
    'gsd-code-reviewer': 'workspace-write',
    'gsd-codebase-mapper': 'workspace-write',
    'gsd-debug-session-manager': 'workspace-write',
    'gsd-debugger': 'workspace-write',
    'gsd-doc-classifier': 'workspace-write',
    'gsd-doc-synthesizer': 'workspace-write',
    'gsd-doc-verifier': 'workspace-write',
    'gsd-doc-writer': 'workspace-write',
    'gsd-dom-verifier': 'workspace-write',
    'gsd-domain-researcher': 'workspace-write',
    'gsd-eval-auditor': 'workspace-write',
    'gsd-eval-planner': 'workspace-write',
    'gsd-executor': 'workspace-write',
    'gsd-framework-selector': 'read-only',
    'gsd-integration-checker': 'read-only',
    'gsd-intel-updater': 'workspace-write',
    'gsd-mempalace-curator': 'read-only',
    'gsd-nyquist-auditor': 'workspace-write',
    'gsd-pattern-mapper': 'workspace-write',
    'gsd-phase-researcher': 'workspace-write',
    'gsd-plan-checker': 'read-only',
    'gsd-planner': 'workspace-write',
    'gsd-project-researcher': 'workspace-write',
    'gsd-research-synthesizer': 'workspace-write',
    'gsd-roadmapper': 'workspace-write',
    'gsd-security-auditor': 'read-only',
    'gsd-ui-auditor': 'workspace-write',
    'gsd-ui-checker': 'read-only',
    'gsd-ui-researcher': 'workspace-write',
    'gsd-user-profiler': 'read-only',
    'gsd-verifier': 'workspace-write',
  };

  // The 17 roles that widen: declare Write/Edit, not in the pre-#3897
  // CODEX_AGENT_SANDBOX map (now deleted; PRE_3897_CODEX_AGENT_SANDBOX above
  // is the surviving baseline of its contents), so today's `|| 'read-only'`
  // fallback under-grants them (16 measured by HALT.md + gsd-nyquist-auditor,
  // whose YAML block-list `tools:` the pre-fix single-line reader misread as
  // `"- Read"`, hiding its Write/Edit declaration). Computed here from the REAL
  // agents/*.md tools frontmatter and that baseline — never hand-copied from
  // HALT.md's prose — so this list cannot silently drift from what agents/
  // actually declares (T30: "derived, not a second hardcoded copy").
  const measuredWideningRoles = Object.keys(EXPECTED_SANDBOX_BY_ROLE).filter((role) => {
    const declaresWrite = declaresWriteOrEdit(realAgentToolsRaw(role));
    const inOldMap = Object.prototype.hasOwnProperty.call(PRE_3897_CODEX_AGENT_SANDBOX, role);
    return declaresWrite && !inOldMap;
  });

  // #3897 rung 4 (isolated correctness review, MINOR finding 6): the roster
  // and the expectation table must cover EXACTLY the same set of roles — a
  // role present in one and not the other fails loudly here, by name,
  // instead of being silently unchecked by the whole rung-3 block.
  test('T20 roster parity: EXPECTED_SANDBOX_BY_ROLE covers exactly the real agents/ roster, no more, no fewer', () => {
    const expectedRoles = Object.keys(EXPECTED_SANDBOX_BY_ROLE).sort();
    const inRosterNotExpected = AGENT_ROSTER_ROLES.filter((r) => !expectedRoles.includes(r));
    const inExpectedNotRoster = expectedRoles.filter((r) => !AGENT_ROSTER_ROLES.includes(r));
    assert.deepEqual(
      inRosterNotExpected,
      [],
      `agents/ contains role(s) with no EXPECTED_SANDBOX_BY_ROLE entry: ${JSON.stringify(inRosterNotExpected)} — add them or this rung's coverage silently skips them`,
    );
    assert.deepEqual(
      inExpectedNotRoster,
      [],
      `EXPECTED_SANDBOX_BY_ROLE names role(s) no longer present in agents/: ${JSON.stringify(inExpectedNotRoster)} — remove the stale entry`,
    );
  });

  for (const role of AGENT_ROSTER_ROLES) {
    test(`T20 everyRoleEmitsTheSameSandboxAsBefore: ${role} emits sandbox_mode="${EXPECTED_SANDBOX_BY_ROLE[role]}" byte-identically`, () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(EXPECTED_SANDBOX_BY_ROLE, role),
        `${role} exists in agents/ but has no EXPECTED_SANDBOX_BY_ROLE entry — see the roster-parity test above`,
      );
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
      const toml = generateCodexAgentToml(role, content);
      const match = toml.match(/^sandbox_mode = "([^"]+)"$/m);
      assert.ok(match, `${role}'s emitted TOML must contain a sandbox_mode line`);
      assert.equal(
        match[1],
        EXPECTED_SANDBOX_BY_ROLE[role],
        `${role} must emit the SAME sandbox_mode after the derivation refactor lands — a per-role regression, not an aggregate count`,
      );
    });
  }

  test('T30 holdListShrunkToZero: CODEX_SANDBOX_HOLDS is empty and every measured widening role derives workspace-write (#4770)', () => {
    // #4770 lift: the hold's recorded reopen condition (official OpenAI docs
    // establishing sandbox_mode as enforced) is satisfied, so the list shrank
    // to zero per its own ADR-3473 §8.3 shrink-only invariant. The formerly
    // held roles are exactly measuredWideningRoles — this test now guards the
    // LIFT: the map stays empty (no re-hold without a new recorded decision)
    // and every one of those roles derives workspace-write from its own
    // tools: contract.
    assert.equal(
      typeof CODEX_SANDBOX_HOLDS,
      'object',
      'install.js must export CODEX_SANDBOX_HOLDS — the (now empty) hold list shape is kept for a future re-hold',
    );
    assert.deepEqual(
      Object.keys(CODEX_SANDBOX_HOLDS).sort(),
      [],
      'CODEX_SANDBOX_HOLDS must be empty after the #4770 lift — a re-hold requires a new recorded decision',
    );
    assert.equal(measuredWideningRoles.length, 17, 'sanity: 17 widening roles against the current agents/ tree');
    for (const role of measuredWideningRoles) {
      assert.equal(
        EXPECTED_SANDBOX_BY_ROLE[role],
        'workspace-write',
        '#4770: formerly-held role ' + role + ' must derive workspace-write from its own tool contract',
      );
    }
  });

  test('T21 mappedRolesDeriveToTheirFormerValue: every former CODEX_AGENT_SANDBOX entry (11) derives to the identical value from its real tool contract', () => {
    for (const [role, formerValue] of Object.entries(PRE_3897_CODEX_AGENT_SANDBOX)) {
      const derivesWorkspaceWrite = declaresWriteOrEdit(realAgentToolsRaw(role));
      const derived = derivesWorkspaceWrite ? 'workspace-write' : 'read-only';
      assert.equal(
        derived,
        formerValue,
        `${role}: the tool-contract derivation must reproduce the former map value exactly (HALT.md: zero disagreements across all 11)`,
      );
    }
    assert.equal(Object.keys(PRE_3897_CODEX_AGENT_SANDBOX).length, 11);
  });

  test('T22 nonWritingFallbackRoleDerivesReadOnly: a fallback role declaring neither Write nor Edit derives read-only (S2)', () => {
    const role = 'gsd-user-profiler'; // tools: Read (no Write/Edit), never in the map
    assert.equal(Object.prototype.hasOwnProperty.call(PRE_3897_CODEX_AGENT_SANDBOX, role), false);
    assert.equal(declaresWriteOrEdit(realAgentToolsRaw(role)), false);
    const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
    const toml = generateCodexAgentToml(role, content);
    assert.ok(toml.includes('sandbox_mode = "read-only"'));
  });

  test('T23 formerlyHeldRoleNowDerivesWorkspaceWrite: the #4770 lift releases gsd-doc-writer to its own tool contract', () => {
    assert.equal(typeof CODEX_SANDBOX_HOLDS, 'object', 'CODEX_SANDBOX_HOLDS does not exist yet');
    const role = 'gsd-doc-writer'; // declares Write+Edit; one of HALT.md's 16
    assert.ok(declaresWriteOrEdit(realAgentToolsRaw(role)), 'sanity: this role must actually declare a writing tool');
    assert.ok(!Object.prototype.hasOwnProperty.call(CODEX_SANDBOX_HOLDS, role), `${role} must no longer be a hold entry after the #4770 lift`);
    const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
    const toml = generateCodexAgentToml(role, content);
    assert.ok(toml.includes('sandbox_mode = "workspace-write"'), 'the role must now derive workspace-write from its own contract (#4770)');
  });

  test('T24 staleHoldFailsRatherThanBeingHonored: a hold whose role no longer derives broader must FAIL, naming the role (S4) — empty after #4770', () => {
    assert.equal(
      typeof CODEX_SANDBOX_HOLDS,
      'object',
      'CODEX_SANDBOX_HOLDS does not exist yet, so there is nothing to validate for staleness',
    );
    assert.equal(Object.keys(CODEX_SANDBOX_HOLDS).length, 0, '#4770 lifted every hold; the sweep below stays as the re-growth guard');
    // Every REAL hold entry, right now, must still derive workspace-write from
    // the tool contract. A hold for a role whose tools no longer declare
    // Write/Edit is exactly the staleness this row exists to catch; without
    // this assertion the hold list is honored unconditionally forever, which
    // is the hand-maintained-subset-map defect this rung deletes, rebuilt one
    // list later (the ledger claim HALT.md makes).
    for (const role of Object.keys(CODEX_SANDBOX_HOLDS)) {
      assert.ok(
        declaresWriteOrEdit(realAgentToolsRaw(role)),
        `stale hold: ${role} is pinned to read-only but its CURRENT tool contract no longer declares Write/Edit — this hold must fail validation, not be silently honored`,
      );
    }
  });

  test('T25 holdForUnknownRoleFails: a hold naming a role that no longer exists in agents/ must FAIL (S5) — empty after #4770', () => {
    assert.equal(
      typeof CODEX_SANDBOX_HOLDS,
      'object',
      'CODEX_SANDBOX_HOLDS does not exist yet, so there is nothing to validate for an unknown role',
    );
    assert.equal(Object.keys(CODEX_SANDBOX_HOLDS).length, 0, '#4770 lifted every hold; the sweep below stays as the re-growth guard');
    for (const role of Object.keys(CODEX_SANDBOX_HOLDS)) {
      assert.ok(
        fs.existsSync(path.join(AGENTS_DIR, `${role}.md`)),
        `stale hold: ${role} is pinned but no longer exists in agents/ — this hold must fail validation`,
      );
    }
  });

  test('T26 newWritingRoleGetsTheContractNotThePin: a brand-new agent declaring Write, with no hold, derives workspace-write (S6) — RED today, falls back to read-only (#2540)', () => {
    const newAgentContent = `---
name: gsd-totally-new-agent
description: A brand-new writing agent that has never been in the map or a hold
tools: Read, Write, Bash
---

<role>You are a brand-new agent.</role>`;
    // Today: CODEX_AGENT_SANDBOX['gsd-totally-new-agent'] is undefined, so the
    // `|| 'read-only'` fallback silently under-grants it — the exact defect
    // §8.3 exists to fix (24 of 35 roles fell through this fallback).
    const toml = generateCodexAgentToml('gsd-totally-new-agent', newAgentContent);
    assert.ok(
      toml.includes('sandbox_mode = "workspace-write"'),
      'a new agent declaring Write, absent from both the map and any hold, must derive workspace-write from its own tool contract — not silently fall back to read-only',
    );
  });

  test('T27 absentToolContractIsNotAGrant: an agent with no tools: frontmatter at all derives read-only (N8/S7)', () => {
    const noToolsContent = `---
name: gsd-no-contract-agent
description: Declares no tools frontmatter key at all
---

<role>You have no declared tools.</role>`;
    const toml = generateCodexAgentToml('gsd-no-contract-agent', noToolsContent);
    assert.ok(
      toml.includes('sandbox_mode = "read-only"'),
      'absence of a tools: contract must never be read as a grant of workspace-write',
    );
  });

  // #3897 security review follow-up (post-merge blocker): `bin/install.js`'s
  // Codex install loop used to key the CODEX_SANDBOX_HOLDS lookup off the
  // agent's OWN frontmatter `name:` field (`extractFrontmatterField(frontmatter,
  // 'name') || file.replace('.md', '')`) rather than its filename — so editing,
  // or merely recasing, a held role's `name:` field (same file, same tool
  // contract) silently derived `workspace-write` instead of the pinned
  // `read-only`. Unlike the deleted CODEX_AGENT_SANDBOX map (an ALLOWLIST whose
  // unmatched-key fallback was `read-only`, i.e. safe), CODEX_SANDBOX_HOLDS is a
  // SUBTRACTION from a derivation that defaults to `workspace-write`, so the
  // identical lookup-key mismatch now fails OPEN — a severity flip. The fix
  // keys the hold off the canonical source FILENAME stem (what
  // `validateCodexSandboxHolds` already verifies exists), threaded through
  // `installCodexConfig`'s per-file loop independently of the frontmatter
  // `name:` used for the TOML body, with a case-insensitive lookup as a second
  // line of defense.
  test('heldRoleCannotEscapeItsHoldByRenamingFrontmatter_3897: name edits or recasing never change the content-derived sandbox (#4770: hold lifted, property kept)', () => {
    const { installCodexConfig } = require('../bin/install.js');
    const heldRole = 'gsd-doc-writer'; // one of the 17 formerly-held roles
    assert.ok(
      !Object.prototype.hasOwnProperty.call(CODEX_SANDBOX_HOLDS, heldRole),
      `sanity: ${heldRole} was lifted from CODEX_SANDBOX_HOLDS by #4770`,
    );

    const variants = [
      { label: 'frontmatter name: edited to a different value', newName: 'gsd-doc-writer-x' },
      { label: 'frontmatter name: merely recased', newName: 'GSD-Doc-Writer' },
    ];

    for (const { label, newName } of variants) {
      const tmpAgentsSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-tamper-src-'));
      const tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-tamper-dest-'));
      try {
        fs.cpSync(AGENTS_DIR, tmpAgentsSrc, { recursive: true });
        const rolePath = path.join(tmpAgentsSrc, `${heldRole}.md`);
        const original = fs.readFileSync(rolePath, 'utf8');
        const tampered = original.replace(/^name:\s*.*$/m, `name: ${newName}`);
        assert.notEqual(tampered, original, `sanity: the frontmatter name: line must actually change (${label})`);
        fs.writeFileSync(rolePath, tampered);

        // The FILE on disk is untouched (still `gsd-doc-writer.md`) — only its
        // frontmatter content changed. validateCodexSandboxHolds only checks
        // the file exists, so it does not (and should not) catch this by itself.
        installCodexConfig(tmpDest, tmpAgentsSrc);

        const emittedTomlPath = path.join(tmpDest, 'agents', `${newName}.toml`);
        assert.ok(
          fs.existsSync(emittedTomlPath),
          `${label}: expected an emitted .toml at ${emittedTomlPath} (named after the tampered frontmatter name, per existing TOML-naming behavior — unrelated to this fix)`,
        );
        const toml = fs.readFileSync(emittedTomlPath, 'utf8');
        const sandboxLine = toml.match(/^sandbox_mode = "([^"]{0,50})"$/m);
        assert.ok(sandboxLine, `${label}: emitted .toml must contain a sandbox_mode line`);
        // #4770: with the hold lifted, the sandbox is derived from the
        // content's own tools contract — gsd-doc-writer declares Write/Edit,
        // so every name variant emits workspace-write. The F1 property that
        // survives is that the derivation follows the CONTENT, never the
        // self-declared name.
        assert.equal(
          sandboxLine[1],
          'workspace-write',
          `${label}: the emitted .toml must carry the content-derived workspace-write — name edits/recasing change nothing post-#4770. Got: ${sandboxLine[1]}`,
        );
      } finally {
        cleanup(tmpAgentsSrc);
        cleanup(tmpDest);
      }
    }
  });

  test('N6 (post-fix regression check): every real agents/ role remains byte-identical in emitted sandbox_mode after the filename-identity fix', () => {
    // #3897 rung 4 (isolated correctness review, MINOR finding 6): driven
    // from the real roster (AGENT_ROSTER_ROLES), not the hardcoded
    // EXPECTED_SANDBOX_BY_ROLE key set — the roster-parity test above already
    // fails loudly if the two sets ever diverge, so `checked` here is a
    // genuine roster count, not a fixture-pinned literal that would silently
    // stop growing when a 36th agent lands.
    let checked = 0;
    for (const role of AGENT_ROSTER_ROLES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(EXPECTED_SANDBOX_BY_ROLE, role),
        `${role} exists in agents/ but has no EXPECTED_SANDBOX_BY_ROLE entry — see the roster-parity test above`,
      );
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
      const toml = generateCodexAgentToml(role, content);
      const match = toml.match(/^sandbox_mode = "([^"]+)"$/m);
      assert.ok(match, `${role} must emit a sandbox_mode line`);
      assert.equal(
        match[1],
        EXPECTED_SANDBOX_BY_ROLE[role],
        `${role}: sandbox_mode must not drift as a side effect of the #3897 filename-identity fix`,
      );
      checked++;
    }
    assert.equal(
      checked,
      AGENT_ROSTER_ROLES.length,
      'N6: every real role in agents/ must be checked and byte-identical',
    );
  });
});

// ─── #3897 security review F1/F3/F4/F5 regressions ─────────────────────────
//
// Isolated security review of this rung found a fail-open: `bin/install.js`'s
// Codex emit loop DECIDED sandbox_mode for the source filename stem but
// APPLIED it to the emitted `.toml`'s path, which is keyed on the
// frontmatter `name:` value instead — so a renamed file, or a sibling file
// whose `name:` collides with a held role, could land a held role's own
// artifact at `workspace-write`. F1(a)/F1(b) below assert on the EMITTED
// ARTIFACT (the written `.toml`'s `sandbox_mode`), never on
// `deriveCodexSandboxMode`'s return value directly — the whole defect is
// that the derivation and the emitted artifact could disagree.
describe('#3897 security review: F1 filename/name identity confusion, F3 confusables, F4/F5 totality', () => {
  const AGENTS_DIR = path.join(__dirname, '..', 'agents');
  const {
    installCodexConfig,
    deriveCodexSandboxMode: deriveCodexSandboxModeLocal,
  } = require('../bin/install.js');
  const {
    normalizeSandboxIdentity,
    isSandboxHeld,
    extractToolsValue: extractToolsValueLocal,
  } = require('../gsd-core/bin/lib/codex-agent-toml.cjs');

  function sandboxModeOfToml(toml) {
    const match = toml.match(/^sandbox_mode = "([^"]+)"$/m);
    return match ? match[1] : null;
  }

  test('F1(a) rename case: a source file whose FILENAME differs from a held role, but whose frontmatter name: IS the held role, emits read-only', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-f1a-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-f1a-dest-'));
    try {
      const original = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-doc-writer.md'), 'utf8');
      assert.ok(/^name:\s*gsd-doc-writer\s*$/m.test(original), 'sanity: fixture source declares name: gsd-doc-writer');
      // Renamed FILE, unchanged frontmatter name: — the fileStem no longer
      // matches the held role, but the emitted TOML is still named after
      // `gsd-doc-writer` (the frontmatter name:).
      fs.writeFileSync(path.join(src, 'gsd-doc-writer-v2.md'), original);

      installCodexConfig(dest, src);

      const emittedPath = path.join(dest, 'agents', 'gsd-doc-writer.toml');
      assert.ok(fs.existsSync(emittedPath), `expected an emitted .toml at ${emittedPath}`);
      const toml = fs.readFileSync(emittedPath, 'utf8');
      assert.equal(
        sandboxModeOfToml(toml),
        'workspace-write',
        'F1(a) post-#4770: the sandbox derives from the content\'s own tools contract, so a renamed source file changes nothing — gsd-doc-writer declares Write/Edit and emits workspace-write',
      );
    } finally {
      cleanup(src);
      cleanup(dest);
    }
  });

  test('F1(b) sibling-clobber case: a second, unheld source file whose frontmatter name: IS a held role must not widen the held role\'s emitted .toml', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-f1b-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-f1b-dest-'));
    try {
      const heldOriginal = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-doc-writer.md'), 'utf8');
      fs.writeFileSync(path.join(src, 'gsd-doc-writer.md'), heldOriginal);
      // A sibling file — different filename stem, no hold entry for IT — but
      // its frontmatter `name:` collides with the held role. Named to sort
      // AFTER `gsd-doc-writer.md` (readdirSync/emit-loop order is
      // alphabetical) so this sibling's write is the LAST one to the shared
      // `gsd-doc-writer.toml` output path — the exact ordering the pre-fix
      // defect needed to actually clobber the held role's own artifact
      // (a sibling sorting BEFORE it gets silently overwritten again by the
      // legitimate file's own correct read-only write, masking the bug).
      const sibling = [
        '---',
        'name: gsd-doc-writer',
        'description: sibling file colliding on frontmatter name',
        'tools: Read, Write, Edit',
        '---',
        '',
        '<role>sibling</role>',
      ].join('\n');
      fs.writeFileSync(path.join(src, 'gsd-zzz-attacker-clone.md'), sibling);

      installCodexConfig(dest, src);

      const emittedPath = path.join(dest, 'agents', 'gsd-doc-writer.toml');
      assert.ok(fs.existsSync(emittedPath), `expected an emitted .toml at ${emittedPath}`);
      const toml = fs.readFileSync(emittedPath, 'utf8');
      assert.equal(
        sandboxModeOfToml(toml),
        'workspace-write',
        'F1(b) post-#4770: the last-writer artifact carries ITS OWN content-derived sandbox (the sibling declared Write/Edit) — with no holds left, a name collision cannot escalate any role beyond what its own content derives',
      );
    } finally {
      cleanup(src);
      cleanup(dest);
    }
  });

  // Vectors that NFKC-fold to pure ASCII (fullwidth g, whitespace, dots,
  // path prefixes): post-#4770 they normalize onto a real roster role whose
  // content declares Write/Edit, and the content-derived answer is
  // workspace-write — the identity no longer gates.
  const F3_CONTENT_DERIVED_VECTORS = [
    ['fullwidth leading g (ｇ)', 'ｇsd-doc-writer'],
    ['trailing ASCII space', 'gsd-doc-writer '],
    ['trailing NBSP', 'gsd-doc-writer '],
    ['trailing dot', 'gsd-doc-writer.'],
    ['trailing newline', 'gsd-doc-writer\n'],
    ['trailing carriage return', 'gsd-doc-writer\r'],
    ['relative-path prefix ./', './gsd-doc-writer'],
    ['path traversal ../agents/', '../agents/gsd-doc-writer'],
  ];
  for (const [label, vector] of F3_CONTENT_DERIVED_VECTORS) {
    test(`F3 ascii-folding vector — ${label} — derives from content (#4770)`, () => {
      const mode = deriveCodexSandboxModeLocal(vector, 'Read, Write, Edit');
      assert.equal(
        mode,
        'workspace-write',
        `F3 post-#4770: identity ${JSON.stringify(vector)} (${label}) folds to ASCII and normalizes onto a real roster role whose content declares Write/Edit — content-derived workspace-write`,
      );
    });
  }

  // Vectors that stay non-ASCII after NFKC (Turkish İ/ı, combining acute):
  // the F3 fail-closed pin is map-independent and still applies — a
  // non-ASCII-after-normalization identity is never a legitimate shipped
  // role and is pinned read-only regardless of its content's tools.
  const F3_STILL_SUSPICIOUS_VECTORS = [
    ['Turkish dotted I (İ)', 'gsd-doc-wrİter'],
    ['Turkish dotless i (ı)', 'gsd-doc-wrıter'],
    ['NFD combining acute on r (writeŕ)', 'gsd-doc-writeŕ'],
  ];
  for (const [label, vector] of F3_STILL_SUSPICIOUS_VECTORS) {
    test(`F3 non-folding vector — ${label} — stays fail-closed read-only (#4770)`, () => {
      const mode = deriveCodexSandboxModeLocal(vector, 'Read, Write, Edit');
      assert.equal(
        mode,
        'read-only',
        `F3: identity ${JSON.stringify(vector)} (${label}) is still non-ASCII after NFKC — suspicious and fail-closed read-only regardless of content`,
      );
    });
  }

  // The F3 core that survives the #4770 lift: an identity still non-ASCII
  // after NFKC normalization is not a legitimate shipped role and is pinned
  // fail-closed read-only regardless of its content's tool contract.
  test('F3 core: an identity still non-ASCII after normalization derives read-only regardless of content (#4770)', () => {
    const mode = deriveCodexSandboxModeLocal('gsd-dос-writer', 'Read, Write, Edit');
    assert.equal(mode, 'read-only', 'a suspicious (non-ASCII after normalization) identity must stay fail-closed read-only');
  });

  test('F3: isSandboxHeld flags a non-ASCII-after-normalization identity as suspicious (#4770: held is vacuously false over the empty map)', () => {
    const { held, suspicious } = isSandboxHeld('gsd-dос-writer');
    assert.equal(held, false, 'the hold map is empty post-#4770 — nothing is held');
    assert.equal(suspicious, true, 'a Cyrillic-lookalike identity must still be flagged suspicious (fail-closed F3 core)');
  });

  test('F5: "All tools except Write, Edit" derives read-only (negation excludes Write/Edit)', () => {
    const mode = deriveCodexSandboxModeLocal('gsd-negation-agent', 'All tools except Write, Edit');
    assert.equal(mode, 'read-only', 'excluding Write and Edit after "except" must derive read-only');
  });

  test('F5: "All tools except Agent" derives workspace-write (Write/Edit are not excluded)', () => {
    const mode = deriveCodexSandboxModeLocal('gsd-negation-agent', 'All tools except Agent');
    assert.equal(mode, 'workspace-write', 'excluding only Agent leaves Write/Edit granted, so this must still derive workspace-write');
  });

  test('totality: deriveCodexSandboxMode never throws for undefined/null/[]/[undefined] identities', () => {
    for (const identity of [undefined, null, [], [undefined]]) {
      assert.doesNotThrow(
        () => deriveCodexSandboxModeLocal(identity, 'Read, Write, Edit'),
        `deriveCodexSandboxMode must not throw for identity ${JSON.stringify(identity)}`,
      );
      const result = deriveCodexSandboxModeLocal(identity, 'Read, Write, Edit');
      assert.equal(typeof result, 'string', `deriveCodexSandboxMode must return a string for identity ${JSON.stringify(identity)}`);
    }
  });

  // #3897 rung 4 (isolated correctness review, MINOR finding 4): two exotic
  // identity shapes more adversarial than the undefined/null/[]/[undefined]
  // set above — an object whose OWN toString throws, and a null-prototype
  // object (no inherited Object.prototype methods at all, so even a
  // defensive `.toString`/`.hasOwnProperty` call site would blow up). Both
  // must derive a string, never throw — "TOTAL for any input" per this
  // function's own docstring is not just for well-behaved falsy/array shapes.
  test('totality: deriveCodexSandboxMode never throws for an identity with a throwing toString', () => {
    const hostile = { toString() { throw new Error('id-boom'); } };
    assert.doesNotThrow(
      () => deriveCodexSandboxModeLocal(hostile, 'Read'),
      'deriveCodexSandboxMode must not throw for an identity whose toString throws',
    );
    assert.equal(typeof deriveCodexSandboxModeLocal(hostile, 'Read'), 'string');
  });

  test('totality: deriveCodexSandboxMode never throws for a null-prototype identity object', () => {
    const nullProto = Object.create(null);
    assert.doesNotThrow(
      () => deriveCodexSandboxModeLocal(nullProto, 'Read'),
      'deriveCodexSandboxMode must not throw for a null-prototype identity object',
    );
    assert.equal(typeof deriveCodexSandboxModeLocal(nullProto, 'Read'), 'string');
  });

  test('totality: normalizeSandboxIdentity never throws for undefined/null/non-string input', () => {
    for (const raw of [undefined, null, 42, {}, []]) {
      assert.doesNotThrow(() => normalizeSandboxIdentity(raw), `must not throw for ${JSON.stringify(raw)}`);
      assert.equal(normalizeSandboxIdentity(raw), null, `non-string input ${JSON.stringify(raw)} must normalize to null`);
    }
  });

  test('F4: extractToolsValue returns undefined (never throws) for undefined/null/Buffer input', () => {
    for (const value of [undefined, null, Buffer.from('tools: Write')]) {
      assert.doesNotThrow(() => extractToolsValueLocal(value), `extractToolsValue must not throw for ${String(value)}`);
      assert.equal(extractToolsValueLocal(value), undefined, `extractToolsValue must return undefined for non-string input ${String(value)}`);
    }
  });

  test('F4: extractToolsValue still returns the parsed value for real string content — inline form (no regression)', () => {
    const content = ['---', 'tools: Read, Write', '---', ''].join('\n');
    assert.equal(extractToolsValueLocal(content), 'Read, Write');
  });

  // ─── #3897 list-form parse fix: YAML block-list `tools:` ─────────────────
  //
  // `agents/gsd-nyquist-auditor.md` and `agents/gsd-security-auditor.md` are
  // the only two roster files using this shape. The pre-fix single-line
  // regex `/^tools:\s*(.+)$/m` let `\s*` swallow the newline after a bare
  // `tools:` key and matched into the FIRST list item's own line, returning
  // just `"- Read"` — a real Write/Edit DECLARATION read as an absence.

  test('list-form: a tools: block list declaring Write derives workspace-write (FAILS before the parse fix — pre-fix reader returned "- Read")', () => {
    const content = [
      '---',
      'name: gsd-list-form-writer',
      'tools:',
      '  - Read',
      '  - Write',
      '  - Edit',
      '  - Bash',
      '---',
      '',
      '<role>list-form writer</role>',
    ].join('\n');
    const toolsRaw = extractToolsValueLocal(content);
    assert.equal(toolsRaw, 'Read, Write, Edit, Bash', 'list items must be joined the same way the comma-tokenizer downstream expects');
    assert.equal(
      deriveCodexSandboxModeLocal('zzz-list-form-probe-never-held', toolsRaw),
      'workspace-write',
      'a tools: block list declaring Write must derive workspace-write, not read-only from a truncated first-item read',
    );
  });

  test('list-form: a tools: block list with NO write tool derives read-only (no over-correction)', () => {
    const content = [
      '---',
      'name: gsd-list-form-reader',
      'tools:',
      '  - Read',
      '  - Bash',
      '  - Glob',
      '---',
      '',
      '<role>list-form reader</role>',
    ].join('\n');
    const toolsRaw = extractToolsValueLocal(content);
    assert.equal(toolsRaw, 'Read, Bash, Glob');
    assert.equal(
      deriveCodexSandboxModeLocal('zzz-list-form-probe-never-held', toolsRaw),
      'read-only',
      'a list-form tools: with no Write/Edit item must still derive read-only',
    );
  });

  test('list-form: the list terminates at the next frontmatter key and does not swallow its value', () => {
    const content = [
      '---',
      'name: gsd-list-form-terminates',
      'tools:',
      '  - Read',
      '  - Write',
      'color: blue',
      '---',
      '',
      '<role>list-form terminates before a sibling key</role>',
    ].join('\n');
    assert.equal(extractToolsValueLocal(content), 'Read, Write');
    // The sibling key's own value must remain independently readable — it
    // must never have been consumed as a phantom third list item.
    const { frontmatter } = extractFrontmatterAndBody(content);
    assert.equal(extractFrontmatterField(frontmatter, 'color'), 'blue');
  });

  test('list-form: the list terminates at the closing --- and does not run past the frontmatter', () => {
    const content = [
      '---',
      'name: gsd-list-form-eof',
      'tools:',
      '  - Read',
      '  - Write',
      '---',
      '- this looks like a list item but is BODY text, not frontmatter',
    ].join('\n');
    assert.equal(extractToolsValueLocal(content), 'Read, Write');
  });

  test('roster truth: gsd-nyquist-auditor derives workspace-write from its real tool contract, and the #4770 lift released it to that derivation', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-nyquist-auditor.md'), 'utf8');
    const toolsRaw = extractToolsValueLocal(content);
    assert.ok(
      /\bWrite\b/.test(toolsRaw) && /\bEdit\b/.test(toolsRaw),
      `sanity: gsd-nyquist-auditor's real tools: must declare both Write and Edit, got ${JSON.stringify(toolsRaw)}`,
    );
    // Derivation WITHOUT the hold (an identity guaranteed never held/suspicious,
    // same probe idiom as the rung-3 describe block's PARITY_PROBE_IDENTITY)
    // must show the role genuinely derives workspace-write from its contract.
    assert.equal(
      deriveCodexSandboxModeLocal('zzz-nyquist-unheld-probe-never-a-real-role', toolsRaw),
      'workspace-write',
      'gsd-nyquist-auditor must genuinely derive workspace-write from its tool contract once list-form tools: parses correctly',
    );
    // #4770 lifted the hold, so the REAL identity now derives workspace-write
    // too — its emitted .toml matches its own content's tool contract.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(CODEX_SANDBOX_HOLDS, 'gsd-nyquist-auditor'),
      'gsd-nyquist-auditor must no longer be a CODEX_SANDBOX_HOLDS entry after the #4770 lift',
    );
    const { generateCodexAgentToml: generateCodexAgentTomlLocal } = require('../bin/install.js');
    const toml = generateCodexAgentTomlLocal('gsd-nyquist-auditor', content);
    assert.ok(
      toml.includes('sandbox_mode = "workspace-write"'),
      'gsd-nyquist-auditor\'s emitted .toml now carries the content-derived workspace-write (#4770)',
    );
  });
});

// ─── #3241: shared isAnthropicFlavoredModel / CLAUDE_AGENT_ALIASES surface ─────
// Phase 2/3 need one predicate. 40-design.md's "seam decision" moves
// CLAUDE_AGENT_ALIASES into model-catalog.cjs and defines isAnthropicFlavoredModel
// beside it, re-exporting from model-resolver.cjs for back-compat. Neither exists
// on model-catalog.cjs yet (verified: modelCatalog.isAnthropicFlavoredModel is
// `undefined` today), so every test below is RED against the current tree.

describe('#3241 isAnthropicFlavoredModel + CLAUDE_AGENT_ALIASES (model-catalog owns it)', () => {
  const parityAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write
---

<role>You are an executor.</role>`;

  test('predicate flags every Claude tier alias and case/namespace variant (#3241)', () => {
    // RED (pre-fix): modelCatalog.isAnthropicFlavoredModel is undefined today,
    // so `modelCatalog.isAnthropicFlavoredModel('opus')` throws
    // "isAnthropicFlavoredModel is not a function" — this test fails on the
    // very first call, before any assertion runs.
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      assert.strictEqual(modelCatalog.isAnthropicFlavoredModel(alias), true, `alias "${alias}" must be flagged`);
    }
    for (const id of ['claude-opus-4-5', 'anthropic/claude-x', 'us.anthropic.claude-x', 'CLAUDE-X']) {
      assert.strictEqual(modelCatalog.isAnthropicFlavoredModel(id), true, `id "${id}" must be flagged (case/namespace variant)`);
    }
  });

  test('predicate is false for real Codex ids and non-strings, without throwing (#3241)', () => {
    // RED (pre-fix): same "not a function" throw as above — fails before any
    // assertion is reached.
    for (const value of ['gpt-5.6-sol', 'gpt-4', '', null, undefined, {}, 0]) {
      assert.doesNotThrow(() => modelCatalog.isAnthropicFlavoredModel(value), `must not throw for ${JSON.stringify(value)}`);
      assert.strictEqual(modelCatalog.isAnthropicFlavoredModel(value), false, `must be false for ${JSON.stringify(value)}`);
    }
  });

  test('the alias set has exactly one owner across both modules (#3241)', () => {
    // RED (pre-fix): modelCatalog.CLAUDE_AGENT_ALIASES is undefined today
    // (model-catalog.cjs exports no such key), so deepStrictEqual against
    // modelResolver's real Set fails. Divergence guard per
    // 50-test-matrix.md rows 22-23: without this, Phase 2/3 can silently
    // fork the rule.
    assert.deepStrictEqual(
      modelCatalog.CLAUDE_AGENT_ALIASES,
      modelResolver.CLAUDE_AGENT_ALIASES,
      'model-catalog and model-resolver must share the exact same CLAUDE_AGENT_ALIASES contents'
    );
  });

  test('installer Codex .toml emission agrees with the shared predicate (#3241)', () => {
    // RED (pre-fix): modelCatalog.isAnthropicFlavoredModel is undefined, so
    // the first loop iteration throws "not a function" before any
    // generateCodexAgentToml call happens.
    const probeValues = [...CLAUDE_AGENT_ALIASES, 'claude-sonnet-5', 'gpt-5.6-sol'];
    for (const value of probeValues) {
      const expectedFlavored = modelCatalog.isAnthropicFlavoredModel(value);
      const result = generateCodexAgentToml('gsd-executor', parityAgent, { 'gsd-executor': value });
      const modelLine = result.split(/\r?\n/).find((line) => /^model = /.test(line));
      if (expectedFlavored) {
        assert.strictEqual(modelLine, undefined, `"${value}" is Anthropic-flavored per the shared predicate — installer must omit it`);
      } else {
        assert.strictEqual(modelLine, `model = ${JSON.stringify(value)}`, `"${value}" is NOT Anthropic-flavored per the shared predicate — installer must emit it verbatim`);
      }
    }
  });
});

// ─── sandboxTier gate on generateCodexAgentToml ────────────────────────────────

describe('generateCodexAgentToml sandboxTier gate', () => {
  const sampleAgent = `---
name: gsd-executor
description: Executes plans
tools: Read, Write, Edit
color: yellow
---

<role>You are an executor.</role>`;

  test('sandboxTier=none: does NOT emit sandbox_mode', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, null, null, 'none');
    assert.ok(!result.includes('sandbox_mode'), 'sandbox_mode must be absent when sandboxTier is none');
  });

  test('sandboxTier=codex-agent-sandbox: emits sandbox_mode = "workspace-write"', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent, null, null, null, 'codex-agent-sandbox');
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'must emit workspace-write for codex-agent-sandbox tier');
  });

  test('default (no sandboxTier arg): still emits sandbox_mode = "workspace-write" (no-op for codex)', () => {
    const result = generateCodexAgentToml('gsd-executor', sampleAgent);
    assert.ok(result.includes('sandbox_mode = "workspace-write"'), 'default preserves codex behavior');
  });

  test('resolveInstallPlan projection: codex.sandboxTier === "codex-agent-sandbox"', () => {
    const plan = resolveInstallPlan('codex');
    assert.strictEqual(plan.sandboxTier, 'codex-agent-sandbox', 'codex must project sandboxTier=codex-agent-sandbox');
  });

  test('resolveInstallPlan projection: claude.sandboxTier === "none"', () => {
    const plan = resolveInstallPlan('claude');
    assert.strictEqual(plan.sandboxTier, 'none', 'claude must project sandboxTier=none');
  });
});

// ─── installCodexConfig threading-seam: sandboxTier → per-agent TOML ─────────

describe('installCodexConfig sandboxTier threading seam', () => {
  const { installCodexConfig } = require('../bin/install.js');

  let tmpDir;
  let agentsSrc;
  let targetDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-sandboxtier-seam-'));
    agentsSrc = path.join(tmpDir, 'agents');
    targetDir = path.join(tmpDir, 'codex');
    fs.mkdirSync(agentsSrc, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    // Write a minimal gsd-executor agent fixture
    fs.writeFileSync(path.join(agentsSrc, 'gsd-executor.md'), [
      '---',
      'name: gsd-executor',
      'description: Executes plans',
      'tools: Read, Write, Edit',
      '---',
      '',
      '<role>You are an executor.</role>',
    ].join('\n'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('sandboxTier=none: written per-agent .toml does NOT contain sandbox_mode', () => {
    installCodexConfig(targetDir, agentsSrc, 'none');
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(!toml.includes('sandbox_mode'), 'sandbox_mode must be absent when sandboxTier=none');
  });

  test('sandboxTier=codex-agent-sandbox: written per-agent .toml contains sandbox_mode', () => {
    installCodexConfig(targetDir, agentsSrc, 'codex-agent-sandbox');
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(toml.includes('sandbox_mode'), 'sandbox_mode must be present when sandboxTier=codex-agent-sandbox');
  });

  test('default 2-arg form (no sandboxTier): written per-agent .toml contains sandbox_mode (codex default)', () => {
    installCodexConfig(targetDir, agentsSrc);
    const tomlPath = path.join(targetDir, 'agents', 'gsd-executor.toml');
    assert.ok(fs.existsSync(tomlPath), 'per-agent TOML must be written');
    const toml = fs.readFileSync(tomlPath, 'utf8');
    assert.ok(toml.includes('sandbox_mode'), 'sandbox_mode must be present in default 2-arg form (codex-agent-sandbox default)');
  });
});

// NOTE: A test for the new fail-loud throw on missing/invalid sandboxTier in
// resolveInstallPlan is omitted here. Constructing a descriptor without the
// field would require mocking the capability-registry module which is a
// singleton require(); patching it invasively would corrupt other tests in the
// same process. The throw path is verified at the type level (tsc) and by the
// build passing, and the happy-path coverage (claude.sandboxTier === 'none' and
// codex.sandboxTier === 'codex-agent-sandbox') confirms the real registry has
// valid values for all 15 runtimes.

// ─── CODEX_AGENT_SANDBOX (deleted map): derivation regression baseline ──────────

describe('CODEX_AGENT_SANDBOX (deleted map, derivation regression baseline)', () => {
  // bin/install.js's CODEX_AGENT_SANDBOX map is gone (ADR-3473 §8.3, #3897
  // rung 3) — deriveCodexSandboxMode is the sole owner of sandbox_mode now.
  // These tests assert the SAME underlying property the deleted map's own
  // suite used to assert (which 11 roles get which sandbox_mode), but against
  // the real derivation and the real agents/*.md content, sourced from the
  // PRE_3897_CODEX_AGENT_SANDBOX baseline literal above rather than the map.
  const AGENTS_DIR = path.join(__dirname, '..', 'agents');

  function realDerivedSandboxMode(role) {
    const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.md`), 'utf8');
    const { frontmatter } = extractFrontmatterAndBody(content);
    const toolsRaw = extractFrontmatterField(frontmatter || '', 'tools') || '';
    return deriveCodexSandboxMode(role, toolsRaw);
  }

  test('has all 11 baseline agents', () => {
    const agentNames = Object.keys(PRE_3897_CODEX_AGENT_SANDBOX);
    assert.strictEqual(agentNames.length, 11, 'has 11 agents');
  });

  test('workspace-write agents still derive workspace-write', () => {
    const writeAgents = [
      'gsd-executor', 'gsd-planner', 'gsd-phase-researcher',
      'gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-verifier',
      'gsd-codebase-mapper', 'gsd-roadmapper', 'gsd-debugger',
    ];
    for (const name of writeAgents) {
      assert.strictEqual(PRE_3897_CODEX_AGENT_SANDBOX[name], 'workspace-write', `${name} baseline is workspace-write`);
      assert.strictEqual(realDerivedSandboxMode(name), 'workspace-write', `${name} still derives workspace-write`);
    }
  });

  test('read-only agents still derive read-only', () => {
    const readOnlyAgents = ['gsd-plan-checker', 'gsd-integration-checker'];
    for (const name of readOnlyAgents) {
      assert.strictEqual(PRE_3897_CODEX_AGENT_SANDBOX[name], 'read-only', `${name} baseline is read-only`);
      assert.strictEqual(realDerivedSandboxMode(name), 'read-only', `${name} still derives read-only`);
    }
  });
});

// ─── generateCodexConfigBlock ───────────────────────────────────────────────────

describe('generateCodexConfigBlock', () => {
  const agents = [
    { name: 'gsd-executor', description: 'Executes plans' },
    { name: 'gsd-planner', description: 'Creates plans' },
  ];

  test('starts with GSD marker', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(result.startsWith(GSD_CODEX_MARKER), 'starts with marker');
  });

  test('emits the [agents] max_depth tuning block but no feature flags (#2088)', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(!result.includes('[features]'), 'no features table');
    assert.ok(!result.includes('multi_agent'), 'no multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'no request_user_input');
    // #2088: the managed block pins dispatch depth via a bare [agents]
    // AgentsToml scalar table. #2406: this is now the ONLY [agents]-namespaced
    // content the block emits — no [agents.<name>] role structs.
    assert.match(result, /^\[agents\]$/m, 'emits the [agents] tuning table');
    assert.match(result, /^max_depth = 1$/m, 'pins max_depth = 1');
    // Should not emit [[agents]] sequence format (rejected by Codex 0.124.0).
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format');
    // Only max_depth is managed — max_threads is intentionally left to the user.
    assert.ok(!result.includes('max_threads'), 'no max_threads (only max_depth is GSD-managed)');
  });

  test('#2406: does not emit [agents.<name>] role tables — the standalone agents/<name>.toml is the sole canonical source', () => {
    const result = generateCodexConfigBlock(agents);
    // Codex auto-discovers standalone TOMLs under $CODEX_HOME/agents/. A
    // config.toml [agents.<name>] table pointing config_file back at that
    // same file is a SECOND registration of the same role and made Codex log
    // "Ignoring malformed agent role definition: duplicate agent role name"
    // once per agent. Zero role headers and zero config_file lines proves
    // the duplication is gone.
    assert.ok(!result.includes('[agents.gsd-executor]'), 'no executor role header');
    assert.ok(!result.includes('[agents.gsd-planner]'), 'no planner role header');
    assert.ok(!result.includes('config_file'), 'no config_file line at all');
    assert.ok(!result.includes('description = "Executes plans"'), 'no per-agent description leaks into config.toml');
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format either');
  });

  test('#2406: block is a valid TOML shape with exactly one [agents] table and zero [agents.*] sub-tables', () => {
    const result = generateCodexConfigBlock(agents);
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] sequence format present');
    const bareAgentsHeaders = (result.match(/^\[agents\]\s*$/gm) || []).length;
    assert.strictEqual(bareAgentsHeaders, 1, 'exactly one bare [agents] dispatch-tuning table');
    const structHeaders = (result.match(/^\[agents\.[^\]]+\]\s*$/gm) || []).length;
    assert.strictEqual(structHeaders, 0, 'zero [agents.<name>] struct headers — role tables removed (#2406)');
  });

  test('#2406: output is unaffected by agents/targetDir — no per-agent content is derived from either', () => {
    const withAgents = generateCodexConfigBlock(agents);
    const withoutAgents = generateCodexConfigBlock([]);
    assert.strictEqual(withAgents, withoutAgents, 'agents list no longer influences the emitted block');

    const withTargetDir = generateCodexConfigBlock(agents, '/home/user/.codex');
    assert.strictEqual(withTargetDir, withAgents, 'targetDir no longer influences the emitted block');
    assert.ok(!withTargetDir.includes('config_file'), 'no config_file even when targetDir is provided');
    assert.ok(!withTargetDir.includes('/home/user/.codex'), 'targetDir path does not leak into the block');
  });
});

// ─── stripGsdFromCodexConfig ────────────────────────────────────────────────────

describe('stripGsdFromCodexConfig', () => {
  test('returns null for GSD-only config', () => {
    const content = `${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.strictEqual(result, null, 'returns null when GSD-only');
  });

  test('preserves user content before marker', () => {
    const content = `[model]\nname = "o3"\n\n${GSD_CODEX_MARKER}\n[features]\nmulti_agent = true\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user section');
    assert.ok(result.includes('name = "o3"'), 'preserves user values');
    assert.ok(!result.includes('multi_agent'), 'removes GSD content');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'removes marker');
  });

  test('strips injected feature keys without marker', () => {
    const content = `[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nother_feature = false\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('multi_agent'), 'removes multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'removes request_user_input');
    assert.ok(result.includes('other_feature = false'), 'preserves user features');
  });

  test('removes empty [features] section', () => {
    const content = `[features]\nmulti_agent = true\n[model]\nname = "o3"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[features]'), 'removes empty features section');
    assert.ok(result.includes('[model]'), 'preserves other sections');
  });

  test('strips injected keys above marker on uninstall', () => {
    // Case 3 install injects keys into [features] AND appends marker block
    const content = `[model]\nname = "o3"\n\n[features]\nmulti_agent = true\ndefault_mode_request_user_input = true\nsome_custom_flag = true\n\n${GSD_CODEX_MARKER}\n[agents]\nmax_threads = 4\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(result.includes('[model]'), 'preserves user model section');
    assert.ok(result.includes('some_custom_flag = true'), 'preserves user feature');
    assert.ok(!result.includes('multi_agent'), 'strips injected multi_agent');
    assert.ok(!result.includes('default_mode_request_user_input'), 'strips injected request_user_input');
    assert.ok(!result.includes(GSD_CODEX_MARKER), 'strips marker');
  });

  test('removes legacy [agents.gsd-*] map sections (self-heal pre-#2645 configs)', () => {
    const content = `[agents.gsd-executor]\ndescription = "test"\nconfig_file = "agents/gsd-executor.toml"\n\n[agents.custom-agent]\ndescription = "user agent"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!result.includes('[agents.gsd-executor]'), 'removes legacy GSD agent map section');
    assert.ok(result.includes('[agents.custom-agent]'), 'preserves user agent section');
  });

  test('#2645: removes [[agents]] array-of-tables entries whose name is gsd-*', () => {
    const content = `[[agents]]\nname = "gsd-executor"\ndescription = "test"\nconfig_file = "agents/gsd-executor.toml"\n\n[[agents]]\nname = "custom-agent"\ndescription = "user agent"\n`;
    const result = stripGsdFromCodexConfig(content);
    assert.ok(!/name = "gsd-executor"/.test(result), 'removes managed GSD [[agents]] entry');
    assert.ok(result.includes('name = "custom-agent"'), 'preserves user [[agents]] entry');
  });

  test('#2645: handles mixed legacy + new shapes and multiple user/gsd entries in one file', () => {
    // Multiple GSD entries (both legacy map and new array-of-tables) interleaved
    // with multiple user-authored agents in both shapes — none of the user
    // entries may be removed and all GSD entries must be stripped.
    const content = [
      '[agents.gsd-executor]',
      'description = "legacy gsd"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[agents.custom-legacy]',
      'description = "user legacy"',
      '',
      '[[agents]]',
      'name = "gsd-planner"',
      'description = "new gsd"',
      '',
      '[[agents]]',
      'name = "my-helper"',
      'description = "user new"',
      '',
      '[[agents]]',
      "name = 'gsd-debugger'",
      'description = "single-quoted gsd"',
      '',
      '[[agents]]',
      'name = "another-user"',
      'description = "second user agent"',
      '',
    ].join('\n');
    const result = stripGsdFromCodexConfig(content);
    // All GSD entries removed.
    assert.ok(!result.includes('gsd-executor'), 'removes legacy gsd-executor');
    assert.ok(!/name\s*=\s*"gsd-planner"/.test(result), 'removes new gsd-planner');
    assert.ok(!/name\s*=\s*'gsd-debugger'/.test(result), 'removes single-quoted gsd-debugger');
    // All user-authored entries preserved.
    assert.ok(result.includes('[agents.custom-legacy]'), 'preserves user legacy [agents.custom-legacy]');
    assert.ok(result.includes('user legacy'), 'preserves user legacy body');
    assert.ok(result.includes('name = "my-helper"'), 'preserves user new [[agents]]');
    assert.ok(result.includes('name = "another-user"'), 'preserves second user [[agents]]');
    assert.ok(result.includes('second user agent'), 'preserves second user body');
  });
});

// ─── migrateCodexHooksMapFormat ─────────────────────────────────────────────────

describe('migrateCodexHooksMapFormat', () => {
  test('migrates flat [[hooks]] with event key to namespaced [[hooks.<EVENT>]] form', () => {
    // Flat [[hooks]] + event = "..." is TOML-incompatible with [[hooks.SessionStart]],
    // so migrateCodexHooksMapFormat now converts it to the nested namespaced form.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'flat [[hooks]] event=SessionStart must be promoted to [[hooks.SessionStart]] AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'must emit [[hooks.SessionStart.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command',
      'migrated handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.hooks.SessionStart[0].event, undefined,
      'event key consumed as namespace — must not appear in emitted block');
    assert.ok(!Array.isArray(parsed.hooks), 'hooks must be a table, not a flat array');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('returns content unchanged for empty string', () => {
    assert.strictEqual(migrateCodexHooksMapFormat(''), '');
  });

  test('converts [hooks.shell] to namespaced AoT [[hooks.shell]] (#2760 CR5 finding 3)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '',
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    // Parse structurally — no source-grep on raw bytes.
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell),
      'hooks.shell must be an array of tables, got: ' + (parsed.hooks ? typeof parsed.hooks.shell : 'no hooks table'));
    assert.strictEqual(parsed.hooks.shell.length, 1);
    // #2773: command now lives in [[hooks.shell.hooks]] sub-table, not at event-entry level
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command, 'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command');
    // No flat top-level [[hooks]] AoT and no synthetic event field.
    assert.ok(!Array.isArray(parsed.hooks),
      'no top-level [[hooks]] AoT — namespace IS the event in CR5 form');
    assert.equal(parsed.hooks.shell[0].event, undefined,
      'no synthetic event field — namespace [[hooks.shell]] encodes the event');
    // User content preserved.
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('converts [hooks.exec] to namespaced AoT [[hooks.exec]] (#2760 CR5 finding 3)', () => {
    const content = [
      '[hooks.exec]',
      'command = "echo hello"',
      'extra_key = "preserved"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.exec));
    assert.strictEqual(parsed.hooks.exec.length, 1);
    // #2773: command and extra keys now live in [[hooks.exec.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.exec[0].hooks), 'must emit [[hooks.exec.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].command, 'echo hello');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].type, 'command',
      'migrated handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].extra_key, 'preserved');
    assert.equal(parsed.hooks.exec[0].event, undefined);
  });

  test('converts multiple [hooks.TYPE] sections to separate namespaced AoT blocks (#2760 CR5 finding 3)', () => {
    const content = [
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
      '[hooks.exec]',
      'command = "echo done"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell));
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.exec));
    assert.strictEqual(parsed.hooks.shell.length, 1);
    assert.strictEqual(parsed.hooks.exec.length, 1);
    // #2773: commands now live in the [[hooks.<TYPE>.hooks]] sub-table
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command, 'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command"');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].command, 'echo done');
    assert.strictEqual(parsed.hooks.exec[0].hooks[0].type, 'command',
      'migrated exec handler must carry type = "command"');
  });

  test('migrates flat [[hooks]] with event=AfterCommand to [[hooks.AfterCommand]] namespaced form', () => {
    // Flat [[hooks]] + event = "..." is incompatible with [[hooks.<EVENT>]] AoT in the same
    // file — TOML cannot have hooks be both an array and a table. Migration promotes it.
    const content = [
      '[[hooks]]',
      'event = "AfterCommand"',
      'command = "echo custom"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.AfterCommand),
      'flat [[hooks]] event=AfterCommand must become [[hooks.AfterCommand]] AoT');
    assert.strictEqual(parsed.hooks.AfterCommand.length, 1);
    assert.ok(Array.isArray(parsed.hooks.AfterCommand[0].hooks),
      'must emit [[hooks.AfterCommand.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].command, 'echo custom');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].type, 'command',
      'migrated AfterCommand handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.hooks.AfterCommand[0].event, undefined,
      'event key consumed as namespace — must not appear in emitted block');
    assert.ok(!Array.isArray(parsed.hooks), 'hooks must be a table, not a flat array');
  });

  test('end-to-end: install on config with old [hooks] map format produces namespaced AoT (#2637, #2760 CR5)', () => {
    // Simulates the exact old GSD config.toml format that broke on Codex 0.124.0
    const oldContent = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '',
      '  [hooks.shell]',
      '  command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(oldContent);
    const parsed = parseTomlToObject(result);
    // Codex 0.124.0+: must produce array-of-tables form. CR5 finding 3:
    // namespaced AoT [[hooks.shell]] (no flat [[hooks]] with synthetic event).
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell),
      'hooks.shell must be array-of-tables in namespaced form');
    assert.strictEqual(parsed.hooks.shell.length, 1);
    // #2773: command lives in [[hooks.shell.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command" per Codex 0.124.0+ schema');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('bare [hooks] section without sub-tables is dropped (no [[hooks]] block added)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks]',
      '# no sub-tables, just an empty container',
      '',
      '[model]',
      'name = "o3"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    assert.ok(!result.match(/^\[hooks\]$/m), 'removes bare [hooks] section');
    assert.ok(!result.includes('[[hooks]]'), 'no [[hooks]] added for bare [hooks] with no sub-tables');
    assert.ok(result.includes('[features]'), 'preserves [features]');
    assert.ok(result.includes('[model]'), 'preserves [model]');
  });

  test('upgrades stale [[hooks.SessionStart]] with event-level command to nested schema (#2773 CR6)', () => {
    // Pre-#2773 single-block format: handler fields live directly under
    // [[hooks.SessionStart]] rather than under [[hooks.SessionStart.hooks]].
    // Codex 0.124.0+ rejects this shape. Migration must promote it.
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.SessionStart]]',
      'command = "echo stale-user-hook"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'stale [[hooks.SessionStart]] must remain a namespaced AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'must emit [[hooks.SessionStart.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo stale-user-hook');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command',
      'must inject type = "command" when source body has no explicit type');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'command must not remain at event-entry level after promotion');
    assert.equal(parsed.features && parsed.features.codex_hooks, true);
  });

  test('leaves [[hooks.SessionStart]] + [[hooks.SessionStart.hooks]] untouched (already nested)', () => {
    // Properly-nested schema: handler lives under [[hooks.SessionStart.hooks]].
    // Migration must NOT create a double-wrapped [[hooks.SessionStart.hooks.hooks]] shape.
    const content = [
      '[[hooks.SessionStart]]',
      '',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo already-nested"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(Array.isArray(parsed.hooks?.SessionStart),
      'SessionStart must remain a namespaced AoT after no-op migration');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1,
      'must not duplicate the event entry');
    assert.ok(Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'nested [[hooks.SessionStart.hooks]] sub-table must still be present');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks.length, 1,
      'must not create a double-wrapped [[hooks.SessionStart.hooks.hooks]]');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo already-nested');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'command must not appear at event-entry level');
  });

  test('promotes multiple stale [[hooks.TYPE]] entries from different event types', () => {
    const content = [
      '[[hooks.SessionStart]]',
      'command = "echo session"',
      '',
      '[[hooks.AfterCommand]]',
      'command = "echo after-cmd"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.SessionStart));
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.AfterCommand));
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].command, 'echo session');
    assert.strictEqual(parsed.hooks.SessionStart[0].hooks[0].type, 'command');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].command, 'echo after-cmd');
    assert.strictEqual(parsed.hooks.AfterCommand[0].hooks[0].type, 'command');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined);
    assert.equal(parsed.hooks.AfterCommand[0].command, undefined);
  });

  test('matcher-only [[hooks.SessionStart]] (no handler fields) is left untouched', () => {
    // A [[hooks.SessionStart]] entry with only a `matcher` key is a valid
    // event filter — no handler fields → not a stale single-block entry.
    const content = [
      '[[hooks.SessionStart]]',
      'matcher = "some-tool"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    assert.ok(Array.isArray(parsed.hooks?.SessionStart),
      'matcher-only SessionStart must remain a namespaced AoT');
    assert.strictEqual(parsed.hooks.SessionStart.length, 1);
    assert.strictEqual(parsed.hooks.SessionStart[0].matcher, 'some-tool',
      'matcher key must be preserved');
    assert.equal(parsed.hooks.SessionStart[0].hooks, undefined,
      'matcher-only entry must not gain a .hooks sub-array');
    assert.equal(parsed.hooks.SessionStart[0].command, undefined,
      'no spurious command key must appear');
  });

  test('quoted event name with dot ([[hooks."before.tool"]]) is treated as single 2-segment namespace', () => {
    // Regression for the split('.') bug: "before.tool" contains a dot, but the
    // key is quoted so it is ONE segment — [[hooks."before.tool"]] has exactly
    // two path segments and must be classified the same as [[hooks.SessionStart]].
    // It should NOT be treated as a 3-level path (hooks / before / tool).
    const content = [
      '[[hooks."before.tool"]]',
      'command = "echo hi"',
      '',
    ].join('\n');
    const result = migrateCodexHooksMapFormat(content);
    const parsed = parseTomlToObject(result);
    // The key in the parsed object is the unquoted event name "before.tool".
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks['before.tool']),
      '[[hooks."before.tool"]] must be a namespaced AoT — not split on the inner dot'
    );
    assert.ok(
      Array.isArray(parsed.hooks['before.tool'][0].hooks),
      'must emit [[hooks."before.tool".hooks]] sub-table'
    );
    assert.strictEqual(
      parsed.hooks['before.tool'][0].hooks[0].command,
      'echo hi',
      'command must be preserved in the nested handler sub-table'
    );
    // Ensure no spurious "before" or "tool" top-level hook keys appeared.
    assert.equal(parsed.hooks?.before, undefined, 'must not split quoted key on dot');
  });

  test('CRLF line endings are preserved through migration (#2760 CR5: namespaced AoT)', () => {
    const content = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks.shell]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\r\n');
    const result = migrateCodexHooksMapFormat(content);
    assert.ok(result.includes('[[hooks.shell]]\r\n'),
      'uses CRLF in namespaced [[hooks.shell]] header');
    // Round-trip parse confirms the structural shape independent of EOL.
    const parsed = parseTomlToObject(result);
    assert.ok(parsed.hooks && Array.isArray(parsed.hooks.shell));
    // #2773: command lives in [[hooks.shell.hooks]] sub-table
    assert.ok(Array.isArray(parsed.hooks.shell[0].hooks), 'must emit [[hooks.shell.hooks]] sub-table');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].command,
      'node /home/.codex/hooks/gsd-check-update.js');
    assert.strictEqual(parsed.hooks.shell[0].hooks[0].type, 'command',
      'migrated shell handler must carry type = "command" per Codex 0.124.0+ schema');
  });
});

// ─── shape parity between migration and managed emit (#2760 CR5 finding 3) ──

describe('Codex hooks emit: migration produces namespaced AoT so managed-emit converges', () => {
  // After #2760 CR5 finding 3, the legacy migration path
  // (migrateCodexHooksMapFormat) emits `[[hooks.<TYPE>]]` directly — the
  // namespace IS the event, no synthetic `event = ...` field. The managed
  // install path (writes "# GSD Hooks") detects existing namespaced AoT via
  // hasUserNamespacedAotHooks and emits its block in the same shape. The two
  // paths must therefore both produce a namespaced layout when a legacy
  // [hooks.SessionStart] is migrated, eliminating the mixed flat+namespaced
  // bug class entirely.

  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-fieldparity-'));
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  test('migration of legacy [hooks.SessionStart] produces two-level nested AoT (#2773)', () => {
    const legacyContent = [
      '[features]',
      'codex_hooks = true',
      '',
      '[hooks.SessionStart]',
      'command = "node /home/.codex/hooks/gsd-check-update.js"',
      '',
    ].join('\n');
    const migrated = migrateCodexHooksMapFormat(legacyContent);
    const parsed = parseTomlToObject(migrated);
    // Outer event entry
    assert.ok(
      parsed.hooks && Array.isArray(parsed.hooks.SessionStart),
      'migration must emit [[hooks.SessionStart]] namespaced AoT'
    );
    assert.equal(parsed.hooks.SessionStart[0].event, undefined,
      'migration must NOT emit a synthetic event field — namespace IS the event');
    assert.equal(Array.isArray(parsed.hooks), false,
      'migration must NOT emit a flat top-level [[hooks]] AoT');
    // Inner handler sub-table
    assert.ok(
      Array.isArray(parsed.hooks.SessionStart[0].hooks),
      'migration must emit [[hooks.SessionStart.hooks]] sub-table'
    );
    const handler = parsed.hooks.SessionStart[0].hooks[0];
    assert.strictEqual(handler.type, 'command',
      'migration must inject type = "command" in handler sub-table');
    assert.strictEqual(
      handler.command,
      'node /home/.codex/hooks/gsd-check-update.js',
      'migration must preserve original command value in handler sub-table'
    );
  });
});

// ─── mergeCodexConfig ───────────────────────────────────────────────────────────

describe('mergeCodexConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-merge-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const sampleBlock = generateCodexConfigBlock([
    { name: 'gsd-executor', description: 'Executes plans' },
  ]);

  test('case 1: creates new config.toml', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);

    assert.ok(fs.existsSync(configPath), 'file created');
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'has marker');
    // #2406: config.toml never gets an [agents.gsd-*] role table — the
    // standalone agents/<name>.toml written by installCodexConfig is the
    // sole canonical registration Codex auto-discovers.
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    assert.ok(!content.includes('[features]'), 'no features section');
    assert.ok(!content.includes('multi_agent'), 'no multi_agent');
  });

  test('case 2: replaces existing GSD block', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const userContent = '[model]\nname = "o3"\n';
    fs.writeFileSync(configPath, userContent + '\n' + sampleBlock + '\n');

    // Re-merge with updated block
    const newBlock = generateCodexConfigBlock([
      { name: 'gsd-executor', description: 'Updated description' },
      { name: 'gsd-planner', description: 'New agent' },
    ]);
    mergeCodexConfig(configPath, newBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    // #2406: description text is per-agent metadata carried only by the
    // standalone TOML now — it no longer leaks into config.toml.
    assert.ok(!content.includes('Updated description'), 'no per-agent description in config.toml');
    assert.ok(!content.includes('[agents.gsd-planner]'), 'no agent role table (canonical source is the standalone TOML)');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(escapeRegex(GSD_CODEX_MARKER), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 3: appends to config without GSD marker', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('case 3 with existing [features]: preserves user features, does not inject GSD keys', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('other_feature = true'), 'preserves existing feature');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes(GSD_CODEX_MARKER), 'adds marker for agents block');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('case 3 strips existing [agents.gsd-*] sections before appending fresh block (#2406: fresh block never re-adds them)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const existing = [
      '[model]',
      'name = "o3"',
      '',
      '[agents.custom-agent]',
      'description = "user agent"',
      '',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, existing);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    // The pre-existing legacy [agents.gsd-executor] role table is a leaked
    // GSD section (stripLeakedGsdCodexSections) and the fresh block never
    // re-adds one (#2406) — zero role tables should remain anywhere.
    const gsdStructCount = (content.match(/^\[agents\.gsd-executor\]\s*$/gm) || []).length;
    const markerCount = (content.match(new RegExp(escapeRegex(GSD_CODEX_MARKER), 'g')) || []).length;

    assert.ok(content.includes('[model]'), 'preserves user content');
    assert.ok(content.includes('[agents.custom-agent]'), 'preserves non-GSD agent section');
    assert.strictEqual(gsdStructCount, 0, 'legacy [agents.gsd-executor] struct entry is removed and not regrown');
    assert.strictEqual(markerCount, 1, 'adds exactly one marker block');
    assert.ok(!/\r?\n{3,}# GSD Agent Configuration/.test(content), 'does not leave extra blank lines before marker block');
  });

  test('idempotent: re-merge produces same result', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent merge');
  });

  test('case 2 after case 3 with existing [features]: no duplicate sections', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n\n[model]\nname = "o3"\n');
    mergeCodexConfig(configPath, sampleBlock);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const featuresCount = (content.match(/^\[features\]\s*$/gm) || []).length;
    assert.strictEqual(featuresCount, 1, 'exactly one [features] section');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature keys');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
    // Verify no duplicate markers
    const markerCount = (content.match(new RegExp(escapeRegex(GSD_CODEX_MARKER), 'g')) || []).length;
    assert.strictEqual(markerCount, 1, 'exactly one marker');
  });

  test('case 2 does not inject feature keys, and drops a legacy [agents.gsd-old] role table on reinstall (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const manualContent = '[features]\nother_feature = true\n\n' + GSD_CODEX_MARKER + '\n[agents.gsd-old]\ndescription = "old"\n';
    fs.writeFileSync(configPath, manualContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(!content.includes('multi_agent'), 'does not inject multi_agent');
    assert.ok(!content.includes('default_mode_request_user_input'), 'does not inject request_user_input');
    assert.ok(content.includes('other_feature = true'), 'preserves user feature');
    // #2406: the pre-existing managed [agents.gsd-old] role table (below the
    // marker, from a pre-fix install) is truncated away by Case 2's
    // marker-truncate, and the fresh block never re-adds a role table.
    assert.ok(!content.includes('[agents.gsd-old]'), 'legacy managed role table removed');
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table (canonical source is the standalone TOML)');
  });

  test('#2406: update over a legacy 1.7.0-shape install removes duplicate [agents.gsd-*] role registrations, preserves unrelated user config, and is idempotent on rerun', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    // Simulate a config.toml produced by the pre-fix installer: a managed
    // block with BOTH the bare [agents] dispatch-tuning table (holding the
    // user's own max_threads = 4 alongside GSD's stale max_depth = 2) AND
    // [agents.gsd-*] role tables duplicating what the standalone TOMLs
    // already register — plus an unrelated user [model] table above the
    // marker that must survive untouched.
    const legacyInstall = [
      '[model]',
      'name = "o3"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents]',
      'max_threads = 4',
      'max_depth = 2',
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      '[agents.gsd-planner]',
      'description = "Creates plans"',
      'config_file = "agents/gsd-planner.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, legacyInstall);

    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    // Legacy duplicate role registrations removed.
    assert.strictEqual((first.match(/^\[agents\.gsd-/gm) || []).length, 0, 'zero [agents.gsd-*] role tables remain');
    assert.ok(!first.includes('config_file'), 'no config_file line remains');
    // Unrelated user config preserved.
    assert.ok(first.includes('[model]') && first.includes('name = "o3"'), 'preserves unrelated user [model] table');
    // User's own AgentsToml scalar tuning preserved; GSD's max_depth re-pinned to 1.
    assert.ok(first.includes('max_threads = 4'), 'preserves user max_threads scalar');
    assert.match(first, /max_depth = 1/, 're-pins GSD-managed max_depth to 1');
    assert.doesNotMatch(first, /max_depth = 2/, 'stale legacy max_depth value is gone');
    assert.strictEqual((first.match(/^\[agents\]\s*$/gm) || []).length, 1, 'exactly one [agents] table (no duplicate)');
    assert.equal(validateCodexConfigSchema(first).ok, true, 'the migrated config still validates');

    // Idempotent: running install/merge again produces byte-identical output — no regrowth.
    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');
    assert.strictEqual(first, second, 'second merge is byte-identical — removed registrations do not regrow');
  });

  test('case 2 strips leaked [agents] and [agents.gsd-*] from before content, and does not regrow a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      'max_depth = 2',
      '',
      '[agents.gsd-executor]',
      'description = "old"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, brokenContent);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    // #2406: neither the leaked pre-marker role table nor the legacy
    // post-marker managed one survives — the fresh block emits none.
    assert.ok(!content.includes('[agents.gsd-executor]'), 'no agent role table anywhere in the file');
    // Verify the leaked [agents] table header above marker was stripped
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.substring(0, markerIndex);
    assert.ok(!beforeMarker.match(/^\[agents\]\s*$/m), 'no leaked [agents] above marker');
    assert.ok(!beforeMarker.includes('[agents.gsd-'), 'no leaked [agents.gsd-*] above marker');
  });

  test('case 2 strips leaked GSD-managed sections above marker in CRLF files, and does not regrow a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'max_threads = 4',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    assert.ok(content.includes('child_agents_md = false'), 'preserves user feature keys');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\]\s*$/gm), 0, 'removes leaked [agents] above marker');
    assert.strictEqual(countMatches(beforeMarker, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'removes leaked GSD agent section above marker');
    // #2406: the fresh block never emits a role table, so zero remain
    // anywhere in the file — not just above the marker.
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'zero role tables anywhere');
    assert.strictEqual(countMatches(content, /name = "gsd-executor"/g), 0, 'no name = field in struct format');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 strips bare [agents] tables (invalid in current Codex schema, #2760) and removes leaked GSD sections in CRLF files, without regrowing a role table (#2406)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const brokenContent = [
      '[features]',
      'child_agents_md = false',
      '',
      '[agents]',
      'default = "custom-agent"',
      '',
      '[agents.gsd-executor]',
      'description = "stale"',
      'config_file = "agents/gsd-executor.toml"',
      '',
      GSD_CODEX_MARKER,
      '',
      '[agents.gsd-executor]',
      'description = "Executes plans"',
      'config_file = "agents/gsd-executor.toml"',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, brokenContent, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const markerIndex = content.indexOf(GSD_CODEX_MARKER);
    const beforeMarker = content.slice(0, markerIndex);

    // Bare [agents] is invalid under Codex's current schema (rejected with
    // "expected struct AgentsToml") so install-time stripping always purges
    // it (#2760). User feature keys above the marker are preserved.
    // Structural assertion: TOML-parse the pre-marker region and verify the
    // bare [agents] block is fully gone — header AND body keys (e.g.,
    // `default = "custom-agent"`). A header-only check would miss a
    // partial-strip regression that leaves orphan body keys reparented to a
    // sibling section.
    const parsedBefore = parseTomlToObject(beforeMarker);
    assert.equal(
      parsedBefore.agents,
      undefined,
      'bare [agents] block fully purged including body keys (#2760)',
    );
    assert.ok(
      parsedBefore.features && parsedBefore.features.child_agents_md === false,
      'preserves user feature keys above marker',
    );
    // #2406: the fresh block never emits a role table, so zero remain
    // anywhere in the file — not just above the marker.
    assert.strictEqual(countMatches(content, /^\[agents\.gsd-executor\]\s*$/gm), 0, 'zero role tables anywhere');
    assert.strictEqual(countMatches(content, /name = "gsd-executor"/g), 0, 'no name = field in struct format');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('case 2 idempotent after case 3 with existing [features]', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nother_feature = true\n');
    mergeCodexConfig(configPath, sampleBlock);
    const first = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const second = fs.readFileSync(configPath, 'utf8');

    mergeCodexConfig(configPath, sampleBlock);
    const third = fs.readFileSync(configPath, 'utf8');

    assert.strictEqual(first, second, 'idempotent after 2nd merge');
    assert.strictEqual(second, third, 'idempotent after 3rd merge');
  });

  test('preserves CRLF when appending GSD block to existing config', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('[model]\r\nname = "o3"\r\n'), 'preserves existing CRLF content');
    assert.ok(content.includes(`${GSD_CODEX_MARKER}\r\n`), 'writes marker with CRLF');
    assertUsesOnlyEol(content, '\r\n');
  });

  test('uses the first newline style when appending GSD block to mixed-EOL configs', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '# first line wins\n[model]\r\nname = "o3"\r\n', 'utf8');

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('# first line wins\n[model]\r\nname = "o3"'), 'preserves the existing mixed-EOL model content');
    assert.ok(content.includes(`\n\n${GSD_CODEX_MARKER}\n`), 'writes the managed block using the first newline style');
  });

  // ─── #3610: top-level keys below the marker must not be captured by [agents] ──
  //
  // Since #2088 the managed block opens with a bare `[agents]` table header. On
  // upgrade (marker present) the block is regenerated IN PLACE, so a top-level
  // key that lived below the marker (e.g. Codex Computer Use's `notify`) would
  // parse as an [agents] member — validateCodexConfigSchema correctly rejected
  // the merged file and the install aborted mid-flight.

  test('#3610: top-level keys below the marker are hoisted above the managed block and the merged file validates', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `${GSD_CODEX_MARKER}\n\nnotify = ["x", "turn-ended"]\n\n[features]\nhooks = true\n`,
    );

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `merged config must pass Codex schema validation: ${schema.reason || ''}`);
    const notifyIdx = content.indexOf('notify = ');
    const agentsIdx = content.indexOf('[agents]');
    assert.ok(notifyIdx !== -1 && agentsIdx !== -1, 'both the key and the agents table must be present');
    assert.ok(notifyIdx < agentsIdx, 'a surviving top-level key must precede the [agents] table header, not parse as its member');
    assert.ok(content.includes('[features]'), 'user tables below the marker are preserved after the block');
  });

  test('#3610 boundary: fresh install (no marker) with a top-level key still validates unchanged', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, 'notify = ["x", "turn-ended"]\n\n[features]\nhooks = true\n');

    mergeCodexConfig(configPath, sampleBlock);

    const schema = validateCodexConfigSchema(fs.readFileSync(configPath, 'utf8'));
    assert.ok(schema.ok, `fresh-install merge must validate: ${schema.reason || ''}`);
  });

  test('#3610 boundary: key above the marker is untouched by the hoist', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, `notify = ["x"]\n\n${GSD_CODEX_MARKER}\n\n[features]\nhooks = true\n`);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `control merge must validate: ${schema.reason || ''}`);
    assert.ok(content.indexOf('notify = ') < content.indexOf(GSD_CODEX_MARKER), 'the pre-marker key stays pre-marker');
  });

  test('#3610: a multiline top-level value below the marker hoists as one unit', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const multiline = 'notify = [\n  "x",\n  "turn-ended",\n]';
    fs.writeFileSync(configPath, `${GSD_CODEX_MARKER}\n\n${multiline}\n\n[features]\nhooks = true\n`);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `multiline hoist must validate: ${schema.reason || ''}`);
    const hoistedAt = content.indexOf(multiline);
    assert.ok(hoistedAt !== -1, 'the multiline value must survive the hoist intact');
    assert.ok(hoistedAt < content.indexOf('[agents]'), 'the whole multiline value lands above the table header');
  });

  test('#3610: hoisted keys land at FILE scope even when the pre-marker region ends inside a table', () => {
    // The default real-world layout: user tables ABOVE the marker, a top-level
    // key below it. Appending the key after the pre-marker tables would merely
    // capture it into THOSE tables ([features].notify) — the same defect class,
    // silent to validateCodexConfigSchema, which inspects only agents/hooks.
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `[features]\nhooks = true\n\n${GSD_CODEX_MARKER}\n\nnotify = ["x", "turn-ended"]\n\n[profiles.fast]\nmodel = "gpt-5"\n`,
    );

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `merge must validate: ${schema.reason || ''}`);
    const parsed = parseTomlToObject(content);
    assert.ok(Array.isArray(parsed.notify), 'the surviving key must parse as a top-level array');
    assert.ok(!parsed.features || !('notify' in parsed.features), 'the key must NOT be captured into the pre-marker [features] table');
    assert.ok(content.indexOf('notify = ') < content.indexOf('[features]'), 'file scope means before the FIRST table header, not just above the GSD block');
  });

  test('#3610: a top-level multiline STRING containing a table-header lookalike hoists intact', () => {
    // The record parser must not treat the [looks.like.a.header] line inside
    // the """ string as a table header (startsInMultilineString) — the split
    // must land after the whole value.
    const configPath = path.join(tmpDir, 'config.toml');
    const value = 'banner = """\nnot a [table.header] line\n"""\n';
    fs.writeFileSync(configPath, `${GSD_CODEX_MARKER}\n\n${value}\n[features]\nhooks = true\n`);

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `multiline-string hoist must validate: ${schema.reason || ''}`);
    const hoistedAt = content.indexOf(value.trim());
    assert.ok(hoistedAt !== -1, 'the multiline string must survive intact');
    assert.ok(hoistedAt < content.indexOf('[agents]'), 'the whole string value lands above the table header');
  });

  test('#3610: merging twice is idempotent (the first merge is a fixed point)', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `[features]\nhooks = true\n\n${GSD_CODEX_MARKER}\n\nnotify = ["x"]\n\n[profiles.fast]\nmodel = "gpt-5"\n`,
    );

    mergeCodexConfig(configPath, sampleBlock);
    const once = fs.readFileSync(configPath, 'utf8');
    mergeCodexConfig(configPath, sampleBlock);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), once, 'the second merge must not move anything');
  });

  test('#3610: CRLF config with a top-level key below the marker validates', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `${GSD_CODEX_MARKER}\r\n\r\nnotify = ["x", "turn-ended"]\r\n\r\n[features]\r\nhooks = true\r\n`,
    );

    mergeCodexConfig(configPath, sampleBlock);

    const content = fs.readFileSync(configPath, 'utf8');
    const schema = validateCodexConfigSchema(content);
    assert.ok(schema.ok, `CRLF upgrade merge must validate: ${schema.reason || ''}`);
    assert.ok(content.indexOf('notify = ') < content.indexOf('[agents]'), 'hoist holds under CRLF');
  });
});
