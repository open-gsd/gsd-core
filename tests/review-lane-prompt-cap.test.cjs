/**
 * #4559 — review lanes cap the prompt by default and refuse rather than trim.
 *
 * Design:      .gsd/phase/feat-4559-review-lane-default-cap/40-design.md
 * Test matrix: .gsd/phase/feat-4559-review-lane-default-cap/50-test-matrix.md
 *
 * Pure rows (1-17) drive `resolveLaneCap` / `checkPromptAgainstCap` / `refuseIfOverCap` /
 * `renderPromptRefusalStub` / `CONTEXT_WINDOW_HEADROOM` directly. CLI rows (21-25, 30) drive the
 * REAL `review-lane plan|invoke` against a temp project with a shim `claude` binary, so "the
 * binary was never spawned" is observed, not inferred.
 *
 * The behavior does not exist yet: every row here is expected to be RED until the design lands.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const {
  resolveLaneCap,
  checkPromptAgainstCap,
  refuseIfOverCap,
  renderPromptRefusalStub,
  CONTEXT_WINDOW_HEADROOM,
  LANE_UNAVAILABLE,
} = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

/** Deterministic property runs — pinned seed, bounded, replay printed on failure. */
const FC = { seed: 4559, numRuns: 200 };

const REFUSAL_REASON = 'prompt_exceeds_context';
const REFUSAL_MARKER = 'review did not run: prompt exceeds';

/** Declared windows (design: floor values) and the caps they derive at the 0.65 headroom. */
const DECLARED = [
  { slug: 'claude', window: 200000, cap: 130000 },
  { slug: 'codex', window: 272000, cap: 176800 },
  { slug: 'qwen', window: 131072, cap: 85196 },
  { slug: 'kimi-code', window: 262144, cap: 170393 },
];
const UNDECLARED = ['opencode', 'cursor', 'antigravity', 'coderabbit', 'ollama', 'lm_studio', 'llama_cpp'];

const laneOf = (slug) => {
  const lane = REVIEWER_LANES.find((l) => l.slug === slug);
  assert.ok(lane, `no declared lane '${slug}'`);
  return lane;
};

/** A config reader over a plain `{ dottedKey: value }` object. */
const cfg = (obj) => (key) => obj[key];

const windowKey = (slug) => `review.context_window_tokens.${slug}`;
const budgetKey = (slug) => `review.max_prompt_tokens_per_reviewer.${slug}`;

/** A lane object with the new fields overridden (REVIEWER_LANES entries are frozen). */
const overlay = (slug, patch) => ({ ...laneOf(slug), ...patch });

/** A third-party overlay lane that predates the new fields entirely. */
function legacyOverlay(slug) {
  const { contextWindowTokens, contextWindowConfigKey, ...rest } = laneOf(slug);
  void contextWindowTokens;
  void contextWindowConfigKey;
  return rest;
}

// ─── rows 1-3: the derived default ────────────────────────────────────────

describe('#4559 resolveLaneCap — derived default from the declared window', () => {
  test('CONTEXT_WINDOW_HEADROOM is 0.65', () => {
    assert.equal(CONTEXT_WINDOW_HEADROOM, 0.65);
  });

  test('resolveLaneCap derives floor(W*0.65) for each declared lane', () => {
    for (const { slug, window, cap } of DECLARED) {
      const r = resolveLaneCap(laneOf(slug), cfg({}));
      assert.equal(r.cap, cap, `${slug}: cap`);
      assert.equal(r.source, 'context-window', `${slug}: source`);
      assert.equal(r.contextWindowTokens, window, `${slug}: contextWindowTokens`);
      assert.equal(cap, Math.floor(window * 0.65), `${slug}: fixture agrees with the formula`);
    }
  });

  test('lanes without a declared window stay uncapped', () => {
    for (const slug of UNDECLARED) {
      const r = resolveLaneCap(laneOf(slug), cfg({}));
      assert.equal(r.cap, null, `${slug}: cap`);
      assert.equal(r.source, 'none', `${slug}: source`);
      assert.equal(r.contextWindowTokens, null, `${slug}: contextWindowTokens`);
    }
  });

  test('coderabbit (promptChannel none) never gets a cap, even when a window key is configured', () => {
    const lane = laneOf('coderabbit');
    assert.equal(lane.contextWindowTokens, null);
    assert.equal(lane.contextWindowConfigKey, null);
    const r = resolveLaneCap(lane, cfg({ [windowKey('coderabbit')]: 1000 }));
    assert.equal(r.cap, null);
    assert.equal(r.source, 'none');
  });
});

