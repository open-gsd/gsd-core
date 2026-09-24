/**
 * gsd-executor agent — MVP+TDD gate section contract
 * Verifies the agent definition contains a section instructing the executor
 * to halt and report when the runtime gate trips.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENT = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
const REF = path.join(__dirname, '..', 'gsd-core', 'references', 'execute-mvp-tdd.md');

describe('gsd-executor — MVP+TDD gate section', () => {
  const content = fs.readFileSync(AGENT, 'utf-8');

  test('agent defines a TDD Gate section keyed on TDD_MODE alone (#4011)', () => {
    assert.match(content, /MVP\+TDD\s*Gate|MVP[\s-]?TDD[\s-]?gate|TDD\s*Gate/i, 'must label the gate');
    // The gate's trigger must not require MVP_MODE (#4011): a discipline gate
    // keyed to a product-scope flag is silently inert on non-MVP phases.
    const gateSection = content.slice(
      content.search(/## (?:MVP\+TDD )?TDD Gate/i),
      content.indexOf('##', content.search(/## (?:MVP\+TDD )?TDD Gate/i) + 3),
    );
    assert.ok(!/MVP_MODE\s*=\s*"?"?true"?.{0,80}TDD_MODE|both .MVP_MODE.= true and .TDD_MODE.= true/i.test(gateSection),
      'the executor gate section must trigger on TDD_MODE alone, not the MVP intersection (#4011)');
  });

  test('agent instructs halt-and-report when gate trips', () => {
    assert.match(content, /halt|stop[^\n]*gate|gate[^\n]*halt/i, 'must instruct halt');
    assert.match(content, /report|surface|emit/i, 'must instruct report');
  });

  test('agent references execute-mvp-tdd.md', () => {
    assert.match(content, /execute-mvp-tdd\.md/, 'must reference the gate semantics file');
  });

  test('referenced file exists on disk', () => {
    assert.ok(fs.existsSync(REF), `${REF} must exist`);
  });
});

describe('gsd-executor — state.* calls use the named-only router form (#1863 regression)', () => {
  // The runtime state-command router (gsd-core/bin/lib/state-command-router.cjs)
  // parses record-metric / add-decision / add-blocker / record-session named-only
  // via parseNamedArgs. Positional values are silently dropped, so state.cjs then
  // throws its required-arg error and metrics/decisions/blockers/session continuity
  // are never recorded. Each invocation in the executor agent must therefore pass
  // the named flags the router expects (mirrors gsd-core/workflows/execute-plan.md).
  const content = fs.readFileSync(AGENT, 'utf-8');

  // Capture a `gsd_run query state.<cmd> ...` invocation, including backslash-continued lines.
  function invocation(cmd) {
    const re = new RegExp(String.raw`gsd_run query state\.${cmd}\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*`);
    const m = content.match(re);
    assert.ok(m, `executor must invoke state.${cmd}`);
    return m[0];
  }

  test('record-metric passes --phase/--plan/--duration/--tasks/--files', () => {
    const call = invocation('record-metric');
    for (const flag of ['--phase', '--plan', '--duration', '--tasks', '--files']) {
      assert.ok(call.includes(flag), `record-metric must pass ${flag}, got:\n${call}`);
    }
  });

  test('add-decision passes --summary (or --summary-file)', () => {
    assert.match(invocation('add-decision'), /--summary(?:-file)?\b/);
  });

  test('add-blocker passes --text (or --text-file)', () => {
    assert.match(invocation('add-blocker'), /--text(?:-file)?\b/);
  });

  test('record-session passes --stopped-at and --resume-file', () => {
    const call = invocation('record-session');
    assert.ok(call.includes('--stopped-at'), 'record-session must pass --stopped-at');
    assert.ok(call.includes('--resume-file'), 'record-session must pass --resume-file');
  });

  test('no state.* call leads with a bare positional (quoted) value — the #1863 bug', () => {
    // Buggy multi-line form: `state.<cmd> \` then a line whose first token is a quote.
    const continued = /state\.(?:record-metric|add-decision|add-blocker|record-session)\b[^\r\n]*\\\r?\n\s*"/;
    assert.ok(!continued.test(content),
      'state.* calls must lead with --flags, not a positional quoted value on the next line');
    // Buggy same-line form: `state.<cmd> "..."`
    const inline = /state\.(?:record-metric|add-decision|add-blocker|record-session)\s+"/;
    assert.ok(!inline.test(content),
      'state.* calls must not pass a positional value immediately after the command');
  });

  test('sibling workflow record-session calls also use named flags (#1863 completeness)', () => {
    // The same named-only router backs milestone-summary.md and forensics.md; both
    // previously passed record-session positionally (`"" "stopped-at" "resume-file"`),
    // silently dropping the values. Guard them alongside the executor.
    for (const rel of ['gsd-core/workflows/milestone-summary.md', 'gsd-core/workflows/forensics.md']) {
      const wf = fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
      const m = wf.match(/gsd_run query state\.record-session\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*/);
      assert.ok(m, `${rel} must invoke state.record-session`);
      assert.ok(m[0].includes('--stopped-at') && m[0].includes('--resume-file'),
        `${rel} record-session must use --stopped-at/--resume-file, got:\n${m[0]}`);
      assert.ok(!/state\.record-session\s+"/.test(wf),
        `${rel} record-session must not lead with a positional value`);
    }
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3097-3099-executor-worktree-path-safety.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3097-3099-executor-worktree-path-safety (consolidation epic #1969 B7 #1976)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #3097)
// Reads markdown product files (gsd-executor.md, worktree-path-safety.md) to
// verify structural protocol.

// Regression guards for bug #3097 and #3099.
//
// #3097: gsd-executor's worktree HEAD guard used `if [ -f .git ]` to detect
// worktree mode. After a Bash `cd` out of the worktree into the main repo,
// `.git` is a DIRECTORY (not a file), so the test is false and the entire
// HEAD safety block is silently skipped. Commits then land on whatever branch
// the main repo has checked out — not the per-agent worktree branch.
//
// #3099: Executor agents construct absolute paths from `pwd` captured in the
// orchestrator context (main repo root). Edit/Write calls using these paths
// resolve to the main repo, not the worktree. git commit from the worktree
// sees a clean tree; the work is silently lost or leaks to main.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const executorSrc = fs.readFileSync(
  path.join(ROOT, 'agents', 'gsd-executor.md'), 'utf8',
);
const executePhaseSrc = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
);

