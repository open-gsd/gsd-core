'use strict';

/**
 * capability-cli.test.cjs — behavioral tests for the `gsd capability` MANAGEMENT CLI
 * (ADR-1244 D5/D6): install / update / remove / list / disable / enable wired in
 * gsd-tools.cjs `case 'capability'` to the Phase-4 lifecycle + Phase-3 ledger.
 *
 * These exercise the REAL CLI end-to-end via runGsdTools (subprocess), the REAL
 * source resolver (local-path kind — no network), and a GSD_HOME-sandboxed global
 * scope so no developer state is touched. They are the contract the reference doc
 * (docs/reference/gsd-capability-command.md) is verified against.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const tmps = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
test.after(() => { for (const d of tmps) cleanup(d); });

/** A GSD_HOME-sandboxed env that also neutralizes ambient GSD_ vars (test hermeticity). */
function scopeEnv(home) {
  return { GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '' };
}

/** A cwd with a .planning/ root so findProjectRoot resolves cleanly. */
function makeCwd() {
  const cwd = tmpDir('cap-cli-cwd-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
  return cwd;
}

/** A project cwd whose config carries a given capabilities.strict_known_registries value. */
function makeCwdWithStrict(strictValue) {
  const cwd = tmpDir('cap-cli-cwd-');
  fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.planning', 'config.json'),
    JSON.stringify({ capabilities: { strict_known_registries: strictValue } }),
  );
  return cwd;
}

/**
 * Write a conformant local capability source dir and return its absolute path
 * (usable directly as an install <spec>). Declarative by default; pass `hooks`
 * (with materialized scripts) to make it an executable surface requiring consent.
 */
function writeCapSource(id, { version = '1.0.0', hooks = [], engines, mcp } = {}) {
  const src = tmpDir(`cap-cli-src-${id}-`);
  const cap = {
    id,
    role: 'feature',
    version,
    title: id,
    description: 'test capability',
    tier: 'standard',
    requires: [],
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks,
    config: {},
    steps: [],
    contributions: [],
    gates: [],
  };
  if (engines) cap.engines = engines;
  if (mcp) cap.mcpServers = mcp; // object map { name: {command, ...} } — an executable surface
  fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
  for (const h of hooks) {
    if (h && h.script) {
      const p = path.join(src, h.script);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '// artifact', 'utf8');
    }
  }
  return src;
}

function ledgerPath(home) { return path.join(home, '.gsd-capabilities.json'); }
function capDir(home, id) { return path.join(home, '.gsd', 'capabilities', id); }
function readLedgerEntry(home, id) {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'));
    return l && l.entries && l.entries[id] ? l.entries[id] : null;
  } catch { return null; }
}
function parse(out) { return JSON.parse(out); }

// ─── install ────────────────────────────────────────────────────────────────

