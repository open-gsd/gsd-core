'use strict';

/**
 * Platform-sensitive tests split out of tests/state.test.cjs (#5074).
 *
 * scripts/gen-platform-conformance-tier.cjs selects whole files for the real-OS
 * (Windows/macOS) conformance tier. The tests below carry the platform signal, so
 * they live here; tests/state.test.cjs stays signal-free and runs on Linux only.
 * Linux lanes run both files. Add a new platform-sensitive test HERE, not in the
 * base file — the generator fails if a split base regains a platform signal.
 *
 * Moved tests and why each needs a real OS:
 * - "(h) a SYMLINKED project path still resolves — repo pinning compares identity,
 *   not spelling" — creates a real symlink via fs.symlinkSync and asserts
 *   readStateHeadFreshness treats the symlinked path as the same repo; symlink
 *   creation/semantics differ under unprivileged Windows (symlink-keyword).
 * - "<flag> naming a FIFO is refused without blocking" (#4926, one per text-file
 *   flag) — creates a real FIFO with `mkfifo`; there is no FIFO on Windows
 *   (process-platform).
 * - "<flag> naming /dev/zero is refused without reading it" (#4926, one per
 *   text-file flag) — reads a real POSIX character device; Windows has none
 *   (process-platform).
 * - frontmatter set/merge on a STATE.md that is a symlink or a FIFO, and on state.md
 *   (#5120) — a real symlink, a real FIFO, and a name that is STATE.md only on a
 *   case-insensitive filesystem (symlink-keyword, process-platform, case-sensitivity).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('readStateHeadFreshness — property invariants (#2573)', () => {
  const { runGit } = require('./helpers/process-seam.cjs');
  const { after } = require('node:test');
  const { cleanup } = require('./helpers.cjs');
  const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');

  const propDirs = [];
  after(() => { while (propDirs.length) cleanup(propDirs.pop()); });

  test('(h) a SYMLINKED project path still resolves — repo pinning compares identity, not spelling', (t) => {
    // Guard against over-tightening (g). `git rev-parse --show-toplevel` reports
    // the REAL path while the project root arrives as the caller spelled it, and
    // those differ routinely: macOS temp dirs (/var/folders → /private/var/folders),
    // any symlinked checkout, Windows casing. A raw string compare would report a
    // perfectly normal project as unknown — the inverse of the bug (g) fixes, and
    // exactly what broke the macOS and Windows CI shards.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symreal-'));
    propDirs.push(realDir);
    const g = (argv) => runGit(argv, { cwd: realDir }).stdout;
    g(['init', '-q']); g(['config', 'user.email', 't@t.com']); g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(realDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(realDir, 'a.txt'), 'a\n');
    g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
    const head = g(['rev-parse', 'HEAD']).trim();

    const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2573-symlink-')), 'proj');
    propDirs.push(path.dirname(linkDir));
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {
      t.skip('symlink creation unavailable (e.g. unprivileged Windows) — nothing to assert');
      return;
    }

    const r = readStateHeadFreshness(linkDir, head);
    assert.strictEqual(r.commit_stale, false,
      'a symlinked project path is the SAME repo — it must resolve, not degrade to unknown');
    assert.strictEqual(r.commits_behind, 0);
  });
});

describe('#4926 text-file inputs: any readable file is accepted; every refusal exits non-zero', () => {
  const { beforeEach, afterEach } = require('node:test');
  const { runGsdTools, cleanup } = require('./helpers.cjs');
  const { createFixture } = require('./fixtures/index.cjs');
  const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');
  // A single `mkfifo` call creates the FIFO fixture.
  const { execFileSync } = require('node:child_process');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

  let tmpDir;
  let outsideDir;
  const stateBody = `# Project State

## Decisions
None yet.

## Blockers
None

## Roadmap Evolution
None
`;
  const statePath = () => path.join(tmpDir, '.planning', 'STATE.md');

  beforeEach(() => {
    tmpDir = createFixture();
    fs.writeFileSync(statePath(), stateBody);
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4926-outside-'));
  });

  afterEach(() => {
    cleanup(outsideDir);
    cleanup(tmpDir);
  });

  const flags = [
    { name: 'add-decision --summary-file', argv: (f) => ['state', 'add-decision', '--phase', '3', '--summary-file', f], flag: '--summary-file' },
    { name: 'add-decision --rationale-file', argv: (f) => ['state', 'add-decision', '--phase', '3', '--summary', 'Chosen', '--rationale-file', f], flag: '--rationale-file' },
    { name: 'add-blocker --text-file', argv: (f) => ['state', 'add-blocker', '--text-file', f], flag: '--text-file' },
    { name: 'add-roadmap-evolution --note-file', argv: (f) => ['state', 'add-roadmap-evolution', '--phase', '3', '--note-file', f], flag: '--note-file' },
  ];

  const assertRefused = (result, flag, why) => {
    assert.strictEqual(result.exitCode, 1, `refusal must exit non-zero; stdout: ${result.output}`);
    const envelope = JSON.parse(result.error);
    assert.strictEqual(envelope.reason, ERROR_REASON.USAGE);
    assert.ok(envelope.message.startsWith(`${flag} could not be read`), `refusal must name the flag; got: ${envelope.message}`);
    assert.ok(envelope.message.endsWith(`(${why})`), `refusal must say why; got: ${envelope.message}`);
    assert.strictEqual(fs.readFileSync(statePath(), 'utf-8'), stateBody, 'STATE.md must be byte-identical after a refusal');
  };

  for (const f of flags) {
    // Without the regular-file check, opening a FIFO with no writer blocks
    // forever and runGsdTools throws on the subprocess timeout.
    test(`${f.name} naming a FIFO is refused without blocking`, (t) => {
      if (process.platform === 'win32') {
        t.skip('no FIFOs on Windows');
        return;
      }
      const fifo = path.join(outsideDir, 'entry.fifo');
      // Throws when mkfifo fails, so on POSIX this row never passes without a FIFO.
      execFileSync('mkfifo', [fifo], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });

      assertRefused(runGsdTools([...f.argv(fifo), '--json-errors'], tmpDir), f.flag, 'not a regular file');
    });

    // /dev/zero never reaches EOF: an unbounded read exhausts memory.
    test(`${f.name} naming /dev/zero is refused without reading it`, (t) => {
      if (process.platform === 'win32') {
        t.skip('no /dev/zero on Windows');
        return;
      }

      assertRefused(runGsdTools([...f.argv('/dev/zero'), '--json-errors'], tmpDir), f.flag, 'not a regular file');
    });
  }
});

// #5120 (pre-push review R4-m2, R4-Q1).
describe('#5120 frontmatter set/merge refuse a STATE.md that is not a regular file', () => {
  const { runGsdTools, cleanup } = require('./helpers.cjs');
  const { execFileSync } = require('node:child_process');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const DOC = '---\nstatus: planning\n---\n\n# Project State\n';
  const commands = {
    set: (file) => ['frontmatter', 'set', file, '--field', 'status', '--value', 'executing'],
    merge: (file) => ['frontmatter', 'merge', file, '--data', '{"status":"executing"}'],
  };
  function tmp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fm-state-nonregular-'));
    t.after(() => cleanup(dir));
    return dir;
  }

  for (const [cmd, argsFor] of Object.entries(commands)) {
    test(`${cmd} on state.md takes no STATE.md lock: the match is the exact, case-sensitive basename`, (t) => {
      const stateMod = require('../gsd-core/bin/lib/state.cjs');
      const dir = tmp(t);
      fs.writeFileSync(path.join(dir, 'state.md'), DOC);
      let iterations = 0;
      stateMod._setStateLockTestHooks({ onLoopIteration: () => { iterations++; } });
      t.after(() => stateMod._resetStateLockTestHooks());
      const result = runGsdTools(argsFor(path.join(dir, 'state.md')), dir);
      assert.ok(result.success, `command failed: ${result.error}`);
      assert.strictEqual(iterations, 0, 'no STATE.md lock was attempted');
      assert.match(fs.readFileSync(path.join(dir, 'state.md'), 'utf-8'), /^status: executing$/m);
    });

    test(`${cmd} refuses a STATE.md that is a symlink, leaves the link and its target, and releases the lock`, (t) => {
      const dir = tmp(t);
      fs.writeFileSync(path.join(dir, 'REAL.md'), DOC);
      const state = path.join(dir, 'STATE.md');
      try { fs.symlinkSync(path.join(dir, 'REAL.md'), state); } catch (err) {
        // fs.symlinkSync needs a privilege on Windows; anywhere else a failure fails the row.
        if (process.platform === 'win32' && err.code === 'EPERM') { assert.strictEqual(process.platform, 'win32'); t.skip('no symlink privilege'); return; }
        throw err;
      }
      const result = runGsdTools(argsFor(state), dir);
      assert.strictEqual(result.success, false, 'the command refuses');
      assert.match(result.error, /is not a regular file/);
      assert.ok(fs.lstatSync(state).isSymbolicLink(), 'the link is left in place');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'REAL.md'), 'utf-8'), DOC, 'the target is unchanged');
      assert.strictEqual(fs.existsSync(`${state}.lock`), false, 'the lock is released');
    });

    test(`${cmd} refuses a STATE.md that is a FIFO without blocking, and releases the lock`, (t) => {
      if (process.platform === 'win32') { t.skip('no FIFOs on Windows'); return; }
      const dir = tmp(t);
      const state = path.join(dir, 'STATE.md');
      execFileSync('mkfifo', [state], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
      const result = runGsdTools(argsFor(state), dir);
      assert.strictEqual(result.success, false, 'the command refuses');
      assert.match(result.error, /is not a regular file/);
      assert.ok(fs.lstatSync(state).isFIFO(), 'the FIFO is left in place');
      assert.strictEqual(fs.existsSync(`${state}.lock`), false, 'the lock is released');
    });
  }
});
