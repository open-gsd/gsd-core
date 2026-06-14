const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'config.cjs');
const EXECUTE_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
const CONFIG_TEMPLATE_PATH = path.join(__dirname, '..', 'gsd-core', 'templates', 'config.json');

// Read shared fixtures once at module load so tests are independent of each other's
// execution order and do not share mutable state.
const executePhaseContent = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
const configTemplate = JSON.parse(fs.readFileSync(CONFIG_TEMPLATE_PATH, 'utf-8'));

// Extract the cross_ai_delegation step body once; used by several assertions below.
const CROSS_AI_STEP_OPEN = '<step name="cross_ai_delegation">';
const CROSS_AI_STEP_START = executePhaseContent.indexOf(CROSS_AI_STEP_OPEN);
const CROSS_AI_STEP_END =
  executePhaseContent.indexOf('</step>', CROSS_AI_STEP_START) + '</step>'.length;
const crossAiSection = CROSS_AI_STEP_START >= 0
  ? executePhaseContent.substring(CROSS_AI_STEP_START, CROSS_AI_STEP_END)
  : '';

// Extract the parse_args step body once.
const PARSE_ARGS_STEP_OPEN = '<step name="parse_args"';
const PARSE_ARGS_STEP_START = executePhaseContent.indexOf(PARSE_ARGS_STEP_OPEN);
const PARSE_ARGS_STEP_END =
  executePhaseContent.indexOf('</step>', PARSE_ARGS_STEP_START) + '</step>'.length;
const parseArgsSection = PARSE_ARGS_STEP_START >= 0
  ? executePhaseContent.substring(PARSE_ARGS_STEP_START, PARSE_ARGS_STEP_END)
  : '';

describe('workflow.cross_ai_execution feature', () => {

  describe('config keys', () => {
    test('workflow.cross_ai_execution is in VALID_CONFIG_KEYS', () => {
      const { VALID_CONFIG_KEYS } = require(CONFIG_PATH);
      assert.ok(VALID_CONFIG_KEYS.has('workflow.cross_ai_execution'),
        'VALID_CONFIG_KEYS must include workflow.cross_ai_execution');
    });

    test('workflow.cross_ai_command is in VALID_CONFIG_KEYS', () => {
      const { VALID_CONFIG_KEYS } = require(CONFIG_PATH);
      assert.ok(VALID_CONFIG_KEYS.has('workflow.cross_ai_command'),
        'VALID_CONFIG_KEYS must include workflow.cross_ai_command');
    });

    test('workflow.cross_ai_timeout is in VALID_CONFIG_KEYS', () => {
      const { VALID_CONFIG_KEYS } = require(CONFIG_PATH);
      assert.ok(VALID_CONFIG_KEYS.has('workflow.cross_ai_timeout'),
        'VALID_CONFIG_KEYS must include workflow.cross_ai_timeout');
    });
  });

  describe('config template defaults', () => {
    test('config template has cross_ai_execution default of false', () => {
      assert.strictEqual(configTemplate.workflow.cross_ai_execution, false,
        'cross_ai_execution should default to false');
    });

    test('config template has cross_ai_command default of empty string', () => {
      assert.strictEqual(configTemplate.workflow.cross_ai_command, '',
        'cross_ai_command should default to empty string');
    });

    test('config template has cross_ai_timeout default of 300 seconds', () => {
      assert.strictEqual(configTemplate.workflow.cross_ai_timeout, 300,
        'cross_ai_timeout should default to 300 seconds');
    });
  });

  describe('execute-phase.md cross-AI step', () => {
    test('execute-phase.md has a cross-AI execution step', () => {
      assert.ok(executePhaseContent.includes(CROSS_AI_STEP_OPEN),
        'execute-phase.md must have a step named cross_ai_delegation');
    });

    test('cross-AI step appears between discover_and_group_plans and execute_waves', () => {
      const discoverIdx = executePhaseContent.indexOf('<step name="discover_and_group_plans">');
      const crossAiIdx = executePhaseContent.indexOf(CROSS_AI_STEP_OPEN);
      const executeIdx = executePhaseContent.indexOf('<step name="execute_waves">');
      assert.ok(crossAiIdx >= 0, 'cross_ai_delegation step is missing from execute-phase.md');
      assert.ok(discoverIdx < crossAiIdx, 'cross_ai_delegation must come after discover_and_group_plans');
      assert.ok(crossAiIdx < executeIdx, 'cross_ai_delegation must come before execute_waves');
    });

    test('cross-AI step handles --cross-ai flag', () => {
      assert.ok(executePhaseContent.includes('--cross-ai'),
        'execute-phase.md must reference --cross-ai flag');
    });

    test('cross-AI step handles --no-cross-ai flag', () => {
      assert.ok(executePhaseContent.includes('--no-cross-ai'),
        'execute-phase.md must reference --no-cross-ai flag');
    });

    test('cross-AI step uses stdin-based prompt delivery', () => {
      // The step must describe piping prompt via stdin, not shell interpolation
      assert.ok(executePhaseContent.includes('stdin'),
        'cross-AI step must describe stdin-based prompt delivery');
    });

    test('cross-AI step validates summary output', () => {
      // The step must describe validating the captured summary
      assert.ok(
        crossAiSection.includes('SUMMARY') && crossAiSection.includes('valid'),
        'cross-AI step must validate the summary output'
      );
    });

    test('cross-AI step warns about dirty working tree', () => {
      assert.ok(
        crossAiSection.includes('dirty') || crossAiSection.includes('uncommitted') || crossAiSection.includes('working tree'),
        'cross-AI step must warn about dirty/uncommitted changes from external command'
      );
    });

    test('cross-AI step reads cross_ai_command from config', () => {
      assert.ok(
        crossAiSection.includes('cross_ai_command'),
        'cross-AI step must read cross_ai_command from config'
      );
    });

    test('cross-AI step reads cross_ai_timeout from config', () => {
      assert.ok(
        crossAiSection.includes('cross_ai_timeout'),
        'cross-AI step must read cross_ai_timeout from config'
      );
    });

    test('cross-AI step handles failure with retry/skip/abort', () => {
      assert.ok(crossAiSection.includes('retry'), 'cross-AI step must offer retry on failure');
      assert.ok(crossAiSection.includes('skip'), 'cross-AI step must offer skip on failure');
      assert.ok(crossAiSection.includes('abort'), 'cross-AI step must offer abort on failure');
    });

    test('cross-AI step skips normal executor for handled plans', () => {
      assert.ok(
        crossAiSection.includes('skip') && (crossAiSection.includes('executor') || crossAiSection.includes('execute_waves')),
        'cross-AI step must describe skipping normal executor for cross-AI handled plans'
      );
    });

    test('parse_args step includes --cross-ai and --no-cross-ai', () => {
      assert.ok(parseArgsSection.includes('--cross-ai'),
        'parse_args step must parse --cross-ai flag');
      assert.ok(parseArgsSection.includes('--no-cross-ai'),
        'parse_args step must parse --no-cross-ai flag');
    });
  });
});
