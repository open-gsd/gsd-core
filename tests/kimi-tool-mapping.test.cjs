/**
 * Kimi CLI tool module mapper tests.
 *
 * Kimi custom agent YAML requires tool module paths such as
 * `kimi_cli.tools.file:ReadFile`; raw Claude tool names and MCP-managed tools
 * must not be emitted.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertKimiToolName,
  mapClaudeToolsToKimiTools,
} = require('../bin/install.js');

describe('convertKimiToolName', () => {
  test('maps Claude and GSD tool names to documented Kimi module paths', () => {
    const expectedMappings = new Map([
      ['Read', 'kimi_cli.tools.file:ReadFile'],
      ['Write', 'kimi_cli.tools.file:WriteFile'],
      ['Edit', 'kimi_cli.tools.file:StrReplaceFile'],
      ['MultiEdit', 'kimi_cli.tools.file:StrReplaceFile'],
      ['Bash', 'kimi_cli.tools.shell:Shell'],
      ['Grep', 'kimi_cli.tools.file:Grep'],
      ['Glob', 'kimi_cli.tools.file:Glob'],
      ['Agent', 'kimi_cli.tools.agent:Agent'],
      ['Task', 'kimi_cli.tools.agent:Agent'],
      ['AskUserQuestion', 'kimi_cli.tools.ask_user:AskUserQuestion'],
      ['TodoWrite', 'kimi_cli.tools.todo:SetTodoList'],
      ['WebSearch', 'kimi_cli.tools.web:SearchWeb'],
      ['WebFetch', 'kimi_cli.tools.web:FetchURL'],
      ['TaskList', 'kimi_cli.tools.background:TaskList'],
      ['TaskOutput', 'kimi_cli.tools.background:TaskOutput'],
      ['TaskStop', 'kimi_cli.tools.background:TaskStop'],
    ]);

    for (const [claudeTool, kimiTool] of expectedMappings) {
      assert.equal(convertKimiToolName(claudeTool), kimiTool, `${claudeTool} maps to Kimi module path`);
    }
  });

  test('returns null for MCP-managed and unsupported tools', () => {
    assert.equal(convertKimiToolName('mcp__context7__resolve-library-id'), null);
    assert.equal(convertKimiToolName('DefinitelyUnknownTool'), null);
  });
});

describe('mapClaudeToolsToKimiTools', () => {
  test('deduplicates mapped tools while preserving first-seen order', () => {
    const result = mapClaudeToolsToKimiTools([
      'Read',
      'ReadFile',
      'Edit',
      'MultiEdit',
      'Bash',
      'Task',
      'Agent',
      'WebFetch',
    ]);

    assert.deepEqual(result.tools, [
      'kimi_cli.tools.file:ReadFile',
      'kimi_cli.tools.file:StrReplaceFile',
      'kimi_cli.tools.shell:Shell',
      'kimi_cli.tools.agent:Agent',
      'kimi_cli.tools.web:FetchURL',
    ]);
    assert.deepEqual(result.diagnostics, []);
  });

  test('excludes MCP-managed tools with diagnostics', () => {
    const result = mapClaudeToolsToKimiTools([
      'Read',
      'mcp__context7__resolve-library-id',
    ]);

    assert.deepEqual(result.tools, ['kimi_cli.tools.file:ReadFile']);
    assert.ok(
      result.diagnostics.some((item) =>
        item.reason === 'mcp_managed' &&
        item.code === 'kimi_mcp_tool_excluded' &&
        item.value === 'mcp__context7__resolve-library-id'
      ),
      'MCP-managed exclusion is diagnosed'
    );
  });

  test('excludes unsupported tools with diagnostics', () => {
    const result = mapClaudeToolsToKimiTools([
      'Read',
      'DefinitelyUnknownTool',
    ]);

    assert.deepEqual(result.tools, ['kimi_cli.tools.file:ReadFile']);
    assert.ok(
      result.diagnostics.some((item) =>
        item.reason === 'unsupported_tool' &&
        item.code === 'kimi_unsupported_tool' &&
        item.value === 'DefinitelyUnknownTool'
      ),
      'unsupported tool exclusion is diagnosed'
    );
  });
});