describe('bug #3097: cwd-drift sentinel in gsd-executor.md', () => {
  test('task_commit_protocol has cwd-drift assertion step (0a)', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    assert.ok(protocolIdx !== -1 && protocolEnd !== -1, 'task_commit_protocol block not found');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      protocol.includes('cwd') || protocol.includes('drift') || protocol.includes('gsd-spawn-toplevel'),
      'task_commit_protocol missing cwd-drift assertion step — #3097 fix not applied',
    );
  });

  test('sentinel uses git rev-parse --git-dir to detect worktree', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      protocol.includes('rev-parse --git-dir') || protocol.includes('worktrees/'),
      'cwd-drift detection does not use git rev-parse --git-dir or .git/worktrees/ pattern',
    );
  });

  test('cwd-drift check precedes HEAD assertion', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    const driftIdx = protocol.search(/cwd.drift|gsd-spawn-toplevel|drift.*assertion/i);
    const headIdx = protocol.indexOf('Pre-commit HEAD safety assertion');
    assert.ok(driftIdx !== -1, 'cwd-drift assertion not found');
    assert.ok(headIdx !== -1, 'HEAD assertion not found');
    assert.ok(driftIdx < headIdx, 'cwd-drift assertion must precede HEAD assertion (step 0a before step 0)');
  });
});

