#!/usr/bin/env node
/**
 * lint-command-contract.cjs  (ADR-0002)
 *
 * Enforces the commands/gsd/*.md contract across all 65 command files:
 *
 *   1. name:        present, non-empty, matches gsd: or gsd- prefix
 *   2. description: present, non-empty
 *   3. allowed-tools: block present, non-empty, all entries from CANONICAL_TOOLS
 *   4. execution_context @-refs: every @-reference resolves to an existing file on disk
 *   5. execution_context @-refs: each appears on its own line (no trailing prose)
 *
 * Exit 0 = clean. Exit 1 = violations (with diagnostics).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const COMMANDS_DIR  = path.join(ROOT, 'commands', 'gsd');
const GSD_ROOT      = path.join(ROOT, 'gsd-core');

const {
  CANONICAL_TOOLS,
  parseFrontmatter,
  executionContextRefs: extractExecutionContextRefs,
} = require('./command-contract-helpers.cjs');

const { runMain } = require('./lib/cli-exit.cjs');

// ─── check one file ───────────────────────────────────────────────────────────

function check(filePath) {
  const content  = fs.readFileSync(filePath, 'utf-8');
  const rel      = path.relative(ROOT, filePath);
  const fm       = parseFrontmatter(content);
  const violations = [];

  // 1. name: present + gsd: / gsd- prefix
  if (!fm.name || !fm.name.trim()) {
    violations.push('name: field missing or empty');
  } else if (!/^gsd[:-]/.test(fm.name.trim())) {
    violations.push(`name: must start with "gsd:" or "gsd-", got "${fm.name.trim()}"`);
  }

  // 2. description: present + non-empty
  if (!fm.description || !fm.description.trim()) {
    violations.push('description: field missing or empty');
  }

  // 3. allowed-tools: present + non-empty + all entries canonical
  if (!fm['allowed-tools'] || !fm['allowed-tools'].trim()) {
    violations.push('allowed-tools: block missing or empty');
  } else {
    const tools = fm['allowed-tools'].split('\n').map(t => t.trim()).filter(Boolean);
    for (const tool of tools) {
      const valid =
        CANONICAL_TOOLS.has(tool) ||
        (tool.startsWith('mcp__context7__') && CANONICAL_TOOLS.has('mcp__context7__*'));
      if (!valid) violations.push(`allowed-tools: unknown tool "${tool}"`);
    }
  }

  // 4+5. execution_context @-refs resolve + no trailing prose
  const refs = extractExecutionContextRefs(content);
  for (const { token, normalized, trailingProse } of refs) {
    const absPath = path.join(GSD_ROOT, normalized);
    if (!fs.existsSync(absPath)) {
      violations.push(`execution_context: @-ref "${normalized}" does not exist on disk`);
    }
    if (trailingProse) {
      violations.push(`execution_context: @-ref "${token}" has trailing prose on the same line`);
    }
  }

  if (violations.length === 0) return null;
  return { file: rel, violations };
}

// ─── run ─────────────────────────────────────────────────────────────────────

function main() {
  const commandFiles = fs
    .readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(COMMANDS_DIR, f));

  const results = commandFiles.map(check).filter(Boolean);

  if (results.length === 0) {
    console.log(
      `ok lint-command-contract: ${commandFiles.length} command files checked, 0 violations`,
    );
    return 0;
  }

  const total = results.reduce((n, r) => n + r.violations.length, 0);
  process.stderr.write(
    `\nERROR lint-command-contract: ${total} violation(s) across ${results.length} file(s)\n\n`,
  );
  for (const r of results) {
    process.stderr.write(`  ${r.file}\n`);
    for (const v of r.violations) {
      process.stderr.write(`    - ${v}\n`);
    }
    process.stderr.write('\n');
  }
  process.stderr.write('See docs/adr/0002-command-contract-validation-module.md for the contract spec.\n\n');
  return 1;
}

runMain(main);
