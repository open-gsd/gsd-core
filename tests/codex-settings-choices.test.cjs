'use strict';
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
  const choiceIds = catalog.codexModelChoices.map(({ id }) => id).sort();
  const effortIds = Object.keys(catalog.codexModelEffort).filter((id) => id !== '_baseline').sort();
  assert.deepEqual(choiceIds, effortIds, 'the display choices and registered Codex effort IDs stay in sync');
});

test('#5591 workflow reads catalog choices and maps selections back to IDs', () => {
  const advanced = fs.readFileSync(path.join(root, 'gsd-core/workflows/settings-advanced.md'), 'utf8');
  assert.match(advanced, /codexModelChoices/);
  assert.match(advanced, /Map a catalog choice back to its `id`/);
});
