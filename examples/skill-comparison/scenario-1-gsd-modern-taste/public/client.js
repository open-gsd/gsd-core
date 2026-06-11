'use strict';

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

function clampPercent(value, min, max) {
  const normalized = ((value - min) / (max - min || 1)) * 100;
  return Math.min(92, Math.max(8, normalized));
}

function renderDetail(store, totalClicks) {
  const hours = store.hours.map((item) => `<li>${item}</li>`).join('');
  return `
    <h3>${store.market}</h3>
    <p>${store.venue}</p>
    <div class="detail-meta">
      <div><dt>Address</dt><dd>${store.address}</dd></div>
      <div><dt>Pricing</dt><dd>${store.priceSummary}</dd></div>
      <div><dt>Click count</dt><dd>${store.clickCount}</dd></div>
      <div><dt>Total tracked clicks</dt><dd>${totalClicks}</dd></div>
    </div>
    <div>
      <dt>Hours</dt>
      <dd><ul>${hours}</ul></dd>
    </div>
    <p><a class="detail-link" href="${store.detailHref}" target="_blank" rel="noreferrer">Reference venue page</a></p>
  `;
}

function setActiveState(storeId) {
  document.querySelectorAll('[data-store-id]').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.storeId === storeId);
    node.setAttribute('aria-pressed', String(node.dataset.storeId === storeId));
  });
}

async function boot() {
  const { stores } = await fetchJson('/api/stores');
  const list = document.getElementById('store-list');
  const mapStage = document.getElementById('map-stage');
  const detailPanel = document.getElementById('detail-panel');
  const storeCount = document.getElementById('store-count');
  const totalClicks = document.getElementById('total-clicks');

  const bounds = stores.reduce((acc, store) => {
    acc.minLat = Math.min(acc.minLat, store.coordinates.lat);
    acc.maxLat = Math.max(acc.maxLat, store.coordinates.lat);
    acc.minLon = Math.min(acc.minLon, store.coordinates.lon);
    acc.maxLon = Math.max(acc.maxLon, store.coordinates.lon);
    return acc;
  }, { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity });

  async function selectStore(storeId, increment) {
    let nextStores = stores;
    if (increment) {
      const result = await fetchJson(`/api/stores/${encodeURIComponent(storeId)}/click`, { method: 'POST' });
      nextStores = stores.map((store) => store.id === storeId ? result.store : store);
      stores.splice(0, stores.length, ...nextStores);
    }

    const activeStore = nextStores.find((store) => store.id === storeId) || nextStores[0];
    const clickTotal = nextStores.reduce((sum, store) => sum + store.clickCount, 0);
    detailPanel.innerHTML = renderDetail(activeStore, clickTotal);
    totalClicks.textContent = String(clickTotal);
    storeCount.textContent = String(nextStores.length);
    setActiveState(activeStore.id);
    list.querySelectorAll('.pill').forEach((node) => {
      const cardStore = nextStores.find((store) => store.id === node.closest('[data-store-id]').dataset.storeId);
      node.textContent = `${cardStore.clickCount} tracked clicks`;
    });
  }

  function attachSelection(node, store) {
    node.addEventListener('click', () => selectStore(store.id, true));
  }

  stores.forEach((store) => {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'map-marker';
    marker.dataset.storeId = store.id;
    marker.setAttribute('aria-label', `Select ${store.market}`);
    marker.setAttribute('aria-pressed', 'false');
    marker.style.left = `${clampPercent(store.coordinates.lon, bounds.minLon, bounds.maxLon)}%`;
    marker.style.top = `${100 - clampPercent(store.coordinates.lat, bounds.minLat, bounds.maxLat)}%`;
    attachSelection(marker, store);
    mapStage.appendChild(marker);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'store-card';
    card.dataset.storeId = store.id;
    card.setAttribute('aria-pressed', 'false');
    card.innerHTML = `
      <h3>${store.market}</h3>
      <p>${store.venue}</p>
      <p>${store.address}</p>
      <span class="pill">${store.clickCount} tracked clicks</span>
    `;
    attachSelection(card, store);
    list.appendChild(card);
  });

  await selectStore(stores[0].id, false);
}

boot().catch((error) => {
  const detailPanel = document.getElementById('detail-panel');
  detailPanel.innerHTML = `<p>Unable to load store explorer: ${error.message}</p>`;
});
