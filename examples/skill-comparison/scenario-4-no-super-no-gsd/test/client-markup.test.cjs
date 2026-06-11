'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderIndexHtml } = require('../src/render-index-html.cjs');

test('rendered client markup includes list, map markers, and detail placeholders', () => {
  const html = renderIndexHtml();

  assert.match(html, /data-testid="map-surface"/);
  assert.match(html, /data-testid="store-list"/);
  assert.match(html, /data-testid="store-detail"/);
  assert.match(html, /data-store-id="sandboxvr-austin"/);
  assert.match(html, /Select a SandboxVR location/i);
});
