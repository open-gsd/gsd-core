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