describe('bug #3099: absolute-path safety guidance in gsd-executor.md', () => {
  test('task_commit_protocol documents absolute-path safety', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    assert.ok(
      (protocol.includes('absolute') || protocol.includes('absolute-path')) &&
      (protocol.includes('worktree') || protocol.includes('WT_ROOT')),
      'task_commit_protocol missing absolute-path safety guidance — #3099 fix not applied',
    );
  });

  test('#4767 — the absolute-path guard also precedes <automated> verify execution', () => {
    const protocolIdx = executorSrc.indexOf('<task_commit_protocol>');
    const protocolEnd = executorSrc.indexOf('</task_commit_protocol>');
    const protocol = executorSrc.slice(protocolIdx, protocolEnd);
    const guardIdx = protocol.indexOf('0b. absolute-path safety');
    assert.ok(guardIdx !== -1, 'step 0b not found in task_commit_protocol');
    const guard = protocol.slice(guardIdx);
    assert.ok(
      guard.includes('<automated>') && guard.includes('#4767') && guard.includes('worktree-path-safety.md'),
      'step 0b does not extend the containment check to <automated> command execution — #4767 fix not applied',
    );
    // The guard body lives in the reference the parallel executor loads (the executor agent file
    // sits at its size cap). Fail-closed, never a silent rewrite: the halt is spelled out and
    // the rewrite is forbidden.
    const ref = fs.readFileSync(path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md'), 'utf8');
    assert.ok(/## `<automated>` command guard — step 0c \(#4767\)/.test(ref), 'worktree-path-safety.md lacks the step 0c section');
    assert.ok(/FATAL: <automated> command names/.test(ref), 'step 0c has no loud halt for an <automated> command outside the worktree');
    assert.ok(/never\s+rewrite the prefix silently/.test(ref), 'step 0c must forbid silently rewriting the command');
  });

  test('execute-phase.md parallel_execution block references path safety', () => {
    const parallelIdx = executePhaseSrc.indexOf('<parallel_execution>');
    assert.ok(parallelIdx !== -1, 'parallel_execution block not found in execute-phase.md');
    // Verify the worktree-path-safety.md reference is present in the execution_context
    // (loaded via @ reference rather than inlined — the safe extract pattern)
    assert.ok(
      executePhaseSrc.includes('worktree-path-safety.md'),
      'execute-phase.md does not reference worktree-path-safety.md in execution_context',
    );
  });

  test('execute-phase prompt anchors subagent file paths to project_root before required_reading (#280)', () => {
    // Anchor on the dispatch's PROJECT_ROOT computation, then require the
    // nearest <required_reading> block to open just before it — the executor
    // must be told to compute the root BEFORE reading the listed files
    // (#3423 note: execute-phase carries several such blocks, so a bare
    // indexOf on the tag can anchor to the wrong one).
    const prIdx = executePhaseSrc.indexOf('PROJECT_ROOT=$(git rev-parse --show-toplevel');
    assert.ok(prIdx !== -1, 'executor dispatch must compute PROJECT_ROOT in the prompt');
    const filesIdx = executePhaseSrc.lastIndexOf('<required_reading>', prIdx);
    assert.ok(filesIdx !== -1, 'required_reading block not found before the PROJECT_ROOT computation');
    assert.ok(prIdx - filesIdx < 1800, 'required_reading block must sit adjacent to the PROJECT_ROOT computation');
    const dispatchSnippet = executePhaseSrc.slice(filesIdx, filesIdx + 1800);
    assert.ok(
      dispatchSnippet.includes('${PROJECT_ROOT}/'),
      'executor required_reading paths must be anchored to ${PROJECT_ROOT}/',
    );
  });

  test('worktree-path-safety.md reference file exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md')),
      'gsd-core/references/worktree-path-safety.md does not exist',
    );
  });

  test('worktree-path-safety.md contains cwd-drift and absolute-path guards', () => {
    const safetySrc = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md'), 'utf8',
    );
    assert.ok(safetySrc.includes('gsd-spawn-toplevel') || safetySrc.includes('cwd-drift'),
      'worktree-path-safety.md missing cwd-drift sentinel content');
    assert.ok(safetySrc.includes('WT_ROOT') || safetySrc.includes('absolute'),
      'worktree-path-safety.md missing absolute-path guard content');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4254 — sequential (non-isolated) executor dispatch had no hard pin to the
// orchestrator's own worktree root: the dispatched prompt told the executor to
// self-derive PROJECT_ROOT via `git rev-parse --show-toplevel`, and every
// existing guard (steps 0a/0b worktree-only, step 0 branch-scoped) is
// self-referential — so an executor spawned with a drifted cwd committed onto
// the wrong checkout silently. The fix ships a mode-agnostic "supplied-root
// pin" guard (step 0p) in worktree-path-safety.md, bound at dispatch time by
// execute-phase.md's SEQUENTIAL branch only (worktree mode keeps its own,
// intentionally different, self-derived root). These tests EXECUTE the shipped
// guard against real git fixtures — no string-only vacuity (#4296 review
// precedent, Blocker 2).
// ────────────────────────────────────────────────────────────────────────
describe('bug #4254: sequential executor supplied-root pin', () => {
  // allow-test-rule: source-text-is-the-product (see #3097) — the reference
  // and the workflow markdown ARE the product under test. ROOT and
  // executePhaseSrc are re-declared here: the folded #3097/#3099 block above
  // declares its own copies inside a closure, out of this describe's scope.
  const ROOT = path.join(__dirname, '..');
  const executePhaseSrc = fs.readFileSync(
    path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8',
  );
  const safetyRefPath = path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md');
  const pinStepPath = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'sequential-root-pin.md');
  const safetySrc = fs.readFileSync(safetyRefPath, 'utf8');
  const pinStepSrc = fs.readFileSync(pinStepPath, 'utf8');
  const { createTempGitProject, cleanup } = require('./helpers.cjs');
  const { runHook } = require('./helpers/process-seam.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  const PIN_MARKER = '# gsd:guard=supplied-root-pin';

  // Extract the shipped guard — the exact ```bash block that carries the
  // marker — so the tests can never pass against a stale or hand-copied body.
  function extractPinGuard() {
    const body = safetySrc.split('```bash\n').find((b) => b.startsWith(PIN_MARKER));
    assert.ok(body, 'worktree-path-safety.md must ship the #4254 supplied-root-pin guard');
    return body.split('```')[0].trim();
  }

  // The composition contract the orchestrator follows at dispatch: a
  // shell-single-quoted literal with `'\''` escaping for embedded quotes.
  const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

  function composeGuard(pinQuotedLiteral) {
    return extractPinGuard().replace("PINNED_ROOT='{PINNED_ROOT}'", `PINNED_ROOT=${pinQuotedLiteral}`);
  }

  // Run the composed guard in `cwd`; `probe` (optional bash line) runs only if
  // the guard passes — proving the write barrier, not just the exit code.
  function runPinGuard(cwd, pin, probe) {
    return runHook('-c', [composeGuard(shellQuote(pin)) + (probe ? `\n${probe}` : '')], {
      interpreter: 'bash',
      cwd,
      timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  // Fixture: a primary checkout plus a linked worktree (the orchestrator's
  // lane). Sibling path — a worktree inside the primary's tree would show up
  // as an untracked directory and muddy the fixtures.
  function makeOrchestratorLane(prefix) {
    const primary = createTempGitProject(prefix);
    const lane = `${primary}-orchestrator-wt`;
    gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/2-1', lane], { cwd: primary });
    return { primary, lane };
  }

  test('#4254: reference ships the supplied-root pin section with composition + runtime contracts', () => {
    assert.match(safetySrc, /## Supplied-root pin — step 0p \(#4254, EVERY mode\)/);
    // Runtime contract: run before first Edit/Write and every commit; HALT on
    // FATAL; warn-and-proceed ONLY when the prompt carries no pin block.
    assert.match(safetySrc, /before your first Edit\/Write and again\s+before every commit/);
    assert.match(safetySrc, /NO `<project_root_pin>` block[\s\S]*?warning line and continue/);
    // The executor must never bind the placeholder itself — that is exactly
    // the #4254 failure mode re-armored as a "fix".
    assert.match(safetySrc, /Never bind\s+`\{PINNED_ROOT\}` yourself/);
    // Composition contract: build-time literal substitution, single-quoted,
    // git-vs-git comparison rationale (the #4296 Windows lesson).
    assert.match(safetySrc, /substituting[\s\S]*`\{PINNED_ROOT\}`[\s\S]*shell-single-quoted/);
    assert.match(safetySrc, /git-vs-git on BOTH sides/);
  });

  test('#4254: RED regression — drifted-cwd executor halts before the wrong-checkout write', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-drift-');
    try {
      // The orchestrator pinned its own lane; the executor's process cwd
      // resolved to the PRIMARY checkout (the issue's exact shape).
      const marker = path.join(primary, 'write-marker');
      const res = runPinGuard(primary, lane, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 1, `mismatched root must halt, got:\n${res.stdout}\n${res.stderr}`);
      assert.equal(fs.existsSync(marker), false, 'no write may run after a root mismatch');
      assert.match(res.stderr, /FATAL[^\n]*#4254/);
      // Loud detection: the FATAL names BOTH roots — the pinned lane and the
      // actual (wrong) primary checkout. The primary's basename is unique to
      // it (the lane appends '-orchestrator-wt'), so matching it inside the
      // Actual-root line proves the right checkout is being named.
      assert.match(res.stderr, /Pinned root:[^\n]*orchestrator-wt/, 'FATAL must name the pinned root');
      const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
      const primaryName = escapeRegex(path.basename(primary));
      assert.match(res.stderr, new RegExp(`Actual root:[^\\n]*${primaryName}`), 'FATAL must name the actual (wrong) root');
      assert.doesNotMatch(res.stderr, new RegExp(`Actual root:[^\\n]*orchestrator-wt`), 'the actual root must NOT be the pinned lane');
      // The FATAL self-describes its stage (and, on capture failures, git's own
      // stderr) — the discriminator whose absence let this class of failure read
      // as "capture returns empty" when the form gate was what fired on Windows.
      assert.match(res.stderr, /Guard stage: root-mismatch/, 'drifted cwd is a root mismatch, not a capture or form failure');
      assert.match(res.stderr, /Diagnostic: actual=.*pinned=.*superproject=<none>/, 'the mismatch diagnostic names both roots and the absent superproject');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: correct-cwd control — matching root permits the write', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-match-');
    try {
      const marker = path.join(lane, 'write-marker');
      const res = runPinGuard(lane, lane, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 0, `matching root must permit the write, got:\n${res.stderr}`);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'W');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: unexpanded or empty pin fails closed (never warn-and-proceed inside a pin block)', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-unbound-');
    try {
      const marker = path.join(lane, 'write-marker');
      // Unexpanded: the orchestrator never performed the build-time substitution.
      const unexpanded = runHook('-c', [extractPinGuard() + `\nprintf 'W' > ${shellQuote(marker)}`], {
        interpreter: 'bash', cwd: lane, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      assert.equal(unexpanded.exitCode, 1, 'an unexpanded {PINNED_ROOT} must halt');
      assert.match(unexpanded.stderr, /Guard stage: pin-unbound/, 'an unexpanded pin halts at the pin-unbound stage');
      // Empty: substituted to nothing — indistinguishable from a forgotten transplant.
      const empty = runHook('-c', [composeGuard("''") + `\nprintf 'W' > ${shellQuote(marker)}`], {
        interpreter: 'bash', cwd: lane, timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
      });
      assert.equal(empty.exitCode, 1, 'an empty pin must halt');
      assert.match(empty.stderr, /Guard stage: pin-unbound/, 'an empty pin halts at the pin-unbound stage');
      assert.equal(fs.existsSync(marker), false);
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: normalization — trailing slash, symlink alias, subdirectory cwd, and unresolved temp-root spelling all match', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-norm-');
    try {
      const alias = `${primary}-alias`;
      fs.symlinkSync(lane, alias, 'junction');
      const subdir = path.join(lane, 'nested');
      fs.mkdirSync(subdir);
      // The unresolved spelling of the temp root (macOS: /var/... vs git's
      // resolved /private/var/...): both sides are git-emitted, so the
      // comparison is representation-safe by construction. On platforms
      // without the /var symlink this degenerates to the realpath form and
      // still asserts the matching property.
      const unresolvedLane = fs.realpathSync(lane).replace('/private/var/', '/var/');
      for (const pin of [lane, `${lane}/`, alias, unresolvedLane]) {
        const marker = path.join(lane, 'write-marker');
        const res = runPinGuard(subdir, pin, `printf 'W' > ${shellQuote(marker)}`);
        assert.equal(res.exitCode, 0, `pin form ${pin} must normalize to the same checkout:\n${res.stderr}`);
        fs.unlinkSync(marker);
      }
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: boundary — registered submodule of the pinned checkout commits; unregistered and sibling checkouts halt', () => {
    const primary = createTempGitProject('gsd-4254-super-');
    const subSource = createTempGitProject('gsd-4254-subsource-');
    try {
      gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'module'], { cwd: primary });
      gitOrThrow(['commit', '-qm', 'chore: register submodule'], { cwd: primary });
      const moduleRoot = path.join(primary, 'module');
      // Registered immediate submodule: legitimate sub_repos work, permitted.
      const inModule = path.join(moduleRoot, 'write-marker');
      assert.equal(runPinGuard(moduleRoot, primary, `printf 'W' > ${shellQuote(inModule)}`).exitCode, 0);
      fs.unlinkSync(inModule);
      // Unregistered nested clone inside the pinned checkout: halts.
      const rogue = path.join(primary, 'rogue-clone');
      gitOrThrow(['clone', '-q', subSource, rogue], { cwd: primary });
      const rogueMarker = path.join(rogue, 'write-marker');
      assert.equal(runPinGuard(rogue, primary, `printf 'W' > ${shellQuote(rogueMarker)}`).exitCode, 1);
      assert.equal(fs.existsSync(rogueMarker), false);
      // Sibling linked worktree of the SAME repo (right repo, wrong checkout —
      // the incident's exact shape): halts.
      const sibling = `${primary}-sibling-wt`;
      gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/9-9', sibling], { cwd: primary });
      const siblingMarker = path.join(sibling, 'write-marker');
      assert.equal(runPinGuard(sibling, primary, `printf 'W' > ${shellQuote(siblingMarker)}`).exitCode, 1);
      assert.equal(fs.existsSync(siblingMarker), false);
    } finally {
      cleanup(primary);
      cleanup(subSource);
    }
  });

  test('#4254: pin outside any git repo, and cwd outside any git repo, both fail closed', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-norepo-');
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-4254-outside-'));
    try {
      assert.equal(runPinGuard(lane, outside).exitCode, 1, 'pin outside a repo must halt');
      assert.equal(runPinGuard(outside, lane).exitCode, 1, 'cwd outside a repo must halt');
    } finally {
      cleanup(outside);
      cleanup(primary);
    }
  });

  test('#4254: shell-metacharacter pin is safely quoted — no command substitution executes', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-meta-');
    try {
      const tricky = path.join(primary, `q' $HOME $(touch PWNED) x`);
      fs.symlinkSync(lane, tricky, 'junction');
      const marker = path.join(lane, 'write-marker');
      const res = runPinGuard(lane, tricky, `printf 'W' > ${shellQuote(marker)}`);
      assert.equal(res.exitCode, 0, `quoted metacharacter pin must match its checkout:\n${res.stderr}`);
      assert.equal(fs.existsSync(path.join(lane, 'PWNED')), false, 'command substitution in the pin must not execute');
      assert.equal(fs.existsSync(marker), true);
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: relative pin is rejected; Windows drive-letter forms pass the form gate and fail only at the git lookup', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-4254-forms-');
    try {
      // Relative pins are never trustworthy across cwds — rejected outright,
      // and the FATAL says so at the form-gate stage.
      const rel = runPinGuard(lane, 'relative/path');
      assert.equal(rel.exitCode, 1);
      assert.match(rel.stderr, /Guard stage: form-gate/, 'a relative pin must halt at the form gate');
      // The drive-letter forms Windows produces must be ACCEPTED by the shipped
      // guard's absolute-form gate and then fail only on the git lookup — never
      // on the form rejection: the forward-slash form git EMITS (C:/…) and the
      // backslash form Node's path.join and cmd.exe PRODUCE (C:\…, including
      // RUNNER~1-style short names). The Guard stage line is the discriminator:
      // pinned-capture means the form passed and `git -C` spoke (its stderr rides
      // the Diagnostic line), form-gate means the gate ate the pin — the exact
      // CI defect where every backslash pin died before the actual root was ever
      // computed. Driving the SHIPPED guard also removes the hand-rolled
      // duplicate `case` this row used to carry (the #4296 Minor 1 duplication
      // smell, and itself a transit-fragile copy of the broken pattern).
      for (const driveForm of ['C:/definitely/not/a/repo', 'C:\\definitely\\not\\a\\repo']) {
        const res = runPinGuard(lane, driveForm);
        assert.equal(res.exitCode, 1, `nonexistent drive-letter pin must fail closed (${driveForm})`);
        assert.match(
          res.stderr, /Guard stage: pinned-capture/,
          `drive form ${driveForm} must pass the form gate and halt at the pinned-capture stage, got:\n${res.stderr}`,
        );
        assert.match(res.stderr, /Diagnostic: git -C <pinned root> rev-parse --show-toplevel failed:/, 'the capture failure carries git stderr');
      }
      // Transit hardening, pinned on the shipped text itself: the guard must
      // generate its backslash comparator at RUNTIME (printf octal) and must not
      // contain a doubled backslash anywhere — a backslash written twice does
      // not survive the Windows command-line round-trip into bash (it arrives
      // halved, rewriting any escape pattern that relies on it). Two earlier
      // pattern spellings failed the Windows CI leg on exactly this.
      const guardBody = extractPinGuard();
      assert.doesNotMatch(guardBody, /\\\\/, 'the shipped guard must contain no doubled backslash (Windows transit halves it)');
      assert.match(guardBody, /printf '\\134'/, 'the drive-form gate must generate its backslash comparator at runtime');
    } finally {
      cleanup(primary);
    }
  });

  test('#4254: execute-phase.md sequential branch pins the orchestrator root at build time', () => {
    const sequential = executePhaseSrc.split('**Sequential mode**')[1].split('4. **Wait for all agents')[0];
    assert.ok(sequential.length > 0, 'sequential-mode section not found');
    // The host step delegates the composition detail to the fragment (ADR-857
    // Phase 6 frozen ceiling — execute-phase.md cannot grow) and the prompt
    // gains the pin block plus the per-write/commit instruction.
    assert.match(sequential, /read and execute\s+`execute-phase\/steps\/sequential-root-pin\.md`/);
    assert.match(sequential, /<project_root_pin>/);
    assert.match(sequential, /Run the `<project_root_pin>` guard before your first Edit\/Write and before every commit/);
    // The fragment carries the full build-time embed contract.
    assert.match(pinStepSrc, /ORCHESTRATOR build-time embed/);
    assert.match(pinStepSrc, /\{PINNED_ROOT\}/);
    assert.match(pinStepSrc, /ORCHESTRATOR_WT/);
    assert.match(pinStepSrc, /do not pass this instruction through/i);
    // The self-derivation is replaced with the literal, preserving the
    // `PROJECT_ROOT=` binding the rest of <required_reading> depends on.
    assert.match(pinStepSrc, /replace the self-derivation line/);
    assert.match(pinStepSrc, /PROJECT_ROOT='<the same literal/);
    // Scoping: the fragment must say worktree mode keeps the self-derived form.
    assert.match(pinStepSrc, /sequential-mode\s+ONLY/i);
    // The wave serialization rules moved with it, verbatim in substance.
    assert.match(pinStepSrc, /two non-worktree plans in the same wave must serialize/);
  });

  test('#4254: worktree-mode dispatch is untouched — keeps self-derivation, gains no pin', () => {
    const isolated = executePhaseSrc.slice(
      executePhaseSrc.indexOf('<parallel_execution>'),
      executePhaseSrc.indexOf('**Sequential mode**'),
    );
    assert.ok(isolated.length > 0, 'worktree-mode dispatch slice not found');
    assert.match(isolated, /PROJECT_ROOT=\$\(git rev-parse --show-toplevel/, 'isolated executor keeps its own (correct) root derivation');
    assert.doesNotMatch(isolated, /<project_root_pin>/, 'isolated prompt must not inherit the orchestrator root');
  });
});

// #4767 — the <automated> command guard (worktree-path-safety.md step 0c) is EXECUTED, not merely
// grepped for: the fenced bash block is extracted verbatim and driven against a real linked
// worktree, so a regex regression in the guard fails here rather than in a maintainer's plan run.
describe('#4767: step 0c <automated> guard executes against a real worktree', { skip: process.platform === 'win32' ? 'bash + git worktree harness is POSIX-only' : false }, () => {
  const os = require('node:os');
  const { before, after } = require('node:test');
  const { spawnSync } = require('node:child_process');
  const { cleanup } = require('./helpers.cjs');
  const REPO_ROOT = path.join(__dirname, '..');
  const SPAWN_TIMEOUT_MS = 30_000;
  const refSrc = fs.readFileSync(path.join(REPO_ROOT, 'gsd-core', 'references', 'worktree-path-safety.md'), 'utf8');
  const sectionIdx = refSrc.indexOf('## `<automated>` command guard — step 0c (#4767)');
  assert.ok(sectionIdx !== -1, 'step 0c section not found');
  const fenceOpen = refSrc.indexOf('```bash\n', sectionIdx);
  const fenceClose = refSrc.indexOf('\n```', fenceOpen + 8);
  const guard = refSrc.slice(fenceOpen + 8, fenceClose);

  let tmp;
  let main;
  let wt;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4767-guard-'));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    const git = (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git(['init', '-q', main], tmp);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
    git(['worktree', 'add', '-q', wt, '-b', 'wt'], main);
    fs.mkdirSync(path.join(wt, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'scripts dir'), { recursive: true });
    fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
    // A symlink INSIDE the worktree that lands in the main checkout — lexically contained, really not.
    fs.symlinkSync(main, path.join(wt, 'main-link'));
    fs.symlinkSync(main, path.join(wt, 'scripts copy'));
    fs.symlinkSync(main, path.join(wt, "O'Reilly"));
    fs.symlinkSync(main, path.join(wt, 'a"b'));
    fs.symlinkSync(main, path.join(wt, 'release=main'));
    fs.symlinkSync(path.join(main, '.git', 'HEAD'), path.join(wt, 'main-head'));
    fs.writeFileSync(path.join(wt, 'README.md'), 'x\n');
    // #4767 round 2 — a readable file in the MAIN checkout, so an interpreter-wrapped absolute file
    // argument (`eval "cat <main>/secret.txt"`) names something that really exists outside the worktree.
    fs.writeFileSync(path.join(main, 'secret.txt'), 'SECRET\n');
  });
  after(() => { if (tmp) cleanup(tmp); });

  // Driven under `bash -eu`: an executor's shell may have both on, and the guard must neither
  // abort on an unset expansion nor be short-circuited by errexit inside its own helpers.
  const run = (cmd) => spawnSync('bash', ['-eu', '-c', guard], { cwd: wt, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: { ...process.env, AUTOMATED_CMD: cmd } });
  const realMain = () => fs.realpathSync(main);
  const realWt = () => fs.realpathSync(wt);

  test('spells literal ERE operators portably for BSD sed and grep', () => {
    // POSIX does not define backslash-escaping these ERE operators. GNU accepts
    // the old `\\|` / `\\(` / `\\{` spelling, while macOS BSD sed rejects the
    // expanded boundary strip with "unbalanced brackets" and disables the scan.
    assert.ok(!guard.includes("_OPEN='(^|&&|&|;|\\||\\(|\\{)"), 'grep boundary carries GNU-only escaped ERE operators');
    assert.ok(!guard.includes('sed -E "s/^(&&|&|;|\\||\\(|\\{)?'), 'sed boundary carries GNU-only escaped ERE operators');
    assert.match(guard, /_OPEN='\(\^\|&&\|&\|;\|\[\|\]\[\|\]\|\[\|\]\|\[\(\]\|\[\{\]\)/);
    assert.equal(
      [...guard.matchAll(/sed -E "s\/\^\(&&\|&\|;\|\[\|\]\[\|\]\|\[\|\]\|\[\(\]\|\[\{\]\)\?/g)].length,
      1,
      'the ordered event scan must use POSIX-portable bracket expressions',
    );
    assert.ok(!guard.includes('sed -E "s#^${_ENV}${_EVAL}'), 'classification must not expand composed EREs into BSD sed');
    assert.match(guard, /_P=\$\(printf '%s' "\$BODY" \| grep -oE "\^\$\{_ENV\}\$\{_EVAL\}"\)/, 'classification should reuse portable grep and strip its match literally');
    assert.match(guard, /_resets_cwd "\$BFR" \|\| _resets_cwd "\$RAW"/, 'the event scan must retain resets across intervening unrecognized commands');
  });

  test('the boundary section’s two interpreter lists match the guard’s behaviour (#4785)', () => {
    // The reference's own closing line says the enumerations are the parts that rot. This checks that
    // claim BEHAVIOURALLY: every name the prose lists as Recognized really halts, and every name it
    // lists as Not recognized really passes. It does NOT parse `_EXEC`.
    //
    // WHY NOT, because the obvious design is to derive the names from the regex and diff them, and
    // that is what this test did for four revisions. The pre-push review broke it four times, each
    // time with a different ERE shape the parser did not model: a section-wide `includes` satisfied by
    // a name in the UNSUPPORTED half (`awk`); a span-scoped `includes` satisfied by substring nesting
    // (`ash` inside `bash`/`dash`); an end-anchored optional-expansion that silently dropped `a?sh`;
    // and, after that was made fail-closed, a bare OUTER alternative (`...|ash|eval)`) that sits
    // outside the groups the fail-closed arm inspects. Four driven evasions of four parsers is the
    // finding: a test that re-implements a shell ERE will keep losing to the next shape, and every
    // loss is a FALSE GREEN on the exact question it exists to answer.
    //
    // So the guarantee is narrowed to one that is TRUE and driven. STATE THE RESIDUAL PLAINLY: this
    // does not catch an interpreter added to `_EXEC` and documented nowhere — nothing here enumerates
    // `_EXEC` any more. What it does catch is the direction that actually misleads a reader of the
    // boundary section: prose that claims coverage the guard does not have, or disclaims coverage it
    // does. `perl -e` was silently covered while the prose implied otherwise; that is this shape.
    //
    // TWO FURTHER RESIDUALS, named because an incomplete disclosure is its own defect. (a) Each
    // ordinary name is exercised as `<name> -c` only; the prose's claims about OTHER option forms and
    // path spellings are unchecked except for the three explicit controls at the end of this test.
    // (b) This reads the two delimited spans and nothing else, so a coverage claim made elsewhere in
    // the section is not driven. Both were named by the pre-push review rather than assumed absent.
    const boundaryIdx = refSrc.indexOf('### What this guard does NOT see');
    assert.ok(boundaryIdx !== -1, 'the step 0c boundary section is missing');
    const boundary = refSrc.slice(boundaryIdx);
    const recogIdx = boundary.indexOf('Recognized,');
    const notRecogIdx = boundary.indexOf('Not recognized:');
    const tailIdx = boundary.indexOf('**The two lists are delimited on purpose**');
    assert.ok(recogIdx !== -1 && notRecogIdx > recogIdx && tailIdx > notRecogIdx,
      'the boundary section no longer delimits `Recognized,` … `Not recognized:` … the spans this test reads are gone');

    // CLASSIFY EVERY BACKTICKED TOKEN IN THE SPAN, AND FAIL CLOSED ON ONE THIS CANNOT PLACE. A
    // narrower name regex silently SKIPS what it does not match, which is the same false green in
    // miniature: `Also recognized: \`tcl-sh\`.` inside the Recognized span left an earlier version
    // green because the pattern was `[a-z][a-z0-9]+` and the hyphen dropped the token — driven by the
    // pre-push review. An option spelling (`-c`, `-ec`, `-[a-z]*[ce]`) is a legitimate non-name and is
    // recognised as such by its leading dash; anything else is UNCLASSIFIABLE and reds here rather
    // than being quietly excluded from the behavioural loop below. A token carrying whitespace or a
    // slash is an example COMMAND or path rather than a name (`/bin/eval 'cd ../main'`), and is
    // skipped; the prose's absolute-path claims are pinned by the three explicit controls at the end
    // of this test instead. That skip is the one deliberate hole in the classification, and it is
    // narrow: a bare name cannot hide in it.
    const words = (span) => {
      const out = [];
      for (const m of span.matchAll(/`([^`\n]+)`/g)) {
        const tok = m[1];
        if (tok.startsWith('-')) continue;                       // an option spelling, not a name
        if (/[\s/]/.test(tok)) continue;                         // an example COMMAND or path, not a name
        if (/^[A-Za-z][A-Za-z0-9._-]+$/.test(tok)) { out.push(tok); continue; }
        if (/^[A-Za-z]$/.test(tok)) continue;                    // a single letter: `c` / `e` in the option prose
        assert.fail(
          `the interpreter lists contain a backticked token this test cannot classify: \`${tok}\`. ` +
          `It is neither an option spelling (leading '-') nor an interpreter name, so it would be ` +
          `silently excluded from the behavioural check.`,
        );
      }
      return out;
    };
    const recognized = [...new Set(words(boundary.slice(recogIdx, notRecogIdx)))];
    const unsupported = [...new Set(words(boundary.slice(notRecogIdx, tailIdx)))];
    assert.ok(recognized.length >= 8, `Recognized list parsed ${recognized.length} names — the span markers moved`);
    assert.ok(unsupported.length >= 2, `Not-recognized list parsed ${unsupported.length} names — the span markers moved`);
    for (const n of unsupported) {
      assert.ok(!recognized.includes(n), `'${n}' appears in BOTH lists — the two halves disagree`);
    }

    // `eval` is a shell builtin with no `-c`; everything else takes a short-option cluster. The guard
    // never EXECUTES the command, so no interpreter needs to be installed for these rows.
    const payload = `cd ${realMain()} && ls`;
    for (const n of recognized) {
      const cmd = n === 'eval' ? `eval "${payload}"` : `${n} -c "${payload}"`;
      assert.notEqual(run(cmd).status, 0,
        `the prose lists '${n}' as Recognized, but the guard did NOT halt on \`${cmd}\``);
    }
    for (const n of unsupported) {
      const cmd = `${n} -c "${payload}"`;
      assert.equal(run(cmd).status, 0,
        `the prose lists '${n}' as Not recognized, but the guard halted on \`${cmd}\``);
    }
    // The prose's own two distinctions, pinned: an absolute-path interpreter IS unwrapped, while the
    // `eval` branch carries no absolute-path form, and the option is a CLUSTER rather than a literal.
    assert.notEqual(run(`/bin/bash -c "${payload}"`).status, 0, 'an absolute-path shell must still halt');
    assert.equal(run(`/bin/eval "${payload}"`).status, 0, 'the prose says `eval` has no absolute-path form');
    assert.notEqual(run(`python -abc "${payload}"`).status, 0, 'the prose says the option is a cluster, not a literal -c');
  });

  test('halts on a cd into the main checkout (the #4767 shape)', () => {
    const r = run(`cd ${realMain()}/scripts/verify && python3 -m pytest -q`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FATAL: <automated> command relocates to .* outside the worktree/);
  });

  for (const [label, cmd] of [
    ['npm --prefix <outside>', 'npm --prefix /srv/other run lint'],
    ['npm --prefix=<outside>', 'npm --prefix=/srv/other run lint'],
    ['npm run … --prefix <outside>', 'npm run lint --prefix /srv/other'],
    ['a subshell-wrapped cd', '(cd /srv/other && make)'],
    ['a path carrying ERE metacharacters', 'cd /srv/c++/a(b)/[1] && make'],
    ['a backslash-escaped space', 'cd /srv/other/path\\ with\\ space && ls'],
    ['cd followed by `;`', 'cd /srv/other; B=x; test -f "$B"'],
    ['builtin cd', 'builtin cd /srv/other && ls'],
    ['command cd', 'command cd /srv/other && ls'],
    ['pushd', 'pushd /srv/other && ls'],
    ['cd --', 'cd -- /srv/other && ls'],
    ['an env-prefixed cd', 'FOO=1 cd /srv/other && ls'],
    ['a target containing `=`', 'cd /srv/other/a=/x && ls'],
    ['a relative hop out of the worktree', 'cd ../main && ls'],
    ['a symlink inside the worktree that resolves to main', () => `cd ${realWt()}/main-link && ls`],
    ['an in-worktree `..` path that resolves to main', () => `cd ${realWt()}/../main && ls`],
    ['a bare absolute file argument under main', () => `python3 -m pytest ${realMain()}/scripts -q`],
    ['a double-quoted target with a space that resolves to main', () => `cd "${realWt()}/scripts copy" && ls`],
    ['a single-quoted outside target with a space', "cd '/srv/other/my dir' && ls"],
    ['a file read through an in-worktree symlink into main', () => `cat ${realWt()}/main-link/.git/HEAD`],
    ['a relative cd through the symlink', 'cd main-link && ls'],
    ['a quoted prefix with an unquoted suffix', () => `cd "${realWt()}"/main-link && ls`],
    ['an escaped single quote in the path', () => `cd ${realWt()}/O\\'Reilly && ls`],
    ['an escaped double quote in the path', () => `cd ${realWt()}/a\\"b && ls`],
    ['a symlinked FILE whose target is in main', () => `cat ${realWt()}/main-head`],
    ['a chained cd whose second hop leaves the worktree', 'cd scripts && cd ../.. && ls'],
    ['a chained cd that reaches main relatively', 'cd scripts && cd ../../main && ls'],
    ['an interpreter after a backgrounded cd starts from the parent cwd', "cd scripts & bash -c 'cd ..'"],
    ['an interpreter after a piped cd starts from the parent cwd', "cd scripts | bash -c 'cd ..'"],
    ['an unrecognized command after a backgrounded cd does not consume the cwd reset', "cd scripts & echo x && bash -c 'cd ..'"],
    ['an unrecognized command after a piped cd does not consume the cwd reset', "cd scripts | cat && bash -c 'cd ..'"],
    ['an earlier interpreter payload is not contaminated by a later outer cd', "cd scripts && bash -c 'cd ../.. && test -d main' && cd deeper"],
    ['a subprocess interpreter cannot relocate its parent shell', "bash -c 'cd scripts' && cd .."],
    ['a launcher cannot turn eval into a cwd-persistent shell builtin', "env eval 'cd scripts'; cd .."],
    ['env -C outside is not hidden by its wrapped interpreter', "env -C ../main bash -c 'echo ok'"],
    ['env --chdir= outside is not hidden by its wrapped interpreter', "env --chdir=../main sh -c 'echo ok'"],
    ['a timeout wrapper cannot hide env -C outside', "timeout 5 env -C ../main bash -c 'echo ok'"],
    ['a later env -C cannot hide an earlier outside launcher relocation', "env -C ../main env -C ../wt bash -c 'echo ok'"],
    ['a quoted env -C launcher target still exposes its payload', "env -C 'scripts dir' bash -c 'cd ../..'"],
    ['a quoted env --chdir launcher target still exposes its payload', "env --chdir 'scripts dir' sh -c 'cd ../..'"],
    ['an equals-form quoted env --chdir target still exposes its payload', "env --chdir='scripts dir' sh -c 'cd ../..'"],
    ['npm --prefix ../.. after a cd (resolved from the reached cwd)', 'cd scripts && npm --prefix ../.. test'],
    ['a double-quoted name containing an apostrophe', `cd "O'Reilly" && ls`],
    ['a path containing a literal =', () => `cd ${realWt()}/release=main && ls`],
    ['an env assignment whose value is a main-checkout path', () => `FOO=${realMain()}/x env | cat`],
    // #4767 round 2 — command-string interpreters. `eval`/`sh -c`/`bash -c` bury the relocating verb
    // inside ONE opaque quoted token, which defeats BOTH scans at once: the verb never sits at a
    // boundary the relocating-verb scan recognizes, and the catch-all tokenizer swallows the whole
    // quoted span, which after unquoting does not begin with `/`. Every row below exits 0 against the
    // round-1 guard (verified as a negative control) and halts against this one.
    ['eval wrapping a cd into main', () => `eval "cd ${realMain()} && ls"`],
    ['eval wrapping a RELATIVE cd out of the worktree', "eval 'cd ../main && ls'"],
    ['sh -c wrapping a cd into main', () => `sh -c "cd ${realMain()} && ls"`],
    ['bash -c wrapping a cd into main', () => `bash -c 'cd ${realMain()} && ls'`],
    ['eval wrapping an absolute FILE argument under main', () => `eval "cat ${realMain()}/secret.txt"`],
    ['sh -c wrapping an absolute FILE argument under main', () => `sh -c "cat ${realMain()}/secret.txt"`],
    ['zsh -c wrapping a cd into main', () => `zsh -c "cd ${realMain()} && ls"`],
    ['a clustered short flag (sh -ec)', () => `sh -ec "cd ${realMain()} && ls"`],
    ['python3 -c relocating via os.chdir', () => `python3 -c "import os;os.chdir('${realMain()}')"`],
    ['node -e relocating via process.chdir', () => `node -e "process.chdir('${realMain()}')"`],
    // The rest of `_EXEC`'s set, pinned because worktree-path-safety.md now STATES the ten it
    // recognizes and a stated coverage claim with no row is prose. The guard never executes the
    // command — it scans text — so none of these needs its interpreter installed.
    ['perl -e relocating via chdir', () => `perl -e 'chdir "${realMain()}"'`],
    ['ksh -c wrapping a cd into main', () => `ksh -c "cd ${realMain()} && ls"`],
    ['a digit-less python -c relocating via os.chdir', () => `python -c "import os;os.chdir('${realMain()}')"`],
    ['a wrapper nested inside a wrapper', () => `eval "sh -c 'cd ${realMain()} && ls'"`],
    ['an interpreter reached after &&', () => `echo hi && eval "cd ${realMain()} && ls"`],
    // …and the launcher forms a planner actually writes in front of one. `timeout` in particular is
    // ordinary in a verify command, and a wrapper is no less a wrapper for having a launcher ahead of it.
    ['a launcher (timeout) ahead of the interpreter', () => `timeout 60 bash -c "cd ${realMain()} && ls"`],
    ['env ahead of the interpreter', () => `env bash -c "cd ${realMain()} && ls"`],
    ['nohup ahead of the interpreter', () => `nohup sh -c "cd ${realMain()} && ls"`],
    // …and the forms the round-2 adversarial pass found still open: an interpreter named by absolute
    // path or carrying its own options, a recognised tool behind a launcher, and a shell CONTROL
    // keyword as the command boundary.
    ['an interpreter named by absolute path', () => `/bin/bash -c 'cd ${realMain()} && ls'`],
    ['an interpreter carrying its own long option', () => `bash --noprofile -c 'cd ${realMain()} && ls'`],
    ['a recognised tool behind a launcher', 'env npm --prefix ../main test'],
    // …a launcher named by absolute path, or carrying an option with a SEPARATE operand.
    ['a launcher named by absolute path', () => `/usr/bin/env bash -c "cd ${realMain()} && ls"`],
    ['a launcher option with a separate operand', () => `env -u FOO bash -c "cd ${realMain()} && ls"`],
    ['a long launcher option with an operand', () => `timeout --signal TERM 60 bash -c "cd ${realMain()} && ls"`],
    ['stdbuf with an operand', () => `stdbuf -o L sh -c "cd ${realMain()} && ls"`],
    // `env` is not only a launcher: --chdir / -C make it a relocating verb in its own right.
    ['env --chdir, which relocates env itself', 'env --chdir=../main npm test'],
    ['env -C, the same flag spelled short', 'env -C ../main npm test'],
    ['env -C reached through a launcher', 'timeout 60 env -C ../main npm test'],
    // A separate-operand option before the directory flag must not hide it: `-u FOO` consumed `FOO`
    // generically and left `-C ../main` unseen. The env option grammar is scoped per consumer.
    ['env -u before -C, which used to hide the flag', 'env -u FOO -C ../main npm test'],
    ['the same, behind a launcher', 'timeout 60 env -u FOO -C ../main npm test'],
    ['the long spellings of both', 'env --unset FOO --chdir=../main npm test'],
    // `env -C <dir>` relocates AND launches: its payload must still be unwrapped.
    ['a payload behind a relocating launcher', "env -C scripts bash -c 'cd ../../main && ls'"],
    // Operand-taking options INTERLEAVED with ordinary ones. A grammar that allows only one contiguous
    // run of them lets a generic option in the middle hide everything after it — including the `-C`.
    ['interleaved env options hiding a -C', 'env -u FOO --debug -u BAR -C ../main npm test'],
    ['interleaved env options before an interpreter', "env -u FOO --debug -u BAR bash -c 'cd ../main && ls'"],
    ['interleaved timeout options', () => `timeout -k 5 --signal TERM 60 bash -c "cd ${realMain()} && ls"`],
    ['interleaved stdbuf options', () => `stdbuf -o L -e L sh -c "cd ${realMain()} && ls"`],
    // #4767 round 2 — a tool's own directory flag with a RELATIVE argument. The absolute form was
    // already caught by the catch-all absolute-word scan; the relative form was invisible to both.
    ['make -C relative, out of the worktree', 'make -C ../main/scripts test'],
    ['git -C relative, out of the worktree', 'git -C ../main status'],
    ['yarn --cwd relative, out of the worktree', 'yarn --cwd ../main test'],
    ['pnpm -C relative, out of the worktree', 'pnpm -C ../main test'],
    ['npx --prefix relative, out of the worktree', 'npx --prefix ../main tsc'],
    // #4767 round 2 — a single `&` is a command boundary too; only `&&` was recognized.
    ['a relative cd after a background operator', 'ls & cd ../main && ls'],
  ]) {
    test(`halts on ${label}`, () => {
      const c = typeof cmd === 'function' ? cmd() : cmd;
      const r = run(c);
      assert.equal(r.status, 1, `expected a halt for: ${c}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /FATAL: <automated> command (names|relocates to)/);
    });
  }

  for (const [label, cmd] of [
    ['a relative cd', 'cd scripts && ls 2>/dev/null'],
    ['a relative cd into a directory that does not exist yet (Wave-0 scaffold)', 'cd future-scaffold && npm test'],
    ['a relative cd into a nested not-yet-existing directory', 'cd scripts/new/deep && ls'],
    ['a relative hop that lands back inside the worktree', 'cd ../wt/scripts && ls'],
    ['absolute arguments under /tmp and $HOME that are not under main', 'ls /tmp /home 2>/dev/null; cd scripts'],
    ['a trailing slash and a ./ prefix', 'cd scripts/ && cd ./scripts && ls'],
    ['a cd onto an existing FILE inside the worktree', 'cd README.md'],
    ['a glob in an absolute argument (no expansion during normalization)', 'ls /missing/*/deep; cd scripts'],
    ['a quoted apostrophe in an ordinary argument', `grep -q 'x' README.md && echo "it's fine"`],
    ['a chained cd that returns to the worktree root', 'cd scripts && cd .. && ls'],
    ['a chained cd through not-yet-existing directories', 'cd future && cd deeper && ls'],
    ['a chained cd followed by npm --prefix .', 'cd scripts && npm --prefix . test'],
    ['a dynamic target the shell would expand (the probe owns these as dynamic_path)', 'cd "$(git rev-parse --show-toplevel)/scripts" && ls'],
    ['an ordinary argument containing =', 'echo a=b=c && cd scripts'],
    ['npm --prefix . and make -C inside the worktree', 'npm --prefix . run test && make -C scripts'],
    ['npm --prefix .. after a cd (npm does not move the cwd)', 'cd scripts && npm --prefix .. test && cd .. && ls'],
    ['an absolute cd inside the worktree', () => `cd ${realWt()}/scripts && ls`],
    ['--prefix= inside the worktree', () => `npm run lint --prefix=${realWt()}/scripts`],
    ['a system path that is not a relocating target', 'cat /etc/hosts | grep -c x'],
    ['an absolute file argument outside both checkouts', 'ls /srv/other/plain && cd scripts'],
    ['a redirect to /dev/null', 'test -f /usr/bin/env && echo ok'],
    // #4767 round 2 — the interpreter class is UNWRAPPED and re-scanned, not rejected wholesale, so an
    // ordinary portability wrapper whose payload stays inside the worktree must remain silent.
    ['bash -c wrapping an in-worktree command', "bash -c 'npm test'"],
    ['sh -c wrapping a relative cd that stays inside', "sh -c 'cd scripts && ls'"],
    ['an eval payload whose cd relocates the current shell', "eval 'cd scripts' && cd .."],
    ['nested in-worktree env -C launchers resolve sequentially', "env -C scripts env -C .. bash -c 'echo ok'"],
    ['a quoted in-worktree env -C target with a safe payload', "env -C 'scripts dir' bash -c 'cd ..'"],
    ['make -C inside the worktree', 'make -C scripts test'],
    ['git -C inside the worktree', 'git -C scripts status'],
    ['an interpreter payload the shell would build at run time (dynamic_path)', 'eval "cd $TARGET && ls"'],
    ['node -e naming no path at all', "node -e 'console.log(1)'"],
    ['a launcher ahead of an interpreter whose payload stays inside', "timeout 60 bash -c 'npm test'"],
    // Two false positives the round-2 adversarial pass found and this round fixed. `--prefix` on `git`
    // names archive MEMBERS, not a directory, so the flag set is tool-scoped; and interpreter text that
    // is merely an ARGUMENT executes nothing, so the launcher set is named rather than a catch-all run.
    ['git archive --prefix, which is not a directory flag', 'git archive --prefix=../main/ HEAD'],
    ['interpreter text passed as an argument, not executed', "echo bash -c 'cd ../main && ls'"],
    // Two more false positives the round-2 pass found. Control keywords are NOT in `_OPEN` precisely
    // because these operators match raw text with no quote-awareness, and `command -v` is a name probe
    // that executes nothing. Both rows fail if either widening is re-introduced.
    ['a control keyword inside a quoted grep argument', "grep -F 'if cd ../main; then' README.md"],
    ['command -v, a name probe that executes nothing', "command -v bash -c 'cd ../main && ls'"],
    // A launcher option that takes NO operand must not swallow the command after it: `env -i echo …`
    // runs echo, not the interpreter text it prints. Which options take an operand is tool-scoped.
    ['an operandless launcher option before a harmless command', "env -i echo bash -c 'cd ../main && ls'"],
    ['a launcher -- separator before a harmless command', "nohup -- echo bash -c 'cd ../main && ls'"],
    ['a directory-flag spelling that is pass-through data', 'env printf -C ../main'],
  ]) {
    test(`passes ${label}`, () => {
      const c = typeof cmd === 'function' ? cmd() : cmd;
      const r = run(c);
      assert.equal(r.status, 0, `expected a pass for: ${c}\nstderr: ${r.stderr}`);
      assert.equal(r.stderr.trim(), '', 'a passing command must be silent');
    });
  }
});
