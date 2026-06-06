// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('MCP tool usage in GSD agents', () => {
  const agentFiles = [
    path.join(__dirname, '..', 'agents', 'gsd-executor.md'),
    path.join(__dirname, '..', 'agents', 'gsd-planner.md'),
  ];

  for (const agentFile of agentFiles) {
    const name = path.basename(agentFile);

    test(`${name} mentions MCP tool usage`, () => {
      const content = fs.readFileSync(agentFile, 'utf-8');
      const hasMcpGuidance =
        content.toLowerCase().includes('mcp') ||
        content.includes('context7') ||
        content.includes('available tools') ||
        content.includes('MCP tool');
      assert.ok(hasMcpGuidance, `${name} should mention MCP tool availability/usage`);
    });
  }

  test('gsd-executor.md explicitly instructs to use available MCP tools', () => {
    const content = fs.readFileSync(agentFiles[0], 'utf-8');
    assert.ok(
      content.includes('MCP') || content.includes('mcp__'),
      'executor should reference MCP tools'
    );
  });
});

// Regression (#657 Phase C.2): researcher agents declare mcp__tavily/ref/jina alongside
// the pre-existing mcp__exa/firecrawl tools. All six use the same generic MCP passthrough
// on every runtime (no explicit registry mapping needed until io.github.* IDs are confirmed).
describe('Researcher agents declare mcp__tavily/ref/jina tools (#657)', () => {
  const researcherAgents = [
    path.join(__dirname, '..', 'agents', 'gsd-project-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-phase-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-ui-researcher.md'),
  ];

  // Tools that must appear in the tools: frontmatter line of every researcher agent
  const requiredMcpTools = [
    'mcp__context7__*',
    'mcp__exa__*',
    'mcp__firecrawl__*',
    'mcp__tavily__*',
    'mcp__ref__*',
    'mcp__jina__*',
  ];

  for (const agentFile of researcherAgents) {
    const name = path.basename(agentFile);
    const content = fs.readFileSync(agentFile, 'utf-8');

    // Extract the tools: frontmatter line (single-line CSV form)
    const toolsLineMatch = content.match(/^tools:\s*(.+)$/m);

    test(`${name} has a tools: frontmatter line`, () => {
      assert.ok(toolsLineMatch, `${name} must have a tools: frontmatter line`);
    });

    for (const tool of requiredMcpTools) {
      test(`${name} declares ${tool}`, () => {
        assert.ok(
          toolsLineMatch && toolsLineMatch[1].includes(tool),
          `${name} tools: line must include ${tool}`
        );
      });
    }
  }
});

// Parity assertion: mcp__tavily/ref/jina must be declared alongside mcp__exa/firecrawl
// in every researcher agent. This test fails when the two sets diverge (#657 generative-fix).
describe('Researcher agent MCP tool set parity: new tools match exa/firecrawl pattern (#657)', () => {
  const researcherAgents = [
    path.join(__dirname, '..', 'agents', 'gsd-project-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-phase-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-ui-researcher.md'),
  ];

  for (const agentFile of researcherAgents) {
    const name = path.basename(agentFile);
    const content = fs.readFileSync(agentFile, 'utf-8');
    const toolsLineMatch = content.match(/^tools:\s*(.+)$/m);
    const toolsLine = toolsLineMatch ? toolsLineMatch[1] : '';

    test(`${name}: mcp__tavily__* co-declared with mcp__exa__*`, () => {
      const hasExa = toolsLine.includes('mcp__exa__*');
      const hasTavily = toolsLine.includes('mcp__tavily__*');
      assert.strictEqual(hasExa, hasTavily,
        `${name}: mcp__exa__* and mcp__tavily__* must both be present or both absent`);
    });

    test(`${name}: mcp__jina__* co-declared with mcp__firecrawl__*`, () => {
      const hasFirecrawl = toolsLine.includes('mcp__firecrawl__*');
      const hasJina = toolsLine.includes('mcp__jina__*');
      assert.strictEqual(hasFirecrawl, hasJina,
        `${name}: mcp__firecrawl__* and mcp__jina__* must both be present or both absent`);
    });

    test(`${name}: mcp__ref__* present (standalone research tool)`, () => {
      assert.ok(
        toolsLine.includes('mcp__ref__*'),
        `${name}: mcp__ref__* must be declared`
      );
    });
  }
});
