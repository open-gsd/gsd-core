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
const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { REVIEWER_LANES } = require('../gsd-core/bin/lib/review-lane-descriptor.cjs');
const { resolveLanePlan } = require('../gsd-core/bin/lib/review-lane-invocation.cjs');

// Async on purpose: the in-process fixture servers must keep serving while the child probes them
// (a sync spawn would block this event loop), so this is not routed through the sync process seam.
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

  // Every server is recorded as it starts, so `after` closes the already-listening ones even when
  // `before` throws midway (node:test still runs `after` hooks after a failed `before`).
  const started = [];
  const open = async (handler) => {
    const s = await listen(handler);
    started.push(s);
    return s;
  };

  before(async () => {
    tmp = createTempProject();
    up = await open((req, res) => { res.statusCode = req.url === '/v1/models' ? 200 : 404; res.end('{}'); });
    unauth = await open(status(401));
    notFound = await open(status(404));
    boom = await open(status(500));
    target = await open(status(200));
    redirector = await open((req, res) => { res.statusCode = 302; res.setHeader('Location', `${target.url}/v1/models`); res.end(); });
    hang = await open(() => {});
    stall = await open((req, res) => { res.writeHead(200); res.write('{'); });
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    downUrl = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((r) => closed.close(r));
  });

  after(async () => {
    for (const s of started) await closeServer(s);
    if (tmp) cleanup(tmp);
  });

  const availability = async (review, extraArgs = [], env) => {
    fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ review }));
    const { stdout } = await run(process.execPath, [TOOLS, 'review-lane', 'availability', '--raw', ...extraArgs], {
      cwd: tmp,
      ...(env && { env: { ...process.env, ...env } }),
      timeout: PROBE_TIMEOUT_MS,
    });
    return splitLines(stdout.trim());
  };

  test('descriptor defaults equal the old review.md curl table (hosts, path, timeout, order)', () => {
    const httpLanes = REVIEWER_LANES.filter((l) => l.transport === 'openai-http');
    const rows = httpLanes.map((lane) => {
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

  test('--selected negative inputs: empty/blank selects all, unknown selects none, metacharacters are data', async () => {
    const hosts = { ollama_host: up.url, lm_studio_host: up.url, llama_cpp_host: up.url };
    const all = ['ollama:available', 'lm_studio:available', 'llama_cpp:available'];
    const cases = [
      ['', all],
      ['  ,  ', all],
      ['nope', []],
      ['ollama,ollama', ['ollama:available']],
      ['ollama;touch pwned', []],
    ];
    for (const [argValue, expected] of cases) {
      // empty stdout splits to [''], so drop blank lines to compare "no rows" as []
      const lines = (await availability(hosts, ['--selected', argValue])).filter((l) => l !== '');
      assert.deepEqual(lines, expected, `--selected ${JSON.stringify(argValue)}`);
    }
    // the child runs in tmp; also check the test process cwd per the inherited-cwd contract
    assert.equal(fs.existsSync(path.join(tmp, 'pwned')), false, 'no file created in child cwd');
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false, 'no file created in process cwd');
  });

  // review.md's `||` fallback: only a failed/unsupported subcommand degrades to all-missing, loudly.
  const AVAIL_LINE = fs
    .readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'review.md'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('gsd_run review-lane availability'));
  const runLine = (stub) => run('bash', ['-c', `gsd_run() { ${stub}; }\n${AVAIL_LINE}`], { timeout: PROBE_TIMEOUT_MS });

  test('review.md fallback: a failing subcommand prints a warning and every http lane as missing', { skip: process.platform === 'win32' }, async () => {
    assert.ok(AVAIL_LINE, 'availability call found in review.md');
    const { stdout, stderr } = await runLine('return 3');
    assert.deepEqual(splitLines(stdout.trim()), ['ollama:missing', 'lm_studio:missing', 'llama_cpp:missing']);
    assert.match(stderr, /WARNING: review-lane availability failed/);
  });

  test('review.md fallback: a succeeding subcommand is passed through with no fallback rows or warning', { skip: process.platform === 'win32' }, async () => {
    const { stdout, stderr } = await runLine("printf 'ollama:available\\n'");
    assert.equal(stdout, 'ollama:available\n');
    assert.equal(stderr, '');
  });

  test('an installed third-party openai-http lane is never probed (ADR-2782 D5 egress/consent)', async (t) => {
    const third = await listen(status(200));
    t.after(() => closeServer(third));
    const home = createTempDir('rev5266-home-');
    const src = createTempDir('rev5266-src-');
    t.after(() => { cleanup(home); cleanup(src); });
    {
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
        // Declared so the project config key survives schema filtering and the lane really resolves a host.
        config: { [hostKey]: { type: 'string', default: '', description: 'Fixture lane host.' } },
      }));
      const env = { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
      const install = runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], tmp, env);
      assert.equal(install.success, true, `install failed: ${install.error || install.output}`);
      // Non-vacuous: the lane is installed and merged into the roster, so only the first-party-only rule keeps it unprobed.
      const sections = runGsdTools(['review-lane', 'sections'], tmp, env);
      assert.match(sections.output, /^rev5266http\t/m, 'overlay lane must be roster-visible');

      // Async run: runGsdTools blocks this event loop, so a listener could never record a request.
      const lines = await availability({ rev5266http_host: third.url }, [], env);
      assert.ok(!lines.join('\n').includes('rev5266http'), `third-party lane leaked into output:\n${lines.join('\n')}`);
      assert.deepEqual(third.requests, [], 'third-party lane host must never be requested');
    }
  });
});
