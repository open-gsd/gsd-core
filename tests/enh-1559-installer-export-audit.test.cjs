'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

let installer;
let conversion;

before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  installer = require('../bin/install.js');
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

describe('bin/install.js compatibility export audit (#1559)', () => {
  test('retains audited compatibility relays for shared rewrite helpers', () => {
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
    assert.strictEqual(
      installer.applyRuntimeContentRewritesForCommandsInPlace,
      conversion.applyRuntimeContentRewritesForCommandsInPlace,
    );
  });

  test('does not leak unaudited conversion-module helpers through the installer', () => {
    for (const name of [
      'yamlQuote',
      'toSingleLine',
      'extractFrontmatterAndBody',
      'extractFrontmatterField',
      'convertClaudeToCursorMarkdown',
      'convertClaudeToCodexMarkdown',
      'transformContentToHyphen',
      'claudeToGeminiTools',
      'convertGeminiToolName',
      'rewriteStagedSkillBodies',
      'rewriteStagedCommandBodies',
      '_computePathPrefix',
      '_stampNonClaudeRuntimeDefaults',
      'NON_CLAUDE_RUNTIMES',
    ]) {
      assert.ok(name in conversion, `${name} remains available from the conversion module`);
      assert.equal(installer[name], undefined, `${name} is not an installer compatibility export`);
    }
  });
});
