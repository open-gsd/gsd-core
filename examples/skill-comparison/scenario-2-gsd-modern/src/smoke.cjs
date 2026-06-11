'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAppServer } = require('./server.cjs');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-smoke-'));
  const dbPath = path.join(tempDir, 'store-clicks.sqlite');
  const server = createAppServer({ dbPath });

  try {
    await server.start(0);
    const beforeResponse = await fetch(`${server.origin}/api/stores`);
    const beforePayload = await beforeResponse.json();
    const store = beforePayload.stores[0];

    const clickResponse = await fetch(`${server.origin}/api/stores/${store.id}/click`, {
      method: 'POST'
    });
    const clickPayload = await clickResponse.json();

    const afterResponse = await fetch(`${server.origin}/api/stores`);
    const afterPayload = await afterResponse.json();
    const updatedStore = afterPayload.stores.find((entry) => entry.id === store.id);

    process.stdout.write(JSON.stringify({
      storeId: store.id,
      before: store.clickCount,
      after: updatedStore.clickCount,
      apiReturned: clickPayload.store.clickCount,
      dbPath
    }, null, 2));
    process.stdout.write('\n');
  } finally {
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
