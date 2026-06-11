'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  getDirName,
  getGlobalDir,
  getConfigDirFromHome,
  runtimeMap,
  allRuntimes,
  parseRuntimeInput,
  buildRuntimePromptText,
  convertClaudeToCommandcodeAgentFrontmatter,
  selectRuntimesFromArgs,
} = require('../bin/install.js');

describe('Command Code runtime directory mapping', () => {
  test('getDirName returns .commandcode for local installs', () => {
    assert.strictEqual(getDirName('commandcode'), '.commandcode');
  });

  test('getGlobalDir returns ~/.commandcode for global installs', () => {
    assert.strictEqual(getGlobalDir('commandcode'), path.join(os.homedir(), '.commandcode'));
  });

  test('getConfigDirFromHome returns .commandcode fragment', () => {
    assert.strictEqual(getConfigDirFromHome('commandcode', false), "'.commandcode'");
    assert.strictEqual(getConfigDirFromHome('commandcode', true), "'.commandcode'");
  });
});

describe('Command Code in runtime selection', () => {
  test('option 18 selects commandcode', () => {
    assert.deepStrictEqual(parseRuntimeInput('18'), ['commandcode']);
  });

  test('--commandcode flag selects commandcode', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--commandcode']), ['commandcode']);
  });

  test('--all includes commandcode exactly once', () => {
    const selected = selectRuntimesFromArgs(['--all']);
    assert.ok(selected.includes('commandcode'));
    assert.strictEqual(selected.filter((runtime) => runtime === 'commandcode').length, 1);
  });

  test('runtimeMap maps 18 to commandcode', () => {
    assert.strictEqual(runtimeMap['18'], 'commandcode');
  });

  test('buildRuntimePromptText includes Command Code', () => {
    const text = buildRuntimePromptText();
    assert.ok(text.includes('Command Code'));
    assert.ok(text.includes('commandcode'));
  });

  test('allRuntimes includes commandcode', () => {
    assert.ok(allRuntimes.includes('commandcode'));
  });
});

describe('convertClaudeToCommandcodeAgentFrontmatter', () => {
  test('converts Claude agent frontmatter to Command Code schema', () => {
    const input = `---
name: gsd-planner
description: Creates executable phase plans.
tools: Read, Write, Bash, Glob, Grep, WebFetch
color: green
---

<body>`;

    const result = convertClaudeToCommandcodeAgentFrontmatter(input);
    assert.match(result, /  read: true/);
    assert.match(result, /color: "#00FF00"/);
    assert.match(result, /mode: subagent/);
    assert.match(result, /<body>/);
  });
});
