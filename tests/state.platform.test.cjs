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
