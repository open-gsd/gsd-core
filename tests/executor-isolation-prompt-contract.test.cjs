'use strict';

/**
 * #3637 — the orchestrator-worktree process spawn must carry the gsd-executor
 * identity and execution contract, not a short objective-only prompt.
 *
 * The process-spawned child has NO host subagent machinery: nothing loads the
 * gsd-executor agent definition or the execute-plan workflow unless the
 * EXECUTOR_PROMPT carries them. A short prompt forced both reporters' executors
 * to reconstruct their role from repository search AND left them unaware of the
 * gitignored-planning skip semantics — so they force-staged gitignored
 * SUMMARY.md files (`git add -f`) to satisfy an unconditional
 * "SUMMARY.md created AND committed" criterion.
 *
 * These are source-text-is-the-product assertions: the workflow markdown IS
 * what the orchestrator runtime loads, and the contract checked here is the
 * documented dispatch text, per the issue's acceptance list. The #5531 compose
 * blocks run in real bash in tests/executor-isolation-dispatch.integration.test.cjs;
 * only the checks that no shell run can show stay here.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');
const { DISPATCH_STEP_PATH } = require('./qa/tdd-walk.cjs');
const { substitutePlaceholders } = require('../scripts/lint-workflow-shellcheck.cjs');
const { scanFencedBlocks, extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
// Read at run time, so a missing fragment fails one hook, not the load of the file.
let content;
before(() => {
  content = readFileNormalized(DISPATCH_STEP_PATH);
});

/** The prompt template: the `text` fence the orchestrator writes to PROMPT_FILE. */
function promptBody() {
  assert.equal(content.split('\n').filter((l) => l.trim() === '```text').length, 1, 'the fragment must hold exactly one text fence: the prompt template');
  const body = extractFencedBlock(content, 'text');
  assert.notEqual(body, null, 'the text fence must close');
  return body + '\n';
}

test('#3637: the executor prompt carries the required-reading contract with the explicit plan path', () => {
  const body = promptBody();
  assert.match(body, /<required_reading>/, 'the prompt must carry the required-reading contract');
  assert.match(body, /\{phase_dir\}\/\{plan_file\}/, 'the prompt must name the explicit plan path');
  assert.match(body, /PROJECT\.md/, 'project context is required reading');
});

test('#3637: the executor prompt carries the execution-context build-time embeds', () => {
  const body = promptBody();
  assert.match(body, /<execution_context>/, 'the prompt must carry an execution_context block');
  assert.match(body, /execute-plan\.md/, 'execute-plan.md must be embedded (the executor workflow)');
  assert.match(body, /worktree-path-safety\.md/, 'worktree path safety must be embedded');
});

test('#3637: the success criteria make an intentional gitignored skip a success path and forbid force-staging', () => {
  const body = promptBody();
  assert.match(body, /skipped_gitignored/, 'skipped_gitignored must be named as an intentional success path');
  assert.match(body, /git add -f/, 'force-staging must be explicitly forbidden');
  assert.doesNotMatch(
    body,
    /SUMMARY\.md created AND committed(?![^\n]*OR)/,
    'the unconditional "created AND committed" criterion that drove git add -f must not appear bare',
  );
});

test('#3637: the gsd-executor ROLE DEFINITION is a mandatory embed with provenance', () => {
  // The agent-skills query alone is conditional (its block is a skills list
  // whenever the project configures agent_skills; only unconfigured
  // non-Claude projects get the full agent file via the #2454 fallback).
  // The child has no host subagent machinery — the role definition itself
  // must ride the prompt (#3637 acceptance bullets 1 and 5).
  const body = promptBody();
  assert.match(body, /agents\/gsd-executor\.md/, 'the role definition file must be named as an embedded source');
  assert.match(body, /steps\s*0\/0a\/0b/, 'the per-commit HEAD/cwd-drift/path-guard discipline must be pointed at');
});

test('#3637: prior-wave summaries are required reading (parallel waves must not clobber siblings)', () => {
  const body = promptBody();
  assert.match(body, /prior_wave_summaries/, 'prior-wave SUMMARY files must be required reading on this parallel-wave backend');
});

test('#3637: the persona rides the prompt (${AGENT_SKILLS}), same as the harness path', () => {
  assert.match(promptBody(), /\$\{AGENT_SKILLS\}/, 'the gsd-executor persona variable must be spliced into the prompt');
});

