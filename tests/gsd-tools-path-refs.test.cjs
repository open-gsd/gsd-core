/**
 * Regression guards for shipped prompt references to gsd-tools.cjs.
 *
 * Command and agent prompts must instruct clean installs to use the supported
 * `gsd-tools query` binary, not the removed standalone `gsd-sdk query` binary.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

function mdFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(dir, f));
}

function rel(file) {
  return path.relative(path.join(__dirname, '..'), file);
}

describe('command files: gsd-tools path references (#1766)', () => {
  test('shipped agents and commands do not instruct removed SDK query binaries', () => {
    const files = [...mdFiles(COMMANDS_DIR), ...mdFiles(AGENTS_DIR)];
    const violations = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\bgsd-sdk\s+query\b|\$GSD_SDK\s+query/.test(lines[i])) {
          violations.push(`${rel(file)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.strictEqual(violations.length, 0,
      'Shipped agent/command prompts must use gsd-tools query, not removed SDK query forms.\n' +
      'Violations:\n' + violations.join('\n'));
  });

  test('workstreams.md documents the supported gsd-tools query binary', () => {
    const content = fs.readFileSync(
      path.join(COMMANDS_DIR, 'workstreams.md'), 'utf-8'
    );

    assert.ok(
      /gsd-tools query workstream\.list/.test(content),
      'workstreams.md should document gsd-tools query workstream.list'
    );
  });
});
