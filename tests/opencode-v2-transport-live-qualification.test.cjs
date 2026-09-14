'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const VERSION = '2.0.3';
const PACKAGE_BINDINGS = Object.freeze({
  '@opencode/client': 'sha512-b+LcpMI131fXnGqf+O+9Y33H4XmwAkQibfYvtpEOROftkTpkcMj3R7WW/wGl2VTBNTZECAk2Yd+TACTzzAwk0A==',
  '@opencode/protocol': 'sha512-DNHbkLDTuAyMsmVdnjuKulcfoDbllW2dxt4W19r2aJEYvswJpEO9168CSK6Sjbx1FOh/B9yL7SQgoDRMd4K5Vw==',
  '@opencode/schema': 'sha512-thPeBbqw4+SkZ/0LOuqfahSRGuWogRa/wwfIVyiQYsoE0vzLx8XUpHQ+FSUWkdz6llDtP0+ZsyBqXUMpXmPgbg==',
});

function closedFailure() {
  const error = new Error('C7 compatibility contract failed');
  error.stack = error.message;
  throw error;
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) closedFailure();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertExactKeys(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function assertPackageBindings() {
  const rootManifest = readJson(path.join(ROOT, 'package.json'));
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  assert.equal(rootManifest.devDependencies['@opencode/client'], VERSION);
  assert.equal(rootManifest.devDependencies['@opencode/schema'], VERSION);
  assert.equal(lock.packages[''].devDependencies['@opencode/client'], VERSION);
  assert.equal(lock.packages[''].devDependencies['@opencode/schema'], VERSION);

  const installed = {};
  for (const [name, integrity] of Object.entries(PACKAGE_BINDINGS)) {
    const relative = `node_modules/${name}`;
    const locked = lock.packages[relative];
    assertExactKeys({ version:locked?.version, integrity:locked?.integrity }, ['version', 'integrity']);
    assert.equal(locked.version, VERSION);
    assert.equal(locked.integrity, integrity);
    installed[name] = readJson(path.join(ROOT, relative, 'package.json'));
    assert.equal(installed[name].name, name);
    assert.equal(installed[name].version, VERSION);
  }

  assert.equal(installed['@opencode/client'].dependencies['@opencode/schema'], VERSION);
  assert.equal(installed['@opencode/client'].dependencies['@opencode/protocol'], VERSION);
  assert.equal(installed['@opencode/protocol'].dependencies['@opencode/schema'], VERSION);
  assert.equal(installed['@opencode/client'].exports['.'].import, './dist/promise/index.js');
  assert.equal(installed['@opencode/schema'].exports['./*'].import, './dist/*.js');
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function assertPublicClientContract(OpenCode, rpcDefinition) {
  const requests = [];
  const client = OpenCode.make({
    baseUrl: 'http://fixture.invalid',
    fetch: async (url, init) => {
      requests.push({ method:init.method, pathname:url.pathname, body:init.body });
      if (url.pathname === '/api/plugin') {
        return jsonResponse({ data:[{ id:'gsd-core', source:{ type:'local', path:'fixture' }, features:{ rpc:true }, state:{ status:'active' } }] });
      }
      if (url.pathname === `/api/rpc/${rpcDefinition.id}/status`) {
        return jsonResponse({ output:{ wave_id:'wave', parent_session_id:'ses_parent', checked_at:1, sealed:false, merge_ready:false, reasons:[], jobs:[] } });
      }
      closedFailure();
    },
  });

  for (const method of ['list', 'awaitActivation', 'check', 'update']) assert.equal(typeof client.plugin[method], 'function');
  assert.equal(typeof client.rpc, 'function');

  const plugins = await client.plugin.list({ location:{ directory:'fixture' } });
  assert.equal(plugins.data.length, 1);
  assertExactKeys(plugins.data[0], ['id', 'source', 'features', 'state']);
  assert.equal(plugins.data[0].id, 'gsd-core');
  assert.equal(plugins.data[0].source.type, 'local');
  assert.equal(plugins.data[0].features.rpc, true);
  assert.equal(plugins.data[0].state.status, 'active');

  const status = await client.rpc(rpcDefinition).status({ parent_session_id:'ses_parent', wave_id:'wave' }, { location:{ directory:'fixture' } });
  assertExactKeys(status, ['wave_id', 'parent_session_id', 'checked_at', 'sealed', 'merge_ready', 'reasons', 'jobs']);
  assert.equal(status.wave_id, 'wave');
  assert.equal(status.parent_session_id, 'ses_parent');
  assert.equal(status.merge_ready, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].pathname, '/api/plugin');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].pathname, `/api/rpc/${rpcDefinition.id}/status`);
  assert.deepEqual(JSON.parse(requests[1].body), { input:{ parent_session_id:'ses_parent', wave_id:'wave' } });
}

