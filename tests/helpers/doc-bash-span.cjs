'use strict';

/**
 * Extract a documented bash capture from a workflow/reference/agent .md file and run it (#5170).
 *
 * The workflows tell an agent to run a shell block; whether that block survives an exit status the CLI
 * now reports (1 = negative verdict, 66 = empty scope, 69 = could not look) is a property of the
 * block's TEXT. These helpers pull the block's lines out by their first words (so a reflow of the
 * prose around it does not break the test) and run them under bash with a stub `gsd_run` that returns
 * a chosen stdout and status, optionally under `set -e`, which is how an agent shell may run them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * The lines of `relFile` (repo-relative) from the one whose trimmed text starts with `from` through
 * the first later one starting with `through`. Both markers must exist.
 */
function span(relFile, from, through) {
  const lines = splitLines(fs.readFileSync(path.join(REPO_ROOT, relFile), 'utf8'));
  const start = lines.findIndex((l) => l.trim().startsWith(from));
  assert.notEqual(start, -1, `${relFile} must carry a line starting with ${from}`);
  const end = lines.findIndex((l, i) => i >= start && l.trim().startsWith(through));
  assert.notEqual(end, -1, `${relFile} must carry a line starting with ${through} after ${from}`);
  return lines.slice(start, end + 1);
}

/**
 * Run `lines` under bash with `gsd_run` stubbed to print `stdout` and return `rc`. `setE` runs them
 * under `set -e`; `preamble` lines (variable seeds) run first; `probe` runs last (read variables).
 */
function runBash(lines, { stdout, rc }, { setE = true, preamble = [], probe = '' } = {}) {
  const script = [
    ...(setE ? ['set -e'] : []),
    'gsd_run() { printf %s "$STUB_OUT"; return "$STUB_RC"; }',
    ...preamble,
    ...lines,
    probe,
    '',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, STUB_OUT: stdout, STUB_RC: String(rc) },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

module.exports = { span, runBash };
