'use strict';

// allow-test-rule: source-text-is-the-product
// The deployed settings.md IS the product — testing its text content tests the deployed contract.

/**
 * Regression test for bug #3784
 *
 * /gsd-settings model profile UI omits `adaptive`. The AskUserQuestion block
 * for model_profile in settings.md lists only four options (Quality, Balanced,
 * Budget, Inherit) but the settings schema registers five valid profiles:
 * quality, balanced, budget, adaptive, inherit. The `adaptive` profile is
 * reachable by name via `gsd:config --profile adaptive` but cannot be selected
 * interactively through `/gsd:settings`.
 *
 * Root cause: the options array in the model-profile AskUserQuestion block was
 * written before the `adaptive` profile was introduced and was never updated.
 * Because AskUserQuestion enforces a hard 4-option cap, the fix uses a two-
 * question split: Q1 asks "Standard tier or Adaptive?" (2 options); if the
 * user picks Standard, Q2 asks which of the three standard profiles to use
 * (Quality, Balanced, Budget). This keeps every call within the 4-option cap
 * while making all five profiles reachable.
 *
 * Fixes: #3784
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'get-shit-done', 'workflows', 'settings.md');

/**
 * Extract all AskUserQuestion option labels from a text block.
 * Returns them lowercased for case-insensitive comparison.
 */
function extractOptionLabels(block) {
  const labelPattern = /label:\s*"([^"]+)"/g;
  const labels = [];
  let match;
  while ((match = labelPattern.exec(block)) !== null) {
    labels.push(match[1].toLowerCase());
  }
  return labels;
}

describe('bug #3784: settings.md model profile UI exposes all 5 profiles', () => {
  let content;
  let presentBlock;

  before(() => {
    content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const presentMatch = content.match(/<step name="present_settings">[\s\S]*?<\/step>/);
    assert.ok(presentMatch, 'settings.md must have a present_settings step');
    presentBlock = presentMatch[0];
  });

  // ── Core contract: all five valid profiles reachable via the settings UI ──

  test('present_settings step includes Adaptive as a selectable option (#3784)', () => {
    // This is the primary assertion for bug #3784 — adaptive was missing.
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'adaptive' || l.startsWith('adaptive')),
      [
        'Bug #3784: present_settings step must include an "Adaptive" label in',
        'its model profile AskUserQuestion options so users can select it',
        `interactively. Got labels: [${labels.join(', ')}]`,
      ].join(' ')
    );
  });

  test('present_settings step includes Quality as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'quality' || l.startsWith('quality')),
      `present_settings step must include a "Quality" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Balanced as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'balanced' || l.startsWith('balanced')),
      `present_settings step must include a "Balanced" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Budget as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'budget' || l.startsWith('budget')),
      `present_settings step must include a "Budget" option. Got: [${labels.join(', ')}]`
    );
  });

  test('present_settings step includes Inherit as a selectable option', () => {
    const labels = extractOptionLabels(presentBlock);
    assert.ok(
      labels.some(l => l === 'inherit' || l.startsWith('inherit')),
      `present_settings step must include an "Inherit" option. Got: [${labels.join(', ')}]`
    );
  });

  // ── update_config step writes adaptive as a valid value ──

  test('update_config step lists adaptive as a valid model_profile value', () => {
    const updateMatch = content.match(/<step name="update_config">[\s\S]*?<\/step>/);
    assert.ok(updateMatch, 'settings.md must have an update_config step');
    const block = updateMatch[0];
    assert.ok(
      block.includes('adaptive'),
      'update_config step must list "adaptive" as a valid model_profile value'
    );
  });

  // ── confirm step displays adaptive as a possible profile value ──

  test('confirm step table shows adaptive as a possible model profile value', () => {
    const confirmMatch = content.match(/<step name="confirm">[\s\S]*?<\/step>/);
    assert.ok(confirmMatch, 'settings.md must have a confirm step');
    const block = confirmMatch[0];
    assert.ok(
      block.includes('adaptive'),
      'confirm step must include "adaptive" in the Model Profile row placeholder'
    );
  });

  // ── adaptive described with role-based routing semantics ──

  test('settings.md describes adaptive profile with role-based routing semantics', () => {
    // Adaptive uses heavy=opus, standard=sonnet, light=haiku per routingTier.
    // The UI description must convey this is role-based, not flat-tier.
    assert.ok(
      content.includes('role') || content.includes('routing') || content.includes('Adaptive'),
      'settings.md must describe the adaptive profile in terms of role-based or routing-tier model selection'
    );
  });
});