// ─── rows 4-7, 10: explicit caps beat the derived default ─────────────────

describe('#4559 resolveLaneCap — explicit configuration precedence', () => {
  test('explicit per-lane cap wins over derived', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [budgetKey('claude')]: 5000 }));
    assert.equal(r.cap, 5000);
    assert.equal(r.source, 'lane');
  });

  test('per-lane 0 disables the cap (source lane, never refuses)', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [budgetKey('claude')]: 0, 'review.max_prompt_tokens': 9000 }));
    assert.equal(r.cap, 0);
    assert.equal(r.source, 'lane');
    assert.deepEqual(checkPromptAgainstCap(10 ** 9, r, laneOf('claude')), { ok: true });
  });

  test('global beats derived when the per-lane value is the -1 sentinel', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [budgetKey('claude')]: -1, 'review.max_prompt_tokens': 9000 }));
    assert.equal(r.cap, 9000);
    assert.equal(r.source, 'global');
  });

  test('global beats derived when the per-lane value is unset', () => {
    const r = resolveLaneCap(laneOf('codex'), cfg({ 'review.max_prompt_tokens': 9000 }));
    assert.equal(r.cap, 9000);
    assert.equal(r.source, 'global');
  });

  test('global 0 disables the derived default too', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [budgetKey('claude')]: -1, 'review.max_prompt_tokens': 0 }));
    assert.equal(r.cap, 0);
    assert.equal(r.source, 'global');
    assert.deepEqual(checkPromptAgainstCap(10 ** 9, r, laneOf('claude')), { ok: true });
  });

  test('a non-number per-lane value is ignored and falls through to the global', () => {
    for (const bad of ['100', true, null, {}, [], NaN, Infinity]) {
      const r = resolveLaneCap(
        laneOf('claude'),
        cfg({ [budgetKey('claude')]: bad, 'review.max_prompt_tokens': 7000 }),
      );
      assert.equal(r.cap, 7000, `per-lane ${String(bad)}`);
      assert.equal(r.source, 'global', `per-lane ${String(bad)}`);
    }
  });

  test('a non-number global is ignored and the derived default applies', () => {
    for (const bad of ['9000', true, NaN, Infinity, null]) {
      const r = resolveLaneCap(laneOf('claude'), cfg({ 'review.max_prompt_tokens': bad }));
      assert.equal(r.cap, 130000, `global ${String(bad)}`);
      assert.equal(r.source, 'context-window', `global ${String(bad)}`);
    }
  });
});

// ─── rows 8-9: the window override key ────────────────────────────────────

describe('#4559 resolveLaneCap — review.context_window_tokens.<slug> override', () => {
  test('override window beats the declared window', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [windowKey('claude')]: 100000 }));
    assert.equal(r.cap, 65000);
    assert.equal(r.source, 'context-window');
  });

  test('override window can raise the cap above the declared floor', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [windowKey('claude')]: 1000000 }));
    assert.equal(r.cap, 650000);
    assert.equal(r.source, 'context-window');
  });

  test('override window gives an undeclared lane a derived cap', () => {
    const r = resolveLaneCap(laneOf('opencode'), cfg({ [windowKey('opencode')]: 100000 }));
    assert.equal(r.cap, 65000);
    assert.equal(r.source, 'context-window');
  });

  test('override window 0 disables the derived cap', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [windowKey('claude')]: 0 }));
    assert.equal(r.cap, null);
    assert.equal(r.source, 'none');
  });

  test('an invalid override falls back to the declared window', () => {
    for (const bad of [-1, '100000', NaN, -5, Infinity, -Infinity, true, null, undefined, {}, []]) {
      const r = resolveLaneCap(laneOf('claude'), cfg({ [windowKey('claude')]: bad }));
      assert.equal(r.cap, 130000, `override ${String(bad)}`);
      assert.equal(r.source, 'context-window', `override ${String(bad)}`);
    }
  });

  test('an explicit per-lane cap still beats an override window', () => {
    const r = resolveLaneCap(laneOf('claude'), cfg({ [budgetKey('claude')]: 5000, [windowKey('claude')]: 1000000 }));
    assert.equal(r.cap, 5000);
    assert.equal(r.source, 'lane');
  });
});

