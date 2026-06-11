'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { sandboxVrStores, sandboxVrStoreIds } = require('./stores');

function createStoreClickRepository(options = {}) {
  const dbPath = options.dbPath || path.join(process.cwd(), 'data', 'store-clicks.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_clicks (
      store_id TEXT PRIMARY KEY,
      click_count INTEGER NOT NULL DEFAULT 0,
      last_clicked_at TEXT
    )
  `);

  const seedStore = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count, last_clicked_at)
    VALUES (@storeId, 0, NULL)
    ON CONFLICT(store_id) DO NOTHING
  `);

  const listCountsStatement = db.prepare(`
    SELECT store_id AS storeId, click_count AS clickCount, last_clicked_at AS lastClickedAt
    FROM store_clicks
    ORDER BY store_id
  `);

  const getCountStatement = db.prepare(`
    SELECT click_count AS clickCount
    FROM store_clicks
    WHERE store_id = ?
  `);

  const incrementStatement = db.prepare(`
    UPDATE store_clicks
    SET click_count = click_count + 1,
        last_clicked_at = @lastClickedAt
    WHERE store_id = @storeId
    RETURNING store_id AS storeId, click_count AS clickCount, last_clicked_at AS lastClickedAt
  `);

  for (const store of sandboxVrStores) {
    seedStore.run({ storeId: store.id });
  }

  function assertKnownStore(storeId) {
    if (!sandboxVrStoreIds.has(storeId)) {
      throw new Error(`Unknown store: ${storeId}`);
    }
  }

  return {
    dbPath,
    listCounts() {
      return listCountsStatement.all();
    },
    getCount(storeId) {
      assertKnownStore(storeId);
      return getCountStatement.get(storeId).clickCount;
    },
    recordClick(storeId) {
      assertKnownStore(storeId);
      return incrementStatement.get({
        storeId,
        lastClickedAt: new Date().toISOString()
      });
    },
    close() {
      db.close();
    }
  };
}

module.exports = {
  createStoreClickRepository
};
