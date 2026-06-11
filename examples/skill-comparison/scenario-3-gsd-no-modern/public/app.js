(() => {
  function createInitialState(stores) {
    return {
      stores,
      selectedStoreId: stores[0] ? stores[0].id : null,
    };
  }

  function getSelectedStore(state) {
    return state.stores.find((store) => store.id === state.selectedStoreId) || state.stores[0] || null;
  }

  function selectStore(state, storeId) {
    return {
      stores: state.stores,
      selectedStoreId: storeId,
    };
  }

  function renderApp(state) {
    const listElement = document.querySelector('[data-testid="store-list"]');
    const detailElement = document.querySelector('[data-testid="store-detail"]');
    const mapElement = document.querySelector('[data-testid="map"]');
    const selectedStore = getSelectedStore(state);

    listElement.innerHTML = state.stores.map((store) => {
      const isSelected = selectedStore && selectedStore.id === store.id;
      return `
        <li>
          <button type="button" class="store-list-item${isSelected ? ' is-selected' : ''}" data-store-id="${store.id}" aria-pressed="${isSelected ? 'true' : 'false'}">
            <strong>${store.name}</strong>
            <span>${store.city}, ${store.country}</span>
            <span>Clicks: ${store.clickCount}</span>
          </button>
        </li>
      `;
    }).join('');

    mapElement.innerHTML = `
      <div class="map-surface-copy">Placeholder map surface</div>
      <div class="map-marker-layer">
        ${state.stores.map((store) => {
          const isSelected = selectedStore && selectedStore.id === store.id;
          return `
            <button type="button" class="map-marker${isSelected ? ' is-selected' : ''}" data-marker-id="${store.id}" data-selected="${isSelected ? 'true' : 'false'}" style="left:${store.mapX}%; top:${store.mapY}%;" aria-label="${store.name}">●</button>
          `;
        }).join('')}
      </div>
    `;

    if (!selectedStore) {
      detailElement.innerHTML = '<p>No store selected.</p>';
      return;
    }

    detailElement.innerHTML = `
      <h2>${selectedStore.name}</h2>
      <p>${selectedStore.city}, ${selectedStore.country}</p>
      <p>${selectedStore.region}</p>
      <p>${selectedStore.description}</p>
      <p>Stored clicks: ${selectedStore.clickCount}</p>
    `;

    listElement.querySelectorAll('[data-store-id]').forEach((button) => {
      button.addEventListener('click', () => handleSelection(button.getAttribute('data-store-id')));
    });

    mapElement.querySelectorAll('[data-marker-id]').forEach((button) => {
      button.addEventListener('click', () => handleSelection(button.getAttribute('data-marker-id')));
    });
  }

  async function fetchStores() {
    const response = await fetch('/api/stores');
    const payload = await response.json();
    return payload.stores;
  }

  async function logClick(storeId) {
    await fetch(`/api/stores/${storeId}/click`, {
      method: 'POST'
    });
    return fetchStores();
  }

  let state = createInitialState([]);

  async function handleSelection(storeId) {
    const stores = await logClick(storeId);
    state = selectStore({ stores, selectedStoreId: state.selectedStoreId }, storeId);
    renderApp(state);
  }

  async function boot() {
    const stores = await fetchStores();
    state = createInitialState(stores);
    renderApp(state);
  }

  boot().catch((error) => {
    const detailElement = document.querySelector('[data-testid="store-detail"]');
    detailElement.textContent = 'Failed to load stores: ' + error.message;
  });
})();
