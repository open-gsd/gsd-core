'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  getDirName,
  getGlobalDir,
  getConfigDirFromHome,
  runtimeMap,
  allRuntimes,
  parseRuntimeInput,
  buildRuntimePromptText,
  convertClaudeToMimoAgentFrontmatter,
  selectRuntimesFromArgs,
} = require('../bin/install.js');

describe('MiMoCode runtime directory mapping', () => {
  test('getDirName returns .mimocode for local installs', () => {
    assert.strictEqual(getDirName('mimo'), '.mimocode');
  });

  test('getGlobalDir returns ~/.config/mimocode for global installs', () => {
    assert.strictEqual(getGlobalDir('mimo'), path.join(os.homedir(), '.config', 'mimocode'));
  });

  test('getConfigDirFromHome returns .config/mimocode fragment', () => {
    assert.strictEqual(getConfigDirFromHome('mimo', false), "'.mimocode'");
    assert.strictEqual(getConfigDirFromHome('mimo', true), "'.config', 'mimocode'");
  });
});

describe('getGlobalDir (MiMoCode)', () => {
  test('returns ~/.config/mimocode with no explicit dir', () => {
    const result = getGlobalDir('mimo');
    assert.strictEqual(result, path.join(os.homedir(), '.config', 'mimocode'));
  });

  test('returns explicit dir when provided', () => {
    const result = getGlobalDir('mimo', '/custom/mimocode-path');
    assert.strictEqual(result, '/custom/mimocode-path');
  });

  test('does not break other runtimes', () => {
    assert.strictEqual(getGlobalDir('claude'), path.join(os.homedir(), '.claude'));
    assert.strictEqual(getGlobalDir('codex'), path.join(os.homedir(), '.codex'));
  });
});

describe('MiMoCode in runtime selection', () => {
  test('option 17 selects mimo', () => {
    assert.deepStrictEqual(parseRuntimeInput('17'), ['mimo']);
  });

  test('--mimo flag selects mimo without interactive prompt', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--mimo']), ['mimo']);
  });

  test('--all includes mimo exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('mimo'), '--all includes mimo');
    assert.strictEqual(selected.filter((runtime) => runtime === 'mimo').length, 1);
  });

  test('runtimeMap maps 17 to mimo', () => {
    assert.strictEqual(runtimeMap['17'], 'mimo');
  });

  test('buildRuntimePromptText includes MiMoCode', () => {
    const text = buildRuntimePromptText();
    assert.ok(text.includes('MiMoCode'), 'prompt should mention MiMoCode');
    assert.ok(text.includes('mimocode'), 'prompt should show mimocode path');
  });
});

describe('convertClaudeToMimoAgentFrontmatter', () => {
  test('converts comma-separated tools and named colors to MiMoCode schema', () => {
    const input = `---
name: gsd-planner
description: Creates executable phase plans.
tools: Read, Write, Bash, Glob, Grep, WebFetch, mcp__context7__*
color: green
# hooks:
#   PostToolUse:
#     - matcher: "Write|Edit"
---

<body>`;

    const result = convertClaudeToMimoAgentFrontmatter(input);
    for (const tool of ['bash', 'glob', 'grep', 'read', 'write', 'webfetch']) {
      assert.match(result, new RegExp(`  ${tool}: true`));
    }
    assert.match(result, /color: "#00FF00"/);
    assert.match(result, /mode: subagent/);
    assert.doesNotMatch(result, /mcp__context7__/);
    assert.doesNotMatch(result, /# hooks:/);
    assert.match(result, /<body>/);
  });

  test('converts YAML list tools and preserves six-digit hex colors', () => {
    const input = `---
name: gsd-security-auditor
description: Security audit agent.
tools:
  - Read
  - Write
  - Edit
  - Bash
color: "#EF4444"
---

<body>`;

    const result = convertClaudeToMimoAgentFrontmatter(input);
    assert.match(result, /tools:\n  bash: true\n  edit: true\n  read: true\n  write: true/);
    assert.match(result, /color: "#EF4444"/);
  });
});

describe('MiMoCode install artifact layout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('mimo-test');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('getDirName returns .mimocode which is the correct local dir', () => {
    const dirName = getDirName('mimo');
    assert.strictEqual(dirName, '.mimocode');
    const localDir = path.join(tmpDir, dirName);
    fs.mkdirSync(localDir, { recursive: true });
    assert.ok(fs.existsSync(localDir), 'local .mimocode dir should exist');
  });

  test('getGlobalDir with explicit dir returns the custom path', () => {
    const customDir = path.join(tmpDir, 'custom-global');
    const result = getGlobalDir('mimo', customDir);
    assert.strictEqual(result, customDir);
  });

  test('allRuntimes includes mimo', () => {
    assert.ok(allRuntimes.includes('mimo'));
  });
});
