'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createInitialState,
  renderApp,
  selectStore,
} = require('../src/client.cjs');

function createDom() {
  return new JSDOM(`<!doctype html>
  <html>
    <body>
      <div id="app">
        <div data-testid="map"></div>
        <ul data-testid="store-list"></ul>
        <section data-testid="store-detail"></section>
      </div>
    </body>
  </html>`);
}

test('client rendering shows detail panel and active selection for chosen store', () => {
  const stores = [
    {
      id: 'sandboxvr-san-francisco',
      name: 'SandboxVR San Francisco',
      brand: 'SandboxVR',
      city: 'San Francisco',
      country: 'USA',
      region: 'North America',
      description: 'Flagship Bay Area location.',
      clickCount: 0,
      mapX: 20,
      mapY: 40,
    },
    {
      id: 'sandboxvr-london',
      name: 'SandboxVR London',
      brand: 'SandboxVR',
      city: 'London',
      country: 'UK',
      region: 'Europe',
      description: 'Central London location.',
      clickCount: 0,
      mapX: 70,
      mapY: 35,
    }
  ];

  const dom = createDom();
  const state = createInitialState(stores);

  renderApp({
    document: dom.window.document,
    state,
  });

  let detailText = dom.window.document.querySelector('[data-testid="store-detail"]').textContent;
  assert.match(detailText, /San Francisco/);

  const nextState = selectStore(state, 'sandboxvr-london');
  renderApp({
    document: dom.window.document,
    state: nextState,
  });

  detailText = dom.window.document.querySelector('[data-testid="store-detail"]').textContent;
  assert.match(detailText, /London/);

  const activeItem = dom.window.document.querySelector('[data-store-id="sandboxvr-london"]');
  assert.equal(activeItem.getAttribute('aria-pressed'), 'true');

  const marker = dom.window.document.querySelector('[data-marker-id="sandboxvr-london"]');
  assert.equal(marker.getAttribute('data-selected'), 'true');
});
