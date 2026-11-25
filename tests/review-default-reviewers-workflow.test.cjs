'use strict';

// The review lanes as product code: the descriptor, the invocation plan, the runner and the opencode output handler
// (bugs #687, #2073, #1936, enh-773). The text of review.md (default reviewers, the build_prompt Review Instructions
// region, the codex exec lines) is the `review-default-reviewers-workflow` text contract in
// scripts/static-checks/text-contracts/.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('bug #687 → #2073: agy print mode is bounded, and its fallback chain fires', () => {
  // Phase 5b (#2799) moved the agy invocation out of review.md's bash into the declared lane plus
  // the named `antigravity` handler, so these assertions follow it.
  //
  // ONE INVARIANT DELIBERATELY CHANGED. The old contract was "--print-timeout PAIRED with an
  // external timeout/gtimeout killer, falling back to bare agy on macOS". That fallback WAS the
  // bug: stock macOS ships neither killer, so the lane ran unbounded there — and --print-timeout
  // cannot fire before agy creates a session (#2073 mode 3), which is the whole reason a second
  // bound existed. spawnSync's native timeout is always available, so the outer bound is now
  // unconditional on every platform. Strictly stronger; only the mechanism changed.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
  const { runLane } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
  const lane = REVIEWER_LANES.find((l) => l.slug === 'antigravity');
  const planFor = () => {
    const r = resolveLanePlan({ lane, configGet: (k) => ({ 'review.models.agy': 'agy-m' })[k], runDir: '/run', repoRoot: '/repo' });
    assert.equal(r.ok, true);
    return r.plan;
  };

  test('keeps its native --print-timeout AND carries an unconditional outer bound', () => {
    const argv = planFor().argv;
    const i = argv.indexOf('--print-timeout');
    assert.notEqual(i, -1, 'the tool-native inner bound must survive');
    assert.match(argv[i + 1], /^\d+s$/);
    assert.ok(lane.timeoutFloorMs > 0, 'and an outer wall-clock bound must be declared');
  });

  test('the outer bound is larger than the inner one, so it only backstops', () => {
    const argv = planFor().argv;
    const innerSec = parseInt(argv[argv.indexOf('--print-timeout') + 1], 10);
    assert.ok(lane.timeoutFloorMs / 1000 > innerSec,
      'the outer cap must not pre-empt a healthy run bounded by --print-timeout');
  });

  test('uses a file-reference prompt, not inline "$(cat …)" (arg-list overflow, #2073)', () => {
    assert.equal(lane.invoke.promptChannel, 'argv-file-ref');
    const last = planFor().argv.slice(-1)[0];
    assert.ok(last.includes('/run/gsd-review-prompt.md'));
    assert.ok(last.length < 1000, 'the reference must never carry the prompt body');
  });

  test('wires --model from review.models.agy (#2073 mode 2)', () => {
    assert.equal(lane.modelConfigKey, 'review.models.agy');
    const argv = planFor().argv;
    assert.equal(argv[argv.indexOf('--model') + 1], 'agy-m');
  });

  test('discards partial output on non-zero exit so the fallback fires (#687)', async () => {
    const p = planFor();
    const files = {};
    const d = {
      files,
      spawn: () => ({ status: 124, stdout: 'PARTIAL GARBAGE', stderr: '' }),
      httpJson: async () => ({ ok: true, status: 200, body: '{}' }),
      readFile: (x) => { if (!(x in files)) throw new Error('ENOENT'); return files[x]; },
      writeFile: (x, c) => { files[x] = c; },
      exists: (x) => x in files,
      hasBinary: () => true,
      configGet: () => undefined,
      homeDir: '/home/u',
      warn: () => {},
    };
    await runLane(p, d, { repoRoot: '/repo' });
    assert.ok(!files[p.reviewPath].includes('PARTIAL GARBAGE'),
      'a non-zero exit must discard stdout so the transcript fallback and diagnostic can take over');
    assert.ok(files[p.reviewPath].includes('failed or returned empty output'));
  });
});

