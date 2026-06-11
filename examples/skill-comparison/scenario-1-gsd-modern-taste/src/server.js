'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createStoreClickRepository } = require('./db');
const { sandboxVrStores } = require('./stores');

const publicDir = path.join(__dirname, '..', 'public');

function createStoreViewModel(store, clickCount) {
  return {
    ...store,
    clickCount,
    detailHref: store.sourcePath
  };
}

function createAppServer(options = {}) {
  const repository = createStoreClickRepository({ dbPath: options.dbPath });
  const countsByStoreId = new Map(
    repository.listCounts().map((entry) => [entry.storeId, entry.clickCount])
  );

  function buildStoresResponse() {
    return sandboxVrStores.map((store) =>
      createStoreViewModel(store, countsByStoreId.get(store.id) || 0)
    );
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/api/stores') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ stores: buildStoresResponse() }));
      return;
    }

    const clickMatch = request.method === 'POST' && url.pathname.match(/^\/api\/stores\/([^/]+)\/click$/);
    if (clickMatch) {
      try {
        const storeId = decodeURIComponent(clickMatch[1]);
        const result = repository.recordClick(storeId);
        countsByStoreId.set(storeId, result.clickCount);
        const store = sandboxVrStores.find((entry) => entry.id === storeId);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            store: createStoreViewModel(store, result.clickCount)
          })
        );
      } catch (error) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/styles.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8'));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/client.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(fs.readFileSync(path.join(publicDir, 'client.js'), 'utf8'));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : undefined;
    },
    listen(port = 3000) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          repository.close();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

module.exports = {
  createAppServer
};

if (require.main === module) {
  const port = Number(process.env.PORT || '3000');
  const dbPath = process.env.STORE_MAP_DB_PATH;
  const app = createAppServer({ dbPath });
  app.listen(port).then(() => {
    process.stdout.write(`SandboxVR store explorer running on http://127.0.0.1:${app.port}\n`);
  });
}
