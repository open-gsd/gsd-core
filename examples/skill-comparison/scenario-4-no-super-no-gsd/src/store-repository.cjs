'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createStoreRepository({ dbPath, stores }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS store_clicks (
      store_id TEXT PRIMARY KEY,
      click_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const ensureStore = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count)
    VALUES (?, 0)
    ON CONFLICT(store_id) DO NOTHING
  `);

  for (const store of stores) {
    ensureStore.run(store.id);
  }

  const selectAll = db.prepare(`
    SELECT store_id, click_count
    FROM store_clicks
  `);
  const selectOne = db.prepare(`
    SELECT click_count
    FROM store_clicks
    WHERE store_id = ?
  `);
  const increment = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count)
    VALUES (?, 1)
    ON CONFLICT(store_id) DO UPDATE SET click_count = click_count + 1
  `);

  function hydrateStore(storeId) {
    const store = stores.find((entry) => entry.id === storeId);
    if (!store) {
      return null;
    }

    const row = selectOne.get(storeId);
    return {
      ...store,
      clickCount: row ? row.click_count : 0
    };
  }

  return {
    listStores() {
      const counts = new Map(selectAll.all().map((row) => [row.store_id, row.click_count]));
      return stores.map((store) => ({
        ...store,
        clickCount: counts.get(store.id) ?? 0
      }));
    },
    getStoreById(storeId) {
      return hydrateStore(storeId);
    },
    recordClick(storeId) {
      if (!stores.some((store) => store.id === storeId)) {
        return null;
      }

      increment.run(storeId);
      return hydrateStore(storeId);
    },
    close() {
      db.close();
    }
  };
}

module.exports = { createStoreRepository };
