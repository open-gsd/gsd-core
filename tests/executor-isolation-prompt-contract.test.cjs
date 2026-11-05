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
 * what the orchestrator runtime loads, and the contract checked there is the
 * documented dispatch text, per the issue's acceptance list. The #5531 compose
 * tests start no shell: they check the fragment's bash blocks as text, so they
 * prove the blocks' shape, not what a shell does with them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileNormalized } = require('./helpers.cjs');
const { DISPATCH_STEP_PATH, extractFencedBashBlockContaining } = require('./qa/tdd-walk.cjs');

// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = readFileNormalized(DISPATCH_STEP_PATH);

/** The prompt template: the `text` fence the orchestrator writes to PROMPT_FILE. */
function promptBody() {
  const open = content.indexOf('```text\n');
  assert.ok(open !== -1, 'the prompt template must sit in a text fence');
  const close = content.indexOf('\n```', open + 8);
  assert.ok(close !== -1, 'the text fence must close');
  return content.slice(open + 8, close + 1);
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

test('#5531: the substitution instruction covers every bash block and every plan identifier it uses', () => {
  assert.match(content, /replace `\{phase_dir\}`, `\{plan_file\}`, `\{plan_number\}`, `\{phase_number\}` and `\{plan_padded\}`/, 'every bash block gets the identifiers substituted');
});

test('#5531: the dispatch prose names what crosses between blocks', () => {
  assert.match(content, /`\$ORCH_ROOT`[^\n]*`\$EXECUTOR_PROMPT`/, 'the prose names what does cross between blocks');
});

test('#5531: the dispatch prose covers the cleanup of every halt before the read-and-check block', () => {
  assert.ok(content.includes('halt before the read-and-check block'), 'cleanup covers every halt before the read-and-check block');
});

test('#5531: the dispatch prose says what the read-back does to CRLF, a BOM, NUL bytes and trailing newlines', () => {
  assert.ok(content.includes('a CRLF or BOM'), 'the prose says what a CRLF or BOM in the written file does');
  assert.ok(content.includes('trailing newlines and NUL bytes'), 'the prose names the bytes `$(...)` drops');
});

test('#5531: the Step 2 comment keeps the {plan_id} clause on one line', () => {
  assert.ok(content.includes("{plan_id} is this plan's `id` field"), 'the Step 2 comment keeps the {plan_id} clause on one line');
});

// ─── #5531: the compose blocks, checked as text (no shell is spawned) ───

const READ = 'EXECUTOR_PROMPT=$(cat -- "$PROMPT_FILE")';
const CREATE = 'PROMPT_FILE=$(mktemp';
const createBlock = () => extractFencedBashBlockContaining(content, CREATE);
const readBlock = () => extractFencedBashBlockContaining(content, READ);

/** True when every `$VAR` use on its line sits inside an unescaped pair of double quotes. */
function everyUseQuoted(block, variable) {
  const use = new RegExp(`\\$\\{?${variable}\\}?`, 'g');
  return block.split('\n').filter((l) => !l.trimStart().startsWith('#')).every((line) => {
    const bare = line.replace(/\\./g, '__');
    return [...bare.matchAll(use)].every((m) => (bare.slice(0, m.index).match(/"/g) ?? []).length % 2 === 1);
  });
}

test('#5531: the template reaches the shell only as file bytes: no heredoc, eval or shell assignment carries its text', () => {
  for (const marker of ['<objective>', '<mcp_tools>', '[gsd:dispatch']) {
    assert.throws(() => extractFencedBashBlockContaining(content, marker), /no fenced bash block contains/, `${marker} must sit in no bash block`);
  }
  for (const block of [createBlock(), readBlock()]) {
    const code = block.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    assert.ok(!/<<|\beval\b|\bsource\b/.test(code), 'no heredoc, eval or source in a compose block');
  }
  assert.equal(readBlock().match(/EXECUTOR_PROMPT=/g).length, 1, 'one EXECUTOR_PROMPT assignment');
  assert.ok(content.includes('with your file-writing tool and never through the shell'), 'the template is written with the file tool');
});

const PATTERN = "'gsd-executor-prompt-{phase_number}-{plan_number}-??????'";
const FIND = 'find "${ORCH_ROOT}/.claude" -maxdepth 1 -name ' + PATTERN;

test('#5531: block 1 text: creates the prompt file under ORCH_ROOT/.claude and halts loudly when it cannot', () => {
  const block = createBlock();
  const at = (s) => block.indexOf(s);
  const mkdir = 'mkdir -p "${ORCH_ROOT}/.claude" || { echo "FATAL';
  const rm = FIND + ' -exec rm -f -- {} + || { echo "FATAL';
  const mktemp = 'PROMPT_FILE=$(mktemp "${ORCH_ROOT}/.claude/gsd-executor-prompt-{phase_number}-{plan_number}-XXXXXX") || { echo "FATAL';
  const printed = 'echo "PROMPT_FILE=$PROMPT_FILE"';
  for (const s of [mkdir, rm, mktemp, printed]) assert.ok(at(s) !== -1, `block 1 has: ${s}`);
  assert.ok(at(mkdir) < at(rm) && at(rm) < at(mktemp) && at(mktemp) < at(printed), 'mkdir, leftover removal, mktemp, print: in that order');
  assert.ok(/\{ echo "FATAL[^\n]*>&2; exit 1; \}/.test(block.slice(at(mkdir), at(rm))), 'a failed mkdir exits 1 with FATAL on stderr');
  assert.ok(/-exec rm -f -- \{\} \+ \|\| \{ echo "FATAL[^\n]*>&2; exit 1; \}/.test(block), 'a failed leftover removal exits 1 with FATAL on stderr');
  assert.ok(/-XXXXXX"\) \|\| \{ echo "FATAL[^\n]*>&2; exit 1; \}/.test(block), 'a failed mktemp exits 1 with FATAL on stderr');
});

test("#5531: one plan-keyed name pattern owns the leftover removal and the lookup, and no shell glob is left in either block", () => {
  const re = /-name '(gsd-executor-prompt-\{phase_number\}-\{plan_number\}-\?{6})'/g;
  const removal = [...createBlock().matchAll(re)].map((m) => m[1]);
  const lookups = [...readBlock().matchAll(re)].map((m) => m[1]);
  assert.equal(removal.length, 1, 'block 1 removes leftovers by the pattern');
  assert.equal(lookups.length, 2, 'block 2 looks the file up and removes every match on a halt by the same pattern');
  assert.equal(new Set([...removal, ...lookups]).size, 1, 'one pattern text in all three places');
  const match = (plan, name) => new RegExp(`^${removal[0].replace('{phase_number}', '7').replace('{plan_number}', plan).replace('?'.repeat(6), '.{6}')}$`).test(name);
  assert.ok(match('3', 'gsd-executor-prompt-7-3-abcdef'), 'this plan leftover matches');
  assert.ok(!match('3', 'gsd-executor-prompt-7-9-abcdef'), "another plan's file stays");
  assert.ok(!match('3', 'gsd-executor-prompt-7-30-abcdef'), 'plan 30 is not plan 3');
  for (const block of [createBlock(), readBlock()]) {
    const code = block.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n').replace(/'[^']*'|"[^"]*"/g, '""').replaceAll('$?', '');
    assert.ok(!code.includes('?'), 'a ? outside quotes is a shell glob, which some shells treat as fatal when it matches nothing');
    assert.ok(!/\bfor\b[^\n]*\bin\b/.test(code), 'no for-list takes the place of the lookup');
  }
});

test('#5531: block 2 text: finds the file by the pattern, halts on no match or more than one match, and removes every match first', () => {
  const block = readBlock();
  const at = (s) => block.indexOf(s);
  const lookup = 'PROMPT_FILE=$(' + FIND + ' 2>/dev/null || :)\ncase "$PROMPT_FILE" in\n';
  const arm = "  ''|*'\n'*)\n    " + FIND + ' -exec rm -f -- {} + 2>/dev/null || :\n    echo "FATAL';
  assert.ok(at(lookup) !== -1, 'the lookup assigns PROMPT_FILE from find and switches on it');
  assert.ok(at(arm) > at(lookup), 'the empty and the newline-containing value (two matches) share the halting arm');
  assert.ok(/exit 1 ;;\nesac\n/.test(block.slice(at(arm))), 'the arm exits 1 before the read');
  assert.ok(at('esac') < at(READ), 'the halt comes before the read');
  assert.equal(block.match(/PROMPT_FILE=/g).length, 1, 'PROMPT_FILE is assigned once, by the lookup');
});

test('#5531: block 2 text: reads the file in its own command and removes it before the read status and every check can halt', () => {
  const block = readBlock();
  const at = (s) => block.indexOf(s);
  const order = [
    'PROMPT_FILE=$(find',
    'case "$PROMPT_FILE" in',
    'if EXECUTOR_PROMPT=$(cat -- "$PROMPT_FILE"); then _PROMPT_RC=0; else _PROMPT_RC=$?; fi',
    'rm -f -- "$PROMPT_FILE" || :',
    '[ "$_PROMPT_RC" -eq 0 ] || { echo "FATAL: executor prompt file',
    '[ -n "$EXECUTOR_PROMPT" ] || { echo "FATAL: executor prompt is empty',
    "grep -q '<required_reading>'",
  ];
  order.reduce((prev, s) => {
    assert.ok(at(s) > prev, `in order: ${s}`);
    return at(s);
  }, -1);
  assert.ok(block.trimEnd().endsWith('fi'), 'the block ends with an if, so a passing compose returns 0 under set -e');
});

test('#5531: block 2 text: five guards halt on a truncated template or an un-substituted marker, and the template carries each marker', () => {
  const needles = [...readBlock().matchAll(/printf '%s' "\$EXECUTOR_PROMPT" \| grep -q '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(needles, ['<required_reading>', 'skipped_gitignored', 'Inline the actual contents', '\\${AGENT_SKILLS}', '\\${TDD_APPLICABLE']);
  const body = promptBody();
  for (const marker of ['<required_reading>', 'skipped_gitignored', 'Inline the actual contents', '${AGENT_SKILLS}', '${TDD_APPLICABLE']) {
    assert.ok(body.includes(marker), `the template carries ${marker}, so a skipped compose step leaves it for a guard to find`);
  }
});

test('#5531: ORCH_ROOT and PROMPT_FILE are only ever expanded inside double quotes, so path text is data', () => {
  for (const block of [createBlock(), readBlock()]) {
    for (const variable of ['ORCH_ROOT', 'PROMPT_FILE']) assert.ok(everyUseQuoted(block, variable), `${variable} is quoted on every use`);
  }
});
