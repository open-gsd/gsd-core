'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { STORES } = require('./stores.cjs');
const { createStoreClickRepository } = require('./db.cjs');

const publicDir = path.join(__dirname, '..', 'public');

function buildStorePayload(repository) {
  return STORES.map((store) => ({
    ...store,
    clickCount: repository.getCount(store.id),
  }));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  response.writeHead(200, { 'content-type': contentType });
  response.end(body);
}

function createAppServer({ dbPath = path.join(__dirname, '..', 'data', 'clicks.sqlite') } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const repository = createStoreClickRepository({ dbPath });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      return sendFile(response, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
    }

    if (request.method === 'GET' && requestUrl.pathname === '/app.js') {
      return sendFile(response, path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8');
    }

    if (request.method === 'GET' && requestUrl.pathname === '/styles.css') {
      return sendFile(response, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/stores') {
      return sendJson(response, 200, { stores: buildStorePayload(repository) });
    }

    const clickMatch = requestUrl.pathname.match(/^\/api\/stores\/([^/]+)\/click$/);
    if (request.method === 'POST' && clickMatch) {
      const storeId = clickMatch[1];
      const knownStore = STORES.find((store) => store.id === storeId);
      if (!knownStore) {
        return sendJson(response, 404, { error: 'Store not found' });
      }
      const clickCount = repository.increment(storeId);
      return sendJson(response, 200, { storeId, clickCount });
    }

    return sendJson(response, 404, { error: 'Not found' });
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    repository.close();
    return originalClose(callback);
  };

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3030);
  const server = createAppServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`SandboxVR store map listening on http://127.0.0.1:${port}\n`);
  });
}

module.exports = {
  createAppServer,
};
