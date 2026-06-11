'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createStoreClickRepository } = require('../src/db');

function makeTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-db-'));
  return path.join(tempDir, 'clicks.sqlite');
}

test('repository initializes counters at zero for every configured store', (t) => {
  const repository = createStoreClickRepository({ dbPath: makeTempDbPath() });
  t.after(() => repository.close());

  const counts = repository.listCounts();

  assert.equal(counts.length, 8);
  assert.deepEqual(
    counts.map((entry) => entry.clickCount),
    Array(8).fill(0)
  );
  assert.ok(counts.every((entry) => typeof entry.storeId === 'string'));
});

test('repository increments and persists click counts per store', (t) => {
  const dbPath = makeTempDbPath();
  const repository = createStoreClickRepository({ dbPath });
  t.after(() => repository.close());

  assert.equal(repository.recordClick('san-francisco').clickCount, 1);
  assert.equal(repository.recordClick('san-francisco').clickCount, 2);
  assert.equal(repository.recordClick('london').clickCount, 1);
  repository.close();

  const reloaded = createStoreClickRepository({ dbPath });
  t.after(() => reloaded.close());

  assert.equal(reloaded.getCount('san-francisco'), 2);
  assert.equal(reloaded.getCount('london'), 1);
  assert.equal(reloaded.getCount('singapore'), 0);
});

test('repository rejects unknown stores', (t) => {
  const repository = createStoreClickRepository({ dbPath: makeTempDbPath() });
  t.after(() => repository.close());

  assert.throws(() => repository.recordClick('unknown-store'), /Unknown store/);
});
