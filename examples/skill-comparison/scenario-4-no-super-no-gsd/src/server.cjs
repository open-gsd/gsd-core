'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { stores } = require('./stores.cjs');
const { createStoreRepository } = require('./store-repository.cjs');
const { renderIndexHtml } = require('./render-index-html.cjs');

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  json(response, 404, { error: 'Not found' });
}

function createAppServer({ dbPath = './data/store-clicks.sqlite', port = Number(process.env.PORT || 3000) } = {}) {
  const repository = createStoreRepository({ dbPath, stores });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderIndexHtml());
      return;
    }

    if (request.method === 'GET' && pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(require('node:fs').readFileSync(require('node:path').join(__dirname, 'app-client.js'), 'utf8'));
      return;
    }

    if (request.method === 'GET' && pathname === '/api/stores') {
      json(response, 200, { stores: repository.listStores() });
      return;
    }

    const detailMatch = pathname.match(/^\/api\/stores\/([^/]+)$/);
    if (request.method === 'GET' && detailMatch) {
      const store = repository.getStoreById(detailMatch[1]);
      if (!store) {
        notFound(response);
        return;
      }

      json(response, 200, { store });
      return;
    }

    const clickMatch = pathname.match(/^\/api\/stores\/([^/]+)\/click$/);
    if (request.method === 'POST' && clickMatch) {
      const store = repository.recordClick(clickMatch[1]);
      if (!store) {
        notFound(response);
        return;
      }

      json(response, 200, { store });
      return;
    }

    notFound(response);
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      const address = server.address();
      this.port = address.port;
      this.baseUrl = `http://127.0.0.1:${address.port}`;
      return this;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          repository.close();
          resolve();
        });
      });
    },
    get baseUrl() {
      return this._baseUrl;
    },
    set baseUrl(value) {
      this._baseUrl = value;
    }
  };
}

if (require.main === module) {
  const appServer = createAppServer();
  appServer.start().then(() => {
    process.stdout.write(`SandboxVR Store Explorer running at ${appServer.baseUrl}\n`);
  });
}

module.exports = { createAppServer };