test('#5531: the substitution instruction names every placeholder any fenced block of the fragment uses', () => {
  const lines = content.split('\n');
  const sentence = lines.find((l) => l.includes('Before running each bash block below'));
  assert.ok(sentence, 'the substitution instruction exists');
  const blocks = scanFencedBlocks(lines);
  assert.ok(blocks.every((b) => b.closeLineIdx !== -1), 'every fenced block of the fragment closes');
  const bodies = blocks.map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  const named = [...sentence.matchAll(/`(\{[^`}]+\})`/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'the instruction names placeholders');
  for (const text of bodies) {
    const rest = named.reduce((acc, token) => acc.replaceAll(token, ''), text);
    assert.equal(substitutePlaceholders(rest), rest, 'a placeholder of a fenced block is missing from the instruction');
  }
});

// ─── #5531: what no bash run of the compose blocks can show ───

test('#5531: the template text sits in no bash block and the instruction has the orchestrator write it with the file tool', () => {
  // The bash run starts from a file that already exists; it cannot show how the orchestrator makes that file.
  const lines = content.split('\n');
  const bashBodies = scanFencedBlocks(lines).filter((b) => b.infoString === 'bash').map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
  assert.ok(bashBodies.length > 0, 'the fragment holds bash blocks');
  for (const marker of ['<objective>', '<mcp_tools>', '[gsd:dispatch']) {
    assert.ok(!bashBodies.some((body) => body.includes(marker)), `${marker} must sit in no bash block`);
  }
  assert.ok(content.includes('with your file-writing tool and never through the shell'), 'the template is written with the file tool');
});

test('#5531: the template carries the two markers that only the read-and-check guards look for', () => {
  // The bash run feeds the guards its own files; it cannot show that the shipped template holds the markers.
  // The other three markers are asserted on the template by the #3637 tests above.
  const body = promptBody();
  for (const marker of ['Inline the actual contents', '${TDD_APPLICABLE']) {
    assert.ok(body.includes(marker), `the template carries ${marker}, so a skipped compose step leaves it for a guard to find`);
  }
});

test('#5531: the two compose blocks declare the same prompt file name prefix', () => {
  // The blocks run as separate commands, so each declares the prefix; a run of one block cannot show they agree.
  const lines = content.split('\n');
  const prefixes = scanFencedBlocks(lines)
    .filter((b) => b.infoString === 'bash')
    .flatMap((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx))
    .filter((l) => l.startsWith('_PROMPT_PREFIX='));
  assert.equal(prefixes.length, 2, 'block 1 and the read-and-check block each declare the prefix');
  assert.equal(new Set(prefixes).size, 1, 'both declare the same prefix');
});

test('#5531: the two compose blocks derive the wave-keyed prompt file name the same way', () => {
  // The blocks run as separate commands, so each derives the name; a run of one block cannot show they agree.
  const lines = content.split('\n');
  const bash = scanFencedBlocks(lines)
    .filter((b) => b.infoString === 'bash')
    .flatMap((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx));
  const stem = bash.filter((l) => l.startsWith('_PROMPT_STEM='));
  const name = bash.filter((l) => l.startsWith('_PROMPT_NAME='));
  assert.equal(stem.length, 1, 'block 1 derives the stem once');
  assert.equal(name.length, 1, 'the read-and-check block derives the name once');
  assert.equal(name[0].replace('_PROMPT_NAME=', ''), stem[0].replace('_PROMPT_STEM=', '').replace(/"$/, '-??????"'), 'the name is the stem plus the random suffix');
  // Block 1 builds the file from the same stem: the sweep and leftover patterns and the mktemp template share it, with a 6-wide suffix.
  assert.ok(bash.some((l) => l.includes('-name "${_PROMPT_STEM}-??????"')), 'the leftover removal matches the stem plus the 6-wide suffix');
  assert.ok(bash.some((l) => l.includes('mktemp "${ORCH_ROOT}/.claude/${_PROMPT_STEM}-XXXXXX"')), 'mktemp creates the stem plus a 6-wide suffix');
});

test('#5531: the wave name shape the prompt file carries is the one execute-phase.md gives the manifest', () => {
  // The integration test builds wave names of this shape by hand.
  const executePhase = readFileNormalized(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'));
  assert.ok(executePhase.includes('mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX"'), 'the manifest is named gsd-worktree-wave-XXXXXX');
});
