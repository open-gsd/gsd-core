'use strict';

// Regression test for #2220: headless mempalace-capture instructed
// `mempalace mine <path> --wing <wing> --room <room>`, but `mine` has no
// --room flag (only `search` does). The fix replaced the flag with a
// detect_room()-based staging approach.
//
// #2414 extension: the staging block also embeds a `rooms:` YAML example.
// mempalace's miner (`detect_room()` and `_mine_impl`) requires each entry
// to be a DICT with at least a `name` key — a bare-string list crashes the
// first `mine` invocation with `TypeError: string indices must be integers,
// not 'str'`. The fix converts each `- <room>` to `- name: <room>`.
//
// Docs sources:
//   CLI reference:  https://mempalaceofficial.com/reference/cli.html
//   Mining guide:   https://mempalaceofficial.com/guide/mining.html
//   Config guide:   https://mempalaceofficial.com/guide/configuration.html

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { runHook, assertSeamExit } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.resolve(__dirname, '..');

const SKILL_FILES = [
  'skills/gsd-mempalace-capture/SKILL.md',
  'commands/gsd/mempalace-capture.md',
];

// Matches actual shell command lines that invoke `mempalace mine`
// (line starts with optional whitespace + "mempalace mine").  Excludes
// prose/instruction text that merely mentions the command.
const MINE_CMD_RE = /^\s*mempalace\s+mine\b/;

describe('#2220 — headless mempalace mine has no --room flag', () => {
  for (const rel of SKILL_FILES) {
    test(`${rel}: no "mine ... --room" command line`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const mineCmdLines = content
        .split(/\r?\n/)
        .filter((l) => MINE_CMD_RE.test(l));
      for (const line of mineCmdLines) {
        assert.doesNotMatch(
          line,
          /--room/,
          `${rel}: "mempalace mine" command must not include --room (mine has no such flag per CLI reference). Offending line: ${line.trim()}`,
        );
      }
    });

    test(`${rel}: staging instructions present (mempalace.yaml + detect_room)`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(content.includes('mempalace.yaml'), `${rel}: must reference mempalace.yaml for room taxonomy`);
      assert.ok(content.includes('detect_room'), `${rel}: must reference detect_room() as the room-assignment mechanism`);
      assert.ok(content.includes('.mempalace-stage'), `${rel}: must use the .mempalace-stage staging directory`);
    });
  }

  test('capture-problems.md: references detect_room staging, not mine --room', () => {
    const rel = 'capabilities/mempalace/fragments/capture-problems.md';
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const mineCmdLines = content
      .split(/\r?\n/)
      .filter((l) => MINE_CMD_RE.test(l));
    for (const line of mineCmdLines) {
      assert.doesNotMatch(
        line,
        /--room/,
        `${rel}: "mempalace mine" command must not include --room. Offending line: ${line.trim()}`,
      );
    }
  });

  test('.gitignore: .mempalace-stage/ is excluded', () => {
    const content = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(content.includes('.mempalace-stage/'), '.gitignore must exclude .planning/.mempalace-stage/');
  });
});

// ─── #2414: rooms: entries MUST be dicts with a `name` key ───────────────────
//
// The skill files embed a `rooms:` YAML example inside a bash heredoc. The
// miner's `detect_room()` and `_mine_impl` index `room["name"]` — a bare-string
// list crashes the first `mine` invocation with
// `TypeError: string indices must be integers, not 'str'`.
//
// This describe block extracts the YAML block from each file, parses it with
// js-yaml, and asserts every entry under `rooms:` is a dict carrying a `name`
// key. It also forbids the pre-fix shape (`- decisions` etc.) so a future
// reversion can't slip back in silently.

