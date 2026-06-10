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

describe('bug #851: Codex adapter documents multi_agent_v1 schema limitation and fallback', () => {
  test('adapter does NOT claim typed spawn_agent(agent_type=...) works unconditionally', () => {
    // The direct-mapping bullet must not exist as a bare unconditional statement;
    // it must be wrapped in a schema-conditioned block (multi_agent_v2 / typed schema).
    // We check that the Section C heading is followed by schema-awareness language,
    // not a naked "Direct mapping:" claim that ignores the schema version.
    const sectionC = src.slice(src.indexOf('## C. Task() → spawn_agent Mapping'));
    const endOfSectionC = sectionC.indexOf('</codex_skill_adapter>');
    const sectionCText = sectionC.slice(0, endOfSectionC);

    // Must contain schema-conditional language
    assert.ok(
      sectionCText.includes('multi_agent_v1') || sectionCText.includes('schema version') || sectionCText.includes('agent_type-capable'),
      'Section C must acknowledge that typed agent_type spawning is schema-version-dependent (multi_agent_v1 vs typed/v2 schema)',
    );
  });

  test('adapter documents generic-subagent fallback for multi_agent_v1 sessions', () => {
    const sectionC = src.slice(src.indexOf('## C. Task() → spawn_agent Mapping'));
    const endOfSectionC = sectionC.indexOf('</codex_skill_adapter>');
    const sectionCText = sectionC.slice(0, endOfSectionC);

    // Must document the fallback for when only message/items/fork_context are available
    assert.ok(
      sectionCText.includes('multi_agent_v1') && sectionCText.includes('message'),
      'Section C must document the generic spawn_agent(message=...) fallback for multi_agent_v1 schema sessions',
    );
  });

  test('adapter labels generic-subagent workaround as NOT equivalent to typed gsd-planner/gsd-executor', () => {
    const sectionC = src.slice(src.indexOf('## C. Task() → spawn_agent Mapping'));
    const endOfSectionC = sectionC.indexOf('</codex_skill_adapter>');
    const sectionCText = sectionC.slice(0, endOfSectionC);

    // The fallback must be labeled as a workaround, not presented as equivalent
    assert.ok(
      sectionCText.includes('workaround') || sectionCText.includes('not equivalent') || sectionCText.includes('generic-agent'),
      'Section C must label the multi_agent_v1 generic-spawn path as a workaround, not equivalent to typed gsd-planner/gsd-executor invocation',
    );
  });

  test('adapter still documents typed agent_type spawn for sessions that support it', () => {
    // Typed mapping must still appear — for multi_agent_v2 / agent_type-capable sessions
    assert.ok(
      /spawn_agent\(agent_type=/.test(src) || /spawn_agent\(agent_type=["']/.test(src) ||
      src.includes('agent_type-capable') || /agent_type.*multi_agent_v2/.test(src),
      'Adapter must still document typed spawn_agent(agent_type=...) for schema versions that support it',
    );
  });

  test('adapter deferred tool discovery instruction is preserved', () => {
    // The pre-existing bug-279 contract must remain intact
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'),
      'Adapter must still instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
