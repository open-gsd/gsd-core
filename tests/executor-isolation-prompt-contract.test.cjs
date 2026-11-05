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
 * The prompt-template and prose tests are source-text-is-the-product
 * assertions: the workflow markdown IS what the orchestrator runtime loads, and
 * the contract checked there is the documented dispatch text, per the issue's
 * acceptance list. The compose tests (#5531) are behavioural: they extract the
 * dispatch fragment's bash blocks and spawn bash through runHook, one fresh
 * shell per block, so no shell variable crosses from block 1 to the
 * read-and-check block.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { extractFencedBashBlockContaining } = require('./qa/tdd-walk.cjs');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

const CREATE = 'PROMPT_FILE=$(mktemp';
const READ = 'EXECUTOR_PROMPT=$(cat -- "$PROMPT_FILE")';

/** A temp dir removed when the test `t` ends. */
function tempDir(t) {
  const dir = createTempDir('gsd-5531-');
  t.after(() => cleanup(dir));
  return dir;
}

/** The prompt template: the `text` fence the orchestrator writes to PROMPT_FILE. */
function promptBody() {
  const open = content.indexOf('```text\n');
  assert.ok(open !== -1, 'the prompt template must sit in a text fence');
  const close = content.indexOf('\n```', open + 8);
  assert.ok(close !== -1, 'the text fence must close');
  return content.slice(open + 8, close + 1);
}

/** The template as the orchestrator leaves it: ${AGENT_SKILLS} replaced, the other two compose-time placeholders resolved. */
function composed(agentSkills) {
  return promptBody()
    .replace('${AGENT_SKILLS}', () => agentSkills)
    .replace('Inline the actual contents', 'Inlined the contents')
    .replace('${TDD_APPLICABLE', 'TDD_APPLICABLE');
}

const PHASE = '7';
const PLAN = '3';
const STEM = `gsd-executor-prompt-${PHASE}-${PLAN}`;

/** `block` as its own bash command with this plan's identifiers substituted, as the orchestrator does; run in `cwd`. */
function runBlock(root, block, { strict = false, tail = '', cwd = path.dirname(root) } = {}) {
  const script = `${root}.sh`;
  const q = root.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const text = block.replaceAll('{phase_number}', PHASE).replaceAll('{plan_number}', PLAN);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.writeFileSync(script, `${strict ? 'set -euo pipefail\n' : ''}ORCH_ROOT='${q}'\n${text}\n${tail}`);
  return runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, cwd });
}

/**
 * Run the read-and-check block alone in a fresh shell with ORCH_ROOT=`root`
 * (no PROMPT_FILE handed over: the block finds the file by glob) and print
 * $EXECUTOR_PROMPT. `text` is written where block 1 would have created the
 * file; `asDir` makes that path a directory instead.
 */
function readAndCheck(root, { text, asDir = false, strict = false } = {}) {
  const file = path.join(root, '.claude', `${STEM}-abcdef`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (asDir) fs.mkdirSync(file);
  else if (text !== undefined) fs.writeFileSync(file, text);
  const r = runBlock(root, extractFencedBashBlockContaining(content, READ), { strict, tail: 'printf "%s" "$EXECUTOR_PROMPT"' });
  return { ...r, gone: !fs.existsSync(file) };
}

/**
 * Write `agentSkills` into the template as the file tool would, then read it
 * back through the real block. The three compose-time placeholders are
 * `${AGENT_SKILLS}` (replaced by the embed), `Inline the actual contents` and
 * `${TDD_APPLICABLE` (both resolved by composed()).
 */
function composeFromFile(agentSkills, { strict = false } = {}) {
  const dir = createTempDir('gsd-5531-');
  try {
    return readAndCheck(path.join(dir, 'orch'), { text: composed(agentSkills), strict });
  } finally {
    cleanup(dir);
  }
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

test('#5531: apostrophe-bearing spliced content reaches the prompt unchanged through the prompt file', (t) => {
  const dir = tempDir(t);
  const sentinel = path.join(dir, 'pwned');
  const persona = `<persona>\nthe user's vision; it doesn't '$(touch ${sentinel})' \`touch ${sentinel}\` "q" \\ end\nGSD_EXECUTOR_PROMPT_EOF\n</success_criteria>\ntouch ${sentinel}\n</persona>`;
  const r = composeFromFile(persona, { strict: true });
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout, composed(persona).replace(/\n$/, ''), 'the prompt must equal the composed template exactly');
  assert.ok(!fs.existsSync(sentinel), 'spliced text must not be executed');
  assert.ok(r.gone, 'the prompt file must be removed after it is read');
});

test('#5531: block 1 creates the prompt file under ORCH_ROOT/.claude', (t) => {
  const root = path.join(tempDir(t), 'orch');
  const block1 = `gsd_run() { echo false; }\n${extractFencedBashBlockContaining(content, CREATE)}`;
  // The path is judged in bash, never compared against a Node path (Git Bash prints /c/... on windows-latest).
  const ok = runBlock(root, block1, { tail: `case "$PROMPT_FILE" in "$ORCH_ROOT"/.claude/${STEM}-??????) ;; *) exit 3 ;; esac; [ -f "$PROMPT_FILE" ] || exit 4` });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`^PROMPT_FILE=.*/\\.claude/${STEM}-.{6}$`, 'm'));
  // A regular file where ORCH_ROOT/.claude must be: mkdir fails and FATAL names the cause.
  const blocked = path.join(path.dirname(root), 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, '.claude'), '');
  const bad = runBlock(blocked, block1);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /FATAL/);
});

