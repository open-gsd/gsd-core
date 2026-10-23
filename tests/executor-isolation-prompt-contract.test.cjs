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
const fc = require('fast-check');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FRAGMENT = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'executor-isolation-dispatch.md',
);
// allow-test-rule: source-text-is-the-product the dispatch fragment is runtime-loaded workflow text (#3637)
const content = fs.readFileSync(FRAGMENT, 'utf8');

const ASSIGN = "IFS= read -r -d '' EXECUTOR_PROMPT <<'GSD_EXECUTOR_PROMPT_EOF' || true";
const TERMINATOR = '\nGSD_EXECUTOR_PROMPT_EOF\n';

/** The EXECUTOR_PROMPT quoted-heredoc assignment: full statement, and its body. */
function promptAssignment() {
  const start = content.indexOf(ASSIGN);
  const end = content.indexOf(TERMINATOR, start);
  assert.ok(start !== -1 && end !== -1, 'EXECUTOR_PROMPT quoted-heredoc assignment must exist');
  return content.slice(start, end + TERMINATOR.length);
}
function promptBody() {
  return promptAssignment().slice(ASSIGN.length);
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

test('#5531: apostrophe-bearing spliced content reaches the prompt byte-for-byte', () => {
  // Evaluate the documented assignment in bash after the orchestrator's textual
  // ${AGENT_SKILLS} substitution. A persona has apostrophes ("user's vision").
  const persona = "<persona>\nthe user's vision; it doesn't '$(echo pwned)' `id` \"q\" \\ end\n</persona>";
  const stmt = promptAssignment().replace('${AGENT_SKILLS}', () => persona);
  const dir = createTempDir('gsd-5531-');
  const script = path.join(dir, 'compose.sh');
  fs.writeFileSync(script, stmt + '\nprintf "%s" "$EXECUTOR_PROMPT"');
  const r = runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  cleanup(dir);
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes(persona), 'the spliced persona must appear verbatim in the prompt');
  assert.ok(r.stdout.startsWith('<objective>'), 'the template must be intact');
  assert.ok(r.stdout.includes('</success_criteria>'), 'the template must be complete');
  assert.ok(!r.stdout.includes("pwned'"), 'spliced text must not be executed');
});

// The documented guard that opens the second bash block: it must run outside the
// heredoc, because an unterminated heredoc swallows everything after it.
function promptGuard() {
  const lines = splitLines(content);
  const start = lines.findIndex((l) => l.startsWith('# Unterminated-heredoc guard'));
  const end = start < 0 ? -1 : lines.indexOf('esac', start);
  assert.ok(end > start, 'the unterminated-heredoc guard must exist in the post-compose block');
  return lines.slice(start, end + 1).join('\n') + '\n';
}

/** Run the real assignment as its own block (sourced, so an unterminated heredoc ends at the block's EOF), then the guard as the next block. */
function composeThenGuard(agentSkills, { mutate = (x) => x, strict = false } = {}) {
  const dir = createTempDir('gsd-5531-');
  fs.writeFileSync(path.join(dir, 'block1.sh'), mutate(promptAssignment().replace('${AGENT_SKILLS}', () => agentSkills)));
  const script = path.join(dir, 'compose.sh');
  fs.writeFileSync(
    script,
    (strict ? 'set -euo pipefail\n' : '') + `. "${dir}/block1.sh"\n` + promptGuard() + '\nprintf "%s" "$EXECUTOR_PROMPT"',
  );
  const r = runHook(script, [], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
  cleanup(dir);
  return r;
}

test('#5531: a terminator that is indented or CRLF fails closed (the heredoc must not swallow the gate)', () => {
  for (const [name, mutate] of [
    ['indented', (x) => x.replace('\nGSD_EXECUTOR_PROMPT_EOF\n', '\n  GSD_EXECUTOR_PROMPT_EOF\n')],
    ['CRLF', (x) => x.replace('\nGSD_EXECUTOR_PROMPT_EOF\n', '\nGSD_EXECUTOR_PROMPT_EOF\r\n')],
  ]) {
    // Observed in PR #5617 CI: Git Bash on windows-latest exits 0 for the CR terminator (mechanism unproven); Linux/macOS still assert.
    if (name === 'CRLF' && process.platform === 'win32') continue;
    const r = composeThenGuard('x', { mutate });
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.notEqual(r.exitCode, 0, `${name} terminator must halt, not dispatch`);
    assert.match(r.stderr, /FATAL/, `${name}: halt must be loud`);
  }
});

test('#5531: an embed containing the terminator line is caught by the guard (documented hazard)', () => {
  const r = composeThenGuard('before\nGSD_EXECUTOR_PROMPT_EOF\ntrue\ntrue');
  assert.notEqual(r.exitCode, 0, 'a truncated prompt must halt');
  assert.match(r.stderr, /FATAL/);
});

test('#5531: well-formed compose passes the guard under set -euo pipefail', () => {
  const r = composeThenGuard("the user's 'vision'", { strict: true });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(r.stdout.includes("the user's 'vision'"));
});

test('#5531: any printable embed (role file, skills, summary text) passes through byte-for-byte', () => {
  const line = fc.string({ unit: 'grapheme-ascii', maxLength: 40 }).filter((l) => l !== 'GSD_EXECUTOR_PROMPT_EOF');
  fc.assert(
    fc.property(fc.array(line, { maxLength: 6 }), (lines) => {
      const embed = lines.join('\n');
      const r = composeThenGuard(embed, { strict: true });
      return r.exitCode === 0 && r.stdout.includes(embed);
    }),
    { numRuns: 20 },
  );
});
