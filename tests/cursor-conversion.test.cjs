/**
 * Cursor conversion regression tests.
 *
 * Ensures Cursor frontmatter names are emitted as plain identifiers
 * (without surrounding quotes), so Cursor does not treat quotes as
 * literal parts of skill/subagent names.
 *
 * Also covers convertClaudeCommandToCursorCommand (#785 — Cursor 1.6
 * slash commands via .cursor/commands/).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeCommandToCursorSkill,
  convertClaudeAgentToCursorAgent,
  convertClaudeCommandToCursorCommand,
} = require('../bin/install.js');

describe('convertClaudeCommandToCursorSkill', () => {
  test('writes unquoted Cursor skill name in frontmatter', () => {
    const input = `---
name: quick
description: Execute a quick task
---

<objective>
Test body
</objective>
`;

    const result = convertClaudeCommandToCursorSkill(input, 'gsd-quick');
    const nameMatch = result.match(/^name:\s*(.+)$/m);

    assert.ok(nameMatch, 'frontmatter contains name field');
    assert.strictEqual(nameMatch[1], 'gsd-quick', 'skill name is plain scalar');
    assert.ok(!result.includes('name: "gsd-quick"'), 'quoted skill name is not emitted');
  });

  test('preserves slash for slash commands in markdown body', () => {
    const input = `---
name: gsd:plan-phase
description: Plan a phase
---

Next:
/gsd:execute-phase 17
/gsd-help
gsd:progress
`;

    const result = convertClaudeCommandToCursorSkill(input, 'gsd-plan-phase');

    assert.ok(result.includes('/gsd-execute-phase 17'), 'slash command remains slash-prefixed');
    assert.ok(result.includes('/gsd-help'), 'existing slash command is preserved');
    assert.ok(result.includes('gsd-progress'), 'non-slash gsd: references still normalize');
    assert.ok(!result.includes('/gsd:execute-phase'), 'legacy colon command form is removed');
  });
});

describe('convertClaudeAgentToCursorAgent', () => {
  test('writes unquoted Cursor agent name in frontmatter', () => {
    const input = `---
name: gsd-planner
description: Planner agent
tools: Read, Write
color: green
---

<role>
Planner body
</role>
`;

    const result = convertClaudeAgentToCursorAgent(input);
    const nameMatch = result.match(/^name:\s*(.+)$/m);

    assert.ok(nameMatch, 'frontmatter contains name field');
    assert.strictEqual(nameMatch[1], 'gsd-planner', 'agent name is plain scalar');
    assert.ok(!result.includes('name: "gsd-planner"'), 'quoted agent name is not emitted');
  });
});

// ─── convertClaudeCommandToCursorCommand (#785) ───────────────────────────────

describe('convertClaudeCommandToCursorCommand (#785 — Cursor 1.6 .cursor/commands/)', () => {
  test('strips YAML frontmatter — output is plain markdown', () => {
    const input = `---
name: help
description: Show help for GSD commands
---

# GSD Help

Use \`/gsd-help\` to see available commands.
`;

    const result = convertClaudeCommandToCursorCommand(input);
    assert.ok(!result.startsWith('---'), 'cursor commands must not have YAML frontmatter');
    assert.ok(!result.includes('name: help'), 'name field must be stripped');
    assert.ok(!result.includes('description:'), 'description field must be stripped');
    assert.ok(result.includes('GSD Help'), 'body content must be preserved');
  });

  test('applies convertClaudeToCursorMarkdown transforms (Bash → Shell, Claude Code → Cursor)', () => {
    const input = `---
name: quick
description: Quick task
---

Use Bash( to run commands.
This runs in Claude Code.
`;

    const result = convertClaudeCommandToCursorCommand(input);
    assert.ok(result.includes('Shell('), 'Bash( should be renamed to Shell(');
    assert.ok(!result.includes('Claude Code'), 'Claude Code brand reference should be replaced');
    assert.ok(result.includes('Cursor'), 'should reference Cursor instead');
  });

  test('normalizes gsd: colon slash commands to gsd- hyphen form', () => {
    const input = `---
name: plan-phase
description: Plan a phase
---

Next step: /gsd:execute-phase 17
`;

    const result = convertClaudeCommandToCursorCommand(input);
    assert.ok(result.includes('/gsd-execute-phase 17'), 'colon form should become hyphen form');
    assert.ok(!result.includes('/gsd:execute-phase'), 'colon form should be removed');
  });

  test('handles input with no frontmatter gracefully', () => {
    const input = `# No Frontmatter Command

Some body content.
`;

    const result = convertClaudeCommandToCursorCommand(input);
    assert.ok(!result.startsWith('---'), 'output must not start with ---');
    assert.ok(result.includes('No Frontmatter Command'), 'body should be preserved');
  });

  test('is exported from install.js', () => {
    assert.strictEqual(typeof convertClaudeCommandToCursorCommand, 'function',
      'convertClaudeCommandToCursorCommand must be exported from install.js');
  });
});
