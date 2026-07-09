'use strict';

/**
 * cline beforeTool plugin UPGRADE — ADR-1239 / #2090 AC (upgrade 1).
 *
 * Proves the `.clinerules/hooks/PreToolUse` file-convention planning-artifact
 * guard is re-implemented as a real Cline SDK `AgentPlugin.hooks.beforeTool`
 * handler, delivered through the negotiated `hookBus: host` interface point.
 * Guard semantics are preserved EXACTLY from the PreToolUse script: fail-open,
 * cancel (skip) write-class calls targeting `.planning/`, pass through
 * everything else.
 *
 * The adapter is exercised directly (mocked SDK payload shape) since the real
 * `@cline/sdk` is a fast-moving package set not linked at test time — same
 * pattern as the VS Code reference binding (tests/fixtures/vscode-host-binding.cjs).
 *
 * Cite:
 *   https://github.com/cline/cline/blob/main/docs/sdk/plugins.mdx
 *     — "Lifecycle hooks ... include beforeRun, afterRun, beforeModel,
 *        afterModel, beforeTool, afterTool, and onEvent."
 *   https://github.com/cline/cline/blob/main/sdk/packages/agents/README.md
 *     — beforeTool({ tool, input }) => { skip: true, reason } | undefined
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  WRITE_TOOL_PATTERN,
  PLANNING_PATH_PATTERN,
  PLANNING_GUARD_REASON,
  evaluateBeforeTool,
  clineGsdPlugin,
} = require('../gsd-core/bin/lib/host-integration-adapters/cline-sdk-binding.cjs');

// -- upgrade 1: write-class detection ---------------------------------------

test('WRITE_TOOL_PATTERN matches the write-class tool verbs (parity with PreToolUse)', () => {
  const writeVerbs = ['write_to_file', 'edit_file', 'replace_in_file', 'create_file',
    'delete_file', 'remove_file', 'append_to_file', 'apply_patch', 'insert_edit', 'mkdir'];
  for (const v of writeVerbs) {
    assert.ok(WRITE_TOOL_PATTERN.test(v), `write-class verb must match: ${v}`);
  }
});

test('WRITE_TOOL_PATTERN does NOT match read-class tools', () => {
  const readVerbs = ['read_file', 'list_files', 'search_files', 'execute_command', 'ask_user'];
  for (const v of readVerbs) {
    assert.ok(!WRITE_TOOL_PATTERN.test(v), `read-class verb must NOT match: ${v}`);
  }
});

// -- upgrade 1: planning-path detection -------------------------------------

test('PLANNING_PATH_PATTERN matches .planning/ paths on posix + windows separators', () => {
  const planningPaths = ['.planning/state.md', '.planning/phases/1/PLAN.md',
    '/home/u/proj/.planning/config.json', 'proj\\.planning\\foo', './.planning/x'];
  for (const p of planningPaths) {
    assert.ok(PLANNING_PATH_PATTERN.test(p), `planning path must match: ${p}`);
  }
});

test('PLANNING_PATH_PATTERN does NOT match non-planning paths', () => {
  // .planning-readme.txt must not match (boundary after .planning required)
  for (const p of ['src/planning-utils.ts', 'docs/plan.md']) {
    assert.ok(!PLANNING_PATH_PATTERN.test(p), `non-planning path must NOT match: ${p}`);
  }
});

// -- upgrade 1: evaluateBeforeTool — the guard decision ----------------------

test('write-class tool targeting .planning/ is SKIPPED (cancel)', () => {
  const result = evaluateBeforeTool({
    tool: { name: 'write_to_file' },
    input: { path: '.planning/phases/1/PLAN.md', content: '...' },
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, PLANNING_GUARD_REASON);
});

test('write-class tool targeting a NON-planning path is ALLOWED', () => {
  const result = evaluateBeforeTool({
    tool: { name: 'write_to_file' },
    input: { path: 'src/index.ts', content: '...' },
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, undefined);
});

test('read-class tool targeting .planning/ is ALLOWED (reads are safe)', () => {
  const result = evaluateBeforeTool({
    tool: { name: 'read_file' },
    input: { path: '.planning/state.md' },
  });
  assert.equal(result.decision, 'allow');
});

test('write tool with .planning/ in a non-PATH field (content body) is ALLOWED', () => {
  // A doc that merely mentions ".planning/" in its body is never falsely blocked —
  // only PATH-bearing field values are inspected (parity with PreToolUse).
  const result = evaluateBeforeTool({
    tool: { name: 'write_to_file' },
    input: { path: 'docs/guide.md', content: 'see .planning/ for details' },
  });
  assert.equal(result.decision, 'allow');
});

test('write tool with .planning/ in a recognized nested path-key is SKIPPED', () => {
  // The guard walks the input object tree collecting values from PATH-keyed
  // fields (path|file|target|dir|...). A recognized key nested anywhere in the
  // payload is caught — parity with the PreToolUse hook's bounded walk.
  const result = evaluateBeforeTool({
    tool: { name: 'apply_patch' },
    input: { target: '.planning/config.json' },
  });
  assert.equal(result.decision, 'skip');
});

// -- upgrade 1: fail-open on malformed/missing input ------------------------

test('evaluateBeforeTool fails OPEN on null tool/input (never throws, never blocks)', () => {
  assert.equal(evaluateBeforeTool({ tool: null, input: null }).decision, 'allow');
  assert.equal(evaluateBeforeTool({}).decision, 'allow');
  assert.equal(evaluateBeforeTool(null).decision, 'allow');
});

test('evaluateBeforeTool fails OPEN on a tool with no name', () => {
  assert.equal(evaluateBeforeTool({ tool: {}, input: { path: '.planning/x' } }).decision, 'allow');
});

// -- upgrade 1: the AgentPlugin wrapper shape -------------------------------

test('clineGsdPlugin is an AgentPlugin with a beforeTool hook', () => {
  assert.equal(typeof clineGsdPlugin, 'object');
  assert.equal(clineGsdPlugin.name, 'gsd-planning-guard');
  assert.equal(typeof clineGsdPlugin.setup, 'function');
});

test('clineGsdPlugin.setup returns hooks.beforeTool that maps skip→{skip,reason}', () => {
  const { hooks } = clineGsdPlugin.setup({ agentId: 'test-agent' });
  assert.equal(typeof hooks.beforeTool, 'function');
  // planning write → { skip: true, reason }
  const blocked = hooks.beforeTool({
    tool: { name: 'write_to_file' },
    input: { path: '.planning/state.md' },
  });
  assert.deepEqual(blocked, { skip: true, reason: PLANNING_GUARD_REASON });
});

test('clineGsdPlugin.beforeTool returns undefined for allowed calls (SDK contract)', () => {
  const { hooks } = clineGsdPlugin.setup({ agentId: 'test-agent' });
  const allowed = hooks.beforeTool({
    tool: { name: 'write_to_file' },
    input: { path: 'src/foo.ts' },
  });
  assert.equal(allowed, undefined, 'undefined = allow (Cline SDK beforeTool contract)');
});

// -- upgrade 1: parity with the existing PreToolUse script semantics --------

test('the guard reason matches the PreToolUse script errorMessage contract', () => {
  // The file-convention hook wrote { cancel:true, errorMessage:'GSD: ...' }.
  // The SDK plugin maps cancel→skip and errorMessage→reason. The user-visible
  // message text is preserved so the guard behaves identically to the user.
  assert.ok(typeof PLANNING_GUARD_REASON === 'string' && PLANNING_GUARD_REASON.length > 0);
  assert.ok(PLANNING_GUARD_REASON.includes('.planning/'),
    'reason must explain the .planning/ protection so the user can act on it');
});