function pluginContext(registrations) {
  const disposable = { async dispose() {} };
  return {
    app: { version:VERSION },
    location: { project:{ directory:ROOT, canonical:ROOT } },
    shell: { async hook() { return disposable; } },
    tool: {
      async hook() { return disposable; },
      async transform(transform) {
        transform({ add(definition) { registrations.tools.push(definition); } });
        return disposable;
      },
    },
    session: {
      async hook() { return disposable; },
      async get() { return { id:'ses_parent', permissions:[] }; },
    },
    rpc: {
      async register(definition, handlers) {
        registrations.rpcs.push({ definition, handlers });
        return disposable;
      },
    },
    event: {
      async *subscribe({ signal }) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once:true }));
        if (!signal.aborted) yield undefined;
      },
    },
    storage: { async scan() { return { entries:[] }; } },
    worktree: { async list() { return []; } },
  };
}

async function assertPluginContract(rpcDefinition) {
  const descriptor = require('../.opencode/plugins/gsd-core.js');
  assertExactKeys(descriptor, ['id', 'setup']);
  assert.equal(descriptor.id, 'gsd-core');
  assert.equal(typeof descriptor.setup, 'function');

  const registrations = { tools:[], rpcs:[] };
  const cleanup = await descriptor.setup(pluginContext(registrations));
  try {
    assert.equal(registrations.tools.length, 1);
    assert.equal(registrations.tools[0].name, 'gsd_worktree_task');
    assert.equal(typeof registrations.tools[0].execute, 'function');
    assert.equal(registrations.tools[0].options.codemode, true);
    assertExactKeys(registrations.tools[0].input, ['oneOf']);
    assert.equal(registrations.rpcs.length, 1);
    assert.equal(registrations.rpcs[0].definition.id, rpcDefinition.id);
    assertExactKeys(registrations.rpcs[0].definition.methods, ['status']);
    assertExactKeys(registrations.rpcs[0].definition.events, []);
    assert.equal(registrations.rpcs[0].definition.methods.status.input.additionalProperties, false);
    assert.equal(registrations.rpcs[0].definition.methods.status.output.additionalProperties, false);
    assertExactKeys(registrations.rpcs[0].definition.methods.status.errors, ['unknown_wave']);
    assert.equal(typeof registrations.rpcs[0].handlers.status, 'function');
  } finally {
    await cleanup();
  }
}

test('OC-203', async () => {
  try {
    if (process.env.GSD_FOCUSED_FORBID_LIVE !== '1' || !process.execArgv.includes('--unhandled-rejections=strict')) {
      throw new Error('C7 offline execution contract failed');
    }
    assertPackageBindings();
    const [{ OpenCode }, schemaRpc, contract] = await Promise.all([
      import('@opencode/client'),
      import('@opencode/schema/rpc'),
      import('../src/opencode-v2-plugin/attestation-rpc.mjs'),
    ]);
    assert.equal(typeof OpenCode.make, 'function');
    assert.equal(typeof schemaRpc.Rpc.define, 'function');
    assert.equal(contract.ATTESTATION_RPC_ID, 'gsd-worktree-task.attestation.v1');
    assert.equal(contract.ATTESTATION_RPC.id, contract.ATTESTATION_RPC_ID);
    assertExactKeys(contract.ATTESTATION_RPC.methods, ['status']);
    assertExactKeys(contract.ATTESTATION_RPC.events, []);
    assert.equal(contract.ATTESTATION_RPC.methods.status.input.additionalProperties, false);
    assert.equal(contract.ATTESTATION_RPC.methods.status.output.additionalProperties, false);
    assertExactKeys(contract.ATTESTATION_RPC.methods.status.errors, ['unknown_wave']);
    await assertPublicClientContract(OpenCode, contract.ATTESTATION_RPC);
    await assertPluginContract(contract.ATTESTATION_RPC);
  } catch {
    closedFailure();
  }
});

module.exports = { assertPackageBindings, assertPluginContract, assertPublicClientContract };
