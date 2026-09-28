'use strict';

// NOTE: this file's readFileSync calls target .md/.json paths (workflow files,
// docs/CONFIGURATION.md, templates/config.json), never a .cjs/.js/.ts source
// path — the no-source-grep ESLint rule's trigger scope — so no
// `allow-test-rule:` marker applies here. `scripts/lint-allow-test-rule-refs.cjs`
// (its "unverified marker-bearing files" ratchet) rejects a marker with no
// detectable violation to suppress, which is exactly what a marker on this file
// would be.

/**
 * #4974 — `gates.*` confirmation toggles never take effect.
 *
 * Two-sided defect: (a) `gsd-core/workflows/execute-plan.md`,
 * `transition.md`, and `complete-milestone.md` gated `gates.<key>` on a
 * `mode="custom"` value that does not exist (only `"interactive"`/`"yolo"`
 * are real), so the toggle never had any effect regardless of mode; (b) the
 * config schema manifest had no `gates.*` entry at all, so `config-set
 * gates.<key>` was rejected as "Unknown config key" and the loader reported
 * the `gates` block in a config.json copied from the shipped template as
 * "will be ignored". `mode` itself was never enum-validated, so
 * `config-set mode custom` silently "succeeded".
 *
 * Same defect class as #1577/#1747/#1814 (config-schema.manifest.json
 * missing an entry for a documented, read key) — see
 * tests/injection-blocking-config.test.cjs for the sibling regression this
 * mirrors.
 *
 * Only 3 of the 8 documented `gates.*` keys (plus 1 undocumented one) are
 * actually read by any workflow condition: `gates.execute_next_plan`
 * (execute-plan.md), `gates.confirm_transition` (transition.md),
 * `gates.confirm_milestone_scope` (complete-milestone.md, previously
 * undocumented). The fix registers exactly those three — NOT a `gates.*`
 * wildcard — so a same-shaped but unread key (`gates.confirm_project`) must
 * keep being rejected (see 'boundary' describe block below).
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/configuration.cjs');

const REAL_GATE_KEYS = [
  'gates.execute_next_plan',
  'gates.confirm_transition',
  'gates.confirm_milestone_scope',
];

const WORKFLOW_FILES = {
  'execute-plan.md': { path: ['gsd-core', 'workflows', 'execute-plan.md'], key: 'gates.execute_next_plan' },
  'transition.md': { path: ['gsd-core', 'workflows', 'transition.md'], key: 'gates.confirm_transition' },
  'complete-milestone.md': { path: ['gsd-core', 'workflows', 'complete-milestone.md'], key: 'gates.confirm_milestone_scope' },
};

const DOCS_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'CONFIGURATION.md');
const TEMPLATE_CONFIG_PATH = path.join(__dirname, '..', 'gsd-core', 'templates', 'config.json');

describe('#4974 — gates.* schema registration (happy path)', () => {
  for (const key of REAL_GATE_KEYS) {
    test(`isValidConfigKey accepts ${key}`, () => {
      assert.ok(isValidConfigKey(key), `${key} must be a valid config key`);
    });
  }

  test('config-set gates.execute_next_plan false is accepted and round-trips', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'gates.execute_next_plan', 'false'], proj);
    assert.ok(res.success, `config-set should succeed: ${res.output || res.error || ''}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(proj, '.planning', 'config.json'), 'utf8'));
    assert.equal(cfg.gates.execute_next_plan, false, 'must persist nested gates.execute_next_plan');
    assert.equal(cfg['gates.execute_next_plan'], undefined, 'must NOT persist a flat dotted key');

    const get = runGsdTools(['config-get', 'gates.execute_next_plan'], proj);
    assert.ok(get.success, `config-get should succeed: ${get.output || get.error || ''}`);
    assert.match(String(get.output || ''), /false/, 'config-get should read back false');
  });

  test('config-set gates.confirm_transition true and gates.confirm_milestone_scope false both accepted', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const r1 = runGsdTools(['config-set', 'gates.confirm_transition', 'true'], proj);
    assert.ok(r1.success, `config-set confirm_transition should succeed: ${r1.output || r1.error || ''}`);
    const r2 = runGsdTools(['config-set', 'gates.confirm_milestone_scope', 'false'], proj);
    assert.ok(r2.success, `config-set confirm_milestone_scope should succeed: ${r2.output || r2.error || ''}`);
  });
});

describe('#4974 — gates.* defaults (regression: unset key preserves documented default)', () => {
  for (const key of REAL_GATE_KEYS) {
    test(`CONFIG_DEFAULTS.gates.${key.split('.')[1]} defaults to true`, () => {
      const field = key.split('.')[1];
      assert.equal(
        CONFIG_DEFAULTS.gates && CONFIG_DEFAULTS.gates[field],
        true,
        `${key} must default to true (per docs/CONFIGURATION.md Gate Settings)`,
      );
    });

    test(`config-get ${key} on a fresh project (no gates block) resolves to the default, not "Key not found"`, (t) => {
      const proj = createTempProject();
      t.after(() => cleanup(proj));

      const get = runGsdTools(['config-get', key], proj);
      assert.ok(get.success, `config-get ${key} should succeed on an absent key: ${get.output || get.error || ''}`);
      assert.match(String(get.output || ''), /true/, `config-get ${key} should resolve to the documented default (true)`);
    });
  }
});

describe('#4974 — mode is now enum-validated', () => {
  test('config-set mode interactive succeeds', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'mode', 'interactive'], proj);
    assert.ok(res.success, `config-set mode interactive should succeed: ${res.output || res.error || ''}`);
  });

  test('config-set mode yolo succeeds', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'mode', 'yolo'], proj);
    assert.ok(res.success, `config-set mode yolo should succeed: ${res.output || res.error || ''}`);
  });

  test('config-set mode custom is REJECTED (previously silently accepted)', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'mode', 'custom'], proj);
    assert.ok(!res.success, 'config-set mode custom must be rejected — "custom" is not a documented mode value');
  });

  test('config-set mode banana is REJECTED (previously silently accepted)', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'mode', 'banana'], proj);
    assert.ok(!res.success, 'config-set mode banana must be rejected');
  });
});

describe('#4974 — boundary: a same-shaped but unregistered gate key stays rejected', () => {
  // gates.confirm_project has the identical dotted-key SHAPE as the 3 real
  // keys above, but nothing reads it (see 10-diagnosis.md). The fix must not
  // have widened the schema to a `gates.*` wildcard just to accept the 3 real
  // keys — that would silently re-admit the same "accepted but has no effect"
  // defect for every other gates.* name.
  test('isValidConfigKey rejects gates.confirm_project', () => {
    assert.ok(!isValidConfigKey('gates.confirm_project'), 'gates.confirm_project must stay rejected (unread key)');
  });

  test('config-set gates.confirm_project true is REJECTED', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const res = runGsdTools(['config-set', 'gates.confirm_project', 'true'], proj);
    assert.ok(!res.success, 'config-set gates.confirm_project must be rejected — not a registered key');
  });

  test('bare "gates" is not a settable leaf key', () => {
    assert.ok(!isValidConfigKey('gates'), 'bare "gates" must be rejected (use gates.<key>)');
  });
});

describe('#4974 — loader no longer warns "will be ignored" for a gates block', () => {
  // `config-get` reads config.json directly and does NOT walk loadConfig's
  // unknown-top-level-key check; `loadConfigResolved` (src/config-loader.cts)
  // is the actual code path that emits "unknown config key(s) ... will be
  // ignored", so exercise it directly rather than through a CLI verb that
  // happens not to reach it.
  const { loadConfigResolved, _resetRuntimeWarningCacheForTests } = require('../gsd-core/bin/lib/config-loader.cjs');

  function loadWithCapturedStderr(cwd) {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      loadConfigResolved(cwd);
    } finally {
      process.stderr.write = origWrite;
    }
    return captured;
  }

  test('a gates block produces no "unknown config key" warning', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const cfgPath = path.join(proj, '.planning', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gates: { execute_next_plan: false } }, null, 2));
    if (typeof _resetRuntimeWarningCacheForTests === 'function') _resetRuntimeWarningCacheForTests();

    const captured = loadWithCapturedStderr(proj);
    assert.ok(
      !/unknown config key\(s\)/i.test(captured),
      `must not warn about an unknown config key for a gates block: ${captured}`,
    );
  });

  test('negative control: a genuinely unknown top-level key still warns (proves the mechanism fires)', (t) => {
    const proj = createTempProject();
    t.after(() => cleanup(proj));

    const cfgPath = path.join(proj, '.planning', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ totallyBogusKeyXYZ: { a: 1 } }, null, 2));
    if (typeof _resetRuntimeWarningCacheForTests === 'function') _resetRuntimeWarningCacheForTests();

    const captured = loadWithCapturedStderr(proj);
    assert.match(
      captured,
      /unknown config key\(s\) in \.planning\/config\.json: totallyBogusKeyXYZ/,
      `expected the unknown-key warning for a genuinely bogus top-level key: ${captured}`,
    );
  });
});

describe('#4974 — doc/workflow content parity', () => {
  let docsContent;

  before(() => {
    docsContent = fs.readFileSync(DOCS_CONFIG_PATH, 'utf-8');
  });

  test('docs/CONFIGURATION.md Gate Settings documents exactly the 3 real gate keys', () => {
    for (const key of REAL_GATE_KEYS) {
      assert.ok(docsContent.includes(`\`${key}\``), `docs/CONFIGURATION.md must document ${key}`);
    }
    const removedKeys = [
      'gates.confirm_project',
      'gates.confirm_phases',
      'gates.confirm_roadmap',
      'gates.confirm_breakdown',
      'gates.confirm_plan',
      'gates.issues_review',
    ];
    for (const key of removedKeys) {
      assert.ok(!docsContent.includes(`\`${key}\``), `docs/CONFIGURATION.md must NOT document unread key ${key}`);
    }
  });

  test('docs/CONFIGURATION.md no longer has a Safety Settings section for unread keys', () => {
    assert.ok(!docsContent.includes('## Safety Settings'), 'Safety Settings section must be removed (nothing reads safety.*)');
    assert.ok(!docsContent.includes('safety.always_confirm_destructive'), 'safety.always_confirm_destructive must be removed from docs');
    assert.ok(!docsContent.includes('safety.always_confirm_external_services'), 'safety.always_confirm_external_services must be removed from docs');
  });

  test('templates/config.json gates block has exactly the 3 real keys and no safety block', () => {
    const tpl = JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf-8'));
    assert.deepStrictEqual(
      Object.keys(tpl.gates || {}).sort(),
      ['confirm_milestone_scope', 'confirm_transition', 'execute_next_plan'],
      'templates/config.json gates block must contain exactly the 3 real keys',
    );
    assert.equal(tpl.safety, undefined, 'templates/config.json must not ship an unread safety block');
  });

  for (const [name, info] of Object.entries(WORKFLOW_FILES)) {
    test(`${name} no longer gates ${info.key} on the fictional "custom" mode`, () => {
      const content = fs.readFileSync(path.join(__dirname, '..', ...info.path), 'utf-8');
      assert.ok(!content.includes('custom with gates.'), `${name} must not reference the undocumented "custom" mode`);
      assert.ok(
        content.includes(`mode="interactive" AND="${info.key} != false"`),
        `${name} must gate ${info.key} on mode="interactive" AND="${info.key} != false"`,
      );
    });
  }
});
