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
const { createTempDir, cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

const CREATE = 'PROMPT_FILE=$(mktemp';
const READ = 'EXECUTOR_PROMPT=$(cat -- "$PROMPT_FILE")';

/** The fenced ```bash block that contains `marker` (indexOf only, no backtracking regex over the file). */
function bashBlock(marker) {
  const at = content.indexOf(marker);
  assert.ok(at !== -1, `the dispatch fragment must contain ${marker}`);
  const open = content.lastIndexOf('```bash\n', at);
  const close = content.indexOf('\n```', at);
  assert.ok(open !== -1 && close !== -1 && content.indexOf('\n```', open + 8) === close, `${marker} must sit in one bash block`);
  return content.slice(open + 8, close + 1);
}

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

/** Run the read-and-check block with PROMPT_FILE=`promptFile` (undefined leaves it unset) and print $EXECUTOR_PROMPT. */
function readAndCheck(dir, promptFile, { strict = false } = {}) {
  const script = path.join(dir, 'check.sh');
  const set = promptFile === undefined ? '' : `PROMPT_FILE='${promptFile.replaceAll('\\', '/')}'\n`;
  fs.writeFileSync(script, (strict ? 'set -euo pipefail\n' : '') + set + bashBlock(READ) + '\nprintf "%s" "$EXECUTOR_PROMPT"');
  return runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
}

/** Write `agentSkills` into the template as the file tool would, then read it back through the real block. */
function composeFromFile(agentSkills, { strict = false } = {}) {
  const dir = createTempDir('gsd-5531-');
  try {
    const file = path.join(dir, 'prompt');
    fs.writeFileSync(file, composed(agentSkills));
    const r = readAndCheck(dir, file, { strict });
    return { ...r, gone: !fs.existsSync(file) };
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

test('#5531: apostrophe-bearing spliced content reaches the prompt byte-for-byte through the prompt file', (t) => {
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

test('#5531: block 1 creates the prompt file under TMPDIR', (t) => {
  const dir = tempDir(t);
  const d = dir.replaceAll('\\', '/');
  const script = path.join(dir, 'create.sh');
  const run = (tmp, tail) => {
    fs.writeFileSync(script, `gsd_run() { echo false; }\nexport TMPDIR='${tmp}'\n${bashBlock(CREATE)}\n${tail}`);
    return runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  };
  // The path is judged in bash, never compared against a Node path (Git Bash prints /c/... on windows-latest).
  const ok = run(d, 'case "$PROMPT_FILE" in */gsd-executor-prompt-??????) ;; *) exit 3 ;; esac; [ -f "$PROMPT_FILE" ] || exit 4');
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.match(ok.stdout, /^PROMPT_FILE=.*gsd-executor-prompt-.{6}$/m);
  const bad = run(`${d}/missing`, '');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /FATAL/);
});

test('#5531: a missing, empty, unreadable or unset prompt file fails closed', (t) => {
  const dir = tempDir(t);
  const blank = path.join(dir, 'blank');
  fs.writeFileSync(blank, '\n');
  for (const [name, file] of [
    ['missing', path.join(dir, 'nope')], ['newline-only', blank], ['unreadable (a directory)', dir], ['unset', undefined],
  ]) {
    const r = readAndCheck(dir, file);
    assert.equal(r.outcome, OUTCOME.EXITED, `${name}: ${r.stderr}`);
    assert.notEqual(r.exitCode, 0, `${name} prompt file must halt, not dispatch`);
    assert.match(r.stderr, /FATAL/, `${name}: halt must be loud`);
  }
});

test('#5531: every halt of the read-and-check block runs with the prompt file already removed', (t) => {
  const block = bashBlock(READ);
  assert.ok(block.indexOf('rm -f -- "$PROMPT_FILE"') !== -1 && block.indexOf('rm -f -- "$PROMPT_FILE"') < block.indexOf('exit 1'), 'the prompt file must be removed before the first halt');
  const dir = tempDir(t);
  const empty = path.join(dir, 'empty');
  fs.writeFileSync(empty, '');
  assert.equal(readAndCheck(dir, empty).exitCode, 1);
  assert.ok(!fs.existsSync(empty), 'an empty prompt file must be removed before the halt');
});

test('#5531: the substitution instruction covers every bash block and all four plan identifiers', () => {
  assert.match(content, /replace `\{phase_dir\}`, `\{plan_file\}`, `\{plan_number\}` and `\{phase_number\}`/, 'every bash block gets the identifiers substituted');
});

test('#5531: an un-substituted ${AGENT_SKILLS} or ${TDD_APPLICABLE marker halts', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'prompt');
  for (const [name, text] of [
    ['AGENT_SKILLS', composed('x') + '\n${AGENT_SKILLS}'],
    ['TDD_APPLICABLE', composed('x') + '\n${TDD_APPLICABLE'],
  ]) {
    fs.writeFileSync(file, text);
    const r = readAndCheck(dir, file);
    assert.equal(r.exitCode, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /FATAL/);
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
