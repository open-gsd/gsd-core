'use strict';

const Database = require('better-sqlite3');

function createStoreClickRepository({ dbPath }) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_clicks (
      store_id TEXT PRIMARY KEY,
      click_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  const selectStatement = db.prepare(`
    SELECT click_count
    FROM store_clicks
    WHERE store_id = ?
  `);

  const upsertStatement = db.prepare(`
    INSERT INTO store_clicks (store_id, click_count)
    VALUES (?, 1)
    ON CONFLICT(store_id) DO UPDATE SET click_count = click_count + 1
    RETURNING click_count
  `);

  return {
    getCount(storeId) {
      const row = selectStatement.get(storeId);
      return row ? row.click_count : 0;
    },
    increment(storeId) {
      const row = upsertStatement.get(storeId);
      return row.click_count;
    },
    close() {
      db.close();
    },
  };
}

module.exports = {
  createStoreClickRepository,
};
