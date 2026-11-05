'use strict';

/**
 * #5433 — an openai-http reviewer lane's execution requests (the `/v1/models` discovery GET and
 * the `/v1/chat/completions` POST) must not follow a redirect. The egress check compares the
 * CONFIGURED host, so a followed redirect sent the review prompt, which can carry repository
 * content, to a host the user never named. A 3xx is a lane failure that names the Location host.
 *
 * These drive the real `review-lane invoke` CLI against loopback fixture servers.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createTempProject, cleanup, installSpawnEnv } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Async on purpose: the in-process fixture servers must keep serving while the child calls them
// (a sync spawn would block this event loop), so this is not routed through the sync process seam.
const run = promisify(execFile);
const TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

const COMPLETION = JSON.stringify({ model: 'm', choices: [{ message: { content: 'REVIEW-FROM-CONFIGURED-HOST' } }] });

async function listen(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}`, host: `127.0.0.1:${server.address().port}` };
}

describe('openai-http execution requests never follow a redirect (#5433)', () => {
  let proj;
  const started = [];
  const open = async (handler) => {
    const s = await listen(handler);
    started.push(s);
    return s;
  };

  before(() => { proj = createTempProject('gsd-5433-'); });
  after(async () => {
    for (const s of started) {
      s.server.closeAllConnections();
      await new Promise((r) => s.server.close(r));
    }
    if (proj) cleanup(proj);
  });

  /** Invoke the first-party `ollama` lane against `hostUrl`; returns the lane result and its review file. */
  async function invokeLane(hostUrl) {
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify({ review: { ollama_host: hostUrl } }));
    const runDir = fs.mkdtempSync(path.join(proj, 'run-'));
    const promptFile = path.join(runDir, 'gsd-review-prompt.md');
    fs.writeFileSync(promptFile, 'PLAN-TEXT-WITH-REPO-CONTENT');
    const { stdout } = await run(
      process.execPath,
      [TOOLS, 'review-lane', 'invoke', '--slug', 'ollama', '--run-dir', runDir, '--repo-root', proj, '--prompt-file', promptFile],
      { cwd: proj, env: installSpawnEnv(), timeout: PROBE_TIMEOUT_MS },
    );
    return { result: JSON.parse(stdout), review: fs.readFileSync(path.join(runDir, 'gsd-review-ollama.md'), 'utf8') };
  }

  for (const code of [301, 302, 307, 308]) {
    test(`a ${code} on the completions request never reaches the redirect target, and the failure names its host`, async () => {
      const target = await open((req, res) => { res.statusCode = 200; res.end(COMPLETION); });
      const redirector = await open((req, res) => {
        if (req.method === 'POST') {
          res.statusCode = code;
          res.setHeader('Location', `${target.url}${req.url}`);
          res.end();
        } else {
          res.statusCode = 200;
          res.end('{}');
        }
      });
      const { review } = await invokeLane(redirector.url);
      assert.deepEqual(target.requests, [], 'the redirect target must never be requested');
      assert.ok(redirector.requests.some((r) => r.startsWith('POST ')), 'the configured host was asked');
      assert.ok(review.includes(target.host), `the failure must name the Location host ${target.host}:\n${review}`);
      assert.ok(!review.includes('REVIEW-FROM-CONFIGURED-HOST'));
    });
  }

  test('a redirect on model discovery is a lane failure naming the Location host; nothing reaches the target and no completions request is sent', async () => {
    const target = await open((req, res) => { res.statusCode = 200; res.end(COMPLETION); });
    const configured = await open((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.statusCode = 302; // the reachability probe reads a 3xx as "a server is there"
        res.setHeader('Location', `${target.url}${req.url}`);
        res.end();
      } else {
        res.statusCode = 200;
        res.end(COMPLETION);
      }
    });
    const { review } = await invokeLane(configured.url);
    assert.deepEqual(target.requests, [], 'the redirect target must never be requested');
    assert.ok(review.includes(target.host), `the failure must name the Location host ${target.host}:\n${review}`);
    assert.ok(!configured.requests.some((r) => r.startsWith('POST ')), 'the prompt must not be sent once discovery was redirected');
    assert.ok(!review.includes('REVIEW-FROM-CONFIGURED-HOST'));
  });

  test('a 3xx without a Location header is a lane failure that says so', async () => {
    const bare = await open((req, res) => {
      res.statusCode = req.method === 'POST' ? 308 : 200;
      res.end(req.method === 'POST' ? '' : '{}');
    });
    const { review } = await invokeLane(bare.url);
    assert.ok(review.includes('without a Location header'), review);
  });

  test('a non-redirect response behaves as before', async () => {
    const plain = await open((req, res) => {
      res.statusCode = 200;
      res.end(req.method === 'GET' ? JSON.stringify({ data: [{ id: 'm' }] }) : COMPLETION);
    });
    const { result, review } = await invokeLane(plain.url);
    assert.equal(result.ok, true);
    assert.equal(result.stubbed, false);
    assert.match(review, /REVIEW-FROM-CONFIGURED-HOST/);
  });
});
