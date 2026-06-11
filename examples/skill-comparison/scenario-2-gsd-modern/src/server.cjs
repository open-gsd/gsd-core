'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createStoreRepository } = require('./db.cjs');
const { STORES } = require('./store-data.cjs');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SandboxVR Store Explorer</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="page-header">
    <p class="eyebrow">Controlled comparison / ${escapeHtml('s2-gsd-modern')}</p>
    <h1>SandboxVR Store Explorer</h1>
    <p class="lede">A standalone example app with a placeholder interactive map, a synchronized store list, and local SQLite click tracking.</p>
  </header>
  <main id="content" class="layout" tabindex="-1">
    <section class="surface cluster" aria-labelledby="map-title">
      <div>
        <p class="section-kicker">Map</p>
        <h2 id="map-title">Interactive map placeholder</h2>
        <p>Select a store marker or list item to update the detail panel and persist a click count.</p>
      </div>
      <div id="map" class="map" aria-label="Placeholder interactive map of SandboxVR stores"></div>
    </section>

    <section class="surface panel-grid" aria-label="Store browser">
      <div class="panel panel-list">
        <h2>Store locations</h2>
        <ul id="store-list" class="store-list"></ul>
      </div>
      <aside class="panel panel-detail" aria-labelledby="detail-title">
        <h2 id="detail-title">Store details</h2>
        <div id="store-detail"></div>
      </aside>
    </section>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>`;
}

function createAppServer({ dbPath = path.join(process.cwd(), 'var', 'store-clicks.sqlite') } = {}) {
  const repo = createStoreRepository({ dbPath, stores: STORES });
  let server;

  function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify(payload));
  }

  function serveStaticAsset(response, assetPath) {
    const filePath = path.join(__dirname, '..', 'public', assetPath);
    if (!fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    response.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream'
    });
    response.end(fs.readFileSync(filePath));
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderPage());
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/styles.css') {
      serveStaticAsset(response, 'styles.css');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/app.js') {
      serveStaticAsset(response, 'app.js');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/stores') {
      writeJson(response, 200, { stores: repo.listStores() });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname.startsWith('/api/stores/') && requestUrl.pathname.endsWith('/click')) {
      const storeId = requestUrl.pathname.slice('/api/stores/'.length, -'/click'.length);
      const store = repo.incrementClickCount(storeId);
      if (!store) {
        writeJson(response, 404, { error: 'Store not found' });
        return;
      }

      writeJson(response, 200, { store });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }

  return {
    async start(port = 3000) {
      server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: error.message }));
        });
      });

      await new Promise((resolve) => {
        server.listen(port, '127.0.0.1', resolve);
      });

      const address = server.address();
      this.origin = `http://127.0.0.1:${address.port}`;
      return this.origin;
    },
    async stop() {
      if (!server) {
        repo.close();
        return;
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      repo.close();
    },
    origin: null,
    repo
  };
}

if (require.main === module) {
  const server = createAppServer({
    dbPath: path.join(process.cwd(), 'var', 'store-clicks.sqlite')
  });

  server.start(Number(process.env.PORT || 3000)).then((origin) => {
    process.stdout.write(`SandboxVR Store Explorer running at ${origin}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createAppServer
};
