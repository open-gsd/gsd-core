#!/usr/bin/env node
// Regenerate the per-file test timing table used to weight chunk packing in
// scripts/run-tests.cjs (issue #2456).
//
// The chunk packer needs to know what each test file actually COSTS. Before
// #2456 it guessed from the filename (`^(?:install|codex-)` scored 12x,
// everything else 1) and was wrong in both directions — installer-migration-
// authoring.test.cjs scored 12x but runs ~0.1s, while the two heaviest files in
// the suite (run-tests-harness.test.cjs and release-tarball-smoke.install
// .test.cjs) both scored 1. This script replaces the guess with measurement.
//
// Input is one or more node:test reporter event streams as emitted by
// `gsd-test` (`~/.local/state/gsd-test/runs/<run-id>/test-events-<os>-node<v>
// .jsonl`). Each stream carries one `test:summary` event per test FILE, whose
// `data.duration_ms` is that file's total wall-clock and whose `data.file` is
// its absolute in-container path.
//
// Usage:
//   node scripts/gen-test-timings.cjs <events.jsonl> [<events.jsonl> ...]
//   node scripts/gen-test-timings.cjs ~/.local/state/gsd-test/runs/*/test-events-*.jsonl
//   node scripts/gen-test-timings.cjs events.jsonl --out tests/test-timings.json
//
// When several streams are supplied (multiple lanes, e.g. node22 + node24), a
// file's recorded time is the MAX across them, not the mean: the packer exists
// to keep the SLOWEST lane's slowest chunk away from the per-chunk timeout, so
// the conservative bound is the right one to balance against.
//
// The table is ADVISORY and deliberately un-gated — there is no `--check` mode
// and no CI lint that fails on staleness, because timing data legitimately
// varies run to run. A file missing from the table falls back to the table's
// median weight, so a stale table degrades chunk BALANCE gracefully instead of
// failing the build. Regenerate it when the suite's cost profile has visibly
// drifted, not on a schedule.
'use strict';

const fs = require('fs');
const { basename, dirname, join } = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const DEFAULT_OUT = join(__dirname, '..', 'tests', 'test-timings.json');
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const inputs = [];
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (!value) return { error: '--out requires a path' };
      out = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) return { error: '--out requires a path' };
      out = value;
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag "${arg}"` };
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) {
    return { error: 'usage: gen-test-timings.cjs <reporter-events.jsonl> [...] [--out <path>]' };
  }
  return { inputs, out };
}

// Fold one reporter event stream into `acc`, keeping the MAX duration seen for
// each test file. Returns per-stream counters for the summary line.
//
// Keying is by BASENAME, matching how run-tests.cjs weights a selected file:
// the reporter reports absolute in-container paths (/work/tests/foo.test.cjs)
// while the harness carries paths relative to its test dir, so the basename is
// the only stable join key between the two. `dirsByBase` records every distinct
// directory a basename was seen in so a genuine collision fails loudly rather
// than silently letting one file's timing stand in for another's.
function foldStream(text, acc, dirsByBase) {
  let files = 0;
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!event || event.type !== 'test:summary') continue;
    const data = event.data;
    if (!data || typeof data.file !== 'string') continue;
    const ms = data.duration_ms;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) continue;
    const path = data.file.replace(/\\/g, '/');
    const base = basename(path);
    if (!dirsByBase.has(base)) dirsByBase.set(base, new Set());
    dirsByBase.get(base).add(dirname(path));
    const prev = acc.get(base);
    if (prev === undefined || ms > prev) acc.set(base, ms);
    files++;
  }
  return { files, malformed };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) throw new ExitError(2, `gen-test-timings: ${parsed.error}`);

  const acc = new Map();
  const dirsByBase = new Map();
  const sources = [];
  for (const input of parsed.inputs) {
    let text;
    try {
      text = fs.readFileSync(input, 'utf8');
    } catch (err) {
      throw new ExitError(2, `gen-test-timings: cannot read "${input}": ${err.message}`);
    }
    const { files, malformed } = foldStream(text, acc, dirsByBase);
    sources.push(basename(input));
    console.error(
      `gen-test-timings: ${basename(input)} — ${files} file summaries` +
        (malformed > 0 ? `, ${malformed} unparseable lines skipped` : ''),
    );
  }

  if (acc.size === 0) {
    throw new ExitError(
      2,
      'gen-test-timings: no `test:summary` events with a file and duration_ms were found. ' +
        'Check that the input is a node:test reporter event stream (test-events-<os>-node<v>.jsonl).',
    );
  }

  // A basename that resolves to two different directories would make the
  // table ambiguous: run-tests.cjs joins on basename alone, so one file's
  // measured cost would silently be applied to the other. Fail rather than
  // emit a table that lies.
  const collisions = [...dirsByBase.entries()]
    .filter(([, dirs]) => dirs.size > 1)
    .map(([base, dirs]) => `${base} (${[...dirs].sort().join(', ')})`);
  if (collisions.length > 0) {
    throw new ExitError(
      2,
      `gen-test-timings: basename collision — the table cannot key on basename alone:\n  ${collisions.join('\n  ')}`,
    );
  }

  // Sorted keys keep the checked-in diff reviewable: a regeneration shows only
  // the files whose cost actually moved, not a reshuffled object.
  const timings = {};
  for (const base of [...acc.keys()].sort()) {
    timings[base] = Math.round(acc.get(base));
  }

  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_by: 'scripts/gen-test-timings.cjs',
    unit: 'ms',
    sources: sources.sort(),
    file_count: acc.size,
    timings,
  };

  fs.writeFileSync(parsed.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const totalMs = [...acc.values()].reduce((sum, ms) => sum + ms, 0);
  console.error(
    `gen-test-timings: wrote ${parsed.out} — ${acc.size} files, ${(totalMs / 1000).toFixed(1)}s total`,
  );
  return 0;
}

if (require.main === module) {
  runMain(main);
}

module.exports = { parseArgs, foldStream };
