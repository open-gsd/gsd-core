/**
 * #5080 — execute-phase by-path dispatch embeds (`workflow.dispatch_embed`).
 *
 * `path` mode replaces two per-dispatch verbatim copies with references:
 *   - the <execution_context> procedure files become an absolute-path list the
 *     executor Reads in full;
 *   - the bound sequential root-pin guard is written ONCE per run to a file in
 *     the checkout's git dir, and each <project_root_pin> block carries only a
 *     `bash '<abs path>'` line (so a pre-#5080 executor still runs a bound guard).
 *
 * The guard file must fail closed when it is missing, unbound, or run from a
 * foreign checkout. These tests EXECUTE the shipped guard and the shipped
 * write-once snippet against real git fixtures — never a hand-copied body.
 */

// Source text is the product here (#5080): execute-phase.md, the
// sequential-root-pin step, worktree-path-safety.md and agents/gsd-executor.md
// are the deployed prompts; the bash snippets extracted from them are what the
// orchestrator and executor run. No `no-source-grep` exemption marker: the rule
// flags no site in this file (it reads .md prompts, never .cjs source).

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const executePhaseSrc = read('gsd-core', 'workflows', 'execute-phase.md');
const pinStepSrc = read('gsd-core', 'workflows', 'execute-phase', 'steps', 'sequential-root-pin.md');
const safetySrc = read('gsd-core', 'references', 'worktree-path-safety.md');
const executorSrc = read('agents', 'gsd-executor.md');

const PIN_MARKER = '# gsd:guard=supplied-root-pin';
const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** The shipped step-0p guard: the ```bash block that starts with the marker. */
function extractPinGuard() {
  const body = safetySrc.split('```bash\n').find((b) => b.startsWith(PIN_MARKER));
  assert.ok(body, 'worktree-path-safety.md must ship the supplied-root-pin guard');
  return body.split('```')[0].trim();
}

/** The guard bound per the composition contract (single-quoted literal). */
function bindGuard(pin) {
  return extractPinGuard().replace("PINNED_ROOT='{PINNED_ROOT}'", `PINNED_ROOT=${shellQuote(pin)}`);
}

/** The shipped write-once snippet from sequential-root-pin.md (the block that sets ROOT_PIN_FILE). */
function extractWriteOnceSnippet() {
  const body = pinStepSrc.split('```bash\n').find((b) => b.startsWith('ROOT_PIN_FILE='));
  assert.ok(body, 'sequential-root-pin.md must ship the path-mode write-once snippet');
  return body.split('```')[0];
}

