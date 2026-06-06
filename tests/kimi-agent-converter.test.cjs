/**
 * Kimi CLI agent artifact contract tests.
 *
 * Kimi custom agents are explicit YAML files loaded with `kimi --agent-file`.
 * This suite tests the in-memory artifact contract only; install/layout wiring
 * belongs to the later Phase 3 slices.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildKimiAgentArtifacts,
} = require('../bin/install.js');

const ROOT_AGENT = `---
name: gsd
description: Root GSD agent for Kimi CLI
tools: Agent, mcp__github__search, DefinitelyUnknownTool
color: blue
---

# GSD Root

Coordinate GSD workflows through subagents.
Read ~/.claude/gsd-core when source-package context is needed.`;

const EXECUTOR_AGENT = `---
name: gsd-executor
description: Execute planned GSD task slices with atomic commits.
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

const INVALID_AGENT = `---
name: not a valid kimi agent
description: Invalid name should be diagnosed and skipped.
tools: Agent
---

This should not become a Kimi custom subagent.`;

describe('buildKimiAgentArtifacts', () => {
  test('builds a root Kimi agent YAML contract with explicit subagent paths', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
      ],
      requestedSubagents: ['gsd-executor', 'gsd-missing'],
    });

    assert.equal(result.root.yamlPath, 'agents/gsd.yaml');
    assert.equal(result.root.promptPath, 'agents/gsd.md');
    assert.ok(result.root.yaml.includes('version: 1'), 'root YAML includes Kimi version marker');
    assert.ok(result.root.yaml.includes('agent:'), 'root YAML includes agent object');
    assert.ok(result.root.yaml.includes('name: gsd'), 'root agent name is gsd');
    assert.ok(result.root.yaml.includes('extend: default'), 'root agent extends default Kimi behavior');
    assert.ok(result.root.yaml.includes('system_prompt_path: ./gsd.md'), 'root prompt path is relative');
    assert.ok(result.root.yaml.includes('tools:'), 'root YAML has a tools field');
    assert.ok(result.root.yaml.includes('kimi_cli.tools.agent:Agent'), 'root can call Kimi subagents');
    assert.ok(
      result.root.yaml.includes('kimi_cli.tools.agent:Agent'),
      'root tools use Kimi module paths'
    );
    assert.ok(!result.root.yaml.includes('- Agent'), 'root YAML does not emit raw Claude Agent tool');
    assert.ok(result.root.yaml.includes('subagents:'), 'root YAML declares custom subagents');
    assert.ok(result.root.yaml.includes('gsd-executor:'), 'known GSD subagent key is canonical');
    assert.ok(
      result.root.yaml.includes('path: ./subagents/gsd-executor.yaml'),
      'known GSD subagent path is relative to root YAML'
    );
    assert.ok(!result.root.yaml.includes('gsd-missing'), 'unknown requested subagent is excluded');
  });

  test('emits separate frontmatter-free Markdown prompts for root and subagents', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
      ],
      requestedSubagents: ['gsd-executor'],
    });

    const executor = result.subagents.find((artifact) => artifact.name === 'gsd-executor');
    assert.ok(executor, 'executor subagent artifact exists');

    assert.equal(executor.yamlPath, 'agents/subagents/gsd-executor.yaml');
    assert.equal(executor.promptPath, 'agents/subagents/gsd-executor.md');
    assert.ok(executor.yaml.includes('system_prompt_path: ./gsd-executor.md'));
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:ReadFile'), 'Read maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:WriteFile'), 'Write maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:StrReplaceFile'), 'Edit maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.shell:Shell'), 'Bash maps to Kimi shell tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:Grep'), 'Grep maps to Kimi grep tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:Glob'), 'Glob maps to Kimi glob tool');
    assert.ok(!executor.yaml.includes('- Read'), 'subagent YAML does not emit raw Claude Read tool');
    assert.ok(!executor.yaml.includes('- Bash'), 'subagent YAML does not emit raw Claude Bash tool');
    assert.ok(!executor.yaml.includes('kimi_cli.tools.agent:Agent'), 'subagent does not inherit nested Agent tool');

    for (const prompt of [result.root.prompt, executor.prompt]) {
      assert.ok(!prompt.trimStart().startsWith('---'), 'source frontmatter is removed');
      assert.ok(!prompt.includes('tools:'), 'source frontmatter tools do not leak into prompt');
      assert.ok(!prompt.includes('color:'), 'source frontmatter color does not leak into prompt');
    }
    assert.ok(result.root.prompt.includes('# GSD Root'), 'root body content is preserved');
    assert.ok(executor.prompt.includes('You are a GSD plan executor.'), 'subagent body content is preserved');
    assert.ok(!result.root.prompt.includes('~/.claude/gsd-core'), 'Claude-specific path is neutralized');
  });

  test('diagnoses unknown subagents and unsupported inputs instead of emitting invalid names', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
        { path: 'agents/not-valid.md', content: INVALID_AGENT },
      ],
      requestedSubagents: ['gsd-executor', 'gsd-missing'],
    });

    assert.deepEqual(
      result.subagents.map((artifact) => artifact.name),
      ['gsd-executor'],
      'invalid and unknown subagents are not emitted'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_unknown_subagent' && item.value === 'gsd-missing'),
      'unknown requested subagent is diagnosed'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_invalid_subagent_name'),
      'invalid source subagent name is diagnosed'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_mcp_tool_excluded'),
      'MCP-managed tools are diagnosed and excluded'
    );
    assert.ok(
      result.diagnostics.some((item) => item.reason === 'mcp_managed'),
      'MCP diagnostics expose mapper reason'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_unsupported_tool'),
      'unsupported tools are diagnosed and excluded'
    );
    assert.ok(
      result.diagnostics.some((item) => item.reason === 'unsupported_tool'),
      'unsupported diagnostics expose mapper reason'
    );
    assert.ok(!result.root.yaml.includes('mcp__github__search'), 'MCP tool names are not emitted');
    assert.ok(!result.root.yaml.includes('DefinitelyUnknownTool'), 'unsupported tool names are not emitted');
  });
});
