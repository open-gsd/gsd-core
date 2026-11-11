'use strict';

/**
 * #4783: execute-phase checkpoint handling step 6 told the orchestrator to spawn the continuation
 * agent "using continuation-prompt.md template", a file that does not ship. The placeholders
 * the step lists are the whole contract, so the step or its shipped continuation part must state
 * them instead of pointing at a missing file. A workflow may not name a `*-prompt.md` template that does not exist in the package.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..', 'gsd-core');
const EXECUTE = path.join(ROOT, 'workflows', 'execute-phase.md');
const EXECUTOR = path.join(__dirname, '..', 'agents', 'gsd-executor.md');
const CONTINUATION_PART = path.join(ROOT, 'workflows', 'execute-phase', 'steps', 'checkpoint-continuation.md');

function shippedFileNames(dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) shippedFileNames(path.join(dir, entry.name), out);
    else out.add(entry.name);
  }
  return out;
}

describe('#4783 execute-phase continuation spawn does not point at a missing template', () => {
  test('step 6 does not reference a *-prompt.md template that does not ship', () => {
    const text = readFileNormalized(EXECUTE) + '\n' + readFileNormalized(CONTINUATION_PART);
    const shipped = shippedFileNames(ROOT);
    const dangling = [...new Set(text.match(/\b[a-z][a-z-]*-prompt\.md\b/g) || [])].filter((name) => !shipped.has(name));
    assert.deepEqual(dangling, [], `execute-phase.md names template file(s) that do not ship: ${dangling.join(', ')}`);
  });

  test('step 6 delegates to the shipped continuation contract after the user response', () => {
    const text = readFileNormalized(EXECUTE);
    const delegation = '6. Read and execute `gsd-core/workflows/execute-phase/steps/checkpoint-continuation.md`';
    assert.ok(text.includes(delegation), 'step 6 must delegate to the shipped part');
    assert.ok(text.indexOf(delegation) > text.indexOf('5. User responds:'), 'continuation follows the user response');
    assert.ok(text.indexOf(delegation) < text.indexOf('7. Continuation agent verifies'), 'continuation precedes commit verification');
    const step = readFileNormalized(CONTINUATION_PART);
    assert.ok(step.includes('**Spawn continuation agent (NOT resume)'), 'part must own the continuation dispatch');
    for (const placeholder of ['{completed_tasks_table}', '{resume_task_number}', '{resume_task_name}', '{user_response}', '{resume_instructions}', '{worktree_path}']) {
      assert.ok(step.includes(placeholder), `step 6 must state ${placeholder}`);
    }
    assert.ok(step.includes('<completed_tasks>'), 'step 6 must name the <completed_tasks> tag the executor keys on');
    assert.ok(step.includes('<completed_tasks></completed_tasks>'), 'an empty first-task checkpoint must still select continuation');
    assert.ok(step.includes('original executor worktree'), 'step 6 must preserve the worktree that owns continuation metadata');
    assert.ok(step.includes('main checkout'), 'step 6 must define an empty worktree path as the main checkout');
    assert.ok(step.includes('non-empty') && step.includes('fail closed'),
      'step 6 must refuse only a missing non-empty continuation worktree');
  });

  test('checkpoint returns carry the worktree metadata consumed by step 6', () => {
    const text = readFileNormalized(EXECUTOR);
    const start = text.indexOf('<checkpoint_return_format>');
    const end = text.indexOf('</checkpoint_return_format>', start);
    assert.ok(start !== -1 && end > start, 'executor must define checkpoint_return_format');
    const checkpoint = text.slice(start, end);
    assert.match(checkpoint, /<worktree_metadata>/);
    assert.match(checkpoint, /"worktree_path":"\{captured_worktree_path\}"/);
    assert.match(checkpoint, /"branch":"\{captured_branch\}"/);
    assert.match(checkpoint, /"expected_base":"\{captured_expected_base\}"/);
  });
});