function bash(script, cwd, env = {}) {
  return runHook('-c', [script], {
    interpreter: 'bash',
    cwd,
    timeoutMs: HOOK_FANOUT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
}

function makeOrchestratorLane(prefix) {
  const primary = createTempGitProject(prefix);
  const lane = `${primary}-orchestrator-wt`;
  gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/2-1', lane], { cwd: primary });
  return { primary, lane };
}

/**
 * Run the orchestrator's write-once snippet with `guardText` in the heredoc
 * slot, exactly as sequential-root-pin.md tells the orchestrator to.
 */
function writeGuardFile(lane, guardText) {
  const snippet = extractWriteOnceSnippet().replace('{the bound step-0p guard}', guardText);
  const res = bash(`${snippet}\nprintf '%s' "$ROOT_PIN_FILE"`, lane, { ORCHESTRATOR_WT: lane });
  return { res, file: res.stdout.trim().split('\n').pop() };
}

describe('#5080 workflow.dispatch_embed config key', () => {
  test('defaults to inline in a project that does not set it', () => {
    const project = createTempProject('gsd-5080-cfg-');
    try {
      const r = runGsdTools(['config-get', 'workflow.dispatch_embed', '--raw'], project);
      assert.equal(r.exitCode, 0, r.output);
      assert.equal(r.output.trim(), 'inline');
    } finally {
      cleanup(project);
    }
  });

  test('accepts path and inline and round-trips them', () => {
    const project = createTempProject('gsd-5080-cfgset-');
    try {
      for (const mode of ['path', 'inline']) {
        const set = runGsdTools(['config-set', 'workflow.dispatch_embed', mode], project);
        assert.equal(set.exitCode, 0, set.output);
        const get = runGsdTools(['config-get', 'workflow.dispatch_embed', '--raw'], project);
        assert.equal(get.output.trim(), mode);
      }
    } finally {
      cleanup(project);
    }
  });

  test('rejects a value outside inline|path', () => {
    const project = createTempProject('gsd-5080-cfgbad-');
    try {
      const set = runGsdTools(['config-set', 'workflow.dispatch_embed', 'verbatim'], project);
      assert.notEqual(set.exitCode, 0, 'an unknown embed mode must be rejected');
    } finally {
      cleanup(project);
    }
  });

  test('execute-phase.md normalises the key: only "path" selects path mode', () => {
    // The shipped two-line read, run against a stubbed gsd_run.
    const lines = executePhaseSrc.split('\n').filter((l) => /^(DISPATCH_EMBED=|\[ "\$DISPATCH_EMBED")/.test(l));
    assert.equal(lines.length, 2, 'execute-phase.md must read and normalise DISPATCH_EMBED');
    const cases = [
      ['echo path', 'path'],
      ['echo inline', 'inline'],
      ['echo verbatim', 'inline'],
      ['return 1', 'inline'],
    ];
    for (const [stub, expected] of cases) {
      const r = bash(`gsd_run() { ${stub}; }\n${lines.join('\n')}\nprintf '%s' "$DISPATCH_EMBED"`, ROOT);
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.stdout, expected, `stub "${stub}" must resolve to ${expected}`);
    }
  });
});

describe('#5080 by-path root-pin guard fails closed', () => {
  test('write-once snippet writes the bound guard into the git dir and self-checks it', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-5080-write-');
    try {
      const { res, file } = writeGuardFile(lane, bindGuard(lane));
      assert.equal(res.exitCode, 0, `bound guard must pass its self-check:\n${res.stderr}`);
      const gitDir = gitOrThrow(['rev-parse', '--absolute-git-dir'], { cwd: lane }).trim();
      assert.equal(file, path.join(gitDir, 'gsd-root-pin.sh').split(path.sep).join('/'));
      assert.ok(fs.statSync(file).isFile());
      // In the git dir, so never an untracked file an executor could stage.
      assert.equal(gitOrThrow(['status', '--porcelain'], { cwd: lane }).trim(), '');
    } finally {
      cleanup(primary);
    }
  });

  test('write-once snippet halts when the written guard is unbound', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-5080-writeunbound-');
    try {
      const { res } = writeGuardFile(lane, extractPinGuard());
      assert.equal(res.exitCode, 1, 'an unbound guard file must fail the orchestrator self-check');
      assert.match(res.stderr, /Guard stage: pin-unbound/);
    } finally {
      cleanup(primary);
    }
  });

  test('bound guard file: pinned checkout passes, foreign checkout halts before the write', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-5080-foreign-');
    try {
      const { file } = writeGuardFile(lane, bindGuard(lane));
      // The minimal <project_root_pin> block line, as a pre-#5080 executor runs it.
      const blockLine = `bash ${shellQuote(file)}`;

      const okMarker = path.join(lane, 'ok-marker');
      const ok = bash(`${blockLine} && printf W > ${shellQuote(okMarker)}`, lane);
      assert.equal(ok.exitCode, 0, ok.stderr);
      assert.equal(fs.readFileSync(okMarker, 'utf8'), 'W');

      const badMarker = path.join(primary, 'bad-marker');
      const bad = bash(`${blockLine} && printf W > ${shellQuote(badMarker)}`, primary);
      assert.equal(bad.exitCode, 1, `a foreign checkout must halt:\n${bad.stderr}`);
      assert.match(bad.stderr, /Guard stage: root-mismatch/);
      assert.equal(fs.existsSync(badMarker), false, 'no write may follow a foreign-checkout run');
    } finally {
      cleanup(primary);
    }
  });

  test('unbound guard file halts at pin-unbound even from the right checkout', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-5080-unbound-');
    try {
      // Outside the lane (the checkout under test) but inside the fixture cleanup() removes.
      const file = path.join(primary, 'unbound-pin.sh');
      fs.writeFileSync(file, `${extractPinGuard()}\n`);
      const marker = path.join(lane, 'marker');
      const r = bash(`bash ${shellQuote(file)} && printf W > ${shellQuote(marker)}`, lane);
      assert.equal(r.exitCode, 1, r.stderr);
      assert.match(r.stderr, /Guard stage: pin-unbound/);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      cleanup(primary);
    }
  });

  test('missing guard file fails closed (non-zero, no write)', () => {
    const { primary, lane } = makeOrchestratorLane('gsd-5080-missing-');
    try {
      const missing = path.join(lane, '.git-does-not-exist', 'gsd-root-pin.sh');
      const marker = path.join(lane, 'marker');
      const r = bash(`bash ${shellQuote(missing)} && printf W > ${shellQuote(marker)}`, lane);
      assert.notEqual(r.exitCode, 0, 'a missing guard file must not read as a pass');
      assert.equal(fs.existsSync(marker), false);
    } finally {
      cleanup(primary);
    }
  });
});

