'use strict';

// Every agent that grants the standalone context7 MCP tools grants the plugin-marketplace form too (#2017): a
// standalone `mcp__context7__*` grant only matches a standalone server, while the Claude Code plugin install names
// its tools `mcp__plugin_context7_context7__*`, so an agent that grants only the first silently loses documentation
// lookup (it falls back to WebSearch with no error). Was tests/context7-plugin-grant-parity.test.cjs.

const STANDALONE = 'mcp__context7__*';
const PLUGIN = 'mcp__plugin_context7_context7__*';

module.exports = {
  id: 'context7-plugin-grant-parity',
  issue: '#2017',
  check(ctx) {
    // The agents directly under agents/ (the test read the directory without descending).
    for (const rel of ctx.list('agents', '.md', 'the agents are what the parity is checked on').filter((path) => path.split('/').length === 2)) {
      ctx.doc(rel).satisfies((text) => {
        const toolsLine = text.split('\n').find((line) => /^tools:/.test(line)) || '';
        if (!toolsLine.includes(STANDALONE)) return true; // the agent does not use context7
        return toolsLine.includes(PLUGIN) || `grants ${STANDALONE} but not ${PLUGIN}`;
      }, 'a standalone context7 grant must imply the plugin-marketplace grant (plugin-marketplace installs silently lose doc lookup)');
    }
  },
};
