'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const helpers = require('./helpers.cjs');

// These bounded in-memory recovery scenarios must never stall the complete-file evidence run.
const RUNTIME_SCENARIO_TIMEOUT_MS = 5_000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function exerciseReplacementRecovery() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-runtime-recovery-')));
  const directory = path.join(root, 'worktree');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: fixture\n');
  fs.writeFileSync(manifestPath, JSON.stringify({ worktrees: [{
    agent_id: 'executor-a',
    worktree_path: 'worktree',
    branch: 'fixture-branch',
    expected_base: 'fixture-base',
  }] }));

  const parentID = 'ses_parent';
  const sessionID = 'ses_child';
  const waveID = 'wave-a';
  const model = { providerID: 'openai', id: 'gpt-test', variant: 'medium' };
  const manifestEntry = {
    agent_id: 'executor-a',
    worktree_path: directory,
    branch: 'fixture-branch',
    expected_base: 'fixture-base',
    files_modified: null,
    declared_deletions: null,
  };
  const crypto = require('node:crypto');
  const manifestEntryHash = crypto.createHash('sha256').update(JSON.stringify(manifestEntry)).digest('hex');
  const requestedExecutor = {
    session_id: sessionID,
    parent_session_id: parentID,
    directory,
    manifest_agent_id: 'executor-a',
    agent: 'gsd-executor',
    model,
    final_permission: { action: 'gsd_worktree_task', resource: '*', effect: 'deny' },
  };
  const key = `wave/${parentID}/${waveID}`;
  const values = new Map([[key, {
    version: 1,
    parent_session_id: parentID,
    wave_id: waveID,
    created_at: 1,
    sealed: false,
    manifest_path: manifestPath,
    jobs: {
      [sessionID]: {
        session_id: sessionID,
        directory,
        status: 'running',
        agent: 'gsd-executor',
        model,
        manifest_path: manifestPath,
        manifest_agent_id: 'executor-a',
        manifest_entry: manifestEntry,
        manifest_entry_hash: manifestEntryHash,
        requested_executor: requestedExecutor,
        started_at: 1,
        deadline: 10_000,
      },
    },
  }]]);
  const normalCycleDone = deferred();
  const storage = {
    async get(storageKey) { return structuredClone(values.get(storageKey)); },
    async set(storageKey, value) {
      values.set(storageKey, structuredClone(value));
      if (value?.jobs?.[sessionID]?.observation?.reason === 'outcome_pending') normalCycleDone.resolve();
    },
    async scan({ prefix }) {
      return {
        entries: [...values].filter(([storageKey]) => storageKey.startsWith(prefix)).map(([storageKey, value]) => ({ key: storageKey, value: structuredClone(value) })),
      };
    },
  };
  const promptCalls = [];
  const importCalls = [];
  const ctx = {
    app: { version: '2.0.3' },
    location: { project: { canonical: root, directory: root, id: 'project-fixture' } },
    storage,
    session: { async prompt(input) { promptCalls.push(input); } },
    worktree: { async list() { return [{ directory }]; } },
  };
  const retryTimers = [];
  const retryScheduled = deferred();
  const schedule = (callback, delay) => {
    const handle = { callback, delay, cancelled: false, unref() {} };
    retryTimers.push(handle);
    retryScheduled.resolve();
    return handle;
  };
  const cancelSchedule = (handle) => { if (handle) handle.cancelled = true; };
  const boundSchedule = () => ({ unref() {} });
  const staleDiscovery = deferred();
  const staleDiscoveryStarted = deferred();
  const replacementGet = deferred();
  const replacementGetStarted = deferred();
  const calls = [];
  let discovery = 0;
  const service = {
    async discover() {
      discovery += 1;
      calls.push(`discover-${discovery}`);
      if (discovery === 2) {
        staleDiscoveryStarted.resolve();
        return staleDiscovery.promise;
      }
      return { generation: discovery };
    },
  };
  const sessionInfo = (outcome) => ({
    id: sessionID,
    parentID,
    location: { directory },
    agent: 'gsd-executor',
    model,
    permissions: [{ action: 'gsd_worktree_task', resource: '*', effect: 'deny' }],
    ...(outcome ? { outcome, time: { idle: 2 } } : { time: {} }),
  });
  const makeClient = (endpoint) => {
    calls.push(`client-${endpoint.generation}`);
    const terminal = endpoint.generation === 3;
    return {
      health: { async get() { calls.push(`health-${endpoint.generation}`); return { healthy: true, pid: process.pid, version: '2.0.3' }; } },
      session: {
        async get() {
          calls.push(`get-${endpoint.generation}`);
          if (terminal) {
            replacementGetStarted.resolve();
            await replacementGet.promise;
          }
          return sessionInfo(terminal ? 'succeeded' : undefined);
        },
        async wait() { calls.push(`wait-${endpoint.generation}`); },
        async context() { calls.push(`context-${endpoint.generation}`); return []; },
        async import(input) { importCalls.push(input); },
      },
    };
  };
  const dependencies = {
    service,
    makeClient,
    now: () => 1_000,
    schedule,
    cancelSchedule,
    boundSchedule,
    cancelBound() {},
  };

  let firstRuntime;
  let secondRuntime;
  let disposeFirst;
  try {
    const { createRuntime } = await import('../src/opencode-v2-plugin/worktree-tool.mjs');
    firstRuntime = createRuntime(ctx, dependencies);
    firstRuntime.startSetupRecovery();
    await normalCycleDone.promise;
    await retryScheduled.promise;
    assert.equal(values.get(key).jobs[sessionID].observation.reason, 'outcome_pending');
    assert.equal(values.get(key).jobs[sessionID].observation.cycle, 1);
    assert.equal(retryTimers.length, 1);
    retryTimers[0].callback();
    await staleDiscoveryStarted.promise;

    disposeFirst = firstRuntime.dispose();
    secondRuntime = createRuntime(ctx, dependencies);
    let recoverSettled = false;
    const recover = secondRuntime.execute({ action: 'recover' }, { sessionID: parentID }).then((value) => {
      recoverSettled = true;
      return value;
    });
    await replacementGetStarted.promise;
    await Promise.resolve();
    const settledBeforeTerminalRead = recoverSettled;
    replacementGet.resolve();
    const recovered = await recover;
    staleDiscovery.resolve({ generation: 2 });
    await disposeFirst;

    const payload = JSON.parse(recovered.content);
    assert.equal(settledBeforeTerminalRead, false, 'explicit recover must await its bounded pull-first cycle');
    assert.equal(payload.waves[0].jobs[0].status, 'succeeded');
    assert.equal(values.get(key).jobs[sessionID].status, 'succeeded');
    assert.deepEqual(calls, [
      'discover-1', 'client-1', 'health-1', 'get-1', 'wait-1',
      'discover-2',
      'discover-3', 'client-3', 'health-3', 'get-3', 'context-3',
    ]);
    assert.equal(calls.includes('client-2'), false, 'revoked continuation must not construct a client');
    return { promptCalls, importCalls };
  } finally {
    staleDiscovery.resolve({ generation: 2 });
    replacementGet.resolve();
    if (disposeFirst) await disposeFirst;
    if (secondRuntime) await secondRuntime.dispose();
    else if (firstRuntime) await firstRuntime.dispose();
    helpers.cleanup(root);
  }
}

test('RUNTIME-NR-01', { timeout: RUNTIME_SCENARIO_TIMEOUT_MS }, async () => {
  const result = await exerciseReplacementRecovery();
  assert.equal(result.promptCalls.length, 0, 'recovery must not replay a session prompt');
});

test('RUNTIME-NR-02', { timeout: RUNTIME_SCENARIO_TIMEOUT_MS }, async () => {
  const result = await exerciseReplacementRecovery();
  assert.equal(result.importCalls.length, 0, 'recovery must not import or recreate a session');
});
