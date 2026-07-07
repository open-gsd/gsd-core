'use strict';

/**
 * issue-2045-third-party-skills-surface.test.cjs — regression for bug #2045.
 *
 * A skills-only `role: feature` third-party capability installs "active" but its
 * skills never surface, `capability enable`/`set` reject it as "unknown", and
 * `capability list` disagrees with `capability state`. Three defects, fix shape
 * "1b" (teach resolveSurface, no on-disk linking):
 *
 *   D1 (materialization): resolveSurface built the `skills` Set only from the
 *      on-disk skill manifest; third-party cap skills live at
 *      ~/.gsd/capabilities/<id>/skills/ and never entered the Set → surfaced:false.
 *      FIX: union registry.capabilityClusters values into the Set.
 *   D2 (enable/set unknown): setCapabilityState validated the capId against the
 *      STATIC first-party registry instead of the composed overlay-aware registry.
 *      FIX: validate against loadRegistry({ includeInstalled }).
 *   D3 (list vs state): `capability list` derived `status` purely from ledger
 *      existence, never surface composition. FIX: add a `surfaced` field so list
 *      reflects the same surface state `capability state` reports.
 *
 * Acceptance criteria (each is a release blocker, per the issue's "I'd expect"
 * table):
 *   AC1 [D1]: resolveSurface includes a third-party cap's skill stems.
 *   AC2:      capability state reports the cap present with surfaced:true.
 *   AC3 [D2]: capability enable/set on an installed third-party cap does NOT
 *             error "unknown capability".
 *   AC4 [D3]: capability list reflects surface state (list/state agree).
 *   AC5:      first-party caps unaffected; writer still rejects truly-unknown ids.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup } = require('./helpers.cjs');

const { resolveCapabilityRuntimeState } = require('../gsd-core/bin/lib/capability-state.cjs');
const { setCapabilityState } = require('../gsd-core/bin/lib/capability-writer.cjs');
const { resolveSurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadRegistry } = require('../gsd-core/bin/lib/capability-loader.cjs');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const CAP_ID = 'demo-2045-cap';
const CAP_SKILLS = ['demo-2045-alpha', 'demo-2045-beta'];
const HOST_RANGE = '>=1.0.0';

const tmps = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
after(() => { for (const d of tmps) cleanup(d); });

/** A conformant skills-only feature capability manifest (the reporter's shape). */
function skillsOnlyCap(id, skills) {
  return {
    id,
    role: 'feature',
    version: '1.0.0',
    title: id,
    description: 'skills-only third-party capability (issue #2045 fixture)',
    tier: 'full',
    requires: [],
    engines: { gsd: HOST_RANGE },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills,
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
}

/** Write a global-scope overlay bundle at <home>/.gsd/capabilities/<id>/. */
function writeGlobalBundle(home, id, skills) {
  const dir = path.join(home, '.gsd', 'capabilities', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(skillsOnlyCap(id, skills)), 'utf8');
  // Materialize each declared skill so the bundle mirrors a real install.
  for (const stem of skills) {
    const skillDir = path.join(dir, 'skills', stem);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\ndescription: ${stem}\n---\n# ${stem}\n`, 'utf8');
  }
  return dir;
}

/** A temp runtime config dir with NO .gsd-profile marker → default 'full' profile. */
function makeRcd() {
  return tmpDir('issue2045-rcd-');
}

/** A temp cwd with .planning/config.json so project-root resolution is hermetic. */
function makeCwd() {
  const cwd = tmpDir('issue2045-cwd-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
  return cwd;
}

/** GSD_HOME-sandboxed env that also neutralizes ambient GSD_ vars (hermeticity). */
function scopeEnv(home) {
  return { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
}

const savedGsdHome = process.env.GSD_HOME;

// ─── AC1 [D1]: resolveSurface unions registry.capabilityClusters ─────────────

describe('issue #2045 AC1 — resolveSurface includes third-party cap skills [D1]', () => {
  test('a composed registry surfaces third-party cap skills without on-disk linking', () => {
    const home = tmpDir('issue2045-home-');
    writeGlobalBundle(home, CAP_ID, CAP_SKILLS);
    const rcd = makeRcd();
    const cwd = makeCwd();
    process.env.GSD_HOME = home;
    try {
      // Composed overlay-aware registry (the loader composes ACTIVE overlay caps).
      const registry = loadRegistry({ includeInstalled: true, cwd, gsdHome: home });
      const clusters = (registry && registry.capabilityClusters) || {};
      assert.ok(Array.isArray(clusters[CAP_ID]), `fixture cap "${CAP_ID}" must own skills in capabilityClusters (loader did not accept the overlay — check engines/validation)`);

      // Empty manifest + composed registry: in the 'full' profile the skills Set
      // is materialized from the manifest (empty here) THEN, after the fix, unioned
      // with capabilityClusters values. Third-party skills are NOT on disk in rcd,
      // so they can only appear via the registry union.
      const surface = resolveSurface(rcd, new Map(), undefined, registry);
      assert.ok(surface.skills instanceof Set, 'resolveSurface returns a skills Set');
      for (const stem of CAP_SKILLS) {
        assert.ok(
          surface.skills.has(stem),
          `AC1: third-party skill "${stem}" must be in the surfaced Set (no on-disk linking) — got [${[...surface.skills].join(', ')}]`,
        );
      }
    } finally {
      process.env.GSD_HOME = savedGsdHome;
    }
  });
});

// ─── AC2: capability state reports present + surfaced:true ───────────────────

describe('issue #2045 AC2 — capability state reports surfaced:true', () => {
  test('resolveCapabilityRuntimeState surfaces an installed third-party skills cap', () => {
    const home = tmpDir('issue2045-home-');
    writeGlobalBundle(home, CAP_ID, CAP_SKILLS);
    const rcd = makeRcd();
    const cwd = makeCwd();
    process.env.GSD_HOME = home;
    try {
      const state = resolveCapabilityRuntimeState(cwd, rcd);
      const cap = state.capabilities.find((c) => c.id === CAP_ID);
      assert.ok(cap, `AC2: capability state must list "${CAP_ID}" as present`);
      assert.equal(cap.surfaced, true, 'AC2: surfaced must be true');
      assert.equal(cap.installed, true, 'AC2: installed must be true (default full profile)');
      // No activationKey on the fixture → active === enabled.
      assert.equal(cap.active, true, 'AC2: active must be true (no config gate)');
    } finally {
      process.env.GSD_HOME = savedGsdHome;
    }
  });
});

// ─── AC3 [D2]: enable/set does NOT error "unknown capability" ────────────────

describe('issue #2045 AC3 — enable/set accepts an installed third-party cap [D2]', () => {
  test('setCapabilityState({enabled:true}) on an installed third-party cap is not "unknown"', () => {
    const home = tmpDir('issue2045-home-');
    writeGlobalBundle(home, CAP_ID, CAP_SKILLS);
    const rcd = makeRcd();
    const cwd = makeCwd();
    process.env.GSD_HOME = home;
    try {
      const result = setCapabilityState(cwd, rcd, [{ id: CAP_ID, enabled: true }]);
      const unknownErr = (result.errors || []).find((e) => /unknown capability/i.test(String(e)));
      assert.ok(!unknownErr, `AC3: must not error "unknown capability" for installed third-party cap — got errors: ${JSON.stringify(result.errors)}`);
      const cap = (result.capabilities || []).find((c) => c.id === CAP_ID);
      assert.ok(cap, 'AC3: result must include the third-party cap');
    } finally {
      process.env.GSD_HOME = savedGsdHome;
    }
  });

  test('AC5 (regression): a truly-unknown id is STILL rejected as "unknown capability"', () => {
    const rcd = makeRcd();
    const cwd = makeCwd();
    const home = tmpDir('issue2045-home-empty-');
    process.env.GSD_HOME = home;
    try {
      const result = setCapabilityState(cwd, rcd, [{ id: 'nonexistent-cap-2045', enabled: true }]);
      const unknownErr = (result.errors || []).find((e) => /unknown capability/i.test(String(e)));
      assert.ok(unknownErr, 'AC5: truly-unknown id must still be rejected (writer validates against composed registry, not "accept all")');
    } finally {
      process.env.GSD_HOME = savedGsdHome;
    }
  });

  test('AC5 (regression): a first-party cap still resolves and surfaces', () => {
    const rcd = makeRcd();
    const cwd = makeCwd();
    const home = tmpDir('issue2045-home-empty-');
    process.env.GSD_HOME = home;
    try {
      const state = resolveCapabilityRuntimeState(cwd, rcd);
      // 'ui' is a first-party skill-owning capability; it must still be present.
      const ui = state.capabilities.find((c) => c.id === 'ui');
      assert.ok(ui, 'AC5: first-party "ui" capability still present');
    } finally {
      process.env.GSD_HOME = savedGsdHome;
    }
  });
});

// ─── AC4 [D3]: capability list reflects surface state (list/state agree) ─────

describe('issue #2045 AC4 — capability list reflects surface state [D3]', () => {
  test('an installed skills cap: list `surfaced` agrees with `capability state`', () => {
    const home = tmpDir('issue2045-home-');
    const cwd = makeCwd();

    // Build a local source dir that declares skills AND materializes them, then
    // install it globally — the real end-to-end path the reporter used.
    const src = tmpDir('issue2045-src-');
    const cap = skillsOnlyCap(CAP_ID, CAP_SKILLS);
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap), 'utf8');
    for (const stem of CAP_SKILLS) {
      const skillDir = path.join(src, 'skills', stem);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\ndescription: ${stem}\n---\n# ${stem}\n`, 'utf8');
    }

    const installRes = runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], cwd, scopeEnv(home));
    assert.equal(installRes.success, true, `install failed: ${installRes.error || installRes.output}`);

    // capability list --json must include a `surfaced` field for the overlay row.
    const listRes = runGsdTools(['capability', 'list', '--json'], cwd, scopeEnv(home));
    assert.equal(listRes.success, true, `list failed: ${listRes.error || listRes.output}`);
    const listRows = JSON.parse(listRes.output);
    const listRow = listRows.find((r) => r.id === CAP_ID);
    assert.ok(listRow, 'AC4: installed cap present in list');
    assert.ok(
      Object.prototype.hasOwnProperty.call(listRow, 'surfaced'),
      `AC4: list row must carry a 'surfaced' field reflecting surface composition — got keys: ${Object.keys(listRow).join(', ')}`,
    );
    assert.equal(listRow.surfaced, true, 'AC4: list surfaced === true (skills resolved via registry union)');

    // capability state <id> --json must agree.
    const stateRes = runGsdTools(['capability', 'state', CAP_ID, '--json'], cwd, scopeEnv(home));
    assert.equal(stateRes.success, true, `state failed: ${stateRes.error || stateRes.output}`);
    const stateObj = JSON.parse(stateRes.output);
    const stateCap = (stateObj.capabilities || []).find((c) => c.id === CAP_ID);
    assert.ok(stateCap, 'AC4: capability state must list the cap');
    assert.equal(stateCap.surfaced, true, 'AC4: state surfaced === true');

    // The agreement the reporter asked for: list.surfaced === state.surfaced.
    assert.equal(listRow.surfaced, stateCap.surfaced, 'AC4: list and state must AGREE on surfaced');
  });
});
