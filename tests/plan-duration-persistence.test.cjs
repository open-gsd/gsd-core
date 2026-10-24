// allow-test-rule: source-text-is-the-product (#5212)
'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const AGENT = path.join(__dirname, '..', 'agents', 'gsd-executor.md');

// #5212: execute the shipped timing protocol in independent Bash calls, as
// executor continuations and the inline execute-plan workflow actually do.
{
  const fc = require('fast-check');
  const { scanFencedBlocks, collectSection } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
  const { parseMarkdownTable } = require('../gsd-core/bin/lib/markdown-table.cjs');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
  const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
  const { gitOrThrow, throwIfFailed } = require('./helpers/git-fixture.cjs');
  const { PROBE_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { createTempDir, cleanup } = require('./helpers.cjs');
  const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan.md');
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  const NO_BASH = process.platform === 'win32' || runHook('-c', ['exit 0'], {
    interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS,
  }).outcome === OUTCOME.SPAWN_FAILED;

  function shellQuote(value) {
    return "'" + value.replaceAll("'", "'\\''") + "'";
  }

  function timingFence(file, tag, step = false, followPart = true) {
    // allow-test-rule: source-text-is-the-product (#5212)
    // The agent/workflow is the deployed timing program; execute its real fence.
    const source = fs.readFileSync(file, 'utf8');
    const opening = step ? `<step name="${tag}">` : `<${tag}>`;
    const start = source.indexOf(opening);
    // Before #5212 the executor has no completion calculation at all.
    if (start === -1) return '';
    const end = source.indexOf(step ? '</step>' : `</${tag}>`, start);
    assert.ok(end > start, `${tag} must close`);
    const lines = splitLines(source.slice(start + opening.length, end));
    const fence = scanFencedBlocks(lines).find((block) => block.infoString === 'bash');
    if (!fence && followPart) {
      // A spine step may delegate to a workflow part; execute the part it names.
      const part = /`(gsd-core\/workflows\/[^`]+\.md)`/.exec(lines.join('\n'));
      assert.ok(part, `${tag} must have a Bash fence or name the workflow part that carries it`);
      return timingFence(path.join(__dirname, '..', part[1]), tag, step, false);
    }
    assert.ok(fence && fence.closeLineIdx !== -1, `${tag} must have a complete Bash fence`);
    return lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
  }

  function fixture() {
    const dir = createTempDir('gsd-plan-timing-');
    gitOrThrow(['init', '-q'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    return dir;
  }

  function runFresh(dir, code, epoch, identity = ['03', '01'], expose = false, realCli = false) {
    const [phase, plan] = identity;
    const script = [
      'set -e',
      'unset PHASE PLAN; TASK_COUNT=2; FILE_COUNT=3',
      // Pin date at the shell boundary; parent mock.timers cannot reach Bash.
      'date() { if [ "$*" = +%s ]; then printf "%s\\n" "$FIXTURE_EPOCH"; else printf "%s\\n" "$FIXTURE_ISO"; fi; }',
      // Intercept only the state mutation to inspect the actual named arguments.
      realCli ? 'gsd_run() { node "$FIXTURE_TOOLS" "$@"; }' :
        'gsd_run() { if [ "$2" = state.record-metric ]; then node -e \'const a=process.argv.slice(1);process.stdout.write(JSON.stringify({duration:a[a.indexOf("--duration")+1]})+"\\n")\' "$@"; fi; }',
      code.replaceAll('"{phase}"', shellQuote(phase)).replaceAll('"{plan}"', shellQuote(plan)),
      ...(expose ? ['node -e \'process.stdout.write(JSON.stringify({file:process.argv[1]})+"\\n")\' "${TIMING_FILE:-}"'] : []),
    ].join('\n');
    const result = runHook('-c', [script], {
      interpreter: 'bash', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        ...process.env, FIXTURE_TOOLS: TOOLS,
        FIXTURE_EPOCH: String(epoch), FIXTURE_ISO: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
        GSD_TEST_MODE: '1', GSD_NOW_MS: String(epoch * 1000),
      },
    });
    throwIfFailed(result, 'fresh timing shell');
    const stdout = result.stdout;
    return stdout.trim() ? JSON.parse(stdout.trim()) : { duration: '' };
  }

  const surfaces = [
    { name: 'executor', file: AGENT, metric: 'state_updates', clear: 'plan_timing_cleanup', step: false },
    { name: 'execute-plan', file: WORKFLOW, metric: 'update_current_position', clear: 'clear_plan_timing', step: true },
  ];
  for (const surface of surfaces) {
    describe(`#5212: ${surface.name} persists measured plan duration`, { skip: NO_BASH ? 'requires Bash on a POSIX host' : false }, () => {
      const start = () => timingFence(surface.file, 'record_start_time', true);
      const finish = () => timingFence(surface.file, 'record_completion_time', true);

      for (const [minutes, duration] of [[0, '0 min'], [59, '59 min'], [60, '1h 0m'], [61, '1h 1m']]) {
        test(`a fresh completion shell measures ${minutes} minutes as ${duration}`, () => {
          const dir = fixture();
          try {
            runFresh(dir, start(), 1000);
            const measured = runFresh(dir, finish(), 1000 + minutes * 60);
            assert.deepEqual(measured, {
              duration, started: '1970-01-01T00:16:40Z',
              completed: new Date((1000 + minutes * 60) * 1000).toISOString().replace('.000Z', 'Z'),
            });
          } finally { cleanup(dir); }
        });
      }

      test('a continuation preserves the start and metrics reuse the frozen SUMMARY duration across a minute boundary', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000);
          // A continuation resumes after record_start_time and deliberately
          // leaves the original marker untouched.
          const summary = runFresh(dir, finish(), 1000 + 59 * 60 + 59);
          assert.deepEqual(summary, { duration: '59 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T01:16:39Z' });
          const metric = runFresh(dir, timingFence(surface.file, surface.metric, surface.step), 1000 + 61 * 60);
          assert.deepEqual(metric, { duration: summary.duration });
          // More work after an unsuccessful close-out must refresh completion,
          // while the original start remains the same on a continuation.
          const resumed = runFresh(dir, finish(), 1000 + 63 * 60);
          assert.deepEqual(resumed, { duration: '1h 3m', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T01:19:40Z' });
          assert.equal(resumed.started, summary.started);
          const resumedMetric = runFresh(dir, timingFence(surface.file, surface.metric, surface.step), 1000 + 64 * 60);
          assert.deepEqual(resumedMetric, { duration: resumed.duration });
        } finally { cleanup(dir); }
      });

      test('a fresh retry overwrites an abandoned marker instead of inheriting stale elapsed time', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000);
          runFresh(dir, start(), 10000);
          assert.deepEqual(runFresh(dir, finish(), 10060), {
            duration: '1 min', started: '1970-01-01T02:46:40Z', completed: '1970-01-01T02:47:40Z',
          });
        } finally { cleanup(dir); }
      });

      test('completion cleanup lets a later legitimate rerun measure from a new start', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000);
          assert.deepEqual(runFresh(dir, finish(), 1000 + 61 * 60), { duration: '1h 1m', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T01:17:40Z' });
          runFresh(dir, timingFence(surface.file, surface.clear, surface.step), 1000 + 62 * 60);
          runFresh(dir, start(), 10000);
          const rerun = runFresh(dir, finish(), 10000 + 60);
          assert.deepEqual(rerun, { duration: '1 min', started: '1970-01-01T02:46:40Z', completed: '1970-01-01T02:47:40Z' });
        } finally { cleanup(dir); }
      });

      test('bracket/project/slash identities remain distinct and confined to their worktree Git directory', () => {
        const dir = fixture();
        try {
          const identities = [['[GSD/M3]P2', '01'], ['GSD/M3', '[P2]01'], ['a-b', 'c'], ['a', 'b-c']];
          const files = identities.map((identity) => runFresh(dir, start(), 1000, identity, true).file);
          assert.equal(new Set(files).size, identities.length);
          for (const file of files) {
            assert.equal(path.resolve(dir, path.dirname(file)), path.join(dir, '.git'));
            assert.ok(fs.existsSync(path.resolve(dir, file)));
          }
          gitOrThrow(['config', 'user.email', 'timing@example.test'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
          gitOrThrow(['config', 'user.name', 'Timing'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
          gitOrThrow(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
          const linked = path.join(dir, 'linked');
          gitOrThrow(['worktree', 'add', '-qb', 'linked', linked], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
          runFresh(linked, start(), 10000, identities[0]);
          assert.deepEqual(runFresh(linked, finish(), 10060, identities[0]), { duration: '1 min', started: '1970-01-01T02:46:40Z', completed: '1970-01-01T02:47:40Z' });
          assert.deepEqual(runFresh(dir, finish(), 4660, identities[0]), { duration: '1h 1m', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T01:17:40Z' });
        } finally { cleanup(dir); }
      });

      test('formatting preserves the whole elapsed minutes for generated intervals', async () => {
        await fc.assert(fc.property(fc.integer({ min: 0, max: 604800 }), (seconds) => {
          const dir = fixture();
          try {
            runFresh(dir, start(), 1000);
            const measured = runFresh(dir, finish(), 1000 + seconds);
            const minutes = Math.floor(seconds / 60);
            const expected = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
            assert.deepEqual(measured, {
              duration: expected, started: '1970-01-01T00:16:40Z',
              completed: new Date((1000 + seconds) * 1000).toISOString().replace('.000Z', 'Z'),
            });
          } finally { cleanup(dir); }
        }), { numRuns: 20, seed: 5212 });
      });

      test('Git lookup failures and missing starts stop without creating timing files', () => {
        const dir = fixture();
        try {
          const initial = fs.readdirSync(dir);
          assert.throws(() => runFresh(dir, 'git() { if [ "$1" = rev-parse ]; then return 23; fi; command git "$@"; }\n' + start(), 1000), (error) => error.exitCode === 1);
          assert.throws(() => runFresh(dir, 'git() { if [ "$1" = hash-object ]; then return 23; fi; command git "$@"; }\n' + start(), 1000), (error) => error.exitCode === 1);
          assert.throws(() => runFresh(dir, finish(), 1000), (error) => error.exitCode === 1);
          assert.deepEqual(fs.readdirSync(dir), initial);
          assert.equal(fs.readdirSync(path.join(dir, '.git')).filter((entry) => entry.startsWith('gsd-plan-timing-')).length, 0);
        } finally { cleanup(dir); }
      });

      test('the real metric CLI records the measured result without PHASE or PLAN in its fresh shell', () => {
        const dir = fixture();
        const identity = ['[GSD/M3]P2', '01'];
        try {
          fs.mkdirSync(path.join(dir, '.planning'));
          const statePath = path.join(dir, '.planning', 'STATE.md');
          fs.writeFileSync(statePath, [
            '# Project State', '', '## Performance Metrics', '',
            '| Plan | Duration | Tasks | Files |', '|------|----------|-------|-------|', '',
          ].join('\n'));
          runFresh(dir, start(), 1000, identity);
          const summary = runFresh(dir, finish(), 1000 + 59 * 60 + 59, identity);
          const lines = splitLines(timingFence(surface.file, surface.metric, surface.step));
          const begin = lines.findIndex((line) => line.trimStart().startsWith('TIMING_KEY='));
          const firstMutation = lines.findIndex((line) => line.trimStart().startsWith('gsd_run query state.advance-plan'));
          const call = lines.findIndex((line) => line.trimStart().startsWith('gsd_run query state.record-metric'));
          assert.ok(begin !== -1 && firstMutation > begin && call > firstMutation,
            'metric shell must restore its cached duration before any STATE mutation');
          let end = call;
          while (lines[end].trimEnd().endsWith('\\')) end++;
          const metricCode = [...lines.slice(begin, firstMutation), ...lines.slice(call, end + 1)].join('\n');
          const metric = runFresh(dir, metricCode, 1000 + 61 * 60, identity, false, true);
          assert.deepEqual(metric, { recorded: true, phase: identity[0], plan: identity[1], duration: summary.duration });
          const section = collectSection(fs.readFileSync(statePath, 'utf8'), (heading) => heading.text === 'Performance Metrics');
          assert.ok(section, 'real CLI must preserve the metrics section');
          const table = parseMarkdownTable(section.body);
          assert.equal(table.ok, true);
          assert.deepEqual(table.value.rows, [{ Plan: 'Phase [GSD/M3]P2 P01', Duration: summary.duration, Tasks: '2 tasks', Files: '3 files' }]);
        } finally { cleanup(dir); }
      });
    });
  }
}
