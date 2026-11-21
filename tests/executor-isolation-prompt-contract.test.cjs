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
const { DISPATCH_STEP_PATH, TDD_EMBED_TERNARY } = require('./qa/tdd-walk.cjs');
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
  // #5861: required reading names the scope-resolved placeholders, not root `.planning/` literals
  assert.match(body, /\{project_rel\}/, 'project context is required reading');
  assert.match(body, /\{state_rel\}/, 'state is required reading');
  assert.match(body, /\{config_rel\}/, 'config is required reading');
  assert.doesNotMatch(body, /\.planning\/(?:PROJECT|STATE)\.md|\.planning\/config\.json/, 'no root .planning/ literal in required reading');
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

test('#5531: the instruction says the whole conditional line, its trailing comment included, is replaced', () => {
  // The bash run cannot show what the file-writing model keeps: a comment left on the line reaches the executor prompt.
  const embedLine = promptBody().split('\n').find((l) => l.startsWith(TDD_EMBED_TERNARY));
  assert.ok(embedLine, 'the template holds the conditional embed line');
  assert.match(embedLine, /\s#\s/, 'the conditional line carries a trailing comment');
  assert.match(content, /replace the whole line, its trailing `#` comment included, with `- tdd\.md` when the verdict is `true` and with nothing otherwise/, 'the instruction replaces the whole line');
});

test('#5531: the wave name shape the prompt file carries is the one execute-phase.md gives the manifest', () => {
  // The integration test builds wave names of this shape by hand.
  const executePhase = readFileNormalized(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md'));
  assert.ok(executePhase.includes('mktemp "${TMPDIR:-/tmp}/gsd-worktree-wave-XXXXXX"'), 'the manifest is named gsd-worktree-wave-XXXXXX');
});

// ─── #5934: quick-batch reuses this fragment, so every placeholder it substitutes needs a value ─────

const QUICK_STEP = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'quick-batch', 'steps', 'worktree-dispatch.md',
);

/** The placeholders the fragment itself says the orchestrator substitutes ("Substitute this plan's ... placeholders"). */
function substitutedPlaceholders() {
  const sentence = content.match(/Substitute this plan's([\s\S]{0,400}?)placeholders/);
  assert.ok(sentence, 'the fragment must state its substitution list');
  const names = [...sentence[1].matchAll(/\{([a-z][a-z_]*)\}/g)].map((m) => m[1]);
  assert.ok(names.length >= 7, `the fragment's substitution list must name at least the 7 known placeholders, saw ${names.length}`);
  return names;
}

/** The quick-batch step's `orchestrator-worktree` bullet. */
function quickOrchestratorWorktreeBullet() {
  // allow-test-rule: source-text-is-the-product the quick-batch dispatch step is runtime-loaded workflow text (#5934)
  const quickContent = readFileNormalized(QUICK_STEP);
  const start = quickContent.indexOf('**`isolation == "orchestrator-worktree"`:**');
  const end = quickContent.indexOf('**`isolation == "none"`:**', start);
  assert.ok(start !== -1 && end !== -1, 'the quick-batch orchestrator-worktree bullet must exist');
  return quickContent.slice(start, end);
}

test('#5934: quick-batch gives every orchestrator-worktree placeholder a value or a stated not-applicable', () => {
  const bullet = quickOrchestratorWorktreeBullet();
  for (const name of substitutedPlaceholders()) {
    const mention = bullet.split('\n').find((line) => line.includes(`{${name}}`));
    assert.ok(mention, `the quick-batch step never names {${name}}, which the reused fragment substitutes`);
    // Either an explicit mapping (`{name}` = `value`) or named in a sentence that says it is not applicable.
    const mapped = new RegExp(`\`\\{${name}\\}\`\\s*=\\s*\`[^\`\\n]{1,80}\``).test(bullet);
    const notApplicable = bullet
      .split('\n')
      .some((line) => line.includes(`\`{${name}}\``) && /\b(?:is|are) not applicable\b/.test(line));
    assert.ok(mapped || notApplicable, `{${name}} is named but has neither a mapped value nor a stated "not applicable" for a quick item`);
  }
});

test('#5934: the not-applicable placeholders name what the prompt carries instead and the omitted marker', () => {
  const bullet = quickOrchestratorWorktreeBullet();
  assert.match(bullet, /Execute quick item \$\{quick_id\}/, 'the prompt header for a quick item must be stated');
  assert.match(
    bullet,
    /omit[^\n]*\[gsd:dispatch/i,
    'the [gsd:dispatch ...] marker line must be stated as omitted for a quick item',
  );
});

test('#5934: the summary path for a quick item has no placeholder left', () => {
  const bullet = quickOrchestratorWorktreeBullet();
  assert.match(bullet, /`\{plan_padded\}`\s*=\s*`\$\{quick_id\}`/, '{plan_padded} must map to the quick id');
  assert.match(bullet, /\$\{ITEM_DIR\}\/\$\{quick_id\}-SUMMARY\.md/, 'the worker-record summary path must be spelled out');
});
