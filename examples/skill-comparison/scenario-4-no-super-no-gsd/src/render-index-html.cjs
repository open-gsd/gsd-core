'use strict';

const { stores } = require('./stores.cjs');

function renderStoreListItems() {
  return stores.map((store) => `
    <li>
      <button class="store-button" type="button" data-store-id="${store.id}">
        <span class="store-name">${store.name}</span>
        <span class="store-city">${store.city}</span>
      </button>
    </li>
  `).join('');
}

function renderMapMarkers() {
  return stores.map((store) => `
    <button
      class="map-marker"
      type="button"
      data-store-id="${store.id}"
      style="left: ${store.x}%; top: ${store.y}%;"
      aria-label="${store.name} marker"
    >●</button>
  `).join('');
}

function renderIndexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SandboxVR Store Explorer</title>
    <style>
      :root { color-scheme: dark; font-family: Arial, sans-serif; }
      body { margin: 0; background: #111827; color: #f9fafb; }
      .layout { display: grid; grid-template-columns: minmax(280px, 360px) 1fr minmax(280px, 360px); gap: 1rem; min-height: 100vh; padding: 1rem; box-sizing: border-box; }
      .panel { background: #1f2937; border: 1px solid #374151; border-radius: 14px; padding: 1rem; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22); }
      h1, h2 { margin-top: 0; }
      .eyebrow { color: #93c5fd; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.8rem; }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
      .store-button { width: 100%; border: 1px solid #4b5563; border-radius: 10px; background: #111827; color: inherit; padding: 0.85rem; text-align: left; cursor: pointer; display: grid; gap: 0.2rem; }
      .store-button:hover, .store-button.is-selected, .map-marker:hover, .map-marker.is-selected { border-color: #93c5fd; box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.25); }
      .store-name { font-weight: 700; }
      .store-city { color: #cbd5e1; }
      .map-surface { position: relative; min-height: 420px; border-radius: 18px; border: 2px dashed #60a5fa; background: radial-gradient(circle at top, rgba(96, 165, 250, 0.25), transparent 40%), linear-gradient(135deg, #0f172a, #111827 55%, #172554); overflow: hidden; }
      .map-grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px); background-size: 42px 42px; }
      .map-copy { position: absolute; left: 1rem; bottom: 1rem; max-width: 260px; background: rgba(17, 24, 39, 0.88); padding: 0.75rem 0.9rem; border-radius: 12px; }
      .map-marker { position: absolute; transform: translate(-50%, -50%); border-radius: 999px; border: 1px solid #dbeafe; background: #2563eb; color: #eff6ff; width: 2.1rem; height: 2.1rem; cursor: pointer; }
      .detail-list { display: grid; gap: 0.6rem; }
      .detail-card { border-top: 1px solid #374151; margin-top: 1rem; padding-top: 1rem; }
      .pill-row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .pill { background: #1d4ed8; border-radius: 999px; padding: 0.35rem 0.7rem; font-size: 0.85rem; }
      .meta { color: #cbd5e1; }
      @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main class="layout">
      <section class="panel">
        <div class="eyebrow">Scenario s4-no-super-no-gsd</div>
        <h1>SandboxVR Store Explorer</h1>
        <p>Browse seeded SandboxVR locations and watch click counts persist locally in SQLite.</p>
        <ul data-testid="store-list" aria-label="SandboxVR stores">${renderStoreListItems()}</ul>
      </section>
      <section class="panel">
        <h2>Interactive map placeholder</h2>
        <div class="map-surface" data-testid="map-surface" aria-label="SandboxVR map placeholder">
          <div class="map-grid" aria-hidden="true"></div>
          ${renderMapMarkers()}
          <div class="map-copy">
            <strong>Placeholder map surface</strong>
            <p>Markers are interactive buttons wired to the same click-count logging path as the store list.</p>
          </div>
        </div>
      </section>
      <aside class="panel" data-testid="store-detail">
        <h2>Store details</h2>
        <div id="store-detail-content" class="detail-list">
          <p>Select a SandboxVR location to view its address, experiences, and persisted click count.</p>
        </div>
      </aside>
    </main>
    <script>
      window.__STORE_DATA__ = ${JSON.stringify(stores)};
    </script>
    <script src="/app.js"></script>
  </body>
</html>`;
}

module.exports = { renderIndexHtml };
