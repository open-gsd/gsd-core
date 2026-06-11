'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAppServer } = require('../src/server.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-server-'));
}

async function startServer() {
  const tempDir = makeTempDir();
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const server = createAppServer({ dbPath });
  await server.start(0);
  return { server, tempDir };
}

test('GET / renders the placeholder map shell and store detail region', async (t) => {
  const { server, tempDir } = await startServer();
  t.after(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${server.origin}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /SandboxVR Store Explorer/);
  assert.match(html, /Interactive map placeholder/);
  assert.match(html, /Store details/);
});

test('GET \/api\/stores returns seeded stores with click counts', async (t) => {
  const { server, tempDir } = await startServer();
  t.after(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${server.origin}/api/stores`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.stores.length > 2, true);
  assert.equal(payload.stores[0].clickCount, 0);
  assert.ok(payload.stores[0].name);
});

test('POST \/api\/stores\/:id\/click increments and returns the selected store', async (t) => {
  const { server, tempDir } = await startServer();
  t.after(async () => {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const storesResponse = await fetch(`${server.origin}/api/stores`);
  const storesPayload = await storesResponse.json();
  const storeId = storesPayload.stores[0].id;

  const clickResponse = await fetch(`${server.origin}/api/stores/${storeId}/click`, {
    method: 'POST'
  });
  const clickPayload = await clickResponse.json();

  assert.equal(clickResponse.status, 200);
  assert.equal(clickPayload.store.id, storeId);
  assert.equal(clickPayload.store.clickCount, 1);

  const refreshedResponse = await fetch(`${server.origin}/api/stores`);
  const refreshedPayload = await refreshedResponse.json();
  const clickedStore = refreshedPayload.stores.find((store) => store.id === storeId);

  assert.equal(clickedStore.clickCount, 1);
});
