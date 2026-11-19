'use strict';

/**
 * gsd-secret-read-guard.js — pattern, exclusion and program operands (#5884)
 *
 * Seam: hooks/gsd-secret-read-guard.js, spawned with a PreToolUse JSON payload
 * on stdin. A search pattern, the value of an exclusion option and a jq program
 * are names or code, never files the command opens, so a secret-looking value
 * in one of those positions is allowed. Every operand the command does open is
 * still checked, and an option the guard does not know withdraws the carve-out
 * for the whole segment.
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

const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

const PROPERTY_RUNS = { seed: 5884, numRuns: 40 };

function assertAllowed(command) {
  const r = runHook(bash(command));
  assert.equal(r.status, 0, `${command}: expected allow (exit 0), got exit ${r.status}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${command}: an allow must emit nothing on stdout`);
}

function assertBlocked(command) {
  const r = runHook(bash(command));
  assert.equal(r.status, 2, `${command}: expected block (exit 2), got exit ${r.status}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', command);
  assert.equal(out.code, 'secret-read', `${command}: code`);
}

describe('gsd-secret-read-guard: pattern, exclusion and program operands (#5884)', () => {
  const allows = [
    // G4: the first positional of the grep family is the pattern.
    "grep -n 'packages/db/.env.local' src/setup.ts",
    "egrep -n 'a|.env.local' src/setup.ts",
    "fgrep -n '.env.local' src/setup.ts",
    'grep -n "packages/db/config.local" src/setup.ts',
    // A value-taking option before the pattern must be skipped, not mistaken for it.
    "grep -m 1 '.env.local' f",
    "grep -A 2 -n '.env.local' f",
    // G5: the value of an exclusion option is a name to skip.
    'grep -rn -i token . --exclude=.env',
    'grep -rn -i token . --exclude .env',
    'grep -rn token . --exclude-dir=.env --exclude=.env.local',
    // G6 (maintainer decision on #5884): the jq program is not a file.
    "jq '.env.DISABLE_AUTOUPDATER' settings.json",
    "jq '.env' file.json",
    "jq -r '.env' file.json",
    "jq -n '.env.X'",
    "jq -rc '.env' file.json",
    // ripgrep: a NEGATED --glob / -g / --iglob value and the pattern positional.
    "rg -g '!.env' token .",
    "rg --glob='!.env' token .",
    "rg --iglob '!.env.local' token .",
    "rg '.env.local' src",
    // xargs hands the same sub-command words to the same carve-out.
    'ls | xargs grep -n token --exclude=.env',
  ];
  for (const cmd of allows) {
    test(`allows ${JSON.stringify(cmd)}`, () => assertAllowed(cmd));
  }

  const blocks = [
    // A real read remains in the segment.
    'grep -rn token . --exclude=.env .env.local',
    'grep pat .env',
    "grep '.env.local' .env",
    'grep KEY .env.local',
    // A pattern file is read: these were deny rows before and stay deny rows.
    'grep -f .env x',
    'grep -f.env pat f',
    'grep -if.env pat f',
    'grep -nif.env pat f',
    'grep -2f.env pat f',
    'grep -2.env pat f',
    'grep --file=.env x',
    'grep --file .env x',
    'rg -f .env x',
    'egrep -f .env x',
    // -e / --regexp supplies the pattern, so the first positional is a file.
    'grep -e pat .env',
    'grep --regexp=pat .env',
    'rg -e pat .env',
    // rg's -r takes a replacement value, so the word after it is not the pattern.
    "rg -r '.env' src",
    // An unknown option withdraws the carve-out for the segment. `-C` is one:
    // BSD grep's optional number would make `.env` a file there.
    'grep -C 3 .env',
    'grep --context 3 .env',
    'grep --frob .env x',
    'grep -Y .env x',
    'rg --frob token .env',
    // A selector READS the file it names: `--include` and a non-negated glob
    // restrict the search to `.env`, so the value is an ordinary operand.
    "grep -rn '' . --include=.env",
    'grep -rn token --include .env.local .',
    'grep -rn token . --include-dir=.env',
    "rg -g .env '' .",
    "rg -g.env '' .",
    "rg --glob=.env '' .",
    "rg --glob .env '' .",
    'rg --iglob .env token .',
    // exclude-from reads the file.
    'grep --exclude-from=.env pat f',
    'grep --exclude-from .env pat f',
    // jq: file operands, program files and file-valued options stay checked.
    'jq . .env',
    'jq -f .env',
    'jq --from-file .env',
    "jq --slurpfile v .env '.'",
    "jq --rawfile v .env '.'",
    "jq -n --arg x .env '.'",
    "jq '.env' .env",
    // xargs does not widen the carve-out to other commands.
    'xargs grep token --exclude=.env .env.local',
    'xargs cp src .env',
  ];
  for (const cmd of blocks) {
    test(`still blocks ${JSON.stringify(cmd)}`, () => assertBlocked(cmd));
  }

  const NAME = fc.constantFrom('.env', '.env.local', '.secrets', 'config/.env.production');
  const EXCLUDE_OPT = fc.constantFrom('--exclude', '--exclude-dir');
  const FORM = fc.constantFrom('=', ' ');
  const SAFE_FLAGS = fc.constantFrom('', '-r ', '-n ', '-rn ', '-i ', '-m 1 ', '-A 2 ');

  test('property: an exclusion value is a name; a real read after it is still blocked', () => {
    fc.assert(fc.property(EXCLUDE_OPT, FORM, NAME, SAFE_FLAGS, (opt, form, name, flags) => {
      assertAllowed(`grep ${flags}token . ${opt}${form}${name}`);
      assertBlocked(`grep ${flags}token . ${opt}${form}${name} .env`);
      assertBlocked(`grep ${flags}token ${opt}${form}${name} ${name}`);
    }), PROPERTY_RUNS);
  });

  test('property: the pattern positional is exempt only while no option supplies the pattern', () => {
    fc.assert(fc.property(NAME, SAFE_FLAGS, fc.constantFrom('grep', 'egrep', 'fgrep', 'rg'), (name, flags, tool) => {
      // rg's `-r` takes a replacement VALUE (grep's means recursive), so the
      // quoted word after it is that value and stays checked.
      const safe = tool === 'rg' ? flags.replace(/-rn? /, '') : flags;
      assertAllowed(`${tool} ${safe}'${name}' src`);
      assertBlocked(`${tool} ${safe}'${name}' ${name}`);
      assertBlocked(`${tool} ${safe}-e pat ${name}`);
    }), PROPERTY_RUNS);
  });

  test('property: a jq program is exempt, every file operand is not', () => {
    fc.assert(fc.property(NAME, fc.constantFrom('', '-r ', '-n ', '-rc '), (name, flags) => {
      assertAllowed(`jq ${flags}'.env.X' file.json`);
      assertBlocked(`jq ${flags}'.x' ${name}`);
    }), PROPERTY_RUNS);
  });
});
