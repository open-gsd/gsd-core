'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../src/server.cjs');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's4-store-smoke-'));
  const dbPath = path.join(tempDir, 'clicks.sqlite');
  const server = createAppServer({ dbPath, port: 0 });

  await server.start();

  try {
    const clickResponse = await fetch(`${server.baseUrl}/api/stores/sandboxvr-austin/click`, { method: 'POST' });
    const clickPayload = await clickResponse.json();
    const detailResponse = await fetch(`${server.baseUrl}/api/stores/sandboxvr-austin`);
    const detailPayload = await detailResponse.json();

    process.stdout.write(JSON.stringify({
      clickStatus: clickResponse.status,
      detailStatus: detailResponse.status,
      store: detailPayload.store,
      smokeDbPath: dbPath,
      clickPayload
    }, null, 2));
    process.stdout.write('\n');
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