// ─── rows 12-15: overlay / hostile lane objects ───────────────────────────

describe('#4559 resolveLaneCap — third-party overlay lanes (trust boundary)', () => {
  test('derived cap is independent of promptBudgetKey (explicit keys are skipped, derived still applies)', () => {
    const lane = overlay('claude', { promptBudgetKey: null });
    const r = resolveLaneCap(lane, cfg({ [budgetKey('claude')]: 5000, 'review.max_prompt_tokens': 9000 }));
    assert.equal(r.cap, 130000);
    assert.equal(r.source, 'context-window');
  });

  test('a lane with neither promptBudgetKey nor a window is uncapped', () => {
    const lane = overlay('opencode', { promptBudgetKey: null });
    const r = resolveLaneCap(lane, cfg({ 'review.max_prompt_tokens': 9000 }));
    assert.equal(r.cap, null);
    assert.equal(r.source, 'none');
  });

  test('a lane missing the new fields behaves as before: no derived cap', () => {
    const r = resolveLaneCap(legacyOverlay('claude'), cfg({}));
    assert.equal(r.cap, null);
    assert.equal(r.source, 'none');
    assert.equal(r.contextWindowTokens, null);
  });

  test('a lane missing the new fields still honors explicit caps', () => {
    const r = resolveLaneCap(legacyOverlay('claude'), cfg({ [budgetKey('claude')]: 5000 }));
    assert.equal(r.cap, 5000);
    assert.equal(r.source, 'lane');
  });

  test('resolveLaneCap narrows a hostile overlay window to null', () => {
    for (const bad of ['big', '200000', 0, -1, NaN, Infinity, -Infinity, true, {}, []]) {
      const r = resolveLaneCap(overlay('claude', { contextWindowTokens: bad }), cfg({}));
      assert.equal(r.cap, null, `window ${String(bad)}`);
      assert.equal(r.source, 'none', `window ${String(bad)}`);
      assert.equal(r.contextWindowTokens, null, `window ${String(bad)}`);
    }
  });

  test('a hostile overlay window does not block an explicit cap', () => {
    const r = resolveLaneCap(overlay('claude', { contextWindowTokens: 'big' }), cfg({ [budgetKey('claude')]: 5000 }));
    assert.equal(r.cap, 5000);
    assert.equal(r.source, 'lane');
  });

  test('a hostile contextWindowConfigKey is never read as a config path', () => {
    const seen = [];
    const get = (k) => { seen.push(k); return undefined; };
    for (const bad of [42, {}, [], true]) {
      seen.length = 0;
      const r = resolveLaneCap(overlay('claude', { contextWindowConfigKey: bad }), get);
      assert.equal(r.cap, 130000, `key ${JSON.stringify(bad)}`);
      assert.ok(seen.every((k) => typeof k === 'string'), `key ${JSON.stringify(bad)}: configGet saw ${JSON.stringify(seen)}`);
    }
  });
});

// ─── rows 13-15: the refusal check ────────────────────────────────────────

