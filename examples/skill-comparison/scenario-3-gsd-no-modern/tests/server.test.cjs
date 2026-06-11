'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAppServer } = require('../src/server.cjs');

test('server serves app shell, store list, and click logging endpoint', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-map-server-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const server = createAppServer({ dbPath });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const pageResponse = await fetch(baseUrl + '/');
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /SandboxVR Store Map/);
    assert.match(pageHtml, /placeholder map/i);

    const storesResponse = await fetch(baseUrl + '/api/stores');
    assert.equal(storesResponse.status, 200);
    const storesPayload = await storesResponse.json();
    assert.ok(Array.isArray(storesPayload.stores));
    assert.ok(storesPayload.stores.length >= 5);
    assert.equal(storesPayload.stores[0].clickCount, 0);

    const firstStoreId = storesPayload.stores[0].id;
    const clickResponse = await fetch(baseUrl + `/api/stores/${firstStoreId}/click`, {
      method: 'POST'
    });
    assert.equal(clickResponse.status, 200);
    const clickPayload = await clickResponse.json();
    assert.equal(clickPayload.storeId, firstStoreId);
    assert.equal(clickPayload.clickCount, 1);

    const refreshedResponse = await fetch(baseUrl + '/api/stores');
    const refreshedPayload = await refreshedResponse.json();
    const refreshedStore = refreshedPayload.stores.find((store) => store.id === firstStoreId);
    assert.equal(refreshedStore.clickCount, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
