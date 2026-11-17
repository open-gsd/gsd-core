'use strict';

/**
 * gsd-secret-read-guard.js — a regex escape is not a path separator (#5883)
 *
 * Seam: hooks/gsd-secret-read-guard.js, spawned with a PreToolUse JSON payload
 * on stdin. In a POSIX shell a quoted backslash reaches the program literally
 * and no POSIX path uses `\` as a separator, so the `\` of `\.env` inside a
 * quoted grep pattern must not make `.env` the "basename" of an operand. A
 * Windows-shaped token (drive prefix or UNC prefix) keeps the split, and the
 * Read and Grep-glob arms keep their backslash handling.
 *
 * Every assertion reads typed fields off the stdout JSON — never a regex over
 * the reason prose (CONTRIBUTING.md).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');
const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-secret-read-guard.js');

function runHook(payload) {
  const r = runHookSeam(HOOK_PATH, [], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
  });
  return { status: r.exitCode, stdout: r.stdout };
}

const read = (file_path) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } });
const grep = (tool_input) => ({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'KEY', ...tool_input } });
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

const PROPERTY_RUNS = { seed: 5883, numRuns: 40 };

function assertAllowed(r, label) {
  assert.equal(r.status, 0, `${label}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${label}: an allow must emit nothing on stdout`);
}

function assertBlocked(r, label) {
  assert.equal(r.status, 2, `${label}: expected block (exit 2), got exit ${r.status}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', label);
  assert.equal(out.code, 'secret-read', `${label}: code`);
  return out;
}

describe('gsd-secret-read-guard: a regex escape in a quoted operand is not a path separator (#5883)', () => {
  const allows = [
    // The three reporter commands (G1-G3) and the fourth, run-of-backslashes case.
    "grep -nE 'loadEnvFile|console\\.(log|error)\\(.*process\\.env' src/",
    "git diff --name-only HEAD~1 | grep -E 'migrations/|\\.env'",
    "git ls-files | grep -i 'data|\\.env'",
    "grep -n -E 'grep|--exclude|env-file|\\\\\\\\\\.env' tests/x.cjs",
    // Negative control and a lone escaped name: a POSIX word, not a file.
    "grep -E 'migrations/|\\.envx' list.txt",
    // A quoted word with a space is not a Windows path: the piece with the
    // escape carries a regex-only character.
    "grep -E 'foo bar|\\.env' list.txt",
    "grep 'x .env' list.txt",
    // A grep pattern operand is a name, not a file read (#5884), so a bare escape
    // there is allowed.
    "grep '\\.env' list.txt",
    "grep -E 'foo\\.env' list.txt",
  ];
  for (const cmd of allows) {
    test(`allows ${JSON.stringify(cmd)}`, () => {
      assertAllowed(runHook(bash(cmd)), cmd);
    });
  }

  const blocks = [
    'cat .env',
    'cat ./config/.env',
    'cat config/.env.local',
    'cat config/.secrets',
    // Windows-shaped tokens keep the backslash split, bare or quoted.
    "cat 'C:\\proj\\.env'",
    'cat "C:\\proj\\.env"',
    "cat '\\\\host\\share\\.env'",
    "cat < 'C:\\proj\\.env'",
    "source 'C:\\proj\\.env'",
    "grep KEY 'D:\\a\\b\\.secrets'",
    // Windows relative paths, bare or inside a command string handed to another
    // interpreter, are not a regex: they stay blocked.
    "cat '.\\.env'",
    "cat '..\\.env'",
    "cat 'config\\.env'",
    'powershell -c "type .\\.env"',
    'powershell -NoProfile -Command "Get-Content .\\.env | Select -First 1"',
    'cmd /c "type config\\.env"',
    // Fail-safe: a bare escape, or one whose word carries only characters legal
    // in a Windows name, is a Windows relative path as readily as a pattern.
    // (A grep pattern operand is a name, not a read, since #5884: see allows.)
    "cat 'config(1)\\.env'",
    "cat 'a+b\\.env'",
  ];
  for (const cmd of blocks) {
    test(`still blocks ${JSON.stringify(cmd)}`, () => {
      assertBlocked(runHook(bash(cmd)), cmd);
    });
  }

  // Parity: the other arms keep deliberate backslash handling.
  test('the Read arm still blocks a Windows path', () => {
    assertBlocked(runHook(read('C:\\proj\\.env')), 'Read C:\\proj\\.env');
  });
  test('the Grep glob arm still reduces config\\.env to .env', () => {
    assertBlocked(runHook(grep({ glob: 'config\\.env' })), 'Grep glob config\\.env');
  });

  // `|`, `*` and `?` never occur in a Windows file name, so a word carrying one
  // is a pattern and the `\` of its escape is not a separator. The metacharacter
  // sits before or after the escape, never between a drive prefix and the name.
  const META = fc.constantFrom('|', '*', '?');
  const DIR = fc.constantFrom('migrations/', 'src/', 'a/b/', '');
  test('property: a backslash escape in a quoted word with a regex-only character is never a separator', () => {
    fc.assert(fc.property(DIR, META, fc.constantFrom('', 'x', 'data'), fc.boolean(), (dir, meta, alt, metaFirst) => {
      const word = metaFirst ? `${dir}${alt}${meta}\\.env` : `${dir}\\.env${meta}${alt}`;
      const cmd = `grep -E '${word}' list.txt`;
      assertAllowed(runHook(bash(cmd)), cmd);
    }), PROPERTY_RUNS);
  });

  // Parity table: the SAME path run through each arm. Bash differs from Read
  // and Grep on purpose for a regex escape, and only for it.
  const PARITY = [
    // [name, bash command, Read path or null, Grep glob or null, bash blocks, other arm blocks]
    ['drive path', "cat 'C:\\proj\\.env'", 'C:\\proj\\.env', 'C:\\proj\\.env', true, true],
    ['relative escape', "cat 'config\\.env'", 'config\\.env', 'config\\.env', true, true],
    ['regex escape with alternation', "grep -E 'a|\\.env' f", 'a|\\.env', 'a|\\.env', false, true],
    ['plain relative', 'cat config/.env', 'config/.env', 'config/.env', true, true],
  ];
  for (const [name, cmd, readPath, glob, bashBlocks, otherBlocks] of PARITY) {
    test(`parity: ${name}`, () => {
      (bashBlocks ? assertBlocked : assertAllowed)(runHook(bash(cmd)), `Bash ${cmd}`);
      (otherBlocks ? assertBlocked : assertAllowed)(runHook(read(readPath)), `Read ${readPath}`);
      (otherBlocks ? assertBlocked : assertAllowed)(runHook(grep({ glob })), `Grep glob ${glob}`);
    });
  }

  test('property: a Windows-shaped quoted token keeps the backslash split', () => {
    const DRIVE = fc.constantFrom('C', 'D', 'z', 'E');
    const SEG = fc.constantFrom('proj', 'a', 'config', 'x y');
    fc.assert(fc.property(DRIVE, fc.array(SEG, { maxLength: 3 }), fc.constantFrom('.env', '.env.local', '.secrets'), (drive, dirs, name) => {
      const cmd = `cat '${drive}:\\${[...dirs, name].join('\\')}'`;
      assertBlocked(runHook(bash(cmd)), cmd);
    }), PROPERTY_RUNS);
  });
});