describe('#4559 checkPromptAgainstCap', () => {
  const info = (cap, source = 'context-window') => ({ cap, source, contextWindowTokens: 200000 });

  test('boundary: estimate = cap-1 and = cap run, = cap+1 is refused', () => {
    const cap = 130000;
    assert.deepEqual(checkPromptAgainstCap(cap - 1, info(cap), laneOf('claude')), { ok: true });
    assert.deepEqual(checkPromptAgainstCap(cap, info(cap), laneOf('claude')), { ok: true });
    const over = checkPromptAgainstCap(cap + 1, info(cap), laneOf('claude'));
    assert.equal(over.ok, false);
    assert.equal(over.reason, REFUSAL_REASON);
    assert.equal(typeof over.detail, 'string');
    assert.ok(over.detail.length > 0);
  });

  test('no cap never refuses: cap null and cap 0 with a huge estimate', () => {
    for (const cap of [null, 0]) {
      assert.deepEqual(checkPromptAgainstCap(10 ** 12, info(cap, cap === null ? 'none' : 'lane'), laneOf('claude')), { ok: true });
    }
  });

  test('a lane that ran and returned empty is not a refusal: an empty prompt never trips a cap', () => {
    assert.deepEqual(checkPromptAgainstCap(0, info(1), laneOf('claude')), { ok: true });
  });

  test('refusal detail names the estimate, the cap and the remedy key', () => {
    const over = checkPromptAgainstCap(130001, info(130000), laneOf('claude'));
    assert.equal(over.ok, false);
    assert.ok(over.detail.includes('130001'), `detail must name the estimate: ${over.detail}`);
    assert.ok(over.detail.includes('130000'), `detail must name the cap: ${over.detail}`);
    assert.ok(over.detail.includes(windowKey('claude')), `detail must name the override key: ${over.detail}`);
  });

  test('the refusal reason is the shared LANE_UNAVAILABLE member', () => {
    assert.equal(LANE_UNAVAILABLE.PROMPT_EXCEEDS_CONTEXT, REFUSAL_REASON);
    assert.equal(checkPromptAgainstCap(2, info(1), laneOf('claude')).reason, LANE_UNAVAILABLE.PROMPT_EXCEEDS_CONTEXT);
  });

  test('renderPromptRefusalStub carries the stable marker, the slug and the detail', () => {
    const detail = 'estimated 130001 tokens > cap 130000';
    const stub = renderPromptRefusalStub('claude', detail);
    assert.equal(typeof stub, 'string');
    assert.ok(stub.startsWith(`claude ${REFUSAL_MARKER}`), `stub must start with the slug and marker: ${stub}`);
    assert.ok(stub.includes(detail), `stub must carry the detail: ${stub}`);
    assert.ok(renderPromptRefusalStub('qwen', detail).startsWith(`qwen ${REFUSAL_MARKER}`));
  });
});

// ─── rows 16-17: properties ───────────────────────────────────────────────

describe('#4559 properties', () => {
  test('property: refusal iff the estimate is strictly over a positive cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), (cap, est) => {
        const r = checkPromptAgainstCap(est, { cap, source: 'lane', contextWindowTokens: null }, laneOf('claude'));
        return r.ok === (est <= cap);
      }),
      FC,
    );
  });

  test('property: a derived cap is floor(window*0.65), never above the window, and monotone in the window', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 5_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), (w, extra) => {
        const lane = overlay('claude', { contextWindowTokens: w });
        const lane2 = overlay('claude', { contextWindowTokens: w + extra });
        const a = resolveLaneCap(lane, cfg({}));
        const b = resolveLaneCap(lane2, cfg({}));
        return a.cap === Math.floor(w * CONTEXT_WINDOW_HEADROOM) && a.cap <= w && a.cap > 0 && b.cap >= a.cap;
      }),
      FC,
    );
  });
});

// ─── rows 21-25, 30: the real CLI ─────────────────────────────────────────

const POSIX_ONLY = process.platform === 'win32' ? 'POSIX shim' : false;

/** estimateTokens is chars/4 rounded up; these sizes pin the cap-1 / cap / cap+1 prompts for claude (130000). */
const CHARS_UNDER = 519996; // 129999 tokens
const CHARS_AT = 520000; // 130000 tokens
const CHARS_OVER = 520001; // 130001 tokens

/** `n` characters of LF text. */
const lfText = (n) => 'x'.repeat(n);

/** Exactly `n` characters made of CRLF-terminated lines (the \r counts toward the estimate). */
function crlfText(n) {
  const unit = 'abcd\r\n';
  const whole = Math.floor(n / unit.length);
  return unit.repeat(whole) + 'abcdefghij'.slice(0, n - whole * unit.length);
}

/**
 * A temp project with a run dir, a shim `claude` that records its invocation, and a config.
 * The shim answers capability probes and drains stdin so a real spawn succeeds.
 */
