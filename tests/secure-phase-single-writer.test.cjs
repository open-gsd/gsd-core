/**
 * Regression test for #2119: /gsd-secure-phase dual SECURITY.md writers.
 *
 * The gsd-security-auditor agent must NOT have Write/Edit tools — the
 * orchestrator (secure-phase.md Step 6) is the sole SECURITY.md writer.
 * The auditor returns a structured verdict; it never writes files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-security-auditor.md');

function parseYamlTools(content) {
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  let inTools = false;
  const tools = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      inFrontmatter = !inFrontmatter;
      if (!inFrontmatter) break;
      continue;
    }
    if (!inFrontmatter) continue;
    if (trimmed.startsWith('tools:')) {
      inTools = true;
      continue;
    }
    if (inTools) {
      if (trimmed.startsWith('- ')) {
        tools.push(trimmed.slice(2).trim());
      } else if (trimmed && !trimmed.startsWith('#')) {
        inTools = false;
      }
    }
  }
  return tools;
}

describe('#2119 — security auditor is return-only (no file writes)', () => {
  const content = fs.readFileSync(AGENT_PATH, 'utf-8');

  test('auditor tools do not include Write or Edit', () => {
    const tools = parseYamlTools(content);
    assert.ok(tools.length > 0, 'tools list should be non-empty');
    assert.ok(
      !tools.includes('Write'),
      `Write must not be in auditor tools (got: ${tools.join(', ')}) — orchestrator is the sole SECURITY.md writer (#2119)`,
    );
    assert.ok(
      !tools.includes('Edit'),
      `Edit must not be in auditor tools (got: ${tools.join(', ')}) — orchestrator is the sole SECURITY.md writer (#2119)`,
    );
  });

  test('auditor description does not claim to produce SECURITY.md', () => {
    const lines = content.split(/\r?\n/);
    const descLine = lines.find((l) => l.startsWith('description:'));
    assert.ok(descLine, 'description field must exist');
    assert.ok(
      !descLine.includes('Produces SECURITY.md'),
      'description must not claim to produce SECURITY.md — auditor returns a verdict, orchestrator writes (#2119)',
    );
    assert.ok(
      descLine.includes('Returns structured') || descLine.includes('returns'),
      'description should state the auditor returns a structured verdict',
    );
  });
});
