'use strict';

async function fetchStores() {
  const response = await fetch('/api/stores');
  if (!response.ok) {
    throw new Error('Failed to load stores');
  }
  return response.json();
}

async function clickStore(storeId) {
  const response = await fetch(`/api/stores/${storeId}/click`, {
    method: 'POST'
  });
  if (!response.ok) {
    throw new Error('Failed to log store click');
  }
  return response.json();
}

function markerLabel(store) {
  return `${store.city}, ${store.region}`;
}

function detailMarkup(store) {
  return `
    <article class="detail-card">
      <h3>${store.name}</h3>
      <p class="detail-location">${store.address}</p>
      <dl class="detail-grid">
        <div>
          <dt>Region</dt>
          <dd>${store.city}, ${store.region}</dd>
        </div>
        <div>
          <dt>Hours</dt>
          <dd>${store.hours}</dd>
        </div>
        <div>
          <dt>Experiences</dt>
          <dd>${store.experiences.join(', ')}</dd>
        </div>
        <div>
          <dt>Recorded clicks</dt>
          <dd>${store.clickCount}</dd>
        </div>
      </dl>
    </article>
  `;
}

function createStoreButton(store, activeId, onSelect) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'store-button';
  button.dataset.storeId = store.id;
  button.setAttribute('aria-pressed', String(store.id === activeId));
  button.innerHTML = `
    <span class="store-button__name">${store.name}</span>
    <span class="store-button__meta">${store.city}, ${store.region}</span>
    <span class="store-button__count">Clicks: ${store.clickCount}</span>
  `;
  button.addEventListener('click', () => onSelect(store.id));
  item.append(button);
  return item;
}

function createMapMarker(store, activeId, onSelect) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-marker';
  button.dataset.storeId = store.id;
  button.style.setProperty('--x', `${store.coordinates.x}%`);
  button.style.setProperty('--y', `${store.coordinates.y}%`);
  button.setAttribute('aria-pressed', String(store.id === activeId));
  button.setAttribute('aria-label', `${store.name} marker`);
  button.textContent = markerLabel(store);
  button.addEventListener('click', () => onSelect(store.id));
  return button;
}

function render(state) {
  const list = document.querySelector('#store-list');
  const map = document.querySelector('#map');
  const detail = document.querySelector('#store-detail');

  list.textContent = '';
  map.textContent = '';

  for (const store of state.stores) {
    list.append(createStoreButton(store, state.selectedId, state.selectStore));
    map.append(createMapMarker(store, state.selectedId, state.selectStore));
  }

  const selectedStore = state.stores.find((store) => store.id === state.selectedId) || state.stores[0];
  detail.innerHTML = detailMarkup(selectedStore);
}

async function bootstrap() {
  const payload = await fetchStores();
  const state = {
    stores: payload.stores,
    selectedId: payload.stores[0]?.id || null,
    async selectStore(storeId) {
      const payload = await clickStore(storeId);
      state.selectedId = storeId;
      state.stores = state.stores.map((store) => {
        if (store.id === storeId) {
          return payload.store;
        }
        return store;
      });
      render(state);
    }
  };

  render(state);
}

bootstrap().catch((error) => {
  const detail = document.querySelector('#store-detail');
  detail.innerHTML = `<p class="error">${error.message}</p>`;
});