function makeProject(t, config = {}) {
  const dir = createTempProject();
  t.after(() => cleanup(dir));
  const binDir = path.join(dir, 'bin');
  const runDir = path.join(dir, 'run');
  const seen = path.join(dir, 'seen.txt');
  fs.mkdirSync(binDir);
  fs.mkdirSync(runDir);
  fs.writeFileSync(
    path.join(binDir, 'claude'),
    '#!/usr/bin/env bash\n' +
      'if [ "$1" = "--help" ] || [ "$1" = "--version" ]; then echo "claude 0.0.0 --model --effort"; exit 0; fi\n' +
      `printf '%s\\n' "$@" >> "${seen}"\n` +
      'cat > /dev/null\n' +
      'echo "a review body long enough to clear the empty-output guard."\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  return { dir, binDir, runDir, seen, promptPath: path.join(runDir, 'gsd-review-prompt.md') };
}

function invoke(p, extraArgs = [], slug = 'claude') {
  const r = runGsdTools(
    ['review-lane', 'invoke', '--slug', slug, '--run-dir', p.runDir, '--repo-root', p.dir, ...extraArgs],
    p.dir,
    { PATH: `${p.binDir}${path.delimiter}${process.env.PATH}`, HOME: p.dir, USERPROFILE: p.dir },
  );
  assert.ok(r.output, `review-lane invoke printed nothing: ${r.error}`);
  return JSON.parse(r.output);
}

function plan(p, slugs) {
  const r = runGsdTools(
    ['review-lane', 'plan', '--selected', slugs.join(','), '--run-dir', p.runDir, '--repo-root', p.dir],
    p.dir,
  );
  assert.equal(r.success, true, `review-lane plan failed: ${r.error || r.output}`);
  return JSON.parse(r.output);
}

describe('#4559 review-lane plan reports the derived cap', () => {
  test('plan reports derived cap, its source and the window', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    const rows = plan(p, ['claude', 'codex', 'opencode', 'coderabbit']);
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
    assert.equal(by.claude.promptBudget, 130000);
    assert.equal(by.claude.promptCapSource, 'context-window');
    assert.equal(by.claude.contextWindowTokens, 200000);
    assert.equal(by.codex.promptBudget, 176800);
    assert.equal(by.codex.contextWindowTokens, 272000);
    assert.equal(by.opencode.promptBudget, null);
    assert.equal(by.opencode.promptCapSource, 'none');
    assert.equal(by.opencode.contextWindowTokens, null);
    assert.equal(by.coderabbit.promptBudget, null);
    assert.equal(by.coderabbit.promptCapSource, 'none');
  });

  test('plan reports the source of an explicit cap', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t, {
      review: { max_prompt_tokens: 9000, max_prompt_tokens_per_reviewer: { codex: 5000 } },
    });
    const by = Object.fromEntries(plan(p, ['claude', 'codex']).map((r) => [r.slug, r]));
    assert.equal(by.codex.promptBudget, 5000);
    assert.equal(by.codex.promptCapSource, 'lane');
    assert.equal(by.claude.promptBudget, 9000);
    assert.equal(by.claude.promptCapSource, 'global');
  });
});

