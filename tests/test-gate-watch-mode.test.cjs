// allow-test-rule: source-text-is-the-product #1857
// Workflow .md files — their text IS the deployed contract the orchestrator runs.

/**
 * #1857, #4784: the post-merge gate's simulator-extraction pipeline, run for real.
 *
 * The text of the test gates (one-shot normalization, the timeout bound, `--raw` config reads, the Xcode
 * construction, the package-manager fallbacks) is the `post-merge-gate-watch-mode` text contract in
 * scripts/static-checks/text-contracts/. This file keeps the one case a contract cannot state: it extracts the
 * gate's OWN `simctl | sed | head` pipeline and executes it against a real-format simctl line.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const POST_MERGE_GATE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'post-merge-gate.md');

// #4784: bounds the one-shot sed pipeline the behavioral extraction test runs
// against a fixture line (a pure text filter on ~50 lines — never the 30s-plus
// subprocess classes in timeouts.cjs).
const SIMCTL_EXTRACT_TIMEOUT_MS = 10_000;

function read(p) { return fs.readFileSync(p, 'utf-8'); }

describe('#4784: Xcode gate construction', () => {
  const gate = read(POST_MERGE_GATE);

  test('#4784: the gate\'s simulator-extraction pipeline yields a UDID from a real-format simctl line', () => {
    // Adversarial-review Finding 1 (behavioral, would have been red): the first
    // cut anchored the sed at end-of-line, but real simctl lines end with a
    // (Shutdown)/(Booted) state suffix (often + trailing space) — the anchored
    // form matched NOTHING and the gates skipped on every machine. Extract the
    // gate's OWN pipeline and execute it against a real-format fixture line.
    const pipeMatch = gate.match(/simctl list devices available 2[^\n]*?(sed -n '[^']+')[^\n]*?head -1/);
    assert.ok(pipeMatch, 'gate must contain the simctl→sed→head extraction pipeline');
    const realFormatLine = '    iPhone 17 Pro (94B8198C-8CF1-4860-994A-5669D3388BE8) (Shutdown) ';
    const { execFileSync } = require('node:child_process');
    const udid = execFileSync('sh', ['-c', `printf '%s\\n' "$1" | ${pipeMatch[1]} | head -1`, 'sh', realFormatLine], {
      encoding: 'utf-8',
      timeout: SIMCTL_EXTRACT_TIMEOUT_MS,
    }).trim();
    assert.match(udid, /^[A-F0-9-]{8,}$/, `the pipeline must extract the UDID from a real-format line, got: ${JSON.stringify(udid)}`);
  });

});
