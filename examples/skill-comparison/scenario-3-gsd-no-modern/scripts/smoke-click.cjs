'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createAppServer } = require('../src/server.cjs');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-map-smoke-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const server = createAppServer({ dbPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const storesResponse = await fetch(baseUrl + '/api/stores');
    const storesPayload = await storesResponse.json();
    const firstStore = storesPayload.stores[0];
    const clickResponse = await fetch(baseUrl + `/api/stores/${firstStore.id}/click`, { method: 'POST' });
    const clickPayload = await clickResponse.json();
    const refreshedResponse = await fetch(baseUrl + '/api/stores');
    const refreshedPayload = await refreshedResponse.json();
    const refreshedStore = refreshedPayload.stores.find((store) => store.id === firstStore.id);

    process.stdout.write(JSON.stringify({
      firstStore: firstStore.id,
      clickPayload,
      refreshedCount: refreshedStore.clickCount,
      dbPath,
    }, null, 2) + '\n');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