describe('capability install', () => {
  test('declarative local capability installs to the global scope and records the ledger', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('declcap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'installed');
    assert.equal(o.id, 'declcap');
    assert.equal(o.scope, 'global');
    assert.ok(readLedgerEntry(home, 'declcap'), 'ledger entry recorded');
    assert.ok(fs.existsSync(path.join(capDir(home, 'declcap'), 'capability.json')), 'bundle extracted');
  });

  test('executable capability WITHOUT --yes aborts for consent and writes nothing', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('execcap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'unconsented executable install must fail');
    assert.match(`${r.error}\n${r.output}`, /consent/i);
    assert.equal(readLedgerEntry(home, 'execcap'), null, 'no ledger entry');
    assert.ok(!fs.existsSync(capDir(home, 'execcap')), 'no install dir');
  });

  test('executable capability WITH --yes installs', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('execyes', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.equal(parse(r.output).status, 'installed');
    assert.ok(readLedgerEntry(home, 'execyes'), 'ledger entry recorded');
  });

  test('a reserved-namespace id is blocked', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('gsd-evil');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /blocked|reserved/i);
    assert.ok(!fs.existsSync(capDir(home, 'gsd-evil')));
  });

  test('an engines-incompatible capability is blocked', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('engcap', { engines: { gsd: '>=99.0.0' } });
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /blocked/i);
    assert.equal(readLedgerEntry(home, 'engcap'), null);
  });

  test('missing <spec> is a usage error', () => {
    const r = runGsdTools(['capability', 'install'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <spec>/i);
  });

  test('an invalid --scope is rejected', () => {
    const src = writeCapSource('scopecap');
    const r = runGsdTools(['capability', 'install', src, '--scope', 'bogus'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Invalid --scope/i);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────

describe('capability list', () => {
  test('--json emits an array including first-party capabilities', () => {
    const r = runGsdTools(['capability', 'list', '--json'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, true, `list failed: ${r.error || r.output}`);
    const rows = parse(r.output);
    assert.ok(Array.isArray(rows), 'list is an array');
    const fp = rows.filter((x) => x.source === 'first-party');
    assert.ok(fp.length > 0, 'first-party capabilities present');
    assert.ok(fp.every((x) => typeof x.id === 'string' && x.scope === 'first-party'));
  });

  test('an installed overlay capability appears with its scope', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('listcap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'list', '--json'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `list failed: ${r.error || r.output}`);
    const row = parse(r.output).find((x) => x.id === 'listcap');
    assert.ok(row, 'installed capability listed');
    assert.equal(row.scope, 'global');
    assert.equal(row.source, src);
    assert.equal(row.version, '1.0.0');
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('capability update', () => {
  test('a not-installed id errors', () => {
    const r = runGsdTools(['capability', 'update', 'nope', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not installed/i);
  });

  test('requires <id> or --all', () => {
    const r = runGsdTools(['capability', 'update', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /requires <id> or --all/i);
  });

  test('<id> and --all are mutually exclusive', () => {
    const r = runGsdTools(['capability', 'update', 'foo', '--all', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not both/i);
  });

  test('an installed capability upgrades to a newer version from its recorded source', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('upcap', { version: '1.0.0' });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Bump the recorded source to a newer version, then update by id.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'upcap', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `update failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'upgraded');
    assert.equal(o.fromVersion, '1.0.0');
    assert.equal(o.toVersion, '2.0.0');
    assert.equal(readLedgerEntry(home, 'upcap').version, '2.0.0');
  });
});

// ─── remove ─────────────────────────────────────────────────────────────────

describe('capability remove', () => {
  test('an installed overlay capability is removed (ledger + bundle gone)', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('rmcap');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const r = runGsdTools(['capability', 'remove', 'rmcap', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `remove failed: ${r.error || r.output}`);
    assert.equal(parse(r.output).status, 'removed');
    assert.equal(readLedgerEntry(home, 'rmcap'), null, 'ledger entry gone');
    assert.ok(!fs.existsSync(capDir(home, 'rmcap')), 'bundle gone');
  });

  test('a not-installed id errors', () => {
    const r = runGsdTools(['capability', 'remove', 'nope', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /not installed/i);
  });

  test('a first-party capability cannot be removed here', () => {
    // Pick a real first-party id from the registry.
    const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
    const firstParty = Object.keys(reg.capabilities)[0];
    const r = runGsdTools(['capability', 'remove', firstParty, '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /first-party/i);
  });

  test('missing <id> is a usage error', () => {
    const r = runGsdTools(['capability', 'remove'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <id>/i);
  });
});

// ─── disable / enable ─────────────────────────────────────────────────────────

describe('capability disable / enable', () => {
  test('disable then enable a first-party capability toggles its activation state', () => {
    const cwd = makeCwd();
    const rcd = tmpDir('cap-cli-rcd-');
    const off = runGsdTools(['capability', 'disable', 'ui', '--config-dir', rcd, '--raw'], cwd);
    assert.equal(off.success, true, `disable failed: ${off.error || off.output}`);
    const ui = parse(off.output).capabilities.find((c) => c.id === 'ui');
    assert.equal(ui.enabled, false, 'ui disabled');
    const on = runGsdTools(['capability', 'enable', 'ui', '--config-dir', rcd, '--raw'], cwd);
    assert.equal(on.success, true, `enable failed: ${on.error || on.output}`);
    assert.equal(parse(on.output).capabilities.find((c) => c.id === 'ui').enabled, true, 'ui re-enabled');
  });

  test('disable without <id> is a usage error', () => {
    const r = runGsdTools(['capability', 'disable'], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing <id>/i);
  });
});

// ─── unknown subcommand ───────────────────────────────────────────────────────

describe('capability (unknown)', () => {
  test('an unknown subcommand lists the full available set', () => {
    const r = runGsdTools(['capability', 'bogus'], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /install, update, remove, list, disable, enable, state, set/);
  });
});

// ─── review-hardening (adversarial-review fixes) ────────────────────────────

describe('capability install (trust hardening)', () => {
  test('an overlay reusing a first-party capability id is blocked', () => {
    // Pick a real first-party id and try to install an overlay that shadows it.
    const reg = require('../gsd-core/bin/lib/capability-registry.cjs');
    const firstParty = Object.keys(reg.capabilities)[0];
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource(firstParty);
    const r = runGsdTools(['capability', 'install', src, '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /first-party capability id/i);
    assert.equal(readLedgerEntry(home, firstParty), null);
  });

  test('a malformed strict_known_registries value fails closed (does not downgrade to permissive)', () => {
    // A hand-edited string instead of an array must BLOCK an external source, not be ignored.
    const cwd = makeCwdWithStrict('github.com');
    const r = runGsdTools(['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'], cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /must be an array|blocked/i);
  });

  test('strict_known_registries: [] (lockdown) blocks an external source', () => {
    const cwd = makeCwdWithStrict([]);
    const r = runGsdTools(['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'], cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /external capability installs are disabled|blocked/i);
  });
});

describe('capability update (id-pinning + reporting)', () => {
  test('update refuses when the recorded source now resolves to a different id', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('orig');
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Retarget the source to a different manifest id.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.id = 'switched';
    cap.version = '2.0.0';
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'orig', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /different capability id|refusing/i);
    // The original is untouched; nothing named 'switched' got installed.
    assert.equal(readLedgerEntry(home, 'orig').version, '1.0.0');
    assert.equal(readLedgerEntry(home, 'switched'), null);
  });

  test('update --all exits non-zero when any entry fails to upgrade', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('exupd', { hooks: [{ event: 'PostToolUse', script: 'hooks/a.js' }] });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    // Change the executable surface (new hook script) so the update needs re-consent.
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0';
    cap.hooks = [{ event: 'PostToolUse', script: 'hooks/b.js' }];
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    fs.writeFileSync(path.join(src, 'hooks', 'b.js'), '// artifact');
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, false, 'partial --all failure must be non-zero');
    assert.match(`${r.error}\n${r.output}`, /did not upgrade/i);
    // The aborted update left the old version intact.
    assert.equal(readLedgerEntry(home, 'exupd').version, '1.0.0');
  });

  test('a successful executable update reports the consented disclosure', () => {
    const home = tmpDir('cap-cli-home-');
    const src = writeCapSource('discl', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    assert.equal(runGsdTools(['capability', 'install', src, '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home)).success, true);
    const cap = JSON.parse(fs.readFileSync(path.join(src, 'capability.json'), 'utf8'));
    cap.version = '2.0.0'; // same hook script => same exec set, no re-consent needed
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    const r = runGsdTools(['capability', 'update', 'discl', '--scope', 'global', '--yes', '--raw'], makeCwd(), scopeEnv(home));
    assert.equal(r.success, true, `update failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.equal(o.status, 'upgraded');
    assert.ok(Array.isArray(o.disclosure) && o.disclosure.length > 0, 'disclosure reported');
  });
});

describe('capability disable (overlay boundary)', () => {
  test('disabling an unknown id (non-raw) reports the error on stderr and exits non-zero', () => {
    const rcd = tmpDir('cap-cli-rcd-');
    const r = runGsdTools(['capability', 'disable', 'totally-unknown-xyz', '--config-dir', rcd], makeCwd());
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /unknown capability/i);
  });

  // Regression for the silent-stdout bug: a --raw command that writes a result/error envelope and
  // then throws (to set a non-zero exit) used to lose ALL of stdout — captureStdoutSyncWrites
  // buffered fd-1 output and discarded it on the throw path, and cmdCapabilitySet exited via
  // process.exit() (bypassing the wrapper). On the old code stdout was 0 bytes; now the JSON
  // error envelope is flushed to stdout AND the exit code stays non-zero.
  test('disabling an unknown id in --raw mode emits the JSON error envelope on stdout (not silent)', () => {
    const rcd = tmpDir('cap-cli-rcd-');
    const r = runGsdTools(['capability', 'disable', 'totally-unknown-xyz', '--config-dir', rcd, '--raw'], makeCwd());
    assert.equal(r.success, false, 'must exit non-zero');
    assert.ok(r.output && r.output.length > 0, 'stdout must NOT be empty in raw error mode');
    const out = JSON.parse(r.output);
    assert.ok(Array.isArray(out.errors), 'JSON error envelope present on stdout');
    assert.match(out.errors.join(' '), /unknown capability/i);
  });
});

// ─── --shared-file safety + config fail-closed (adversarial-review R2) ──────

describe('capability install (--shared-file confinement)', () => {
  test('a --shared-file whose parent is a symlink escaping the scope writes NOTHING outside it', () => {
    const home = tmpDir('cap-cli-home-');
    fs.mkdirSync(home, { recursive: true });
    const outside = tmpDir('cap-cli-outside-');
    // Plant a symlink inside the scope root pointing outside it.
    fs.symlinkSync(outside, path.join(home, 'evil'));
    const src = writeCapSource('symcap', { hooks: [{ event: 'PostToolUse', script: 'hooks/run.js' }] });
    const r = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--shared-file', 'evil/settings.json', '--raw'],
      makeCwd(), scopeEnv(home),
    );
    // Install still succeeds (the bundle installs); the unsafe shared-file edit is skipped.
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    assert.ok(!fs.existsSync(path.join(outside, 'settings.json')), 'must NOT write through the escaping symlink');
  });

  test('install does not clobber a user mcpServers entry whose name collides with the capability', () => {
    const home = tmpDir('cap-cli-home-');
    fs.mkdirSync(home, { recursive: true });
    // Pre-existing user settings with an mcpServers entry the capability will also declare.
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ mcpServers: { shared: { command: 'user-server' } } }));
    const src = writeCapSource('mcpcap', { mcp: { shared: { command: 'cap-server' } } });
    const r = runGsdTools(
      ['capability', 'install', src, '--scope', 'global', '--yes', '--shared-file', 'settings.json', '--raw'],
      makeCwd(), scopeEnv(home),
    );
    assert.equal(r.success, true, `install failed: ${r.error || r.output}`);
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.mcpServers.shared.command, 'user-server', 'user mcpServers entry must be preserved, not clobbered');
  });
});

describe('capability install (config policy fail-closed)', () => {
  test('an unparseable project config fails CLOSED — an external source is blocked, not silently permitted', () => {
    const cwd = tmpDir('cap-cli-cwd-');
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{ this is not valid json');
    const r = runGsdTools(
      ['capability', 'install', 'https://github.com/x/y.git', '--scope', 'project'],
      cwd, { GSD_WORKSTREAM: '', GSD_PROJECT: '' },
    );
    assert.equal(r.success, false, 'broken config must not silently permit an external install');
    assert.match(`${r.error}\n${r.output}`, /external capability installs are disabled|blocked|array/i);
  });
});

// ─── code-review coverage gaps ──────────────────────────────────────────────

describe('capability (argument + empty-state handling)', () => {
  test('update --all over an empty ledger succeeds with an empty result set', () => {
    const r = runGsdTools(['capability', 'update', '--all', '--scope', 'global', '--raw'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, true, `update --all failed: ${r.error || r.output}`);
    const o = parse(r.output);
    assert.deepEqual(o.updated, [], 'no installed capabilities → empty updated list');
  });

  test('a flag value that looks like another flag is rejected (no value swallowing)', () => {
    const src = writeCapSource('flagcap');
    // `--integrity --scope` — the value after --integrity is itself a flag, which must error, not be consumed.
    const r = runGsdTools(['capability', 'install', src, '--integrity', '--scope', 'global'], makeCwd(), scopeEnv(tmpDir('cap-cli-home-')));
    assert.equal(r.success, false);
    assert.match(`${r.error}\n${r.output}`, /Missing value for --integrity/i);
  });
});
