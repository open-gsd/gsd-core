'use strict';

// Regression test for #2220: headless mempalace-capture instructed
// `mempalace mine <path> --wing <wing> --room <room>`, but `mine` has no
// --room flag (only `search` does). The fix replaced the flag with a
// detect_room()-based staging approach.
//
// Docs sources:
//   CLI reference:  https://mempalaceofficial.com/reference/cli.html
//   Mining guide:   https://mempalaceofficial.com/guide/mining.html
//   Config guide:   https://mempalaceofficial.com/guide/configuration.html

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
