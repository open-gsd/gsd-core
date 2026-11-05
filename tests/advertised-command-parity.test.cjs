'use strict';

/**
 * #5215 / ADR-5057 Phase 12 — the installer's advertised "next step" command
 * is generated from the runtime's registered trigger surface, never from a
 * hand-kept per-runtime table (#4567: pi advertised `/gsd-new-project` while
 * registering only `/gsd`).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const { resolveAdvertisedNewProject, resolveTriggerSurface } = layout;

const RUNTIME_IDS = Object.keys(registry.runtimes).sort();
const SCOPES = ['global', 'local'];
const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const DEFAULT_CMD = '/gsd-new-project';

function registeredTriggers(runtime, scope) {
  return resolveTriggerSurface(runtime, [scope], { stems: ['new-project'] }).map((t) => t.trigger);
}

// What each registered runtime is told to type. Every current runtime registers the
// trigger `gsd-new-project`; three hosts invoke it with their own syntax. Pinned as
// literals, not derived from the renderer, so a wrong renderer entry goes red.
const INVOCATION = {
  codex: '$gsd-new-project',
  cursor: 'gsd-new-project (mention the skill name)',
  kimi: '/skill:gsd-new-project',
  pi: '/skill:gsd-new-project',
};
const expectedCommand = (runtime) => INVOCATION[runtime] || DEFAULT_CMD;

describe('advertised command equals the registered surface', () => {
  for (const runtime of RUNTIME_IDS) {
    for (const scope of SCOPES) {
      test(`${runtime} ${scope}: advertised iff a new-project trigger is registered, and it is the exact rendered command`, () => {
        const triggers = registeredTriggers(runtime, scope);
        const advert = resolveAdvertisedNewProject(runtime, scope);
        if (triggers.length === 0) {
          assert.equal(advert.kind, 'unregistered');
          return;
        }
        assert.deepEqual(triggers, triggers.map(() => 'gsd-new-project'), `${runtime} ${scope}: registered trigger is not gsd-new-project`);
        assert.deepEqual(advert, { kind: 'command', command: expectedCommand(runtime) });
      });
    }
  }

  // INTENTIONAL RATCHET: this list is the census of runtime x scope pairs that
  // register no new-project trigger. A change here is a change in what a user is
  // told after install — review it, do not just update it.
  test('runtimes that register no new-project trigger in a scope are exactly the ones that advertise nothing there', () => {
    const unregistered = [];
    for (const runtime of RUNTIME_IDS) {
      for (const scope of SCOPES) {
        if (resolveAdvertisedNewProject(runtime, scope).kind === 'unregistered') unregistered.push(`${runtime}:${scope}`);
      }
    }
    assert.deepEqual(unregistered.sort(), [
      'vscode:global', 'vscode:local', 'windsurf:global',
      'cline:local', 'kimi:local', 'kimi-code:local',
    ].sort());
  });

  // #5547: pi used to be the one runtime whose only registered surface was its
  // native `/gsd` extension command, so it was told to run `/gsd`. It now also
  // installs every command as a skill, so it is told the skill command — and
  // the extension's own `/gsd` is still the one command it registers.
  test('pi registers a new-project skill trigger and is told to invoke it as /skill:', () => {
    const names = [];
    const pi = new Proxy({}, { get: (_, key) => (key === 'registerCommand' ? (name) => names.push(name) : () => {}) });
    require('../pi/gsd.cjs')(pi);
    assert.deepEqual(names, ['gsd']);
    for (const scope of SCOPES) {
      assert.deepEqual(registeredTriggers('pi', scope), ['gsd-new-project']);
      assert.deepEqual(resolveAdvertisedNewProject('pi', scope), { kind: 'command', command: '/skill:gsd-new-project' });
    }
    assert.deepEqual(resolveAdvertisedNewProject('windsurf', 'global'), { kind: 'unregistered', nativeCommand: null });
  });
});

describe('previously advertised strings are preserved for registered runtimes (Hyrum)', () => {
  const EXPECTED = {
    claude: DEFAULT_CMD,
    codex: '$gsd-new-project',
    cursor: 'gsd-new-project (mention the skill name)',
    kimi: '/skill:gsd-new-project',
    'kimi-code': DEFAULT_CMD,
    opencode: DEFAULT_CMD,
    pi: '/skill:gsd-new-project',
    qwen: DEFAULT_CMD,
    windsurf: DEFAULT_CMD,
  };
  for (const [runtime, command] of Object.entries(EXPECTED)) {
    test(`${runtime}`, () => {
      const scope = registeredTriggers(runtime, 'global').length > 0 ? 'global' : 'local';
      assert.deepEqual(resolveAdvertisedNewProject(runtime, scope), { kind: 'command', command });
    });
  }
});

describe('cross-agent default for an id GSD cannot know (ADR-5057 §5 Phase 10 amendment)', () => {
  test('empty and unknown ids keep /gsd-new-project', () => {
    for (const id of ['', 'future-runtime-xyz', 'gemini']) {
      for (const scope of SCOPES) {
        assert.deepEqual(resolveAdvertisedNewProject(id, scope), { kind: 'command', command: DEFAULT_CMD });
      }
    }
  });

  test('property: a non-registered id never resolves to unregistered', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), fc.constantFrom(...SCOPES), (id, scope) => {
        if (Object.prototype.hasOwnProperty.call(registry.runtimes, id)) return true;
        return resolveAdvertisedNewProject(id, scope).kind === 'command';
      }),
    );
  });
});

describe('the installer completion message is generated from the registered surface (wired surface)', () => {
  const cases = [
    ['pi', 'global', true],
    ['windsurf', 'global', false],
    ['claude', 'global', true],
    ['codex', 'global', true],
  ];
  for (const [runtime, scope, advertises] of cases) {
    test(`${runtime} --${scope} ${advertises ? 'advertises' : 'does not advertise'} a new-project command`, () => {
      const res = runMinimalInstall({ runtime, scope });
      try {
        const out = res.stdout.replace(ANSI, '');
        const done = out.slice(out.lastIndexOf('Done!'));
        assert.ok(done.startsWith('Done!'), `no completion message in:\n${out}`);
        if (advertises) {
          assert.match(done, /gsd-new-project/);
          if (runtime === 'pi') assert.match(done, /\/skill:gsd-new-project/, 'pi invokes a skill as /skill:<name>, never /gsd-new-project');
        } else {
          assert.doesNotMatch(done, /gsd-new-project/, `completion message advertises an unregistered command:\n${done}`);
          assert.match(done, /registers no/);
        }
      } finally {
        cleanup(res.root);
      }
    });
  }
});