describe('#4559 review-lane invoke refuses a prompt over the cap', () => {
  test('invoke refuses over-cap prompt: ok:false, stub at reviewPath, binary never spawned', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER));
    const res = invoke(p);

    assert.equal(res.ok, false);
    assert.equal(res.slug, 'claude');
    assert.equal(res.reason, REFUSAL_REASON);
    assert.equal(typeof res.detail, 'string');
    assert.equal(res.reviewPath, `${p.runDir}/gsd-review-claude.md`);
    assert.deepEqual(res.refusal, {
      estimatedTokens: 130001,
      cap: 130000,
      capSource: 'context-window',
      contextWindowTokens: 200000,
    });

    const stub = fs.readFileSync(path.join(p.runDir, 'gsd-review-claude.md'), 'utf8');
    assert.ok(stub.includes(REFUSAL_MARKER), `stub must carry the marker: ${stub}`);
    assert.equal(fs.existsSync(p.seen), false, 'the claude binary must never be spawned for a refused lane');
  });

  test('boundary: cap-1 and cap run, cap+1 is refused', { skip: POSIX_ONLY }, (t) => {
    for (const [chars, refused] of [[CHARS_UNDER, false], [CHARS_AT, false], [CHARS_OVER, true]]) {
      const p = makeProject(t);
      fs.writeFileSync(p.promptPath, lfText(chars));
      const res = invoke(p);
      assert.equal(res.reason === REFUSAL_REASON, refused, `${chars} chars: refused=${refused}`);
      assert.equal('refusal' in res, refused, `${chars} chars: refusal field presence`);
      assert.equal(fs.existsSync(p.seen), !refused, `${chars} chars: binary spawned=${!refused}`);
    }
  });

  test('CRLF prompt: the carriage returns count toward the estimate (cap-1, cap, cap+1)', { skip: POSIX_ONLY }, (t) => {
    for (const [chars, refused] of [[CHARS_UNDER, false], [CHARS_AT, false], [CHARS_OVER, true]]) {
      const p = makeProject(t);
      const body = crlfText(chars);
      assert.equal(body.length, chars, 'fixture sanity');
      fs.writeFileSync(p.promptPath, body);
      const res = invoke(p);
      assert.equal(res.reason === REFUSAL_REASON, refused, `${chars} CRLF chars: refused=${refused}`);
      if (refused) assert.equal(res.refusal.estimatedTokens, 130001);
    }
  });

  test('a prompt over a lowered window override is refused with the override as the cap', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t, { review: { context_window_tokens: { claude: 1000 } } });
    fs.writeFileSync(p.promptPath, lfText(2601));
    const res = invoke(p);
    assert.equal(res.reason, REFUSAL_REASON);
    assert.equal(res.refusal.cap, 650);
    assert.equal(res.refusal.capSource, 'context-window');
    assert.equal(res.refusal.estimatedTokens, 651);
  });

  test('a per-lane cap of 0 lets an over-window prompt run', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t, { review: { max_prompt_tokens_per_reviewer: { claude: 0 } } });
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER + 4000));
    const res = invoke(p);
    assert.notEqual(res.reason, REFUSAL_REASON);
    assert.equal(fs.existsSync(p.seen), true, 'cap 0 means no cap: the binary runs');
  });

  test('an uncapped lane is never refused, however large the prompt', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER + 4000));
    const res = invoke(p, [], 'coderabbit');
    assert.notEqual(res.reason, REFUSAL_REASON);
    assert.equal('refusal' in res, false);
  });

  test('a missing prompt file is not a refusal: the run proceeds and the runner reports its own error', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    assert.equal(fs.existsSync(p.promptPath), false, 'fixture sanity: no prompt file');
    const res = invoke(p);
    assert.notEqual(res.reason, REFUSAL_REASON);
    assert.equal('refusal' in res, false);
    assert.equal(
      fs.existsSync(path.join(p.runDir, 'gsd-review-claude.md')) &&
        fs.readFileSync(path.join(p.runDir, 'gsd-review-claude.md'), 'utf8').includes(REFUSAL_MARKER),
      false,
      'no refusal stub may be written for an unreadable prompt',
    );
  });

  test('--prompt-file: the size is measured on the file actually sent (small override passes)', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER + 4000));
    const small = path.join(p.runDir, 'gsd-review-prompt-small.md');
    fs.writeFileSync(small, 'a small prompt');
    const res = invoke(p, ['--prompt-file', small]);
    assert.notEqual(res.reason, REFUSAL_REASON, 'the combined prompt is huge but the override sent is not');
    assert.equal(fs.existsSync(p.seen), true, 'the binary runs on the small override');
  });

  test('--prompt-file: a large override is refused even when the combined prompt is small', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    fs.writeFileSync(p.promptPath, 'a small combined prompt');
    const big = path.join(p.runDir, 'gsd-review-prompt-big.md');
    fs.writeFileSync(big, lfText(CHARS_OVER));
    const res = invoke(p, ['--prompt-file', big]);
    assert.equal(res.reason, REFUSAL_REASON);
    assert.equal(res.refusal.estimatedTokens, 130001);
    assert.equal(fs.existsSync(p.seen), false);
  });

  test('--as: the refusal stub is written to the reviewer instance path, not the lane path', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t);
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER));
    const res = invoke(p, ['--as', 'my-instance']);
    assert.equal(res.reason, REFUSAL_REASON);
    assert.equal(res.reviewPath, `${p.runDir}/gsd-review-my-instance.md`);
    const stub = fs.readFileSync(path.join(p.runDir, 'gsd-review-my-instance.md'), 'utf8');
    assert.ok(stub.includes(REFUSAL_MARKER), `instance stub must carry the marker: ${stub}`);
    assert.equal(
      fs.existsSync(path.join(p.runDir, 'gsd-review-claude.md')),
      false,
      'the lane-named review path must not be written for an instance run',
    );
  });
});

// ─── review findings (F1, F3, F4, F6, F7, F10) ────────────────────────────

