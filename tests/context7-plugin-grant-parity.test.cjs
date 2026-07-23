'use strict';

// Regression guard for #2017 — agent `mcp__context7__*` grants only match a
// standalone context7 MCP server; the Claude Code plugin-marketplace install
// (`context7@claude-plugins-official`) names tools `mcp__plugin_context7_context7__*`,
// so every agent that uses context7 must grant BOTH forms or silently lose
// documentation lookup (falls back to WebSearch with no error).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function agentFiles() {
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => path.join(AGENTS_DIR, f));
}

describe('#2017 — context7 plugin-marketplace grant parity', () => {
  const STANDALONE = 'mcp__context7__*';
  const PLUGIN = 'mcp__plugin_context7_context7__*';

  for (const file of agentFiles()) {
    const name = path.basename(file);
    const content = fs.readFileSync(file, 'utf8');
    const toolsLine = (content.split(/\r?\n/).find((l) => /^tools:/.test(l)) || '');

    test(`${name}: standalone context7 grant implies the plugin-marketplace grant`, () => {
      if (!toolsLine.includes(STANDALONE)) return; // agent doesn't use context7 — skip
      assert.ok(toolsLine.includes(PLUGIN),
        `${name} grants ${STANDALONE} but not ${PLUGIN} (plugin-marketplace installs silently lose doc lookup — #2017)`);
    });
  }
});
