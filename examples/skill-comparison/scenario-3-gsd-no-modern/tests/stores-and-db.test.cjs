'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { STORES } = require('../src/stores.cjs');
const { createStoreClickRepository } = require('../src/db.cjs');

test('store seed exposes multiple SandboxVR locations', () => {
  assert.ok(Array.isArray(STORES));
  assert.ok(STORES.length >= 5);
  assert.equal(STORES[0].brand, 'SandboxVR');
  assert.ok(STORES.every((store) => store.id && store.name && store.city && store.country));
});

test('sqlite repository increments and persists click counts per store', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-map-db-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const repository = createStoreClickRepository({ dbPath });

  assert.equal(repository.getCount('sandboxvr-san-francisco'), 0);
  assert.equal(repository.increment('sandboxvr-san-francisco'), 1);
  assert.equal(repository.increment('sandboxvr-san-francisco'), 2);
  assert.equal(repository.increment('sandboxvr-london'), 1);
  assert.equal(repository.getCount('sandboxvr-san-francisco'), 2);

  repository.close();

  const reopened = createStoreClickRepository({ dbPath });
  assert.equal(reopened.getCount('sandboxvr-san-francisco'), 2);
  assert.equal(reopened.getCount('sandboxvr-london'), 1);
  reopened.close();
});
