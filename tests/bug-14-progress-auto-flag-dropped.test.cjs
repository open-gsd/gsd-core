// allow-test-rule: source-text-is-the-product
// The command markdown is loaded directly by runtime prompt assembly.
// This test verifies that --auto is documented in progress.md and handled in next.md.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('#14: /gsd:progress --next --auto flag must be documented and propagated', () => {
  test('progress.md <flags> section documents --auto flag', () => {
    const command = fs.readFileSync(
      path.join(ROOT, 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    assert.ok(
      command.includes('--auto'),
      'progress.md must document the --auto flag in the <flags> section'
    );
  });

  test('progress.md <process> block explicitly passes --auto through to next workflow', () => {
    const command = fs.readFileSync(
      path.join(ROOT, 'commands', 'gsd', 'progress.md'),
      'utf8'
    );

    // Extract only the <process>…</process> block so this assertion is
    // scoped to the handoff wiring, not just any occurrence in the file.
    const processMatch = command.match(/<process>([\s\S]*?)<\/process>/);
    assert.ok(
      processMatch,
      'progress.md must contain a <process> block'
    );
    const processBlock = processMatch[1];

    assert.ok(
      processBlock.includes('--auto'),
      'progress.md <process> block must explicitly mention --auto so it is not silently stripped at the --next handoff'
    );
  });

  test('next.md show_and_execute step handles --auto to chain steps', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'workflows', 'next.md'),
      'utf8'
    );

    assert.ok(
      workflow.includes('--auto'),
      'next.md must handle the --auto flag to chain step invocations automatically'
    );
  });

  test('next.md --auto chaining re-invokes /gsd:progress --next after step completion', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, 'gsd-core', 'workflows', 'next.md'),
      'utf8'
    );

    // The workflow must contain instructions to re-invoke /gsd:progress --next --auto
    // after the determined step completes, enabling the chain.
    assert.ok(
      workflow.includes('--next --auto'),
      'next.md must instruct re-invocation of /gsd:progress --next --auto after step completion to enable chaining'
    );
  });
});
