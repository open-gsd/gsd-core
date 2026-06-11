// allow-test-rule: source-text-is-the-product
// The autonomous command and workflow markdown are runtime-loaded contracts.
// Checking their text verifies the shipped slash-command behavior.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'gsd', 'autonomous.md');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'autonomous.md');
const COMMANDS_DOC_PATH = path.join(REPO_ROOT, 'docs', 'COMMANDS.md');
const HOW_TO_PATH = path.join(REPO_ROOT, 'docs', 'how-to', 'run-phases-autonomously.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

describe('autonomous --converge flag (#711)', () => {
  test('command advertises --converge and documents --cross-ai as alias', () => {
    const command = read(COMMAND_PATH);

    assert.match(
      command,
      /^argument-hint:.*--converge/m,
      'autonomous command should advertise --converge in argument-hint',
    );
    assert.match(command, /--cross-ai/, 'autonomous command should document --cross-ai alias');
    assert.match(
      command,
      /workflow\.plan_review_convergence=true/,
      'autonomous command should mention the existing convergence feature gate',
    );
  });

  test('workflow parses converge aliases into a plan strategy', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(workflow, /PLAN_STRATEGY="local"/, 'workflow should default to local planning');
    assert.match(workflow, /PLAN_STRATEGY="converge"/, 'workflow should opt into converge planning');
    assert.match(workflow, /converge\|cross-ai/, 'workflow should accept --converge and --cross-ai');
  });

  test('workflow fails fast when convergence is requested but disabled', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /config-get workflow\.plan_review_convergence/,
      'workflow should check workflow.plan_review_convergence before planning',
    );
    assert.match(
      workflow,
      /gsd config-set workflow\.plan_review_convergence true/,
      'workflow should print the enable command instead of silently downgrading',
    );
  });

  test('workflow routes planning through plan-review-convergence when enabled', () => {
    const workflow = read(WORKFLOW_PATH);

    assert.match(
      workflow,
      /Skill\(skill="gsd-plan-review-convergence", args="\$\{PHASE_NUM\} \$\{CONVERGENCE_ARGS\}"\)/,
      'non-interactive converge mode should call gsd-plan-review-convergence',
    );
    assert.match(
      workflow,
      /Run plan convergence for phase \$\{PHASE_NUM\}: Skill\(skill=\\"gsd-plan-review-convergence\\"/,
      'interactive converge mode should dispatch plan convergence in the background agent',
    );
    assert.match(
      workflow,
      /Skill\(skill="gsd-plan-phase", args="\$\{PHASE_NUM\}"\)/,
      'local planning path should remain available for default autonomous runs',
    );
  });

  test('workflow forwards reviewer flags and max cycles to convergence', () => {
    const workflow = read(WORKFLOW_PATH);
    const reviewerFlags = [
      '--codex',
      '--gemini',
      '--claude',
      '--opencode',
      '--ollama',
      '--lm-studio',
      '--llama-cpp',
      '--all',
      '--text',
    ];

    assert.match(workflow, /CONVERGENCE_ARGS/, 'workflow should build convergence pass-through args');
    for (const flag of reviewerFlags) {
      assert.ok(workflow.includes(flag), `workflow should pass through ${flag}`);
    }
    assert.match(workflow, /--max-cycles/, 'workflow should pass through --max-cycles N');
  });

  test('docs show autonomous convergence usage', () => {
    const commandsDoc = read(COMMANDS_DOC_PATH);
    const howTo = read(HOW_TO_PATH);

    assert.match(commandsDoc, /--converge/, 'COMMANDS.md should document --converge');
    assert.match(commandsDoc, /--cross-ai/, 'COMMANDS.md should document --cross-ai alias');
    assert.match(howTo, /\/gsd-autonomous --only 4 --converge/, 'how-to should show single-phase converge usage');
  });
});