describe('#2414 — rooms: entries are dicts with a name key (not bare strings)', () => {
  // Extract the YAML `rooms:` block from a markdown file. The block lives
  // inside a bash heredoc that ends with `YAML` on its own line. We capture
  // from the line beginning with `rooms:` through the closing `YAML` sentinel.
  function extractRoomsYaml(content) {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*rooms:\s*$/.test(l));
    if (start === -1) return null;
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
      // The heredoc terminator in the embedded bash is `YAML` on its own line
      // (possibly with leading whitespace from the markdown fence indentation).
      if (/^\s*YAML\s*$/.test(lines[i])) { end = i; break; }
    }
    if (end === -1) return null;
    return lines.slice(start, end).join('\n');
  }

  for (const rel of SKILL_FILES) {
    test(`${rel}: every rooms: entry is a dict with a \`name\` key`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const yamlBlock = extractRoomsYaml(content);
      assert.ok(yamlBlock, `${rel}: could not locate a rooms: YAML block`);
      const parsed = yaml.load(yamlBlock);
      assert.ok(parsed && Array.isArray(parsed.rooms), `${rel}: rooms: must parse to an array`);
      assert.ok(parsed.rooms.length >= 5, `${rel}: expected the GSD room taxonomy (≥5 rooms), got ${parsed.rooms.length}`);
      for (const [i, entry] of parsed.rooms.entries()) {
        assert.ok(
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
          `${rel}: rooms:[${i}] must be a dict, got ${JSON.stringify(entry)} (a bare-string list crashes mempalace miner's detect_room with TypeError: string indices must be integers — #2414)`,
        );
        assert.ok(
          typeof entry.name === 'string' && entry.name.length > 0,
          `${rel}: rooms:[${i}] must have a non-empty name string, got ${JSON.stringify(entry)}`,
        );
      }
    });

    test(`${rel}: no bare-string rooms: entries remain (forbid the pre-fix shape)`, () => {
      // Direct guard against the pre-fix shape — any line under rooms: that
      // matches `^- <word>$` (no colon) is the broken form. Belt-and-suspenders
      // alongside the parse-and-shape check above; keeps the assertion readable
      // when the YAML parser is removed/refactored in the future.
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const yamlBlock = extractRoomsYaml(content);
      assert.ok(yamlBlock, `${rel}: could not locate a rooms: YAML block`);
      const bareStringEntries = yamlBlock
        .split(/\r?\n/)
        .filter((l) => /^\s*-\s+[A-Za-z][A-Za-z0-9_-]*\s*$/.test(l));
      assert.strictEqual(
        bareStringEntries.length,
        0,
        `${rel}: rooms: must not contain bare-string entries (crashes mempalace miner — #2414). Offenders: ${JSON.stringify(bareStringEntries)}`,
      );
    });
  }
});

// ── #4700 / #6266 — a locked palace never drops the capture silently, and a capture never starts the
// daemon. #4700 queued the headless mine with --daemon --background; on MemPalace 3.12 that flag
// AUTO-STARTS a daemon which holds the palace writer lock for its whole life and blocks every MCP
// write tool (#6266). The daemon route is now used only when a daemon is already running; otherwise
// a plain mine is retried with bounded backoff and a final failure is reported.

