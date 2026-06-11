'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createStoreRepository({ dbPath, stores }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_clicks (
      store_id TEXT PRIMARY KEY,
      click_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const seed = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count)
    VALUES (?, 0)
    ON CONFLICT(store_id) DO NOTHING
  `);

  for (const store of stores) {
    seed.run(store.id);
  }

  const listStatement = db.prepare(`
    SELECT store_id, click_count
    FROM store_clicks
  `);
  const incrementStatement = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count)
    VALUES (?, 1)
    ON CONFLICT(store_id) DO UPDATE SET click_count = click_count + 1
    RETURNING store_id, click_count
  `);

  function listStores() {
    const counts = new Map(listStatement.all().map((row) => [row.store_id, row.click_count]));
    return stores.map((store) => ({
      ...store,
      clickCount: counts.get(store.id) ?? 0
    }));
  }

  function incrementClickCount(storeId) {
    const match = stores.find((store) => store.id === storeId);
    if (!match) {
      return null;
    }

    const row = incrementStatement.get(storeId);
    return {
      ...match,
      clickCount: row.click_count
    };
  }

  return {
    listStores,
    incrementClickCount,
    close() {
      db.close();
    }
  };
}

module.exports = {
  createStoreRepository
};