describe('#4559 a promptChannel none lane receives no prompt, so no cap ever applies (coderabbit)', () => {
  const NO_CAP = { cap: null, source: 'none', contextWindowTokens: null };

  test('a global cap resolves to no cap', () => {
    assert.deepEqual(resolveLaneCap(laneOf('coderabbit'), cfg({ 'review.max_prompt_tokens': 1000 })), NO_CAP);
  });

  test('a per-lane cap resolves to no cap', () => {
    const get = cfg({ [budgetKey('coderabbit')]: 1000, 'review.max_prompt_tokens': 1000 });
    assert.deepEqual(resolveLaneCap(laneOf('coderabbit'), get), NO_CAP);
    assert.equal(refuseIfOverCap({ lane: laneOf('coderabbit'), estimatedTokens: 10 ** 9, configGet: get }), null);
  });

  test('property: whatever the keys hold, a promptChannel none lane resolves to no cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 5_000_000 }), fc.integer({ min: -5, max: 5_000_000 }), (a, b) => {
        const get = cfg({ [budgetKey('coderabbit')]: a, 'review.max_prompt_tokens': b, [windowKey('coderabbit')]: a });
        const r = resolveLaneCap(laneOf('coderabbit'), get);
        return r.cap === null && r.source === 'none' && r.contextWindowTokens === null;
      }),
      FC,
    );
  });

  test('plan reports no cap for coderabbit under a global cap', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t, { review: { max_prompt_tokens: 1000 } });
    const by = Object.fromEntries(plan(p, ['claude', 'coderabbit']).map((r) => [r.slug, r]));
    assert.equal(by.claude.promptBudget, 1000);
    assert.equal(by.claude.promptCapSource, 'global');
    assert.equal(by.coderabbit.promptBudget, null);
    assert.equal(by.coderabbit.promptCapSource, 'none');
  });

  test('invoke does not refuse coderabbit for a huge prompt under a global cap', { skip: POSIX_ONLY }, (t) => {
    const p = makeProject(t, { review: { max_prompt_tokens: 1000 } });
    fs.writeFileSync(p.promptPath, lfText(CHARS_OVER));
    const res = invoke(p, [], 'coderabbit');
    assert.notEqual(res.reason, REFUSAL_REASON);
    assert.equal('refusal' in res, false);
  });
});

describe('#4559 refuseIfOverCap — the one shared refusal decision', () => {
  test('returns null at cap-1 and cap, a structured refusal at cap+1', () => {
    const get = cfg({ [budgetKey('claude')]: 500 });
    assert.equal(refuseIfOverCap({ lane: laneOf('claude'), estimatedTokens: 499, configGet: get }), null);
    assert.equal(refuseIfOverCap({ lane: laneOf('claude'), estimatedTokens: 500, configGet: get }), null);
    const over = refuseIfOverCap({ lane: laneOf('claude'), estimatedTokens: 501, configGet: get });
    assert.equal(over.ok, false);
    assert.equal(over.reason, REFUSAL_REASON);
    assert.equal(typeof over.detail, 'string');
    assert.deepEqual(over.refusal, { estimatedTokens: 501, cap: 500, capSource: 'lane', contextWindowTokens: null });
  });

  test('property: refuses exactly when the estimate is strictly over a positive cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), (cap, est) => {
        const r = refuseIfOverCap({ lane: laneOf('claude'), estimatedTokens: est, configGet: cfg({ [budgetKey('claude')]: cap }) });
        return est > cap ? r !== null && r.ok === false && r.refusal.cap === cap : r === null;
      }),
      FC,
    );
  });
});

describe('#4559 the refusal remedy names the lane\'s declared keys, not keys built from the slug', () => {
  const custom = () =>
    overlay('claude', {
      slug: 'zeta',
      promptBudgetKey: 'custom.zeta.budget',
      contextWindowConfigKey: 'custom.zeta.window',
    });

  test('source lane: names the declared per-lane key', () => {
    const r = refuseIfOverCap({ lane: custom(), estimatedTokens: 10, configGet: cfg({ 'custom.zeta.budget': 5 }) });
    assert.ok(r.detail.includes('custom.zeta.budget'), r.detail);
    assert.equal(r.detail.includes('max_prompt_tokens_per_reviewer.zeta'), false, r.detail);
    assert.equal(r.detail.includes('max_prompt_tokens_per_reviewer.claude'), false, r.detail);
  });

  test('source global: names the global key and the declared per-lane key', () => {
    const r = refuseIfOverCap({ lane: custom(), estimatedTokens: 10, configGet: cfg({ 'review.max_prompt_tokens': 5 }) });
    assert.ok(r.detail.includes('review.max_prompt_tokens'), r.detail);
    assert.ok(r.detail.includes('custom.zeta.budget'), r.detail);
    assert.equal(r.detail.includes('max_prompt_tokens_per_reviewer.zeta'), false, r.detail);
  });

  test('source context-window: names the declared window key', () => {
    const r = refuseIfOverCap({ lane: custom(), estimatedTokens: 10 ** 9, configGet: cfg({}) });
    assert.equal(r.refusal.capSource, 'context-window');
    assert.ok(r.detail.includes('custom.zeta.window'), r.detail);
    assert.equal(r.detail.includes('context_window_tokens.zeta'), false, r.detail);
  });
});

