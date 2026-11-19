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
 * what the orchestrator runtime loads. The contract checked here is the
 * documented dispatch text, per the issue's acceptance list.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

/** The EXECUTOR_PROMPT single-quoted assignment body. */
function promptBody() {
  const start = content.indexOf("EXECUTOR_PROMPT='<objective>");
  const end = content.indexOf("</success_criteria>'", start);
  assert.ok(start !== -1 && end !== -1, 'EXECUTOR_PROMPT assignment must exist');
  return content.slice(start, end);
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

test('#3637: the compose step fails closed when the embeds are missing', () => {
  assert.match(
    content,
    /grep -q '<required_reading>'[\s\S]{0,400}exit 1/,
    'a prompt missing the required-reading contract must halt before spawn',
  );
  assert.match(
    content,
    /grep -q 'skipped_gitignored'[\s\S]{0,400}exit 1/,
    'a prompt missing the skip semantics must halt before spawn',
  );
});

test('#3637: embed PERFORMANCE is gated — an un-embedded template halts before spawn', () => {
  // The two template-completeness greps above cannot detect skipped embeds
  // (the placeholders live in the template itself). The performance gates
  // catch the raw-template dispatch: the provenance parenthetical must be
  // GONE and the persona marker must be substituted (#3637 review finding).
  assert.match(
    content,
    /grep -q 'Inline the actual contents'[\s\S]{0,300}exit 1/,
    'a prompt still carrying its compose-time placeholder means the embeds were skipped — halt',
  );
  assert.match(
    content,
    /grep -q '\\\$\{AGENT_SKILLS\}'[\s\S]{0,300}exit 1/,
    'an un-substituted persona marker means the role definition was not spliced — halt',
  );
});

test('#4266: embed PERFORMANCE is gated — an un-substituted TDD_APPLICABLE marker halts before spawn', () => {
  // Matches the ${AGENT_SKILLS} gate immediately above: a third performance gate for
  // the #4266/#4272 TDD-applicability predicate, halting before worktree creation
  // when the marker survives composition.
  assert.match(
    content,
    /grep -q '\\\$\{TDD_APPLICABLE'[\s\S]{0,300}exit 1/,
    'an un-substituted TDD_APPLICABLE marker means the TDD-applicability decision was not resolved into the prompt — halt',
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

test('#3637: the prompt body contains no single-quote character (single-quoted assignment)', () => {
  const body = promptBody();
  const startQuote = body.indexOf("'");
  const rest = body.slice(startQuote + 1);
  assert.ok(!rest.includes("'"), 'the prompt body must be free of apostrophes or the shell assignment breaks');
});

// ─── #5934: quick-batch reuses this fragment, so every placeholder it substitutes needs a value ─────

const QUICK_STEP = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'quick-batch', 'steps', 'worktree-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the quick-batch dispatch step is runtime-loaded workflow text (#5934)
const quickContent = fs.readFileSync(QUICK_STEP, 'utf8');

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
