'use strict';

// allow-test-rule: source-text-is-the-product
// The deployed settings.md IS the product — testing its text content tests the deployed contract.

/**
 * Regression test for issue #33
 *
 * model_profile UI shows 4 options, schema has 5 — `adaptive` missing from
 * `settings.md` AskUserQuestion.
 *
 * The schema (sdk/shared/model-catalog.json `profiles` array) defines 5 valid
 * model_profile values: quality, balanced, budget, adaptive, inherit. The
 * settings.md AskUserQuestion block for model_profile originally listed only 4
 * options (Quality, Balanced, Budget, Inherit) — `adaptive` was missing.
 *
 * Fix: the model_profile selection uses a two-question split. Q1 routes between
 * Adaptive / Standard-tier / Inherit (3 options). Q2 (only when Q1 = Standard)
 * asks Quality / Balanced / Budget. This keeps every individual options array
 * within the AskUserQuestion 4-option cap while making all 5 profiles reachable.
 *
 * Fixes: #33
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(REPO_ROOT, 'get-shit-done', 'workflows', 'settings.md');
const CATALOG_PATH = path.join(REPO_ROOT, 'sdk', 'shared', 'model-catalog.json');

/**
 * Collect every label: "..." value within a text block, lowercased.
 */
function extractOptionLabels(block) {
  const re = /label:\s*"([^"]+)"/g;
  const labels = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    labels.push(m[1].toLowerCase());
  }
  return labels;
}

describe('issue #33: model_profile schema and settings.md UI are in sync', () => {
  let catalog;
  let settingsContent;
  let presentBlock;

  before(() => {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    settingsContent = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const presentMatch = settingsContent.match(/<step name="present_settings">[\s\S]*?<\/step>/);
    assert.ok(presentMatch, 'settings.md must contain a present_settings step');
    presentBlock = presentMatch[0];
  });

  // -- (a) Schema contract ---------------------------------------------------

  test('schema lists exactly 5 model_profile values', () => {
    assert.ok(
      Array.isArray(catalog.profiles),
      'sdk/shared/model-catalog.json must have a "profiles" array'
    );
    assert.strictEqual(
      catalog.profiles.length,
      5,
      'Expected 5 model_profile values in schema, got ' + catalog.profiles.length + ': [' + catalog.profiles.join(', ') + ']'
    );
  });

  test('schema includes adaptive as a model_profile value', () => {
    assert.ok(
      catalog.profiles.includes('adaptive'),
      '"adaptive" must be in sdk/shared/model-catalog.json profiles. Got: [' + catalog.profiles.join(', ') + ']'
    );
  });

  test('schema includes all expected model_profile values', () => {
    const expected = ['quality', 'balanced', 'budget', 'adaptive', 'inherit'];
    for (const profile of expected) {
      assert.ok(
        catalog.profiles.includes(profile),
        'Schema must include "' + profile + '" in profiles. Got: [' + catalog.profiles.join(', ') + ']'
      );
    }
  });

  // -- (b) UI contract — all 5 profiles reachable via present_settings -------

  test('present_settings includes Adaptive as a selectable option (#33)', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'adaptive' || l.startsWith('adaptive')),
      'Issue #33: present_settings must include an "Adaptive" label in its model_profile AskUserQuestion options so users can select it interactively. Got labels: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Quality as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'quality' || l.startsWith('quality')),
      'present_settings must include a "Quality" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Balanced as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'balanced' || l.startsWith('balanced')),
      'present_settings must include a "Balanced" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Budget as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'budget' || l.startsWith('budget')),
      'present_settings must include a "Budget" option. Got: [' + labels.join(', ') + ']'
    );
  });

  test('present_settings includes Inherit as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'inherit' || l.startsWith('inherit')),
      'present_settings must include an "Inherit" option. Got: [' + labels.join(', ') + ']'
    );
  });

  // -- 4-option cap guard ----------------------------------------------------

  test('each options array in present_settings has at most 4 entries (AskUserQuestion cap)', () => {
    const ASK_CAP = 4;
    const optionsKeyRe = /\boptions\s*:\s*\[/g;
    let match;
    let questionIndex = 0;
    while ((match = optionsKeyRe.exec(presentBlock)) !== null) {
      questionIndex++;
      let depth = 0;
      const start = match.index + match[0].length - 1;
      let end = start;
      for (let k = start; k < presentBlock.length; k++) {
        if (presentBlock[k] === '[') depth++;
        else if (presentBlock[k] === ']') {
          depth--;
          if (depth === 0) { end = k; break; }
        }
      }
      const body = presentBlock.slice(start, end + 1);
      const count = (body.match(/label:\s*"[^"]+"/g) || []).length;
      assert.ok(
        count <= ASK_CAP,
        'Question object ' + questionIndex + ' in present_settings has ' + count + ' options — exceeds the AskUserQuestion runtime cap of ' + ASK_CAP
      );
    }
    assert.ok(questionIndex > 0, 'present_settings must contain at least one AskUserQuestion options array');
  });

  // -- update_config and confirm steps reference adaptive --------------------

  test('update_config step lists adaptive as a valid model_profile value', () => {
    const m = settingsContent.match(/<step name="update_config">[\s\S]*?<\/step>/);
    assert.ok(m, 'settings.md must have an update_config step');
    assert.ok(
      m[0].includes('adaptive'),
      'update_config step must list "adaptive" as a valid model_profile value'
    );
  });

  test('confirm step table shows adaptive as a possible model profile value', () => {
    const m = settingsContent.match(/<step name="confirm">[\s\S]*?<\/step>/);
    assert.ok(m, 'settings.md must have a confirm step');
    assert.ok(
      m[0].includes('adaptive'),
      'confirm step must include "adaptive" in the Model Profile row'
    );
  });
});
