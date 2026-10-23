/**
 * #5482: `milestone complete --confirm` is the one-way door, so the engine
 * re-checks every blocking `ship:pre` predicate gate against each milestone
 * phase directory and refuses. Fixture capability is an ACTIVE overlay cap (no
 * consent gate, no activation key) under a clean HOME/XDG so the user's real
 * capabilities cannot leak in.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, createTempDir, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROADMAP = '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Build\n**Goal:** Build\n';

function writeGateCap(home, { command, predicate, blocking = true, onError = 'halt', gates }) {
  const capDir = path.join(home, '.gsd', 'capabilities', 'open-work');
  fs.mkdirSync(capDir, { recursive: true });
  fs.writeFileSync(path.join(capDir, 'capability.json'), JSON.stringify({
    id: 'open-work', role: 'feature', version: '1.0.0', title: 'Open Work',
    description: '#5482 engine backstop fixture', tier: 'standard', requires: [],
    engines: { gsd: '>=0.0.0' }, runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [],
    gates: (gates ?? [{ check: { predicate: predicate ?? { kind: 'command-exit-zero', command } }, blocking, onError }])
      .map((g) => ({ point: 'ship:pre', ...g })),
  }));
}

describe('milestone complete re-checks blocking ship:pre predicate gates per milestone phase (#5482)', () => {
  let tmpDir;
  let home;
  const env = () => ({
    HOME: home, GSD_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
  });
  const complete = (extra = '') =>
    runGsdTools(`--json-errors milestone complete v1.0 --name MVP --confirm ${extra}`, tmpDir, env());
  const dryRun = () => runGsdTools('milestone complete v1.0 --name MVP --dry-run', tmpDir, env());
  const archived = () => fs.existsSync(path.join(tmpDir, '.planning', 'milestones'));
  const parseErr = (r) => JSON.parse(r.error.trim().split('\n').pop());
  const phaseDir = (name) => path.join(tmpDir, '.planning', 'phases', name);
  const snapshot = () => fs.readdirSync(tmpDir, { recursive: true }).sort()
    .map((p) => [p, fs.statSync(path.join(tmpDir, p)).isFile() ? fs.readFileSync(path.join(tmpDir, p), 'utf-8') : null]);

  beforeEach(() => {
    tmpDir = createTempProject();
    home = createTempDir('gsd-5482-home-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n\n**Status:** In progress\n');
    fs.mkdirSync(phaseDir('01-foundation'), { recursive: true });
    fs.mkdirSync(phaseDir('02-build'), { recursive: true });
  });
  afterEach(() => { cleanup(tmpDir); cleanup(home); });

  test('T-C8 blocking predicate exit 3 refuses with typed reason and mutates nothing', () => {
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 01 || { echo 2 open items >&2; exit 3; }' });
    const before = snapshot();
    const r = complete();
    assert.equal(r.success, false);
    const err = parseErr(r);
    assert.equal(err.reason, ERROR_REASON.MILESTONE_GATE_BLOCKED);
    assert.deepEqual(err.blocked, [{ cap_id: 'open-work', phase: '01', gate_message: 'command exited 3: 2 open items' }]);
    assert.match(err.message, /"open-work" \(phase "01"\): "command exited 3: 2 open items"/);
    assert.match(err.message, /Nothing has been changed\. Resolve or waive in that capability; --force does not bypass it\.$/);
    assert.deepEqual(snapshot(), before, 'a refused close must leave the project tree byte-identical');
  });

  for (const [title, cap] of [['passing', { command: 'exit 0' }], ['non-blocking failing', { command: 'exit 1', blocking: false }]]) {
    test(`T-C9 ${title} gate archives`, () => {
      writeGateCap(home, cap);
      assert.equal(complete().success, true);
      assert.equal(archived(), true);
    });
  }

  test('T-C11 malformed predicate: onError halt refuses, skip archives with warning', () => {
    writeGateCap(home, { predicate: { kind: 'command-exit-zero' } });
    const halted = complete();
    assert.equal(halted.success, false);
    const err = parseErr(halted);
    assert.equal(err.reason, ERROR_REASON.MILESTONE_GATE_BLOCKED);
    assert.equal(err.blocked[0].gate_message, 'gate predicate could not be evaluated: command-exit-zero predicate requires a non-empty string "command"');
    assert.equal(archived(), false);

    writeGateCap(home, { predicate: { kind: 'command-exit-zero' }, onError: 'skip' });
    const skipped = runNode(
      [TOOLS_PATH, 'milestone', 'complete', 'v1.0', '--name', 'MVP', '--confirm'],
      { cwd: tmpDir, env: { ...process.env, ...env() }, timeoutMs: PROBE_TIMEOUT_MS },
    );
    assert.equal(skipped.exitCode, 0, skipped.stderr);
    assert.match(skipped.stderr, /warning: ship:pre gate of "open-work" skipped for phase "01"/);
    assert.equal(archived(), true);
  });

  test('T-C12 --dry-run with failing gate exits 0, mutates nothing, and previews the refusal', () => {
    writeGateCap(home, { command: 'exit 3' });
    const r = dryRun();
    assert.equal(r.success, true, r.error);
    assert.equal(archived(), false);
    assert.deepEqual(JSON.parse(r.output).would_refuse, [
      { cap_id: 'open-work', phase: '01', gate_message: 'command exited 3' },
      { cap_id: 'open-work', phase: '02', gate_message: 'command exited 3' },
    ]);
  });

  test('T-C12b --dry-run with passing gate previews no refusal', () => {
    writeGateCap(home, { command: 'exit 0' });
    assert.deepEqual(JSON.parse(dryRun().output).would_refuse, []);
  });

  test('T-C13 --force never bypasses a blocking gate (#3726 AC4)', () => {
    writeGateCap(home, { command: 'exit 3' });
    const r = complete('--force');
    assert.equal(r.success, false);
    assert.equal(parseErr(r).reason, ERROR_REASON.MILESTONE_GATE_BLOCKED);
    assert.equal(archived(), false);
  });

  test('T-C14 control characters in gate output are escaped in the refusal', () => {
    writeGateCap(home, { command: "printf '\\033[31mred\\nError: forged' >&2; exit 1" });
    const r = runGsdTools('milestone complete v1.0 --name MVP --confirm', tmpDir, env());
    assert.equal(r.success, false);
    assert.ok(!r.error.includes('\x1b'), 'raw ESC must not reach stderr');
    assert.equal(r.error.trim().split('\n').length, 1, 'newline in gate output must not forge a second line');
  });

  test('T-C15 query-kind blocking gate is prose-only: the engine ignores it', () => {
    writeGateCap(home, { gates: [{ check: { query: 'status' }, blocking: true, onError: 'halt' }] });
    assert.equal(complete().success, true);
    assert.equal(archived(), true);
  });

  test('T-C16 several gates: an advisory pass then a blocking failure still refuses', () => {
    writeGateCap(home, { gates: [
      { check: { predicate: { kind: 'command-exit-zero', command: 'exit 0' } }, blocking: false, onError: 'skip' },
      { check: { predicate: { kind: 'command-exit-zero', command: 'exit 3' } }, blocking: true, onError: 'halt' },
    ] });
    const r = complete();
    assert.equal(r.success, false);
    assert.equal(parseErr(r).reason, ERROR_REASON.MILESTONE_GATE_BLOCKED);
    assert.equal(archived(), false);
  });

  test('T-C17 artifact-frontmatter-equals resolves against each phase dir', () => {
    fs.writeFileSync(path.join(phaseDir('01-foundation'), '01-OPEN-WORK.md'), '---\nstatus: open\n---\n');
    fs.writeFileSync(path.join(phaseDir('02-build'), '02-OPEN-WORK.md'), '---\nstatus: closed\n---\n');
    writeGateCap(home, { predicate: { kind: 'artifact-frontmatter-equals', artifact: 'OPEN-WORK.md', field: 'status', equals: 'closed' } });
    const r = complete();
    assert.equal(r.success, false);
    assert.deepEqual(parseErr(r).blocked.map((b) => b.phase), ['01']);
    fs.writeFileSync(path.join(phaseDir('01-foundation'), '01-OPEN-WORK.md'), '---\nstatus: closed\n---\n');
    assert.equal(complete().success, true);
  });

  test('T-C18 default security_enforcement + enabled broken-windows without artifacts do not refuse (ship.md step 6 owns them)', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ workflow: { windows_enforce: true } }));
    assert.deepEqual(JSON.parse(dryRun().output).would_refuse, []);
    assert.equal(complete().success, true);
    assert.equal(archived(), true);
  });

  test('T-C19 a phase directory outside the milestone is not evaluated', () => {
    fs.mkdirSync(phaseDir('05-later'), { recursive: true });
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 05' });
    assert.deepEqual(JSON.parse(dryRun().output).would_refuse, []);
    assert.equal(complete().success, true);
  });

  test('T-C20 two blocked phases both appear in the error details and in would_refuse', () => {
    writeGateCap(home, { command: 'echo open >&2; exit 3' });
    const expected = ['01', '02'].map((phase) => ({ cap_id: 'open-work', phase, gate_message: 'command exited 3: open' }));
    assert.deepEqual(JSON.parse(dryRun().output).would_refuse, expected);
    const err = parseErr(complete());
    assert.deepEqual(err.blocked, expected);
    assert.match(err.message, /"open-work" \(phase "01"\): .*; "open-work" \(phase "02"\): /);
  });

  test('T-C21 ${PHASE_NUMBER} and ${PHASE_DIR} interpolate per phase', () => {
    writeGateCap(home, { command: 'echo "${PHASE_NUMBER}|${PHASE_DIR}" >&2; exit 3' });
    const blocked = JSON.parse(dryRun().output).would_refuse;
    assert.deepEqual(blocked.map((b) => b.phase), ['01', '02']);
    for (const [b, dir] of [[blocked[0], '01-foundation'], [blocked[1], '02-build']]) {
      const [num, dirArg] = b.gate_message.replace(/^command exited 3: /, '').split('|');
      assert.equal(num, b.phase);
      assert.ok(path.isAbsolute(dirArg), dirArg);
      assert.ok(dirArg.endsWith(path.join('.planning', 'phases', dir)), dirArg);
    }
  });

  test('T-C22 TRUNCATED window with --force widens the gated set to every phase dir on disk', () => {
    // Heading found but its section ends before the phase entries (#3166): --force overrides the
    // scope refusal and the filter degrades to pass-all, so the backstop gates every directory.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.0 MVP\n\nNotes.\n\n## v2.0 Next\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Build\n**Goal:** Build\n');
    fs.mkdirSync(phaseDir('05-later'), { recursive: true });
    writeGateCap(home, { command: 'test "${PHASE_NUMBER}" != 05' });
    assert.match(complete().error, /the ROADMAP window for .*v1\.0.* is truncated/, 'fixture must be TRUNCATED');
    const r = complete('--force');
    assert.equal(r.success, false, r.output);
    assert.deepEqual(parseErr(r).blocked.map((b) => b.phase), ['05']);
  });
});
