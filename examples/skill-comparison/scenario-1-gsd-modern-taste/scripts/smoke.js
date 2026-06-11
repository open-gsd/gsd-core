'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAppServer } = require('../src/server');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxvr-store-map-s1-smoke-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const app = createAppServer({ dbPath });
  await app.listen(0);

  try {
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const initial = await fetch(`${baseUrl}/api/stores`).then((response) => response.json());
    const firstStore = initial.stores[0];
    const before = firstStore.clickCount;
    const clicked = await fetch(`${baseUrl}/api/stores/${firstStore.id}/click`, { method: 'POST' }).then((response) => response.json());
    const after = await fetch(`${baseUrl}/api/stores`).then((response) => response.json());
    const refreshed = after.stores.find((store) => store.id === firstStore.id);

    process.stdout.write(JSON.stringify({
      storeId: firstStore.id,
      before,
      after: clicked.store.clickCount,
      persisted: refreshed.clickCount,
      dbPath
    }, null, 2));
    process.stdout.write('\n');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
