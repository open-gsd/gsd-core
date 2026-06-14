/**
 * Tests for gsd-statusline.js GSD state display helpers.
 *
 * Covers:
 * - parseStateMd across YAML-frontmatter, body-fallback, and partial formats
 * - formatGsdState graceful degradation when fields are missing
 * - readGsdState walk-up search with proper bounds
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseStateMd,
  formatGsdState,
  readGsdState,
  isInstalledAheadOfLatest,
} = require('../hooks/gsd-statusline.js');
const { cleanup } = require('./helpers.cjs');

// ─── parseStateMd ───────────────────────────────────────────────────────────

describe('parseStateMd', () => {
  test('parses full YAML frontmatter', () => {
    const content = [
      '---',
      'status: executing',
      'milestone: v1.9',
      'milestone_name: Code Quality',
      '---',
      '',
      '# State',
      'Phase: 1 of 5 (fix-graphiti-deployment)',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, 'executing');
    assert.equal(s.milestone, 'v1.9');
    assert.equal(s.milestoneName, 'Code Quality');
    assert.equal(s.phaseNum, '1');
    assert.equal(s.phaseTotal, '5');
    assert.equal(s.phaseName, 'fix-graphiti-deployment');
  });

  test('treats literal "null" values as null', () => {
    const content = [
      '---',
      'status: null',
      'milestone: null',
      'milestone_name: null',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, null);
    assert.equal(s.milestone, null);
    assert.equal(s.milestoneName, null);
  });

  test('strips surrounding quotes from frontmatter values', () => {
    const content = [
      '---',
      'milestone_name: "Code Quality"',
      "milestone: 'v1.9'",
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.milestone, 'v1.9');
    assert.equal(s.milestoneName, 'Code Quality');
  });

  test('parses phase without name', () => {
    const content = [
      '---',
      'status: planning',
      '---',
      'Phase: 3 of 10',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.phaseNum, '3');
    assert.equal(s.phaseTotal, '10');
    assert.equal(s.phaseName, null);
  });

  test('falls back to body Status when frontmatter is missing', () => {
    const content = [
      '# State',
      'Status: Ready to plan',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, 'planning');
  });

  test('body fallback recognizes executing state', () => {
    const content = 'Status: Executing phase 2';
    assert.equal(parseStateMd(content).status, 'executing');
  });

  test('body fallback recognizes complete state', () => {
    const content = 'Status: Complete';
    assert.equal(parseStateMd(content).status, 'complete');
  });

  test('body fallback recognizes archived as complete', () => {
    const content = 'Status: Archived';
    assert.equal(parseStateMd(content).status, 'complete');
  });

  test('returns empty object for empty content', () => {
    const s = parseStateMd('');
    assert.deepEqual(s, {});
  });

  test('returns partial state when only some fields present', () => {
    const content = [
      '---',
      'milestone: v2.0',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.milestone, 'v2.0');
    assert.equal(s.status, undefined);
    assert.equal(s.phaseNum, undefined);
  });

  test('parses next_phases from YAML block-list form (#3153)', () => {
    const content = [
      '---',
      'next_action: execute',
      'next_phases:',
      '  - 4.5',
      '  - 4.6',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.nextAction, 'execute');
    assert.deepEqual(s.nextPhases, ['4.5', '4.6']);
  });
});

// ─── formatGsdState ─────────────────────────────────────────────────────────

describe('formatGsdState', () => {
  test('formats full state with milestone name, status, and phase name', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      milestoneName: 'Code Quality',
      status: 'executing',
      phaseNum: '1',
      phaseTotal: '5',
      phaseName: 'fix-graphiti-deployment',
    });
    assert.equal(out, 'v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)');
  });

  test('skips placeholder "milestone" value in milestoneName', () => {
    const out = formatGsdState({
      milestone: 'v1.0',
      milestoneName: 'milestone',
      status: 'planning',
    });
    assert.equal(out, 'v1.0 · planning');
  });

  test('uses short phase form when phase name is missing', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      status: 'executing',
      phaseNum: '3',
      phaseTotal: '7',
    });
    assert.equal(out, 'v2.0 · executing · ph 3/7');
  });

  test('omits phase entirely when phaseNum/phaseTotal missing', () => {
    const out = formatGsdState({
      milestone: 'v1.0',
      status: 'planning',
    });
    assert.equal(out, 'v1.0 · planning');
  });

  test('handles milestone version only (no name)', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      status: 'executing',
    });
    assert.equal(out, 'v1.9 · executing');
  });

  test('handles milestone name only (no version)', () => {
    const out = formatGsdState({
      milestoneName: 'Foundations',
      status: 'planning',
    });
    assert.equal(out, 'Foundations · planning');
  });

  test('treats numeric 100 percent as milestone complete (#3153)', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      percent: 100,
    });
    assert.equal(out, 'v2.0 [██████████] 100% · milestone complete');
  });

  test('returns empty string for empty state', () => {
    assert.equal(formatGsdState({}), '');
  });

  test('returns only available parts when everything else is missing', () => {
    assert.equal(formatGsdState({ status: 'planning' }), 'planning');
  });
});

describe('isInstalledAheadOfLatest', () => {
  test('treats prerelease patch increment as ahead of prior stable', () => {
    assert.equal(isInstalledAheadOfLatest('1.2.1-beta.1', '1.2.0'), true);
  });

  test('treats equal base version prerelease as not ahead', () => {
    assert.equal(isInstalledAheadOfLatest('1.2.0-rc.1', '1.2.0'), false);
  });
});

// ─── readGsdState ───────────────────────────────────────────────────────────

describe('readGsdState', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-statusline-test-'));

  test('finds STATE.md in the starting directory', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'STATE.md'),
      '---\nstatus: executing\nmilestone: v1.0\n---\n'
    );

    const s = readGsdState(proj);
    assert.equal(s.status, 'executing');
    assert.equal(s.milestone, 'v1.0');
  });

  test('walks up to find STATE.md in a parent directory', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'STATE.md'),
      '---\nstatus: planning\n---\n'
    );

    const nested = path.join(proj, 'src', 'components', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    const s = readGsdState(nested);
    assert.equal(s.status, 'planning');
  });

  test('returns null when no STATE.md exists in the walk-up chain', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    const nested = path.join(proj, 'src');
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(readGsdState(nested), null);
  });

  test('returns null on malformed STATE.md without crashing', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    // Valid file (no content to crash on) — parseStateMd returns {}
    fs.writeFileSync(path.join(proj, '.planning', 'STATE.md'), '');

    const s = readGsdState(proj);
    // Empty file yields an empty state object, not null — the function
    // only returns null when no file is found.
    assert.deepEqual(s, {});
  });
});

// ─── CLAUDE_CODE_AUTO_COMPACT_WINDOW context meter (#2219) ──────────────────

describe('context meter respects CLAUDE_CODE_AUTO_COMPACT_WINDOW (#2219)', () => {
  const { execFileSync } = require('node:child_process');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  /**
   * Run the statusline hook with a synthetic context_window payload.
   * Returns { normalizedUsed, rawUsedPct } where:
   *   - normalizedUsed: the buffer-adjusted % shown in the statusline bar
   *     (parsed from the hook's stdout ANSI output, e.g. "60%")
   *   - rawUsedPct: the raw value written to the bridge file (100 - remaining,
   *     CC-consistent per #2451 fix)
   */
  function runHook(remainingPct, totalTokens, acwEnv) {
    const sessionId = `test-2219-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: sessionId,
      context_window: {
        remaining_percentage: remainingPct,
        total_tokens: totalTokens,
      },
    });

    const env = { ...process.env };
    if (acwEnv != null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(acwEnv);
    } else {
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookPath], {
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });
    } catch (e) {
      stdout = e.stdout || '';
    }

    // Parse normalized used% from the statusline bar output (e.g. "60%")
    // Strip ANSI escape codes then extract the percentage digit(s) before "%"
    // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const match = clean.match(/(\d+)%/);
    const normalizedUsed = match ? parseInt(match[1], 10) : null;

    // Read raw used_pct from the bridge file (#2451: bridge stores raw CC value)
    const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
    let rawUsedPct = null;
    try {
      const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
      rawUsedPct = bridge.used_pct;
      fs.unlinkSync(bridgePath);
    } catch { /* bridge may not exist if hook exited early */ }

    return { normalizedUsed, rawUsedPct };
  }

  test('default buffer (no env var): 50% remaining → ~60% normalized bar display', () => {
    // Default 16.5% buffer: usableRemaining = (50 - 16.5) / (100 - 16.5) * 100 ≈ 40.12%
    // normalized used ≈ 100 - 40.12 = 59.88 → rounded 60 (shown in statusline bar)
    const { normalizedUsed } = runHook(50, 1_000_000, null);
    assert.strictEqual(normalizedUsed, 60);
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000: 50% remaining → 100% normalized bar display', () => {
    // ACW = 400k usable tokens out of 1M total → usable fraction = 40%, buffer = 60%.
    // (1 - 400000/1000000) * 100 = 60% buffer. With 50% remaining already below the
    // 60% buffer threshold, usableRemaining = max(0, (50-60)/(100-60)*100) = 0%,
    // normalized used = 100 (bar shows full — context is within the compact-trigger buffer).
    const { normalizedUsed } = runHook(50, 1_000_000, 400_000);
    assert.strictEqual(normalizedUsed, 100);
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW=0 falls back to default buffer', () => {
    // Explicit "0" means unset — should behave like no env var (16.5% buffer)
    const { normalizedUsed } = runHook(50, 1_000_000, 0);
    assert.strictEqual(normalizedUsed, 60);
  });

  test('ACW exceeds total context: buffer clamped to 0% — used reflects real remaining', () => {
    // Pathological: ACW > totalCtx → (1 - 2M/1M) * 100 = -100% → clamped to 0%.
    // With 0% buffer, usableRemaining = 50%, normalized used = 50.
    // The Math.max(0, ...) clamp prevents negative buffer from inverting the display.
    const { normalizedUsed } = runHook(50, 1_000_000, 2_000_000);
    assert.strictEqual(normalizedUsed, 50);
  });

  test('bridge used_pct is raw (CC-consistent) regardless of ACW setting (#2451)', () => {
    // Fix for #2451: bridge used_pct must be raw (100 - remaining), not normalized.
    // This ensures gsd-context-monitor warning messages match CC native /context.
    // The ACW normalization only affects the statusline bar display, not the bridge.
    const { rawUsedPct } = runHook(50, 1_000_000, 400_000);
    assert.strictEqual(rawUsedPct, 50,
      'bridge used_pct must be raw (100-50=50) regardless of CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
});

// ─── auto-compact buffer boundary tests (#1194) ─────────────────────────────

describe('context meter boundary: acw at/near totalCtx does not pin used at 100% (#1194)', () => {
  const { execFileSync } = require('node:child_process');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  /**
   * Run the hook with a given acw and totalTokens; remaining fixed at 50%.
   * Returns the normalizedUsed percentage shown in the statusline bar.
   */
  function runBoundaryHook(remainingPct, totalTokens, acwEnv) {
    const sessionId = `test-1194-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: sessionId,
      context_window: {
        remaining_percentage: remainingPct,
        total_tokens: totalTokens,
      },
    });

    const env = { ...process.env };
    if (acwEnv != null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(acwEnv);
    } else {
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookPath], {
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });
    } catch (e) {
      stdout = e.stdout || '';
    }

    // Strip ANSI escape codes then extract the percentage digit(s) before "%"
    // eslint-disable-next-line no-control-regex -- \x1b is the required leading byte of ANSI SGR sequences
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const match = clean.match(/(\d+)%/);
    return match ? parseInt(match[1], 10) : null;
  }

  // acw == totalCtx - 1 (one token below total): buffer is near-zero (≈0%),
  // so the full window is usable. With 50% remaining the bar should show ~50%.
  test('acw = totalCtx - 1: used reflects actual remaining context (≈50%)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx - 1; // 999999
    const used = runBoundaryHook(50, totalCtx, acw);
    // buffer ≈ 0% → usableRemaining ≈ 50% → used ≈ 50. Accept 49-51 for rounding.
    assert.ok(
      used !== null && used >= 49 && used <= 51,
      `expected used ≈ 50 when acw=totalCtx-1, got: ${used}`
    );
  });

  // acw == totalCtx (the triggering edge case): buffer should be 0%,
  // NOT 100%.  The "used" value must reflect real remaining context, not 100.
  test('acw = totalCtx: used MUST NOT stick at 100 (division-by-zero boundary)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx; // 1000000
    const used = runBoundaryHook(50, totalCtx, acw);
    // Buffer = 0% → usableRemaining = 50% → used ≈ 50. Must not be 100.
    assert.ok(
      used !== null && used !== 100,
      `expected used != 100 when acw==totalCtx (div-by-zero boundary), got: ${used}`
    );
    // Also assert the bar is in a sane range (should be around 50%)
    assert.ok(
      used >= 0 && used <= 99,
      `expected used in 0-99 when acw==totalCtx, got: ${used}`
    );
  });

  // acw == totalCtx + 1 (exceeds total): buffer would be negative without a clamp;
  // the Math.max(0,...) clamp should keep buffer=0%, not a negative value.
  test('acw = totalCtx + 1: does not produce negative buffer (clamp prevents it)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx + 1; // 1000001
    const used = runBoundaryHook(50, totalCtx, acw);
    // Buffer clamped to 0 → used ≈ 50 (reflects real remaining, not 100)
    assert.ok(
      used !== null && used !== 100,
      `expected used != 100 when acw=totalCtx+1, got: ${used}`
    );
    assert.ok(
      used >= 0 && used <= 99,
      `expected used in 0-99 when acw=totalCtx+1, got: ${used}`
    );
  });

  // Default path (no env var / acw==0): must be unchanged. 50% remaining → ~60%.
  test('acw = 0 (default path): unchanged, ~60% normalized for 50% remaining', () => {
    const used = runBoundaryHook(50, 1_000_000, 0);
    assert.strictEqual(used, 60, `default path must still produce 60, got: ${used}`);
  });

  // Normal partial value: 93% remaining → ~usesd ≈ 7% with default buffer.
  test('normal partial value: 93% remaining → ~7% normalized used', () => {
    // Default 16.5% buffer: usableRemaining = (93 - 16.5) / (100 - 16.5) * 100 = 91.6%
    // used ≈ 100 - 91.6 = 8.4 → rounded 8
    const used = runBoundaryHook(93, 1_000_000, null);
    assert.ok(
      used !== null && used >= 7 && used <= 10,
      `expected used ≈ 7-10 for 93% remaining with default buffer, got: ${used}`
    );
  });
});

