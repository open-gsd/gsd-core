'use strict';
// allow-test-rule: source-text-is-the-product — workflows are executable instructions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const catalog = require('../gsd-core/bin/shared/model-catalog.json');

test('#5591 catalog contains the seven approved display choices and registered IDs', () => {
  assert.deepEqual(catalog.codexModelChoices, [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol (current)', description: 'Latest workhorse model for coding and everyday work' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier model for the most demanding work' },
    { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model' },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model' },
  ]);
  for (const choice of catalog.codexModelChoices) assert.ok(Object.hasOwn(catalog.codexModelEffort, choice.id));
});

test('#5591 workflows use catalog choices and gate availability', () => {
  const settings = fs.readFileSync(path.join(root, 'gsd-core/workflows/settings.md'), 'utf8');
  const advanced = fs.readFileSync(path.join(root, 'gsd-core/workflows/settings-advanced.md'), 'utf8');
  assert.match(settings, /\/gsd:config --advanced/);
  assert.match(advanced, /codexModelChoices/);
  assert.match(advanced, /only offer as selectable entries the IDs the user confirms are available/);
  assert.match(advanced, /Map the chosen entry back to its catalog `id`/);
});
