'use strict';

/**
 * #2483 — the claude reviewer leg in review.md was a bare headless spawn
 * (`cat {run_dir}/gsd-review-prompt.md | claude ... -p -`), run from the
 * project cwd, so the spawned session inherited the invoking user's global
 * CLAUDE.md, the project CLAUDE.md, and Claude Code auto-memory.
 *
 * That made it the only reviewer leg seeing anything beyond the prompt file:
 * `gather_context` assembles PROJECT.md, the roadmap section, every PLAN
 * file, CONTEXT.md, RESEARCH.md and REQUIREMENTS.md into the prompt before
 * any reviewer runs, the gemini leg receives only that prompt, and the codex
 * leg runs `--ephemeral`. Beyond the measured injection cost, the asymmetry
 * cuts at the workflow's premise — "independent review" meant something
 * different for the claude leg than for the other two.
 *
 * The fix guards both dispatch lines with a per-invocation
 * `env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. `env`, never `export`: the flag
 * must not leak into the orchestrating session (which may itself be Claude
 * Code on the SELF_CLI="auto" path) or into any later spawn.
 *
 * review.md IS the product the runtime loads (an AI agent reads and executes
 * these workflow instructions verbatim), so this is a static-content
 * regression against the deployed text, mirroring
 * fix-2358-review-temp-path-scoping.test.cjs and
 * fix-2194-review-timeout-guidance.test.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

describe('#2483 the claude reviewer leg suppresses CLAUDE.md + auto-memory injection', () => {
  const content = fs.readFileSync(REVIEW_MD, 'utf-8');

  test('both claude dispatch lines are guarded, and the guard sits between the pipe and the CLI', () => {
    const guarded = content.match(/\|\s*env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude\s/g) || [];
    assert.equal(
      guarded.length, 2,
      'review.md must dispatch the claude reviewer exactly twice (the --model branch and the ' +
      'bare-model branch), each through `env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` — the guard must ' +
      'immediately precede the `claude` binary so it applies to that invocation only'
    );
  });

  test('every line that invokes the claude CLI carries the guard', () => {
    // Line-oriented rather than shape-oriented on purpose. A matcher keyed to
    // `| claude -p` only pins the two shapes that exist today; a later
    // `timeout 900 claude -p`, `command claude -p`, or
    // `claude --output-format text -p` would add an unguarded dispatch while a
    // narrower assertion stayed green. Instead: find every line that invokes the
    // `claude` binary with flags, and require the guard on each one.
    // `.split(/\r?\n/)`, not `.split('\n')` — Windows git-autocrlf checkouts yield
    // "\r\n", and a literal-"\n" split leaves a trailing "\r" on every line
    // (local/no-crlf-fragile-split).
    // The matcher tolerates variable expansions between `claude` and its first
    // literal flag: the effortSurface wiring (#2481) reshaped the bare-model
    // dispatch to `claude $CLAUDE_EFFORT_ARGS -p -`, which the dash-first form
    // of this matcher could no longer see (the count assertion below caught
    // exactly that — a reshaped dispatch — as designed).
    const invocations = content
      .split(/\r?\n/)
      .filter((line) => /(?:^|[|;&(]|\s)claude\s+(?:\$\{?\w+\}?\s+)*-{1,2}\w/.test(line));

    assert.equal(
      invocations.length, 2,
      'expected exactly two claude CLI invocations in review.md (the --model branch and the ' +
      'bare-model branch); a change in this count means a dispatch was added, removed or ' +
      `reshaped and this guard needs revisiting. Found:\n${invocations.join('\n')}`
    );

    const unguarded = invocations.filter(
      (line) => !line.includes('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1')
    );
    assert.deepEqual(
      unguarded, [],
      'every line invoking the claude CLI in review.md must carry ' +
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 — an unguarded leg re-inherits global CLAUDE.md, ' +
      'project CLAUDE.md and auto-memory, reintroducing the asymmetry against the prompt-fed ' +
      'gemini and codex legs'
    );
  });

  test('the guard is per-invocation, never exported into the orchestrating session', () => {
    assert.ok(
      !/export\s+CLAUDE_CODE_DISABLE_CLAUDE_MDS/.test(content),
      'review.md must not `export` CLAUDE_CODE_DISABLE_CLAUDE_MDS — exporting leaks the flag ' +
      'into the orchestrating session (which may itself be Claude Code on the SELF_CLI="auto" ' +
      'path) and into every subsequent spawn, suppressing CLAUDE.md far outside the review'
    );
  });

  test('the guard is scoped to the claude leg only', () => {
    const geminiDispatch = content.match(/\|\s*\S*\s*gemini\s+(-m|-p)/g) || [];
    assert.ok(
      geminiDispatch.length > 0,
      'expected the gemini reviewer dispatch to still be present in review.md'
    );
    assert.ok(
      !/CLAUDE_CODE_DISABLE_CLAUDE_MDS=1\s+(gemini|codex)/.test(content),
      'the CLAUDE_CODE_DISABLE_CLAUDE_MDS guard is Claude-Code-specific and must not be applied ' +
      'to the gemini or codex dispatch — neither CLI reads CLAUDE.md, and codex already scopes ' +
      'its own context with --ephemeral'
    );
  });
});
