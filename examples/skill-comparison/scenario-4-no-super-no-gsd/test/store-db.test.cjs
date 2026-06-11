'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStoreRepository } = require('../src/store-repository.cjs');
const { stores } = require('../src/stores.cjs');

test('store repository initializes every SandboxVR location with zero clicks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-store-db-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');

  const repository = createStoreRepository({ dbPath, stores });
  const allStores = repository.listStores();

  assert.equal(allStores.length, stores.length);
  assert.deepEqual(
    allStores.map((store) => ({ id: store.id, clickCount: store.clickCount })),
    stores.map((store) => ({ id: store.id, clickCount: 0 }))
  );

  repository.close();
});

test('store repository increments and persists per-store click counts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-store-db-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');

  const repository = createStoreRepository({ dbPath, stores });
  const firstResult = repository.recordClick('sandboxvr-austin');
  repository.close();

  const reopened = createStoreRepository({ dbPath, stores });
  const secondResult = reopened.recordClick('sandboxvr-austin');
  const selectedStore = reopened.getStoreById('sandboxvr-austin');

  assert.equal(firstResult.clickCount, 1);
  assert.equal(secondResult.clickCount, 2);
  assert.equal(selectedStore.clickCount, 2);

  reopened.close();
});
