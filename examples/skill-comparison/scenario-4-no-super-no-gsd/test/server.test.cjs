'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAppServer } = require('../src/server.cjs');

async function startTestServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-store-server-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const server = createAppServer({ dbPath, port: 0 });
  await server.start();
  return server;
}

test('server serves the app shell with placeholder map and detail panel', async (t) => {
  const server = await startTestServer();
  t.after(async () => {
    await server.stop();
  });

  const response = await fetch(`${server.baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Interactive map placeholder/i);
  assert.match(html, /Store details/i);
  assert.match(html, /SandboxVR Store Explorer/i);
});

test('server exposes stores and records click counts through HTTP', async (t) => {
  const server = await startTestServer();
  t.after(async () => {
    await server.stop();
  });

  const listResponse = await fetch(`${server.baseUrl}/api/stores`);
  const storesPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(storesPayload.stores));
  assert.equal(storesPayload.stores[0].clickCount, 0);

  const clickResponse = await fetch(`${server.baseUrl}/api/stores/sandboxvr-austin/click`, {
    method: 'POST'
  });
  const clickedStore = await clickResponse.json();

  assert.equal(clickResponse.status, 200);
  assert.equal(clickedStore.store.id, 'sandboxvr-austin');
  assert.equal(clickedStore.store.clickCount, 1);

  const detailResponse = await fetch(`${server.baseUrl}/api/stores/sandboxvr-austin`);
  const detailPayload = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detailPayload.store.clickCount, 1);
});
