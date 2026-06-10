// allow-test-rule: source-text-is-the-product
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
  const headingIdx = src.indexOf('## C. Task() → spawn_agent Mapping');
  assert.ok(headingIdx >= 0, 'Section C heading must exist in bin/install.js');
  const closeTag = src.indexOf('</codex_skill_adapter>', headingIdx);
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
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'),
      'Adapter must still instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
