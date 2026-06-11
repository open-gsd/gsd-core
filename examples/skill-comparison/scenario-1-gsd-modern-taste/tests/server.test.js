'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createAppServer } = require('../src/server');

function makeTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-server-'));
  return path.join(tempDir, 'clicks.sqlite');
}

async function startServer() {
  const server = createAppServer({ dbPath: makeTempDbPath() });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl };
}

test('server returns store list with click counts', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/stores`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stores.length, 8);
  assert.equal(body.stores[0].clickCount, 0);
  assert.match(body.stores[0].detailHref, /^https:\/\/sandboxvr\.com\//);
});

test('server records clicks and returns updated detail payload', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/stores/london/click`, {
    method: 'POST'
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.store.id, 'london');
  assert.equal(body.store.clickCount, 1);
  assert.equal(body.store.market, 'London, UK');

  const second = await fetch(`${baseUrl}/api/stores/london/click`, { method: 'POST' });
  const secondBody = await second.json();
  assert.equal(secondBody.store.clickCount, 2);
});

test('server renders the standalone application shell', async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());

  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /SandboxVR store explorer/i);
  assert.match(html, /Interactive map placeholder/i);
  assert.match(html, /Store details/i);
});