describe('enh-773: automated codex exec invocations include --ephemeral (hook-trust bypass dropped by #2479)', () => {
  // Declared in the lane now rather than grepped out of review.md's bash lines.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const codex = REVIEWER_LANES.find((l) => l.slug === 'codex');
  const args = codex.invoke.args.join(' ');

  test('the codex lane uses the exec subcommand', () => {
    assert.ok(args.includes('exec'));
    assert.equal(codex.invoke.args[0], 'exec', 'exec is a SUBCOMMAND and must come first');
  });

  test('codex exec is --ephemeral', () => {
    assert.ok(args.includes('--ephemeral'));
  });

  test('no hook-trust bypass flag is emitted (#2479)', () => {
    assert.ok(!/dangerously|bypass/i.test(args),
      'host-harness safety classifiers deny commands carrying it; a genuine untrusted-hook prompt '
      + 'surfaces through the .err capture and the empty-output stub instead');
  });

  test('#1115: codex review failures are surfaced, not silently swallowed', () => {
    assert.equal(codex.emptyOutput, 'stub-with-stderr',
      'a failed codex run must produce a diagnosable stub carrying its stderr');
  });
});

describe('bug #1936: OpenCode reviewer must not silently yield an empty review', () => {
  // The agent can end its turn with ZERO output tokens, and `--format default` then drops the
  // assistant text entirely. Phase 5b (#2799) made the reconstruction a named first-party handler
  // rather than a jq pipeline in bash, so these assertions are behavioural over that handler.
  const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
  const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');
  const { handleOpencodeOutput } = require('../gsd-core/bin/lib/review-lane-runner.cjs');
  const NL = String.fromCharCode(10);
  const lane = REVIEWER_LANES.find((l) => l.slug === 'opencode');

  test('captures opencode stderr to a sidecar, never /dev/null', () => {
    const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/run', repoRoot: '/repo' });
    assert.equal(r.ok, true);
    assert.ok(r.plan.errPath.endsWith('.err'));
    assert.notEqual(r.plan.errPath, '/dev/null');
  });

  test('requests structured JSON output and reconstructs from assistant text parts', () => {
    assert.ok(lane.invoke.args.join(' ').includes('--format json'),
      '--format json is the PRIMARY invocation, not a fallback');
    assert.equal(lane.handler, 'opencode', 'reconstruction cannot be expressed as data');
    const stream = [
      JSON.stringify({ type: 'text', part: { text: 'part one' } }),
      JSON.stringify({ type: 'text', part: { text: 'part two' } }),
    ].join(NL);
    assert.equal(handleOpencodeOutput(stream).review, ['part one', 'part two'].join(NL));
  });

  test('gates the empty-review stub on extracted CONTENT, not output-file size', () => {
    // A JSON stream with no assistant text is many BYTES but zero review.
    const noText = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } });
    assert.ok(noText.length > 0, 'the raw stream is non-empty by byte count');
    assert.equal(handleOpencodeOutput(noText).review, '', 'yet the extracted review is empty');
  });

  test('empty-output stub is diagnosable: stop reason and output tokens', () => {
    const stream = JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { output: 0 } } });
    const out = handleOpencodeOutput(stream);
    assert.ok(out.diagnostic.includes('stop'), 'the stop reason must be surfaced');
    assert.ok(out.diagnostic.includes('0'), 'the output-token count must be surfaced');
  });

  test('does not regress the Codex reviewer (still captures stderr to .err)', () => {
    const codex = REVIEWER_LANES.find((l) => l.slug === 'codex');
    const r = resolveLanePlan({ lane: codex, configGet: () => undefined, runDir: '/run', repoRoot: '/repo' });
    assert.ok(r.plan.errPath.endsWith('.err'));
    assert.equal(r.plan.outputTarget.kind, 'file', 'codex still captures via --output-last-message (#1698)');
  });
});