describe('#4700 / #6266 — headless mine: daemon only when running, bounded retry otherwise', () => {
  const SURFACES = [
    'commands/gsd/mempalace-capture.md',
    'skills/gsd-mempalace-capture/SKILL.md',
  ];

  // The shipped snippet: from the #6266 comment to the `fi` that closes the daemon guard, one list-indent removed.
  function snippetOf(rel) {
    const lines = splitLines(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const from = lines.findIndex((l) => l.includes('#6266: use the daemon route only when'));
    assert.ok(from !== -1, `${rel}: the #6266 daemon-route comment must be present`);
    const to = lines.findIndex((l, i) => i > from && /^\s*fi\s*$/.test(l));
    assert.ok(to !== -1, `${rel}: the daemon guard must be closed by fi`);
    return lines.slice(from, to + 1).map((l) => l.replace(/^ {3}/, '')).join('\n').replaceAll('<wing>', 'w');
  }

  // `mempalace` is a stub that logs every call: `daemon status` answers DAEMON_RC, and `mine` exits MINE_RC
  // (1 = a held lock) for its first MINE_FAILS calls. `sleep` logs its delay so the backoff is visible.
  function runCapture(rel, { daemonRc, mineFails, mineRc = 1 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6266-'));
    const log = path.join(dir, 'calls.log');
    const script = [
      'STAGE=/stage',
      'sleep() { printf "sleep %s\\n" "$1" >> "$CALL_LOG"; }',
      'mempalace() { printf "%s\\n" "$*" >> "$CALL_LOG"; case "$1" in',
      '  daemon) return "$DAEMON_RC";;',
      '  mine) if [ "$(grep -c "^mine " "$CALL_LOG")" -gt "$MINE_FAILS" ]; then return 0; else return "$MINE_RC"; fi;;',
      'esac; }',
      snippetOf(rel),
    ].join('\n');
    try {
      const res = runHook('-c', [script], {
        interpreter: 'bash',
        env: { ...process.env, CALL_LOG: log, DAEMON_RC: String(daemonRc), MINE_FAILS: String(mineFails), MINE_RC: String(mineRc) },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const calls = fs.existsSync(log) ? splitLines(fs.readFileSync(log, 'utf8')).filter(Boolean) : [];
      return { res, calls, mines: calls.filter((c) => c.startsWith('mine ')), sleeps: calls.filter((c) => c.startsWith('sleep ')) };
    } finally {
      cleanup(dir);
    }
  }

  for (const rel of SURFACES) {
    test(`${rel}: a running daemon is used (--daemon --background) and nothing else is mined`, () => {
      const { res, calls, mines } = runCapture(rel, { daemonRc: 0, mineFails: 0 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(calls, ['daemon status', 'mine /stage --wing w --daemon --background']);
      assert.equal(mines.length, 1);
    });

    test(`${rel}: with no daemon running a plain mine runs and the daemon is never started`, () => {
      const { res, calls, mines } = runCapture(rel, { daemonRc: 1, mineFails: 0 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(mines, ['mine /stage --wing w --direct'], 'a plain mine would follow a prefer/require policy and start the daemon');
      assert.ok(!calls.some((c) => c.includes('--daemon') || c.startsWith('daemon start')), 'no daemon may be started');
      assert.doesNotMatch(res.stdout, /skipped/);
    });

    test(`${rel}: a held lock is retried at limit-1, limit and limit+1 failures, then reported, never silent`, () => {
      // Three attempts: two failures still file the capture, three or more are reported.
      const recovered = runCapture(rel, { daemonRc: 1, mineFails: 2 });
      assert.equal(recovered.mines.length, 3, 'limit-1 failures: the third attempt files it');
      assert.doesNotMatch(recovered.res.stdout, /skipped/);
      for (const fails of [3, 4]) {
        const lost = runCapture(rel, { daemonRc: 1, mineFails: fails });
        assertSeamExit(assert, lost.res, 0, 'a skipped capture never fails the step (onError: skip)');
        assert.equal(lost.mines.length, 3, `${fails} failures: still exactly three attempts`);
        assert.match(lost.res.stdout, /MemPalace capture skipped — palace locked/);
        assert.ok(!lost.calls.some((c) => c.includes('--daemon')), 'the daemon is not started as a fallback');
        assert.deepEqual(lost.sleeps, ['sleep 1', 'sleep 2'], 'no sleep after the final failure');
      }
    });

    test(`${rel}: a failure that is not a held lock is reported as that, at once, without retries`, () => {
      for (const mineRc of [2, 127]) {
        const { res, mines, sleeps } = runCapture(rel, { daemonRc: 1, mineFails: 9, mineRc });
        assertSeamExit(assert, res, 0, 'a skipped capture never fails the step (onError: skip)');
        assert.equal(mines.length, 1, `exit ${mineRc}: not retried`);
        assert.equal(sleeps.length, 0);
        assert.match(res.stdout, new RegExp(`MemPalace capture skipped — mine failed \\(exit ${mineRc}\\)`));
        assert.doesNotMatch(res.stdout, /palace locked/);
      }
    });

    test(`${rel}: a CLI without the daemon subcommand (probe exit 2) gets a plain mine, retried like any other`, () => {
      const { res, mines } = runCapture(rel, { daemonRc: 2, mineFails: 1 });
      assertSeamExit(assert, res, 0, 'the snippet must run to completion');
      assert.deepEqual(mines, ['mine /stage --wing w', 'mine /stage --wing w']);
    });

    test(`${rel}: every mempalace mine line sits inside the daemon guard, and the report names queued and skipped captures`, () => {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const mineLines = splitLines(content).filter((l) => MINE_CMD_RE.test(l));
      assert.equal(mineLines.length, 2, 'one guarded daemon mine and one plain mine');
      assert.equal(snippetOf(rel).split('\n').filter((l) => MINE_CMD_RE.test(l)).length, 2);
      assert.match(content, /queued/);
      assert.match(content, /skipped/i);
      assert.match(content, /interactive run must never start the daemon/);
    });
  }

  test('the execute:post problems fragment takes the same daemon route and never starts a daemon (#6266)', () => {
    const frag = 'capabilities/mempalace/fragments/capture-problems.md';
    const content = fs.readFileSync(path.join(ROOT, frag), 'utf8');
    assert.match(content, /`--daemon --background` only when `mempalace daemon status` already reports a running daemon, never starting one/);
    assert.doesNotMatch(content, /the background queue defers the write/, 'the queue claim is true only with a running daemon');
    assert.doesNotMatch(content, /mempalace mine --daemon --background/, 'the unconditional daemon invocation must not return');
  });
});
