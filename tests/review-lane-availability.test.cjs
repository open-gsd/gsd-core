/**
 * #5266 — `review-lane availability` reports `<slug>:available|missing` for every first-party
 * openai-http lane, resolving the host through the lane descriptor (hostConfigKey +
 * defaultHost), so review.md carries no inline `config-get review.*_host`.
 *
 * Semantics (replaces the old review.md curl loop): ANY HTTP response means a server is
 * listening and is `available`; redirects are never followed; refused/hung = `missing`.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

const run = promisify(execFile);
const TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
// Fixture probe budget for the synthetic third-party lane: a loopback HTTP fixture answers in
// ms, so this is a per-lane descriptor value under test, not a subprocess class norm.
const FIXTURE_PROBE_TIMEOUT_MS = 2000;

/** Listening server; `handler` decides the response. Returns `{ url, server, requests }`. */
async function listen(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}` };
}

const closeServer = (s) => {
  s.server.closeAllConnections();
  return new Promise((r) => s.server.close(r));
};

const status = (code) => (req, res) => { res.statusCode = code; res.end('{}'); };

describe('review-lane availability (#5266)', () => {
  let tmp;
  let up;
  let unauth;
  let notFound;
  let boom;
  let target;
  let redirector;
  let hang;
  let stall;
  let downUrl;

  before(async () => {
    tmp = createTempProject();
    up = await listen((req, res) => { res.statusCode = req.url === '/v1/models' ? 200 : 404; res.end('{}'); });
    unauth = await listen(status(401));
    notFound = await listen(status(404));
    boom = await listen(status(500));
    target = await listen(status(200));
    redirector = await listen((req, res) => { res.statusCode = 302; res.setHeader('Location', `${target.url}/v1/models`); res.end(); });
    hang = await listen(() => {});
    stall = await listen((req, res) => { res.writeHead(200); res.write('{'); });
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    downUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((r) => closed.close(r));
  });

  after(async () => {
    for (const s of [up, unauth, notFound, boom, target, redirector, hang, stall]) await closeServer(s);
    cleanup(tmp);
  });

  const availability = async (review, extraArgs = []) => {
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ review }));
    const { stdout } = await run(process.execPath, [TOOLS, 'review-lane', 'availability', '--raw', ...extraArgs], {
      cwd: tmp,
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout.trim().split('\n');
  };

  test('descriptor defaults equal the old review.md curl table (hosts, path, timeout, order)', () => {
    const http_lanes = REVIEWER_LANES.filter((l) => l.transport === 'openai-http');
    const rows = http_lanes.map((lane) => {
      const r = resolveLanePlan({ lane, configGet: () => undefined, runDir: '/run', repoRoot: '/repo' });
      assert.equal(r.ok, true, `${lane.slug} failed to resolve`);
      return [lane.slug, r.plan.host, lane.probe.path, lane.probe.timeoutMs];
    });
    assert.deepEqual(rows, [
      ['ollama', 'http://localhost:11434', '/v1/models', 2000],
      ['lm_studio', 'http://localhost:1234', '/v1/models', 2000],
      ['llama_cpp', 'http://localhost:8080', '/v1/models', 2000],
    ]);
  });

  test('reachable -> available, refused -> missing, in descriptor order', async () => {
    const lines = await availability({ ollama_host: up.url, lm_studio_host: downUrl, llama_cpp_host: `${up.url}/` });
    assert.deepEqual(lines, ['ollama:available', 'lm_studio:missing', 'llama_cpp:available']);
  });

  test('any HTTP status counts as available (401, 404, 500)', async () => {
    const lines = await availability({ ollama_host: unauth.url, lm_studio_host: notFound.url, llama_cpp_host: boom.url });
    assert.deepEqual(lines, ['ollama:available', 'lm_studio:available', 'llama_cpp:available']);
  });

  test('a 302 is available and the redirect target is never requested', async () => {
    const lines = await availability({ ollama_host: redirector.url, lm_studio_host: downUrl, llama_cpp_host: downUrl }, [
      '--selected', 'ollama',
    ]);
    assert.deepEqual(lines, ['ollama:available']);
    assert.ok(redirector.requests.length > 0, 'redirector was probed');
    assert.deepEqual(target.requests, [], 'redirect target must never be requested');
  });

  test('a server that never responds is missing within the probe timeout', async () => {
    const lines = await availability({ ollama_host: hang.url }, ['--selected', 'ollama']);
    assert.deepEqual(lines, ['ollama:missing']);
  });

  test('headers then a stalled body is still available', async () => {
    const lines = await availability({ ollama_host: stall.url }, ['--selected', 'ollama']);
    assert.deepEqual(lines, ['ollama:available']);
  });

  test('--selected restricts output to the named lane', async () => {
    const lines = await availability({ ollama_host: up.url, lm_studio_host: up.url, llama_cpp_host: up.url }, [
      '--selected', 'ollama',
    ]);
    assert.deepEqual(lines, ['ollama:available']);
  });

  test('unset hosts resolve descriptor defaults and report every http lane in descriptor order', async () => {
    const lines = await availability({});
    assert.equal(lines.length, 3);
    lines.forEach((l, i) => assert.match(l, new RegExp(`^${['ollama', 'lm_studio', 'llama_cpp'][i]}:(available|missing)$`)));
  });

  test('an installed third-party openai-http lane is never probed (ADR-2782 D7)', async () => {
    const third = await listen(status(200));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rev5266-home-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rev5266-src-'));
    try {
      const hostKey = 'review.rev5266http_host';
      fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify({
        id: 'rev5266http',
        role: 'reviewer',
        version: '1.0.0',
        title: 'rev5266http test lane',
        description: 'third-party openai-http reviewer lane for #5266',
        tier: 'standard',
        requires: [],
        engines: { gsd: '>=1.9.0' },
        reviewer: {
          slug: 'rev5266http',
          flags: ['--rev5266http'],
          transport: 'openai-http',
          probe: { kind: 'http-reachable', hostConfigKey: hostKey, path: '/v1/models', timeoutMs: FIXTURE_PROBE_TIMEOUT_MS },
          invoke: { hostConfigKey: hostKey, path: '/v1/chat/completions', modelDiscovery: 'none', effortChannel: 'none' },
          timeoutFloorMs: 5000,
          emptyOutput: 'stub-with-stderr',
          reviewsSection: 'rev5266http review',
          evidenceClass: 'source-grounded',
          requiresBinaries: [],
          promptBudgetKey: null,
          handler: null,
        },
      }));
      const env = { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
      const install = runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], tmp, env);
      assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
      // Non-vacuous: the lane is installed and merged into the roster, so only D7 keeps it unprobed.
      const sections = runGsdTools(['review-lane', 'sections'], tmp, env);
      assert.match(sections.output, /^rev5266http\t/m, 'overlay lane must be roster-visible');

      fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ review: { rev5266http_host: third.url } }));
      const out = runGsdTools(['review-lane', 'availability', '--raw'], tmp, env);
      assert.equal(out.success, true, out.error || out.output);
      assert.ok(!out.output.includes('rev5266http'), `third-party lane leaked into output:\n${out.output}`);
      assert.deepEqual(third.requests, [], 'third-party lane host must never be requested');
    } finally {
      cleanup(home);
      cleanup(src);
      await closeServer(third);
    }
  });
});