test('#5531: block 1 removes a leftover file of the same plan and keeps another plan\'s', (t) => {
  const root = path.join(tempDir(t), 'orch');
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, `${STEM}-abcdef`);
  const other = path.join(dir, `gsd-executor-prompt-${PHASE}-9-abcdef`);
  fs.writeFileSync(mine, 'old');
  fs.writeFileSync(other, 'other');
  const r = runBlock(root, `gsd_run() { echo false; }\n${extractFencedBashBlockContaining(content, CREATE)}`);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(!fs.existsSync(mine), 'the leftover of this plan must be removed');
  assert.ok(fs.existsSync(other), "another plan's file must stay");
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(`${STEM}-`)).length, 1, 'only the new file of this plan remains');
});

test('#5531: block 2 finds the prompt file by glob in a fresh shell and fails closed under set -euo pipefail', (t) => {
  const dir = tempDir(t);
  for (const [name, args] of [
    ['no file', {}], ['empty', { text: '' }], ['newline-only', { text: '\n' }], ['a directory at the path', { asDir: true }],
  ]) {
    const r = readAndCheck(path.join(dir, name.replaceAll(' ', '_')), { ...args, strict: true });
    assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
    assert.equal(r.exitCode, 1, `${name} must halt, not dispatch: ${r.stderr}`);
    assert.match(r.stderr, /FATAL/, `${name}: halt must be loud`);
    assert.equal(r.stdout, '', `${name}: no prompt printed`);
  }
  const ok = readAndCheck(path.join(dir, 'plain'), { text: composed('x'), strict: true });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(ok.stdout, composed('x').replace(/\n$/, ''));
  assert.ok(ok.gone, 'the prompt file must be removed after it is read');
});

test('#5531: ORCH_ROOT text is data: quotes, backticks, $(...), spaces and $ in the path never run', (t) => {
  const dir = tempDir(t);
  for (const name of ["o'brien", 'bt`touch S`x', 'cs$(touch S)x', 'sp ace', 'dollar$HOME', 'dq"x']) {
    const r = readAndCheck(path.join(dir, name), { text: composed('x'), strict: true });
    assert.equal(r.exitCode, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout, composed('x').replace(/\n$/, ''), name);
    assert.ok(r.gone, `${name}: file removed`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'S')), 'ORCH_ROOT text must not be executed');
});

test('#5531: the read-and-check block removes the prompt file before its first halt', (t) => {
  const block = extractFencedBashBlockContaining(content, READ);
  assert.ok(block.indexOf('rm -f -- "$PROMPT_FILE"') !== -1 && block.indexOf('rm -f -- "$PROMPT_FILE"') < block.indexOf('exit 1'), 'the prompt file must be removed before the first halt');
  const dir = tempDir(t);
  const r = readAndCheck(dir, { text: '' });
  assert.equal(r.exitCode, 1);
  assert.ok(r.gone, 'an empty prompt file must be removed before the halt');
});

test('#5531: the substitution instruction covers every bash block and every plan identifier it uses', () => {
  assert.match(content, /replace `\{phase_dir\}`, `\{plan_file\}`, `\{plan_number\}`, `\{phase_number\}` and `\{plan_padded\}`/, 'every bash block gets the identifiers substituted');
});

test('#5531: the dispatch prose states what the fix does', () => {
  assert.ok(!content.includes('no shell variable crosses between them'), 'the blocks share a shell: ORCH_ROOT, EXPECTED_BASE, WAVE_WORKTREE_MANIFEST and EXECUTOR_PROMPT cross');
  assert.match(content, /`\$ORCH_ROOT`[^\n]*`\$EXECUTOR_PROMPT`/, 'the prose names what does cross between blocks');
  assert.ok(content.includes('halt before the read-and-check block'), 'cleanup covers every halt before the read-and-check block');
  assert.ok(content.includes('CRLF'), 'the prose says what a CRLF or BOM in the written file does');
  assert.ok(content.includes('trailing newlines and NUL bytes'), 'the prose names the bytes `$(...)` drops');
  assert.ok(content.includes("{plan_id} is this plan's `id` field"), 'the Step 2 comment keeps the {plan_id} clause on one line');
  assert.ok(content.includes('`quick` for `{phase_number}`'), 'a caller without a phase passes the literal quick');
});

test('#5531: an un-substituted ${AGENT_SKILLS} or ${TDD_APPLICABLE marker halts', (t) => {
  const dir = tempDir(t);
  for (const [name, text, marker] of [
    ['AGENT_SKILLS', composed('x') + '\n${AGENT_SKILLS}', '${AGENT_SKILLS}'],
    ['TDD_APPLICABLE', composed('x') + '\n${TDD_APPLICABLE', '${TDD_APPLICABLE'],
  ]) {
    const r = readAndCheck(path.join(dir, name), { text });
    assert.equal(r.exitCode, 1, `${name}: ${r.stderr}`);
    assert.ok(r.stderr.includes(marker), `${name}: the message must name the marker that fired: ${r.stderr}`);
    assert.ok(r.gone, `${name}: the prompt file must be removed`);
  }
});

test('#5531: well-formed compose passes the guard under set -euo pipefail', () => {
  const r = composeFromFile("the user's 'vision'", { strict: true });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes("the user's 'vision'"));
});

test('#5531: any printable embed (apostrophes, $(...), backticks, quotes, delimiter-like and indented lines) reaches the prompt unchanged', () => {
  const line = fc.oneof(
    fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 40 }),
    fc.constantFrom("it's", '$(touch S)', '`touch S`', '"q"', 'GSD_EXECUTOR_PROMPT_EOF', '  GSD_EXECUTOR_PROMPT_EOF', '</success_criteria>'),
  );
  fc.assert(
    fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
      const embed = lines.join('\n');
      const r = composeFromFile(embed, { strict: true });
      return r.exitCode === 0 && r.stdout.includes(embed);
    }),
    { numRuns: 10 },
  );
});
