'use strict';

// Issue #5741 — the verifier must harvest every `<verify><human-check>` block on an
// auto task, including one whose `<expected>` already records a verdict.
// Prompt-text contract for agents/gsd-verifier.md Step 8 and the planner-side references.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');

const verifier = read('agents', 'gsd-verifier.md');
const plannerMode = read('gsd-core', 'references', 'planner-human-verify-mode.md');
const checkpoints = read('gsd-core', 'references', 'checkpoints.md');

function step8(text) {
  const start = text.indexOf('## Step 8: Identify Human Verification Needs');
  assert.ok(start >= 0, 'Step 8 heading present');
  const end = text.indexOf('\n## Step 9', start);
  return text.slice(start, end > start ? end : undefined);
}

const harvestSection = step8(verifier);

test('#5741: a recorded verdict in <expected> is not a reason to omit the check', () => {
  assert.match(harvestSection, /recorded verdict[^\n]*is not a reason to omit/i);
});

test('#5741: deduplication is limited to overlap with the verifier\'s own analysis', () => {
  assert.match(harvestSection, /[Dd]eduplicate only against your own analysis/);
});

test('#5741: <expected> text is carried through unmodified', () => {
  assert.match(harvestSection, /<expected>[^\n]*unmodified/);
});

test('#5741: planner-side references agree that harvest ignores a recorded verdict', () => {
  const cases = [
    ['planner-human-verify-mode.md', plannerMode,
      /verifier \(Step 8\) harvests every `<verify><human-check>` block at end-of-phase, even when its `<expected>` already records a verdict/],
    ['checkpoints.md', checkpoints,
      /verifier harvests every `<verify><human-check>` at end-of-phase \(Step 8\), even when its `<expected>` already records a verdict/],
  ];
  for (const [name, text, harvestSentence] of cases) {
    assert.match(text, harvestSentence, name);
  }
});