// ─── todo-resolution path (#305) ────────────────────────────────────────────

describe('todo-resolution: resolves in_progress task from the newest matching todos file (#305)', () => {
  const { execFileSync } = require('node:child_process');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  test('resolves in_progress task from the newest matching todos file (#305)', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-305-'));
    t.after(() => {
      cleanup(tempDir);
    });

    const todosDir = path.join(tempDir, 'todos');
    fs.mkdirSync(todosDir, { recursive: true });

    const session = `sess-305-${Math.random().toString(36).slice(2)}`;
    const now = Date.now() / 1000; // seconds for utimesSync

    // Older matching file — should NOT be selected
    const olderPath = path.join(todosDir, `${session}-agent-A.json`);
    fs.writeFileSync(olderPath, JSON.stringify([
      { content: 'old task', status: 'in_progress', activeForm: 'OLDER TASK 305' },
    ]));
    const olderTime = now - 10000;
    fs.utimesSync(olderPath, olderTime, olderTime);

    // Newer matching file — should be selected
    const newerPath = path.join(todosDir, `${session}-agent-B.json`);
    fs.writeFileSync(newerPath, JSON.stringify([
      { content: 'new task', status: 'in_progress', activeForm: 'NEWER TASK 305' },
    ]));
    const newerTime = now - 1000;
    fs.utimesSync(newerPath, newerTime, newerTime);

    // Distractor: different session prefix — must be ignored even with very-new mtime
    const wrongSessPath = path.join(todosDir, 'other-sess-agent-Z.json');
    fs.writeFileSync(wrongSessPath, JSON.stringify([
      { content: 'wrong session', status: 'in_progress', activeForm: 'WRONG SESSION 305' },
    ]));
    fs.utimesSync(wrongSessPath, now, now);

    // Distractor: matches session + .json but lacks -agent- — must be ignored
    const notAgentPath = path.join(todosDir, `${session}-notagent.json`);
    fs.writeFileSync(notAgentPath, JSON.stringify([
      { content: 'not agent', status: 'in_progress', activeForm: 'NOT AGENT 305' },
    ]));
    fs.utimesSync(notAgentPath, now, now);

    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: session,
      context_window: { remaining_percentage: 80, total_tokens: 1_000_000 },
    });

    const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir };

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookPath], {
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });
    } catch (e) {
      stdout = e.stdout || '';
    }

    assert.ok(stdout.includes('NEWER TASK 305'),
      `expected stdout to contain "NEWER TASK 305", got: ${stdout}`);
    assert.ok(!stdout.includes('OLDER TASK 305'),
      `stdout must NOT contain "OLDER TASK 305", got: ${stdout}`);
    assert.ok(!stdout.includes('WRONG SESSION 305'),
      `stdout must NOT contain "WRONG SESSION 305", got: ${stdout}`);
    assert.ok(!stdout.includes('NOT AGENT 305'),
      `stdout must NOT contain "NOT AGENT 305", got: ${stdout}`);
  });
});