describe('#5080 prompt contracts', () => {
  test('execute-phase.md <execution_context> covers both modes and flags the short reply', () => {
    const block = executePhaseSrc.slice(
      executePhaseSrc.indexOf('<execution_context>'),
      executePhaseSrc.indexOf('</execution_context>'),
    );
    assert.match(block, /`DISPATCH_EMBED=inline`[^\n]*inlined verbatim/);
    assert.match(block, /`DISPATCH_EMBED=path`[^\n]*Read each file below IN FULL/);
    assert.match(block, /<reply_shape>short<\/reply_shape>/);
    assert.match(block, /@path` never expands/, 'the #3324 no-@-include rule must survive');
  });

  test('step 0p accepts a by-path guard and forbids warn-and-continue when the file is absent', () => {
    assert.match(safetySrc, /\*\*By-path guard \(#5080\):\*\*/);
    assert.match(safetySrc, /`bash '<absolute path>'`/);
    assert.match(safetySrc, /Any non-zero\s+exit is FATAL/);
    assert.match(safetySrc, /never fall back to\s+the warn-and-continue path/);
  });

  test('gsd-executor recognises the by-path guard', () => {
    assert.match(executorSrc, /<step name="root_pin">[\s\S]*?`bash '<absolute path>'`[\s\S]*?HALT[\s\S]*?<\/step>/);
  });

  test('short completion reply is opt-in, at most 15 lines, and keeps every parsed marker', () => {
    const fmt = executorSrc.slice(
      executorSrc.indexOf('<completion_format>'),
      executorSrc.indexOf('</completion_format>'),
    );
    const at = fmt.indexOf('**Short reply (opt-in, #5080):**');
    assert.ok(at > 0, 'the short shape must follow the full completion format');
    assert.match(fmt.slice(at), /only when your prompt contains `<reply_shape>short<\/reply_shape>`/);
    const shape = fmt.slice(at).split('```markdown\n')[1].split('```')[0].trimEnd().split('\n');
    assert.ok(shape.length <= 15, `short reply must be <= 15 lines, got ${shape.length}`);
    for (const marker of ['## PLAN COMPLETE', '<worktree_metadata>', '</worktree_metadata>', '**Self-Check:**', '**SUMMARY:**']) {
      assert.ok(shape.some((l) => l.startsWith(marker)), `short reply must keep ${marker}`);
    }
  });
});
