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
  const TIMING_PARTS = [
    'record-start-time.md',
    'record-completion-time.md',
    'executor-state-updates.md',
    'update-current-position.md',
    'clear-plan-timing.md',
  ].map((name) => path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan', 'steps', name));
  const TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  const NO_BASH = process.platform === 'win32' || runHook('-c', ['exit 0'], {
    interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS,
  }).outcome === OUTCOME.SPAWN_FAILED;

  function delegatedPart(file, tag, step = false) {
    const source = fs.readFileSync(file, 'utf8');
    const opening = step ? `<step name="${tag}">` : `<${tag}>`;
    const start = source.indexOf(opening);
    assert.notEqual(start, -1, `${tag} must exist`);
    const end = source.indexOf(step ? '</step>' : `</${tag}>`, start);
    assert.ok(end > start, `${tag} must close`);
    const section = source.slice(start + opening.length, end);
    const match = /`((?:~\/\.claude\/)?gsd-core\/workflows\/[^`]{1,500}\.md)`/.exec(section);
    assert.ok(match, `${tag} must name its workflow part`);
    return {
      declaredPath: match[1],
      sourcePath: match[1].replace(/^~\/\.claude\//, ''),
    };
  }

  function timingKeyBlock(file) {
    const lines = splitLines(fs.readFileSync(file, 'utf8'));
    const start = lines.findIndex((line) => line.trim() === '# plan-timing-key:start');
    const end = lines.findIndex((line, index) => index > start && line.trim() === '# plan-timing-key:end');
    assert.ok(start !== -1 && end > start, `${path.basename(file)} must delimit its timing-key resolver`);
    return lines.slice(start + 1, end)
      .map((line) => line.trimStart())
      .filter((line) => !line.startsWith('PHASE_VALUE=') && !line.startsWith('PLAN_VALUE='));
  }

  function timingFence(file, tag, step = false, followPart = true) {
    // The agent/workflow is the deployed timing program; execute its real fence.
    const source = fs.readFileSync(file, 'utf8');
    const opening = step ? `<step name="${tag}">` : `<${tag}>`;
    const start = source.indexOf(opening);
    // Before #5212 the executor has no completion calculation at all.
    if (start === -1) return '';
    const end = source.indexOf(step ? '</step>' : `</${tag}>`, start);
    assert.ok(end > start, `${tag} must close`);
    const lines = splitLines(source.slice(start + opening.length, end));
    const fences = scanFencedBlocks(lines).filter((block) => block.infoString === 'bash');
    let fence = fences.find((block) => (
      lines.slice(block.openLineIdx + 1, block.closeLineIdx).some((line) => line.includes('state.record-metric'))
    ));
    if (!fence && followPart) {
      const part = /`((?:~\/\.claude\/)?gsd-core\/workflows\/[^`]+\.md)`/.exec(lines.join('\n'));
      if (part) return timingFence(path.join(__dirname, '..', part[1].replace(/^~\/\.claude\//, '')), tag, true, false);
    }
    fence ??= fences[0];
    if (!fence && followPart) {
      // A spine step may delegate to a workflow part; execute the part it names.
      const part = /`((?:~\/\.claude\/)?gsd-core\/workflows\/[^`]+\.md)`/.exec(lines.join('\n'));
      assert.ok(part, `${tag} must have a Bash fence or name the workflow part that carries it`);
      return timingFence(path.join(__dirname, '..', part[1].replace(/^~\/\.claude\//, '')), tag, true, false);
    }
    assert.ok(fence && fence.closeLineIdx !== -1, `${tag} must have a complete Bash fence`);
    return lines.slice(fence.openLineIdx + 1, fence.closeLineIdx).join('\n');
  }

  function fixture() {
    const dir = createTempDir('gsd-plan-timing-');
    gitOrThrow(['init', '-q'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    return dir;
  }

  function runFresh(
    dir,
    code,
    epoch,
    identity = ['03', '01'],
    expose = false,
    realCli = false,
    attempt = 'fresh',
    mutationLog = '',
    taskCount = 2,
    fileCount = 3,
    summaryPath = '',
    decisionsJson = '{"decisions":[]}',
  ) {
    const [phase, plan] = identity;
    const executableCode = splitLines(code)
      .filter((line) => !line.startsWith('_GSD_SHIM_NAME="gsd-tools.cjs";'))
      .join('\n');
    const script = [
      'set -e',
      'unset PHASE PLAN TASK_COUNT FILE_COUNT DECISIONS',
      // Pin date at the shell boundary; parent mock.timers cannot reach Bash.
      'date() { if [ "$*" = +%s ]; then printf "%s\\n" "$FIXTURE_EPOCH"; else printf "%s\\n" "$FIXTURE_ISO"; fi; }',
      // Intercept only the state mutation to inspect the actual named arguments.
      realCli ? 'gsd_run() { node "$FIXTURE_TOOLS" "$@"; }' :
        'gsd_run() { if [ -n "$FIXTURE_MUTATION_LOG" ]; then node -e \'const fs=require("node:fs");fs.appendFileSync(process.argv[1],JSON.stringify(process.argv.slice(2))+"\\n")\' "$FIXTURE_MUTATION_LOG" "$@"; fi; if [ "$2" = summary-extract ]; then printf "%s\\n" "$FIXTURE_DECISIONS_JSON"; elif [ "$2" = state.record-metric ]; then node -e \'const a=process.argv.slice(1);process.stdout.write(JSON.stringify({duration:a[a.indexOf("--duration")+1]})+"\\n")\' "$@"; fi; }',
      executableCode
        .replaceAll('{timing_phase}', JSON.stringify(phase))
        .replaceAll('{timing_plan}', JSON.stringify(plan))
        .replaceAll('{timing_attempt}', attempt)
        .replaceAll('{task_count}', String(taskCount))
        .replaceAll('{file_count}', String(fileCount))
        .replaceAll('{summary_path}', summaryPath),
      ...(expose ? ['node -e \'process.stdout.write(JSON.stringify({file:process.argv[1]})+"\\n")\' "${TIMING_FILE:-}"'] : []),
    ].join('\n');
    const result = runHook('-c', [script], {
      interpreter: 'bash', cwd: dir, timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        ...process.env, FIXTURE_TOOLS: TOOLS,
        FIXTURE_EPOCH: String(epoch), FIXTURE_ISO: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
        GSD_TEST_MODE: '1', GSD_NOW_MS: String(epoch * 1000), FIXTURE_MUTATION_LOG: mutationLog,
        FIXTURE_DECISIONS_JSON: decisionsJson,
      },
    });
    throwIfFailed(result, 'fresh timing shell');
    const stdout = result.stdout;
    return stdout.trim() ? JSON.parse(stdout.trim()) : { duration: '' };
  }

  const surfaces = [
    { name: 'executor', file: AGENT, metric: 'state_updates', clear: 'clear_plan_timing', step: false },
    { name: 'execute-plan', file: WORKFLOW, metric: 'update_current_position', clear: 'clear_plan_timing', step: true },
  ];

  test('#5212: executor and inline workflow share one timing lifecycle source', () => {
    for (const [tag, agentStep] of [
      ['record_start_time', true],
      ['record_completion_time', true],
      ['clear_plan_timing', true],
    ]) {
      const agentPart = delegatedPart(AGENT, tag, agentStep);
      const workflowPart = delegatedPart(WORKFLOW, tag, true);
      assert.equal(
        agentPart.declaredPath.startsWith('~/.claude/gsd-core/'),
        true,
        `${tag} must use an install-rewritable agent path`,
      );
      assert.equal(
        workflowPart.declaredPath.startsWith('gsd-core/'),
        true,
        `${tag} workflow delegation must stay repository-relative`,
      );
      assert.equal(agentPart.sourcePath, workflowPart.sourcePath, `${tag} delegation paths must share one source`);
    }
  });

  test('#5212: every timing part shares one canonical identity-to-key program', () => {
    const [owner, ...mirrors] = TIMING_PARTS.map(timingKeyBlock);
    for (const mirror of mirrors) assert.deepEqual(mirror, owner);
  });

  test('#5212: executor and inline STATE parts share the measured metric prelude', () => {
    function metricPrelude(file, tag) {
      const lines = splitLines(timingFence(file, tag, true, false));
      const start = lines.findIndex((line) => line.trim() === '# plan-timing-key:start');
      const call = lines.findIndex((line) => line.trimStart().startsWith('gsd_run query state.record-metric'));
      assert.ok(start !== -1 && call > start, `${path.basename(file)} must carry the timing metric prelude`);
      let end = call;
      while (lines[end].trimEnd().endsWith('\\')) end++;
      return lines.slice(start, end + 1).map((line) => line.trimStart());
    }
    const executor = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan', 'steps', 'executor-state-updates.md');
    const inline = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-plan', 'steps', 'update-current-position.md');
    assert.deepEqual(metricPrelude(inline, 'update_current_position'), metricPrelude(executor, 'state_updates'));
  });

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
          // A continuation may execute the start fence again; its explicit
          // signal makes the shell preserve the original marker.
          runFresh(dir, start(), 2000, ['03', '01'], false, false, 'continuation');
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

      test('numeric phase and plan spellings share one canonical marker', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000, ['5', '1']);
          assert.deepEqual(runFresh(dir, finish(), 1060, ['05', '01']), {
            duration: '1 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T00:17:40Z',
          });
        } finally { cleanup(dir); }
      });

      test('numeric dotted phase spellings share one canonical marker', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000, ['5.1', '1']);
          assert.deepEqual(runFresh(dir, finish(), 1060, ['05.1', '01']), {
            duration: '1 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T00:17:40Z',
          });
        } finally { cleanup(dir); }
      });

      test('numeric prefixes in named phase spellings share one canonical marker', () => {
        const dir = fixture();
        try {
          runFresh(dir, start(), 1000, ['5.1A', '1B']);
          assert.deepEqual(runFresh(dir, finish(), 1060, ['05.01A', '01B']), {
            duration: '1 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T00:17:40Z',
          });
        } finally { cleanup(dir); }
      });

      test('every shipped capture delimiter fails closed or remains whole as identity data', () => {
        const delimiters = [
          'PLAN!PHASE!5212', 'PLAN!NUMBER!5212', 'PLAN!TASKS!5212',
          'PLAN!FILES!5212', 'PLAN!SUMMARY!5212',
        ];
        for (const delimiter of delimiters) {
          const dir = fixture();
          const sentinel = path.join(dir, 'delimiter-ran');
          const identity = [`prefix\n${delimiter}\ntouch ${sentinel}`, delimiter];
          try {
            runFresh(dir, start(), 1000, identity);
            assert.deepEqual(runFresh(dir, finish(), 1060, identity), {
              duration: '1 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T00:17:40Z',
            });
            assert.equal(fs.existsSync(sentinel), false, `${delimiter} must never execute identity text`);
          } finally { cleanup(dir); }
        }
      });

      test('unsubstituted phase and plan placeholders fail before creating a marker', () => {
        const dir = fixture();
        try {
          assert.throws(
            () => runFresh(dir, start(), 1000, ['{phase}', '{plan}']),
            (error) => error.exitCode === 1 && /unsubstituted/.test(error.stderr),
          );
          assert.equal(fs.readdirSync(path.join(dir, '.git')).some((entry) => entry.startsWith('gsd-plan-timing-')), false);
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
          runFresh(linked, start(), 4000, identities[0], false, false, 'continuation');
          assert.deepEqual(runFresh(linked, finish(), 4660, identities[0]), { duration: '1h 1m', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T01:17:40Z' });
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

      test('future and oversized epochs are rejected before producing a cached result', () => {
        const dir = fixture();
        try {
          const timingFile = runFresh(dir, start(), 1000, ['03', '01'], true).file;
          fs.writeFileSync(path.resolve(dir, timingFile), '2000\n1970-01-01T00:33:20Z\n');
          assert.throws(
            () => runFresh(dir, finish(), 1000),
            (error) => error.exitCode === 1 && /in the future/.test(error.stderr),
          );
          assert.equal(fs.existsSync(path.resolve(dir, `${timingFile}.result`)), false);

          fs.writeFileSync(path.resolve(dir, timingFile), '99999999999999999999\ninvalid\n');
          assert.throws(() => runFresh(dir, finish(), 1000), (error) => error.exitCode === 1);
          assert.equal(fs.existsSync(path.resolve(dir, `${timingFile}.result`)), false);
        } finally { cleanup(dir); }
      });

      for (const epoch of [999999999, 1000000000, 10000000000]) {
        test(`epoch digit boundary ${String(epoch).length} digits`, (t) => {
          const dir = fixture();
          t.after(() => cleanup(dir));
          runFresh(dir, start(), epoch);
          if (String(epoch).length > 10) {
            assert.throws(() => runFresh(dir, finish(), epoch), (error) => error.exitCode === 1);
          } else {
            assert.deepEqual(runFresh(dir, finish(), epoch), {
              duration: '0 min', started: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
              completed: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'),
            });
          }
        });
      }

      test('empty or truncated cached results fail before any STATE mutation', () => {
        const dir = fixture();
        try {
          const timingFile = runFresh(dir, start(), 1000, ['03', '01'], true).file;
          const metric = timingFence(surface.file, surface.metric, surface.step);
          const mutationLog = path.join(dir, 'mutations.log');
          for (const invalid of ['', '1970-01-01T00:16:40Z\n1970-01-01T00:17:40Z\n']) {
            fs.writeFileSync(path.resolve(dir, `${timingFile}.result`), invalid);
            assert.throws(
              () => runFresh(dir, metric, 1060, ['03', '01'], false, false, 'fresh', mutationLog),
              (error) => error.exitCode === 1 && /missing or invalid/.test(error.stderr),
            );
            assert.equal(fs.existsSync(mutationLog), false, 'STATE commands must not run before validation');
          }
        } finally { cleanup(dir); }
      });

      test('the state-update shell carries identity and measured counts without inherited variables', () => {
        const dir = fixture();
        try {
          const identity = ['05.1', '01'];
          const mutationLog = path.join(dir, 'mutations.jsonl');
          runFresh(dir, start(), 1000, identity);
          runFresh(dir, finish(), 1060, identity);
          runFresh(
            dir,
            timingFence(surface.file, surface.metric, surface.step),
            1060,
            identity,
            false,
            false,
            'fresh',
            mutationLog,
            7,
            9,
          );
          const calls = splitLines(fs.readFileSync(mutationLog, 'utf8')).filter(Boolean).map(JSON.parse);
          const metric = calls.find((call) => call[1] === 'state.record-metric');
          assert.deepEqual(metric, [
            'query', 'state.record-metric',
            '--phase', identity[0], '--plan', identity[1], '--duration', '1 min',
            '--tasks', '7', '--files', '9',
          ]);
          if (surface.name === 'executor') {
            const session = calls.find((call) => call[1] === 'state.record-session');
            assert.deepEqual(session, [
              'query', 'state.record-session',
              '--stopped-at', `Completed ${identity[0]}-${identity[1]}-PLAN.md`,
              '--resume-file', 'None',
            ]);
          }
        } finally { cleanup(dir); }
      });

      if (surface.name === 'executor') test('the state-update shell extracts SUMMARY decisions without an inherited array', () => {
        const dir = fixture();
        try {
          const mutationLog = path.join(dir, 'decision-mutations.jsonl');
          runFresh(dir, start(), 1000);
          runFresh(dir, finish(), 1060);
          runFresh(
            dir,
            timingFence(surface.file, surface.metric, surface.step),
            1060,
            ['03', '01'],
            false,
            false,
            'fresh',
            mutationLog,
            2,
            3,
            '.planning/phases/03-example/03-01-SUMMARY.md',
            JSON.stringify({ decisions: [
              { summary: 'Use $HOME literally', rationale: 'Preserve * and spaces' },
              { summary: 'No rationale', rationale: null },
            ] }),
          );
          const calls = splitLines(fs.readFileSync(mutationLog, 'utf8')).filter(Boolean).map(JSON.parse);
          const decisions = calls.filter((call) => call[1] === 'state.add-decision');
          assert.equal(decisions.length, 2);
          for (const call of decisions) {
            assert.equal(call[call.indexOf('--phase') + 1], '03');
            assert.ok(call.includes('--summary-file'));
          }
          assert.ok(decisions[0].includes('--rationale-file'));
          assert.equal(decisions[1].includes('--rationale-file'), false);
        } finally { cleanup(dir); }
      });

      test('phase and plan text is data, never shell syntax', () => {
        const dir = fixture();
        try {
          const pwned = path.join(dir, 'timing-pwned');
          const identity = [`$(touch ${pwned})`, `"; touch ${pwned}; #`];
          runFresh(dir, start(), 1000, identity);
          assert.deepEqual(runFresh(dir, finish(), 1060, identity), {
            duration: '1 min', started: '1970-01-01T00:16:40Z', completed: '1970-01-01T00:17:40Z',
          });
          runFresh(dir, timingFence(surface.file, surface.metric, surface.step), 1060, identity);
          assert.equal(fs.existsSync(pwned), false);
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
          const begin = lines.findIndex((line) => line.trim() === '# plan-timing-key:start');
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
