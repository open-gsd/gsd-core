/**
 * #5473 — the real-bash half of tests/xtrace-phase-timing.test.cjs.
 *
 * These tests spawn /bin/bash and perl, so they live in the `.platform` sibling
 * (docs/how-to/split-platform-sensitive-tests.md): the pure parser, attribution
 * and CLI-surface tests stay in the base file and out of the real-OS tiers.
 * Every test here skips where there is no unix /bin/bash and perl.
 *
 * What they pin: the instrumentation (one line inserted after the shebang)
 * really stamps a real bash's trace; a traced run of the REAL hook behaves
 * exactly like a direct run; and the report pipeline works end to end.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const {
  stampPs4,
  TRACE_PS4_FILE,
  INJECTED_LINES,
  injectTracing,
  parseTimedXtrace,
  shiftLines,
} = require('../scripts/xtrace-phase-timing.cjs');
const {
  report,
  prepareTracedHooks,
  STAMP_COMMAND,
  HOOK,
} = require('../scripts/diagnose-validate-commit-phases.cjs');

const NONCE = 'k3f9a1';

const BASH = '/bin/bash';
const REAL_BASH_BOUND_MS = 30000;
const haveRealBash = fs.existsSync(BASH)
  && spawnSync('perl', ['-e', '1'], { timeout: REAL_BASH_BOUND_MS }).status === 0;
const needsBash = !haveRealBash && 'needs a unix /bin/bash and perl';

describe('the instrumentation against a real bash', () => {
  test('stamps parse, and the original lines and functions are attributed', { skip: needsBash }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-xtrace-probe-'));
    const script = path.join(dir, 'probe.sh');
    fs.writeFileSync(script, injectTracing(['#!/bin/bash', 'a=1', 'b=2', 'f() {', '  c=3', '}', 'f', ''].join('\n')));
    fs.writeFileSync(path.join(dir, TRACE_PS4_FILE), stampPs4(STAMP_COMMAND, NONCE));
    const r = spawnSync(BASH, [script], { encoding: 'utf8', timeout: REAL_BASH_BOUND_MS });
    cleanup(dir);
    assert.equal(r.status, 0, r.stderr);
    const entries = shiftLines(parseTimedXtrace(r.stderr, NONCE), INJECTED_LINES);
    const byCmd = Object.fromEntries(entries.map((e) => [e.cmd, e]));
    const seen = `entries=${JSON.stringify(entries.map((e) => e.cmd))} stderr=${JSON.stringify(r.stderr.slice(0, 600))}`;
    for (const cmd of ['a=1', 'b=2', 'c=3']) assert.ok(byCmd[cmd], `no stamped entry for ${cmd}: ${seen}`);
    assert.equal(byCmd['a=1'].line, 2);
    assert.equal(byCmd['b=2'].line, 3);
    assert.equal(byCmd['c=3'].fn, 'f');
    assert.equal(byCmd['a=1'].fn, '');
    // A stamp is an integer epoch-millisecond reading from the perl clock.
    for (const e of entries) assert.ok(Number.isInteger(e.t) && e.t > 0, `bad stamp ${e.t}`);
  });

  test('a traced run of the real hook behaves exactly like a direct run (status and stdout)', { skip: needsBash }, () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-xtrace-parity-'));
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.planning', 'config.json'),
      JSON.stringify({ hooks: { community: true } }),
    );
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` };
    const { hook: tracedHook } = prepareTracedHooks(project, stampPs4(STAMP_COMMAND, NONCE));
    try {
      for (const [command, expectedStatus] of [
        ['git commit -m "feat: add thing"', 0],
        ['git commit -m "wibble wobble"', 2],
      ]) {
        const input = JSON.stringify({ tool_input: { command } });
        const direct = spawnSync(BASH, [HOOK], { cwd: project, env, input, encoding: 'utf8', timeout: REAL_BASH_BOUND_MS });
        const viaTrace = spawnSync(BASH, [tracedHook], { cwd: project, env, input, encoding: 'utf8', timeout: REAL_BASH_BOUND_MS });
        assert.equal(direct.status, expectedStatus, `direct run of ${command}: ${direct.stderr}`);
        assert.equal(viaTrace.status, direct.status, `traced exit differs for ${command}`);
        assert.equal(viaTrace.stdout, direct.stdout, `traced stdout differs for ${command}`);
        assert.ok(parseTimedXtrace(viaTrace.stderr, NONCE).length > 0, 'the traced run produced no stamped commands');
      }
    } finally {
      cleanup(project);
    }
  });
});

describe('report', () => {
  test('the whole pipeline on a cheap command, with background load', { skip: needsBash }, () => {
    const cheap = [{ name: 'cheap conforming commit', command: 'git commit -m "feat: add thing"' }];
    const { text, ok } = report({ load: 1, top: 3 }, cheap);
    assert.equal(ok, true, text);
    assert.match(text, /^# validate-commit phase timing \(#5473\)/);
    assert.match(text, /background load: 1 process\(es\) forking node/);
    assert.match(text, /stamp overhead: [\d.]+ ms per traced command/);
    assert.match(text, /## cheap conforming commit/);
    assert.match(text, /untraced wall ms \(3 runs\): min \d+ \/ median \d+ \/ max \d+ \(last exit 0\)/);
    assert.match(text, /Elapsed per 50-line region/);
    assert.match(text, /\| hook line \| after ms \| before ms \|/);
  });

  test('with two scenarios it adds the first-vs-last median ratio', { skip: needsBash }, () => {
    const two = [
      { name: 'first', command: 'git commit -m "feat: a"' },
      { name: 'second', command: 'git commit -m "feat: b"' },
    ];
    const { text } = report({ load: 0, top: 1 }, two);
    assert.match(text, /untraced median: "first" \d+ ms vs "second" \d+ ms \(ratio /);
  });
});
