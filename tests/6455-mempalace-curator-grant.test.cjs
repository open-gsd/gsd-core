// docs-guard-exempt: 'docs/reference/agents.md' is read as shipped product data by the parity row, intentionally (#6455).
'use strict';

/**
 * tests/6455-mempalace-curator-grant.test.cjs
 *
 * #6455: the shipped gsd-mempalace-curator (full and compact) instructs bare `mempalace_*` MCP tool calls while its
 * `tools:` frontmatter withholds the MemPalace MCP grant. These rows pin the grant in the shipped data (RED pre-fix),
 * drive the new bare-name rule of scripts/static-checks/text-contracts/mcp-tool-inheritance.cjs on synthetic docs, pin
 * the grant's parity across the shipped surfaces (RED pre-fix), and pin the Qwen and pi converters' treatment of the
 * grant token (pi drops it into a comment, by ADR-5559 design).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { walkers } = require('../scripts/static-checks/text-contracts/mcp-tool-inheritance.cjs');
const frontmatter = require('../gsd-core/bin/lib/frontmatter.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { convertClaudeAgentToCodexAgent, convertClaudeAgentToQwenAgent, convertClaudeAgentToPiAgent } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GRANT = 'mcp__mempalace__*';
const CURATOR = 'agents/gsd-mempalace-curator.md';
const CURATOR_COMPACT = 'agents/gsd-mempalace-curator.compact.md';
const REFERENCE = 'docs/reference/agents.md';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
const grantTokens = (content) => walkers.toolTokens((frontmatter.parseFrontmatter(content) || {}).tools) || [];

describe('#6455 the shipped curator grants the MemPalace MCP server in both variants (RED pre-fix)', () => {
  for (const rel of [CURATOR, CURATOR_COMPACT]) {
    test(`${rel} tools: lists ${GRANT}`, () => {
      assert.ok(grantTokens(read(rel)).includes(GRANT));
    });
  }
});

describe('#6455 the bare-name rule fails an agent that calls mempalace_* with no grant', () => {
  const doc = (tools, body) => `---\nname: gsd-test-agent\ndescription: A synthetic agent for the #6455 rule.\ntools: ${tools}\n---\n\n${body}`;
  const CALL = 'Call `mempalace_kg_add(node, edge)` once.';

  test('a body calling mempalace_kg_add( with no MCP grant is reported', () => {
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc('Read, Bash', CALL), frontmatter), ['kg_add']);
  });
  test('the mcp__mempalace__* grant passes the same body', () => {
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc(`Read, Bash, Grep, Glob, ${GRANT}`, CALL), frontmatter), []);
  });
  test('the bare mcp__* wildcard passes the same body', () => {
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc('Read, mcp__*', CALL), frontmatter), []);
  });
  test('a body naming mempalace without a call passes', () => {
    const prose = 'The mempalace wing holds the diary; mempalace_diary_read is named but never called.';
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc('Read, Bash', prose), frontmatter), []);
  });
  test('a missing tools: key inherits every grant', () => {
    const inherits = '---\nname: gsd-test-agent\ndescription: d\n---\n\ncall mempalace_diary_read(w)';
    assert.deepEqual(walkers.ungrantedMempalaceCalls(inherits, frontmatter), []);
  });
  test('a longer identifier is not a call, and whitespace before ( is', () => {
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc('Read, Bash', 'xmempalace_kg_add(x)'), frontmatter), []);
    assert.deepEqual(walkers.ungrantedMempalaceCalls(doc('Read, Bash', 'mempalace_kg_add\n  (x)'), frontmatter), ['kg_add']);
  });
  test('the shipped curator passes the rule once granted (RED pre-fix)', () => {
    assert.deepEqual(walkers.ungrantedMempalaceCalls(read(CURATOR), frontmatter), []);
  });
});

describe('#6455 the grant is identical across the shipped surfaces (RED pre-fix)', () => {
  test('the full and compact tools: lines are byte-identical and carry the grant', () => {
    const full = walkers.toolsLine(read(CURATOR));
    assert.equal(full, walkers.toolsLine(read(CURATOR_COMPACT)));
    assert.ok(full.includes(GRANT));
  });
  test('docs/reference/agents.md lists the grant on the curator Tools row', () => {
    const reference = read(REFERENCE);
    const start = reference.indexOf('### gsd-mempalace-curator\n');
    assert.notEqual(start, -1, 'the reference doc must hold the curator section');
    const row = splitLines(reference.slice(start)).find((line) => line.startsWith('| **Tools** |'));
    assert.ok(row !== undefined && row.includes(GRANT), `the curator Tools row must list ${GRANT}`);
  });
});

describe('#6455 the converters treat the grant per runtime', () => {
  const granted = `---\nname: gsd-test-agent\ndescription: A synthetic agent carrying the MemPalace grant.\ntools: Read, Bash, ${GRANT}\n---\n\nCall \`mempalace_kg_add(node, edge)\` once.`;

  test('the Qwen converter double-quotes the grant in its tools list', () => {
    assert.ok(convertClaudeAgentToQwenAgent(granted).includes(`  - "${GRANT}"`));
  });
  test('the Qwen output for the shipped curator carries the grant (RED pre-fix)', () => {
    assert.ok(convertClaudeAgentToQwenAgent(read(CURATOR)).includes(`  - "${GRANT}"`));
  });
  test('the pi converter drops the grant into the no-equivalent comment', () => {
    const pi = convertClaudeAgentToPiAgent(granted);
    const toolsLine = splitLines(pi).find((line) => line.startsWith('tools: '));
    assert.equal(toolsLine, 'tools: read, bash');
    assert.ok(pi.includes(`# tools with no Pi equivalent, dropped: ${GRANT}`));
  });
  test('the Codex converter passes the grant verbatim into the role header tools listing', () => {
    assert.ok(convertClaudeAgentToCodexAgent(granted).includes(`tools: Read, Bash, ${GRANT}\n`));
  });
});

test('the bare-call walk equals the documented regex oracle over generated strings (#6455)', () => {
  // Differential property: the linear walk in bareMempalaceCalls must agree with the /\bmempalace_([a-z_]+)\s*\(/g
  // it mirrors, on every generated string — the parser-parity rule from CLAUDE.md test conventions.
  const oracle = (text) => {
    const names = new Set();
    for (const m of text.matchAll(/\bmempalace_([a-z_]+)\s*\(/g)) names.add(m[1]);
    return [...names].sort();
  };
  const word = fc.constantFrom('mempalace_', 'mempalace_kg_add', 'mempalace_diary_read', 'mempalace_', '(', ')', ' ', '\n', 'x', '_', 'xmempalace_kg_add', 'MEMPALACE_FOO', 'mempalace_enabled', '.', '`', 'mempalace_find_tunnels');
  fc.assert(
    fc.property(fc.array(word, { minLength: 0, maxLength: 14 }), (parts) => {
      const text = parts.join('');
      assert.deepEqual(walkers.bareMempalaceCalls(text), oracle(text), `walk diverges on ${JSON.stringify(text)}`);
    }),
    { seed: 6455, numRuns: 200 }
  );
});
