// allow-test-rule: source-text-is-the-product — commands/gsd/*.md files ARE the
// deployed skill surface. Testing their contract tests the runtime behaviour.

'use strict';

/**
 * Command Contract tests  (ADR-0002)
 *
 * Authoritative behavioral contract for every commands/gsd/*.md file.
 * Replaces scattered coverage in enh-2790-skill-consolidation and
 * bug-3135-capture-backlog-workflow for the full-surface contract checks.
 *
 * Contract:
 *   1. name:          present, non-empty, starts with gsd: or gsd-
 *   2. description:   present, non-empty
 *   3. allowed-tools: present, non-empty, all entries from CANONICAL_TOOLS
 *   4. execution_context @-refs: every reference resolves to an existing file
 *   5. execution_context @-refs: each on its own line (no trailing prose)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT         = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
const GSD_ROOT     = path.join(ROOT, 'gsd-core');

const {
  CANONICAL_TOOLS,
  parseFrontmatter,
  executionContextRefs,
} = require('../scripts/command-contract-helpers.cjs');

const commandFiles = fs
  .readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ name: f, full: path.join(COMMANDS_DIR, f) }));

// ─── contract tests ───────────────────────────────────────────────────────────

describe('command contract: name field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: name: present and starts with gsd: or gsd-`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(fm.name && fm.name.trim(), `${name}: name: field missing or empty`);
      assert.ok(
        /^gsd[:-]/.test(fm.name.trim()),
        `${name}: name: must start with "gsd:" or "gsd-", got "${fm.name.trim()}"`,
      );
    });
  }
});

describe('command contract: description field (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: description: present and non-empty`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm.description && fm.description.trim(),
        `${name}: description: field missing or empty`,
      );
    });
  }
});

describe('command contract: allowed-tools (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: allowed-tools: present, non-empty, all canonical`, () => {
      const fm = parseFrontmatter(fs.readFileSync(full, 'utf-8'));
      assert.ok(
        fm['allowed-tools'] && fm['allowed-tools'].trim(),
        `${name}: allowed-tools: block missing or empty`,
      );
      const tools = fm['allowed-tools'].split('\n').map(t => t.trim()).filter(Boolean);
      for (const tool of tools) {
        const valid =
          CANONICAL_TOOLS.has(tool) ||
          (tool.startsWith('mcp__context7__') && CANONICAL_TOOLS.has('mcp__context7__*'));
        assert.ok(valid, `${name}: unknown tool "${tool}" in allowed-tools`);
      }
    });
  }
});

describe('command contract: execution_context @-refs resolve (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: all execution_context @-refs exist on disk`, () => {
      const refs = executionContextRefs(fs.readFileSync(full, 'utf-8'));
      for (const { normalized } of refs) {
        assert.ok(
          fs.existsSync(path.join(GSD_ROOT, normalized)),
          `${name}: execution_context @-ref "${normalized}" does not exist — ` +
          'create the file or remove the reference',
        );
      }
    });
  }
});

describe('command contract: execution_context @-refs on own line (ADR-0002)', () => {
  for (const { name, full } of commandFiles) {
    test(`${name}: no @-refs with trailing prose in execution_context`, () => {
      const refs = executionContextRefs(fs.readFileSync(full, 'utf-8'));
      const bad = refs.filter(r => r.trailingProse);
      assert.equal(
        bad.length, 0,
        `${name}: @-refs with trailing prose in execution_context: ` +
        bad.map(r => r.token).join(', '),
      );
    });
  }
});