describe('#4559 a refusal stub that cannot be written is reported, not swallowed', () => {
  test('stubWritten is true on success and false when the review path is unwritable', { skip: POSIX_ONLY }, (t) => {
    const ok = makeProject(t);
    fs.writeFileSync(ok.promptPath, lfText(CHARS_OVER));
    const okRes = invoke(ok);
    assert.equal(okRes.reason, REFUSAL_REASON);
    assert.equal(okRes.stubWritten, true);

    const bad = makeProject(t);
    fs.writeFileSync(bad.promptPath, lfText(CHARS_OVER));
    // A directory sitting where the stub must go makes the write fail.
    fs.mkdirSync(path.join(bad.runDir, 'gsd-review-claude.md'));
    const badRes = invoke(bad);
    assert.equal(badRes.reason, REFUSAL_REASON, 'the refusal itself must still be reported');
    assert.equal(badRes.ok, false);
    assert.equal(badRes.stubWritten, false);
  });
});

describe('#4559 every lane\'s context-window config description states its declared window', () => {
  const capsDir = path.join(__dirname, '..', 'capabilities');
  const findKey = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const v of Object.values(obj)) {
      const hit = findKey(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const manifests = fs
    .readdirSync(capsDir)
    .map((d) => path.join(capsDir, d, 'capability.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

  test('the description matches the descriptor for every lane with a window key', () => {
    let checked = 0;
    for (const lane of REVIEWER_LANES) {
      if (!lane.contextWindowConfigKey) continue;
      const entries = manifests.map((m) => findKey(m, lane.contextWindowConfigKey)).filter((e) => e !== undefined);
      assert.equal(entries.length, 1, `${lane.slug}: exactly one manifest declares ${lane.contextWindowConfigKey}`);
      const expected =
        lane.contextWindowTokens === null
          ? 'use none (no declared window'
          : `declared window of ${lane.contextWindowTokens} tokens`;
      assert.ok(
        String(entries[0].description).includes(expected),
        `${lane.slug}: description must contain "${expected}": ${entries[0].description}`,
      );
      checked++;
    }
    assert.ok(checked >= DECLARED.length, 'at least every declared lane was checked');
  });
});

describe('#4559 review.md aggregation drops a lane only when its parsed reason is the refusal', () => {
  const REVIEW_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md');

  function aggregationLoop() {
    const text = fs.readFileSync(REVIEW_MD, 'utf8');
    const start = text.indexOf('for SLUG in $(printf \'%s\' "$DISPATCH_SLUGS"); do\n  LANE_RESULT=');
    assert.notEqual(start, -1, 'aggregation loop not found in review.md');
    const end = text.indexOf('\ndone\n', start);
    assert.notEqual(end, -1, 'aggregation loop terminator not found');
    return text.slice(start, end + '\ndone\n'.length);
  }

  test('a failed lane whose detail merely mentions the refusal string is still aggregated', { skip: POSIX_ONLY }, (t) => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-4559-agg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (slug, obj) =>
      fs.writeFileSync(path.join(dir, `gsd-review-lane-result-${slug}.json`), JSON.stringify(obj, null, 2) + '\n');
    write('refused', { slug: 'refused', ok: false, reason: REFUSAL_REASON, detail: 'too big' });
    write('ran', { slug: 'ran', ok: true });
    write('mentions', { slug: 'mentions', ok: false, reason: 'probe_failed', detail: `earlier ${REFUSAL_REASON} noted` });

    const r = spawnSync('bash', ['-c', aggregationLoop()], {
      env: { ...process.env, RUN_DIR: dir, DISPATCH_SLUGS: 'refused ran mentions' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = fs
      .readFileSync(path.join(dir, 'gsd-review-lane-results.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const joined = lines.join('\n');
    assert.equal(joined.includes('"slug": "refused"'), false, 'the refused lane must be left out');
    assert.equal(joined.includes('"slug": "ran"'), true);
    assert.equal(joined.includes('"slug": "mentions"'), true, 'a failure that only mentions the string must be kept');
  });
});
