'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStoreRepository } = require('../src/db.cjs');
const { STORES } = require('../src/store-data.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-'));
}

test('repository seeds stores with zero click counts', () => {
  const tempDir = makeTempDir();
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const repo = createStoreRepository({ dbPath, stores: STORES });

  const stores = repo.listStores();

  assert.equal(stores.length, STORES.length);
  assert.equal(stores[0].clickCount, 0);
  assert.equal(stores[0].id, STORES[0].id);

  repo.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('repository increments and persists click counts by store', () => {
  const tempDir = makeTempDir();
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  let repo = createStoreRepository({ dbPath, stores: STORES });

  const firstClick = repo.incrementClickCount(STORES[1].id);
  const secondClick = repo.incrementClickCount(STORES[1].id);

  assert.equal(firstClick.clickCount, 1);
  assert.equal(secondClick.clickCount, 2);
  repo.close();

  repo = createStoreRepository({ dbPath, stores: STORES });
  const reloadedStore = repo.listStores().find((store) => store.id === STORES[1].id);

  assert.equal(reloadedStore.clickCount, 2);

  repo.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
