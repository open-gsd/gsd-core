'use strict';

/**
 * capability-loader.test.cjs — ADR-1244 D2 runtime registry overlay.
 *
 * Behavioral tests for loadRegistry({ includeInstalled }): first-party ∪
 * validated overlay composition, first-party-wins collisions, reserved
 * namespace, engines.gsd load-time re-gate (skip-with-warning), gate-kind
 * fail-closed tracking, and parity with the canonical builder.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { loadRegistry } = require('../gsd-core/bin/lib/capability-loader.cjs');
const baseRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { buildRegistry } = require('../scripts/gen-capability-registry.cjs');

const HOST = '1.6.0';

function featureCap(id, extra) {
  return {
    id, role: 'feature', version: '1.0.0', title: id, description: 'overlay cap',
    tier: 'standard', requires: [], engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [], agents: [], hooks: [], config: {}, steps: [], contributions: [], gates: [],
    ...extra,
  };
}

// Build a temp GSD home containing .gsd/capabilities/<id>/capability.json for each cap.
function makeOverlayHome(caps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-overlay-'));
  for (const cap of caps) {
    const dir = path.join(home, '.gsd', 'capabilities', cap.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(cap), 'utf8');
  }
  return home;
}

// Always pass cwd === home so the project-root probe cannot wander into the
// real repo; root-dedup makes the project scope a no-op there.
function load(home, opts) {
  return loadRegistry({ includeInstalled: true, gsdHome: home, cwd: home, hostVersion: HOST, ...opts });
}

describe('loadRegistry — base behavior', () => {
  test('without includeInstalled returns the frozen registry (identity-stable)', () => {
    assert.strictEqual(loadRegistry(), baseRegistry);
    assert.strictEqual(loadRegistry({ includeInstalled: false }), baseRegistry);
  });

  test('includeInstalled with no overlay directory returns the frozen registry unchanged', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-empty-'));
    try {
      assert.strictEqual(load(home), baseRegistry);
    } finally {
      cleanup(home);
    }
  });
});

describe('loadRegistry — accepting valid overlays', () => {
  test('a valid overlay capability appears in every derived view (toggable + federated)', (t) => {
    const home = makeOverlayHome([
      featureCap('deploy-gate', {
        skills: ['deploy-review'],
        agents: ['gsd-deploy-checker'],
        config: { 'workflow.deploy_gate': { type: 'boolean', default: true, description: 'Enable the deploy gate.' } },
        steps: [{ point: 'execute:wave:post', ref: { skill: 'deploy-review' }, produces: ['DEPLOY.md'], consumes: [], when: 'workflow.deploy_gate', onError: 'skip' }],
      }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);

    assert.ok(reg.capabilities['deploy-gate'], 'overlay in capabilities');
    assert.equal(reg.bySkill['deploy-review'], 'deploy-gate', 'overlay skill indexed (surface)');
    assert.equal(reg.byAgent['gsd-deploy-checker'], 'deploy-gate', 'overlay agent indexed');
    assert.ok(reg.configSchema['workflow.deploy_gate'], 'overlay config federated');
    assert.equal(reg.configKeys['workflow.deploy_gate'], 'deploy-gate', 'overlay config key owned');
    assert.ok(reg.capabilityClusters['deploy-gate'], 'overlay in capabilityClusters (surface toggle)');
    assert.ok(reg.profileMembership['deploy-gate'], 'overlay in profileMembership (surface toggle)');
    const wavePost = reg.byLoopPoint['execute:wave:post'];
    assert.ok(wavePost && Array.isArray(wavePost.steps) &&
      wavePost.steps.some((h) => h.capId === 'deploy-gate'), 'overlay step wired into the loop');

    // First-party is preserved.
    assert.equal(reg.capabilities['ui'].title, 'UI design contracts');
    assert.equal(reg._overlay.warnings.length, 0, 'no warnings when all overlays accepted');
    assert.deepEqual(reg._overlay.incompatibleGateCapIds, []);
  });

  test('composed registry equals buildRegistry over the same merged cap-map (no drift / no dropped caps)', (t) => {
    const overlay = featureCap('extra-cap', { skills: ['extra-skill'] });
    const home = makeOverlayHome([overlay]);
    t.after(() => cleanup(home));
    const reg = load(home);

    const mergedMap = new Map(Object.entries(baseRegistry.capabilities));
    mergedMap.set('extra-cap', overlay);
    const expected = buildRegistry(mergedMap);

    assert.deepEqual(Object.keys(reg.capabilities).sort(), Object.keys(expected.capabilities).sort());
    assert.deepEqual(reg.bySkill, expected.bySkill);
    assert.deepEqual(Object.keys(reg.configSchema).sort(), Object.keys(expected.configSchema).sort());
    assert.deepEqual(reg.capabilityClusters['extra-cap'], expected.capabilityClusters['extra-cap']);
  });
});

describe('loadRegistry — uncommitted (_pending) overlay is not activated (ADR-1244 Phase 4)', () => {
  test('a capability dir whose ledger entry has a _pending intent is skipped with a warning', (t) => {
    const home = makeOverlayHome([featureCap('pendingcap', { skills: ['pending-skill'] })]);
    t.after(() => cleanup(home));
    // Co-located ledger marks the cap as an in-flight (uncommitted) install.
    fs.writeFileSync(
      path.join(home, '.gsd-capabilities.json'),
      JSON.stringify({
        version: '1', updatedAt: '2026-01-01T00:00:00Z',
        entries: { pendingcap: { id: 'pendingcap', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [], _pending: { kind: 'install', backupName: null, sharedFiles: [] } } },
      }),
      'utf8',
    );
    const reg = load(home);
    assert.ok(!reg.capabilities['pendingcap'], 'uncommitted cap not activated');
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'pendingcap' && /in progress/.test(w.reason)), 'skip warning recorded');
  });

  test('once the ledger entry is committed (no _pending) the same dir activates normally', (t) => {
    const home = makeOverlayHome([featureCap('committedcap', { skills: ['committed-skill'] })]);
    t.after(() => cleanup(home));
    fs.writeFileSync(
      path.join(home, '.gsd-capabilities.json'),
      JSON.stringify({
        version: '1', updatedAt: '2026-01-01T00:00:00Z',
        entries: { committedcap: { id: 'committedcap', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] } },
      }),
      'utf8',
    );
    const reg = load(home);
    assert.ok(reg.capabilities['committedcap'], 'committed cap activates');
  });
});

describe('loadRegistry — _overlay.commandRoots (ADR-1244 Phase 5 dispatch)', () => {
  // commandRoots requires a COMMITTED ledger entry (the consent signal). Write one.
  function writeCommittedLedger(home, ids) {
    const entries = {};
    for (const id of ids) entries[id] = { id, version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] };
    fs.writeFileSync(path.join(home, '.gsd-capabilities.json'), JSON.stringify({ version: '1', updatedAt: '2026-01-01T00:00:00Z', entries }), 'utf8');
  }

  test('a COMMITTED overlay cap that declares commands records its absolute install root', (t) => {
    const home = makeOverlayHome([featureCap('tpcap', { commands: [{ family: 'tp-cmd', module: 'router.cjs', router: 'run' }] })]);
    t.after(() => cleanup(home));
    writeCommittedLedger(home, ['tpcap']);
    const reg = load(home);
    assert.ok(reg.capabilities['tpcap'], 'overlay cap accepted');
    assert.ok(reg._overlay && reg._overlay.commandRoots, '_overlay.commandRoots present');
    assert.strictEqual(reg._overlay.commandRoots['tpcap'], path.join(home, '.gsd', 'capabilities', 'tpcap'), 'install root recorded');
  });

  test('CONSENT NEGATIVE PROOF: a cap with commands but NO ledger entry (bundle dropped on disk) is NOT in commandRoots', (t) => {
    // No ledger written at all — models a repo that ships .gsd/capabilities/<id> without an install.
    const home = makeOverlayHome([featureCap('dropped', { commands: [{ family: 'dropped-cmd', module: 'router.cjs', router: 'run' }] })]);
    t.after(() => cleanup(home));
    const reg = load(home);
    const roots = (reg._overlay && reg._overlay.commandRoots) || {};
    assert.ok(!('dropped' in roots), 'an uninstalled (no-ledger) cap must not be command-dispatchable');
    // Declarative surfaces still load (Phase 2 behavior unchanged) — only command dispatch is gated.
    assert.ok(reg.capabilities['dropped'], 'declarative surfaces still compose');
  });

  test('an overlay cap WITHOUT commands is not in commandRoots, and first-party families are absent too', (t) => {
    const home = makeOverlayHome([
      featureCap('nocmd', { skills: ['nocmd-skill'] }),
      featureCap('tpcap', { commands: [{ family: 'tp-cmd', module: 'router.cjs', router: 'run' }] }),
    ]);
    t.after(() => cleanup(home));
    writeCommittedLedger(home, ['tpcap']);
    const reg = load(home);
    const roots = reg._overlay.commandRoots;
    assert.ok(!('nocmd' in roots), 'declarative overlay cap not in commandRoots');
    assert.ok(!('graphify' in roots) && !('intel' in roots), 'first-party families never appear in commandRoots');
  });

  test('CONSENT NEGATIVE PROOF: a _pending (uncommitted) overlay cap with commands is NOT in commandRoots', (t) => {
    const home = makeOverlayHome([featureCap('pendcmd', { commands: [{ family: 'pend-cmd', module: 'router.cjs', router: 'run' }] })]);
    t.after(() => cleanup(home));
    fs.writeFileSync(
      path.join(home, '.gsd-capabilities.json'),
      JSON.stringify({
        version: '1', updatedAt: '2026-01-01T00:00:00Z',
        entries: { pendcmd: { id: 'pendcmd', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [], _pending: { kind: 'install', backupName: null, sharedFiles: [] } } },
      }),
      'utf8',
    );
    const reg = load(home);
    const roots = (reg._overlay && reg._overlay.commandRoots) || {};
    assert.ok(!('pendcmd' in roots), 'an unconsented capability must not expose a dispatchable command root');
    assert.ok(!reg.capabilities['pendcmd'], 'unconsented cap not activated');
  });

  test('FAIL CLOSED: a malformed/tampered committed-looking entry is NOT treated as consent', (t) => {
    const home = makeOverlayHome([
      featureCap('mal1', { commands: [{ family: 'mal1-cmd', module: 'router.cjs', router: 'run' }] }),
      featureCap('mal2', { commands: [{ family: 'mal2-cmd', module: 'router.cjs', router: 'run' }] }),
      featureCap('mal3', { commands: [{ family: 'mal3-cmd', module: 'router.cjs', router: 'run' }] }),
    ]);
    t.after(() => cleanup(home));
    fs.writeFileSync(
      path.join(home, '.gsd-capabilities.json'),
      JSON.stringify({
        version: '1', updatedAt: '2026-01-01T00:00:00Z',
        entries: {
          mal1: { id: 'mal1', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [], _pending: null }, // falsy-but-present intent → not committed
          mal2: { id: 'WRONG', version: '1.0.0', source: 's', integrity: '', files: [], sharedEdits: [] }, // id mismatch
          mal3: { id: 'mal3', version: '1.0.0' }, // missing required fields
        },
      }),
      'utf8',
    );
    const reg = load(home);
    const roots = (reg._overlay && reg._overlay.commandRoots) || {};
    assert.ok(!('mal1' in roots), '_pending:null (own-property intent) is not consent');
    assert.ok(!('mal2' in roots), 'entry.id mismatch is not consent');
    assert.ok(!('mal3' in roots), 'missing required fields is not consent');
  });
});

describe('loadRegistry — first-party always wins', () => {
  test('overlay whose id collides with a first-party id is rejected; first-party preserved', (t) => {
    const home = makeOverlayHome([featureCap('ui', { skills: ['hijacked'] })]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.equal(reg.capabilities['ui'].title, 'UI design contracts', 'first-party ui untouched');
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'ui' && /collide/i.test(w.reason)));
  });

  test('overlay claiming a first-party skill stem is rejected', (t) => {
    const home = makeOverlayHome([featureCap('skill-thief', { skills: ['ui-phase'] })]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['skill-thief']);
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'skill-thief' && /skill/i.test(w.reason)));
  });

  test('reserved id prefix (gsd-/gsd-core-/anthropic-) is rejected', (t) => {
    const home = makeOverlayHome([
      featureCap('gsd-impostor'),
      featureCap('anthropic-impostor'),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['gsd-impostor']);
    assert.ok(!reg.capabilities['anthropic-impostor']);
    assert.equal(reg._overlay.warnings.filter((w) => /reserved/i.test(w.reason)).length, 2);
  });
});

describe('loadRegistry — load-time re-gate (engines.gsd) + fail-closed gates', () => {
  test('incompatible engines.gsd is skipped with a warning', (t) => {
    const home = makeOverlayHome([featureCap('future-cap', { engines: { gsd: '>=99.0.0' } })]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['future-cap']);
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'future-cap' && /incompatible/i.test(w.reason)));
    assert.deepEqual(reg._overlay.incompatibleGateCapIds, [], 'no gate declared → not a fail-closed blocker');
  });

  test('a skipped capability that DECLARES a gate is recorded for fail-closed handling', (t) => {
    const home = makeOverlayHome([
      featureCap('incompat-gate', {
        engines: { gsd: '>=99.0.0' },
        gates: [{ point: 'execute:wave:post', check: { query: 'x.deploy' }, blocking: true, onError: 'halt' }],
      }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['incompat-gate'], 'incompatible cap not loaded');
    assert.ok(reg._overlay.incompatibleGateCapIds.includes('incompat-gate'), 'gate-kind tracked as fail-closed');
    assert.ok(
      reg._overlay.blockedGates.some((g) => g.point === 'execute:wave:post' && g.capId === 'incompat-gate'),
      'declared gate point recorded for per-point fail-closed injection',
    );
  });

  test('compatible engines.gsd is accepted', (t) => {
    const home = makeOverlayHome([featureCap('compat-cap', { engines: { gsd: '>=1.6.0 <3.0.0' } })]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(reg.capabilities['compat-cap']);
  });
});

describe('loadRegistry — malformed overlays are skipped, never crash', () => {
  test('manifest failing validation is skipped with a warning', (t) => {
    const home = makeOverlayHome([
      // missing required version → validateCapability error
      (() => { const c = featureCap('no-version'); delete c.version; return c; })(),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['no-version']);
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'no-version' && /version/i.test(w.reason)));
  });

  test('unreadable / invalid JSON is skipped with a warning (no throw)', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-badjson-'));
    t.after(() => cleanup(home));
    const dir = path.join(home, '.gsd', 'capabilities', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), '{ not valid json', 'utf8');
    let reg;
    assert.doesNotThrow(() => { reg = load(home); });
    assert.ok(!reg.capabilities['broken']);
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'broken'));
  });

  test('the loop never crashes — first-party registry remains fully intact alongside bad overlays', (t) => {
    const home = makeOverlayHome([
      featureCap('gsd-reserved'),
      (() => { const c = featureCap('bad'); c.role = 'nonsense'; return c; })(),
      featureCap('good', { skills: ['good-only-skill'] }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.equal(Object.keys(baseRegistry.capabilities).length + 1, Object.keys(reg.capabilities).length,
      'exactly the one good overlay is added; first-party count preserved');
    assert.ok(reg.capabilities['good']);
  });
});

describe('loadRegistry — full merged-set cross-capability validation', () => {
  test('overlay claiming a first-party command family is rejected (first-party wins)', (t) => {
    const firstPartyFamily = Object.keys(baseRegistry.commandFamilies || {})[0];
    assert.ok(firstPartyFamily, 'precondition: first-party owns at least one command family');
    const home = makeOverlayHome([
      featureCap('cmd-thief', { commands: [{ family: firstPartyFamily, module: 'thief.cjs', router: 'route' }] }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['cmd-thief'], 'overlay hijacking a first-party command family is not loaded');
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'cmd-thief' && /command family/i.test(w.reason)));
    assert.ok(reg.commandFamilies[firstPartyFamily], 'first-party command family preserved');
  });

  test('overlay with an unsatisfiable consumes is rejected by cross-capability validation', (t) => {
    const home = makeOverlayHome([
      featureCap('bad-consumes', {
        skills: ['bad-consumes-skill'],
        config: { 'workflow.bad_consumes': { type: 'boolean', default: true, description: 'x' } },
        steps: [{ point: 'plan:pre', ref: { skill: 'bad-consumes-skill' }, produces: [], consumes: ['NONEXISTENT-ARTIFACT.md'], when: 'workflow.bad_consumes', onError: 'skip' }],
      }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['bad-consumes'], 'overlay failing consumes-satisfiability is not loaded');
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'bad-consumes' && /cross-capability/i.test(w.reason)));
  });

  test('an invalid hook fragment path (escaping the capability dir) is rejected', (t) => {
    const home = makeOverlayHome([
      featureCap('frag-escape', {
        contributions: [{ point: 'plan:pre', into: 'planner', fragment: { path: '../../../etc/passwd' }, when: 'workflow.frag', onError: 'skip' }],
        config: { 'workflow.frag': { type: 'boolean', default: true, description: 'x' } },
      }),
    ]);
    t.after(() => cleanup(home));
    const reg = load(home);
    assert.ok(!reg.capabilities['frag-escape'], 'overlay with an escaping fragment path is not loaded');
    assert.ok(reg._overlay.warnings.some((w) => w.id === 'frag-escape' && /fragment/i.test(w.reason)));
  });
});

describe('loadRegistry — project-scoped overlay root', () => {
  test('reads an overlay from <projectRoot>/.gsd/capabilities when cwd is inside a project', (t) => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-proj-'));
    t.after(() => cleanup(proj));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true }); // project-root marker
    const dir = path.join(proj, '.gsd', 'capabilities', 'proj-cap');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('proj-cap', { skills: ['proj-skill'] })), 'utf8');

    // Point the global home elsewhere (empty) so only the project scope contributes.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-emptyhome-'));
    t.after(() => cleanup(emptyHome));
    const reg = loadRegistry({ includeInstalled: true, gsdHome: emptyHome, cwd: proj, hostVersion: HOST });
    assert.ok(reg.capabilities['proj-cap'], 'project-scoped overlay loaded');
  });
});
