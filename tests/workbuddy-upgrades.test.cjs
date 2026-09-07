// docs-guard-exempt: codebuddy.ai/docs/... is an external URL citation in a comment, not a repo path.
'use strict';

/**
 * WorkBuddy capability UPGRADES — #4952 (WorkBuddy runtime).
 *
 * WorkBuddy is built on the same CodeBuddy Code core as CodeBuddy, so the two
 * EoS-driven upgrades CodeBuddy contributed apply identically to WorkBuddy:
 *
 *   UPGRADE 1 — extended hook events: WorkBuddy's `extendedHookEvents` wires
 *   all four Claude-compatible lifecycle events — `SubagentStop` / `Stop` /
 *   `PreCompact` / `SubagentStart` — via gsd-context-monitor.js. Without
 *   this wiring a fresh `--workbuddy --global` install would leave the host
 *   with no subagent-lifecycle or stop/compact hooks, breaking the
 *   context-headroom tracking the GSD workflow assumes.
 *
 *   UPGRADE 2 — dispatch.background: WorkBuddy's capability.json declares
 *   `dispatch.background: true`, which legitimately EXCEEDS the
 *   `declarative-cli` profile baseline (`false`, per
 *   `PROFILE_BASELINES['declarative-cli']` in src/host-integration.cts).
 *   No agent-file/frontmatter change is involved — the WorkBuddy host (like
 *   CodeBuddy) has no background-dispatch frontmatter field. The
 *   documented `true` value must survive negotiation without a downgrade
 *   warning.
 *
 *   The ONLY behavioral difference from CodeBuddy at the content-conversion
 *   layer is `$ARGUMENTS` preservation (see #4952) — covered separately by
 *   tests/workbuddy-install.test.cjs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
} = require('../gsd-core/bin/lib/host-integration.cjs');

const WORKBUDDY_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'workbuddy', 'capability.json'), 'utf8'),
);
const WORKBUDDY_AXES = WORKBUDDY_CAP.runtime.hostIntegration;

// ---------------------------------------------------------------------------
// UPGRADE 1: extended hook events — all 4 events' live-install coverage
// ---------------------------------------------------------------------------

test('capabilities/workbuddy/capability.json extendedHookEvents contains exactly the 4 documented events', () => {
  const events = WORKBUDDY_CAP.runtime.extendedHookEvents;
  assert.deepEqual(events, ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart']);
  assert.equal(events.length, 4);
});

test('workbuddy --global: settings.json wires all 4 extended hook events to the GSD context-monitor hook (UPGRADE 1)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'workbuddy', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  assert.ok(fs.existsSync(settingsPath), `${settingsPath} must exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const EXTENDED_EVENTS = ['SubagentStop', 'Stop', 'PreCompact', 'SubagentStart'];

  const entries = EXTENDED_EVENTS.map((eventName) => {
    const eventHooks = settings.hooks && settings.hooks[eventName];
    assert.ok(Array.isArray(eventHooks) && eventHooks.length > 0,
      `settings.hooks.${eventName} must exist and be non-empty`);
    const entry = eventHooks[0].hooks[0];
    assert.ok(entry.command.includes('gsd-context-monitor'),
      `${eventName} command must reference gsd-context-monitor.js, got: ${entry.command}`);
    assert.equal(entry.timeout, 10, `${eventName} entry must have timeout 10`);
    return entry;
  });

  const [stopEntry, ...restEntries] = entries;
  for (const entry of restEntries) {
    assert.equal(entry.command, stopEntry.command,
      'all 4 extended events must wire the same gsd-context-monitor command');
  }
});

test('a runtime whose extendedHookEvents omits SubagentStart does NOT get one (descriptor-gated, not a global default)', (t) => {
  const { configDir, root } = runMinimalInstall({ runtime: 'claude', scope: 'global' });
  t.after(() => cleanup(root));

  const settingsPath = path.join(configDir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.ok(
    settings.hooks && Array.isArray(settings.hooks.SubagentStop) && settings.hooks.SubagentStop.length > 0,
    'claude must have SubagentStop wired (sanity — proves hooks ARE configured)',
  );
  assert.ok(
    !settings.hooks || settings.hooks.SubagentStart === undefined,
    "claude must NOT have SubagentStart wired — it is not in claude's extendedHookEvents",
  );
});

// ---------------------------------------------------------------------------
// UPGRADE 2: dispatch.background negotiation — documented true survives,
// exceeding the declarative-cli profile baseline.
// ---------------------------------------------------------------------------

test("workbuddy classifies as the 'declarative-cli' profile, whose baseline dispatch.background is false", () => {
  assert.equal(profileOf(WORKBUDDY_AXES), 'declarative-cli');
  assert.equal(PROFILE_BASELINES['declarative-cli'].dispatch.background, false,
    'sanity: the declarative-cli baseline is false — workbuddy legitimately exceeds it');
});

test('negotiateHostCapabilities surfaces workbuddy\'s documented dispatch.background:true with no downgrade warning (UPGRADE 2)', () => {
  assert.equal(WORKBUDDY_AXES.dispatch.background, true,
    'sanity: the descriptor declares dispatch.background: true (documented, not undocumented)');

  const { effective, warnings } = negotiateHostCapabilities(WORKBUDDY_AXES);

  assert.equal(effective.dispatch.background, true,
    'a documented true value must survive negotiation, exceeding the declarative-cli baseline of false');
  assert.ok(
    !warnings.some((w) => w.includes('dispatch.background')),
    `no warning may be raised for the documented dispatch.background axis, got: ${JSON.stringify(warnings)}`,
  );
});
