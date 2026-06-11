(() => {
  const storeData = window.__STORE_DATA__ || [];
  const detailNode = document.getElementById('store-detail-content');
  const controls = Array.from(document.querySelectorAll('[data-store-id]'));
  let selectedStoreId = null;

  function applySelectionState(storeId) {
    for (const control of controls) {
      control.classList.toggle('is-selected', control.dataset.storeId === storeId);
    }
  }

  function renderDetails(store) {
    if (!store) {
      detailNode.innerHTML = '<p>Select a SandboxVR location to view its address, experiences, and persisted click count.</p>';
      return;
    }

    detailNode.innerHTML = `
      <div>
        <strong>${store.name}</strong>
        <div class="meta">${store.city}</div>
      </div>
      <div class="detail-card">
        <div><strong>Address</strong></div>
        <div class="meta">${store.address}</div>
      </div>
      <div class="detail-card">
        <div><strong>Experiences</strong></div>
        <div class="pill-row">${store.experiences.map((experience) => `<span class="pill">${experience}</span>`).join('')}</div>
      </div>
      <div class="detail-card">
        <div><strong>Recorded clicks</strong></div>
        <div class="meta">${store.clickCount}</div>
      </div>
    `;
  }

  async function selectStore(storeId) {
    const response = await fetch(`/api/stores/${storeId}/click`, { method: 'POST' });
    if (!response.ok) {
      renderDetails(null);
      return;
    }

    const payload = await response.json();
    selectedStoreId = storeId;
    applySelectionState(selectedStoreId);
    renderDetails(payload.store);
  }

  for (const control of controls) {
    control.addEventListener('click', () => {
      selectStore(control.dataset.storeId);
    });
  }

  if (storeData.length > 0) {
    renderDetails({
      ...storeData[0],
      clickCount: 0
    });
    applySelectionState(null);
  }
})();
