'use strict';

/**
 * The shell launcher's runtime-home candidate list is DERIVED from the runtime
 * descriptors, the same registry the JS resolver reads (#5169, ADR-5057 §5 "one
 * resolver", #4347).
 *
 * `_gsd_homes` used to be a hand-written copy of the JS resolver's list. It
 * drifted: it kept probing GEMINI_CONFIG_DIR after the gemini runtime was
 * retired, and it omitted zcode, pi, kimi and kimi-code. The sync script now
 * renders the function from the registry; this file proves
 *   - the committed snippet is exactly that rendering (drift fails here),
 *   - no retired-runtime env var survives anywhere the preamble ships,
 *   - and, by executing the real shell function, that for EVERY registered
 *     runtime the launcher finds the very install directory the JS resolver
 *     resolves — so the two resolvers cannot pick different installs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const registry = require(path.join(LIB, 'capability-registry.cjs'));
const { resolveConfigHomeFromDescriptor } = require(path.join(LIB, 'runtime-homes.cjs'));
const { LEGACY_NON_REGISTRY_RUNTIME_HOMES } = require(path.join(LIB, 'runtime-name-policy.cjs'));
const sync = require(path.join(ROOT, 'scripts', 'sync-runtime-launcher.cjs'));

const SNIPPET = path.join(ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');
const snippetText = fs.readFileSync(SNIPPET, 'utf8');
const RUNTIMES = Object.keys(registry.runtimes);

describe('the sync only rewrites lines that are genuinely the launcher preamble', () => {
  const canonical = splitLines(snippetText).find((l) => sync.PREAMBLE_LINE_RE.test(l));

  test('the marker matches the snippet preamble line', () => {
    assert.ok(canonical, 'the snippet carries a line the marker recognizes');
  });

  test('a stale preamble line is replaced by the canonical one', () => {
    const stale = '_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="old"; echo stale';
    assert.equal(sync.replaceResolverLines(`a\n${stale}\nb`, canonical), `a\n${canonical}\nb`);
  });

  test('a line that merely starts with the variable name is left untouched', () => {
    const divergent = '_GSD_SHIM_NAME=other-tool.cjs # intentionally different';
    const doc = `a\n${divergent}\nb`;
    assert.equal(sync.replaceResolverLines(doc, canonical), doc);
  });
});

describe('_gsd_homes is rendered from the descriptors', () => {
  test('the committed snippet equals the registry rendering (no hand edits, no stale descriptors)', () => {
    const found = sync.extractHomesFunction(snippetText);
    assert.ok(found, 'the snippet carries a _gsd_homes function');
    assert.equal(found.text, sync.loadDerivedHomes());
  });

  test('rendering is deterministic and independent of registry key order', () => {
    const reversed = { runtimes: {} };
    for (const id of Object.keys(registry.runtimes).reverse()) reversed.runtimes[id] = registry.runtimes[id];
    assert.equal(
      sync.renderHomesFunction(reversed, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
      sync.renderHomesFunction(registry, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
    );
  });

  test('claude is probed first; the legacy non-registry home is probed last', () => {
    const text = sync.loadDerivedHomes();
    const list = text.slice(text.indexOf('set -- ') + 'set -- '.length, text.indexOf('; for _h; do '));
    assert.ok(list.startsWith('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "'), 'claude is the first element');
    assert.ok(list.slice(list.lastIndexOf(' "')).includes('GROK_AGENTS_HOME'), 'the legacy home is the last element');
  });

  test('the shim suffix is written once, in the loop body, not once per home (the preamble ships in ~240 files)', () => {
    const text = sync.loadDerivedHomes();
    assert.equal(text.split('/gsd-core/bin/').length - 1, 1);
    assert.ok(text.endsWith('; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }'));
    // No `for x in <list>` header: the #4109 structural lint flags any such list containing a `$`.
    assert.ok(!/\bfor\s+\w+\s+in\s/.test(text));
  });

  test('every registered runtime with a file-projected home contributes its env override', () => {
    const text = sync.loadDerivedHomes();
    let contributing = 0;
    for (const id of RUNTIMES) {
      const configHome = registry.runtimes[id].runtime.configHome;
      if (!configHome || configHome.kind === 'none') continue;
      assert.ok(configHome.env.length > 0, `${id} declares an env override`);
      assert.ok(text.includes('${' + configHome.env[0] + ':-'), `${id} (${configHome.env[0]}) must be probed`);
      contributing += 1;
    }
    assert.ok(contributing >= 18);
  });

  test('a runtime with no file-projected home (kind "none") contributes nothing', () => {
    const fake = { runtimes: { ide: { runtime: { configHome: { kind: 'none', name: 'ide', env: [] } } } } };
    const text = sync.renderHomesFunction(fake, {});
    assert.equal(text, '_gsd_homes() { set -- ; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }');
  });

  test('every descriptor value rendered into shell is a plain identifier or path segment (no shell metacharacters)', () => {
    // renderHomesFunction does not shell-escape: it is safe because the registry is first-party
    // and these fields are plain tokens. This pins that precondition so a descriptor edit that
    // introduced a quote, `$(`, backtick or `;` fails here instead of reaching every workflow.
    const ENV = /^[A-Z][A-Z0-9_]*$/;
    const SEGMENT = /^[A-Za-z0-9._~/-]+$/;
    for (const id of RUNTIMES) {
      const configHome = registry.runtimes[id].runtime.configHome;
      if (!configHome || configHome.kind === 'none') continue;
      for (const name of configHome.env) assert.match(name, ENV, `${id} env ${name}`);
      for (const field of [configHome.name, configHome.parent, ...(configHome.probe || [])]) {
        if (field === undefined) continue;
        assert.match(field, SEGMENT, `${id} path segment ${field}`);
      }
    }
    for (const [id, legacy] of Object.entries(LEGACY_NON_REGISTRY_RUNTIME_HOMES)) {
      assert.match(legacy.env, ENV, `${id} env`);
      for (const segment of legacy.dir) assert.match(segment, SEGMENT, `${id} dir ${segment}`);
    }
  });

  test('the retired gemini runtime is no longer probed (#4347)', () => {
    assert.ok(!snippetText.includes('GEMINI_CONFIG_DIR'));
    for (const id of RUNTIMES) assert.ok(!registry.runtimes[id].runtime.configHome.env.includes('GEMINI_CONFIG_DIR'));
  });

  test('the resolver reference and every command template carry the canonical preamble line (no older fixed-list copy)', () => {
    const preambleLine = sync.loadPreamble()[0];
    const offenders = [];
    const check = (file) => {
      for (const line of splitLines(fs.readFileSync(file, 'utf8'))) {
        if (/^_GSD_SHIM_NAME=/.test(line) && line !== preambleLine) offenders.push(path.relative(ROOT, file));
      }
    };
    check(path.join(ROOT, 'gsd-core', 'references', 'gsd-run-resolver.md'));
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) check(full);
      }
    };
    walk(path.join(ROOT, 'commands'));
    assert.deepEqual(offenders, []);
  });

  test('no shipped workflow, agent or command carries the retired env var', () => {
    const offenders = [];
    for (const dir of ['gsd-core/workflows', 'agents', 'commands']) {
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md') || entry.name.endsWith('.sh')) {
            if (fs.readFileSync(full, 'utf8').includes('GEMINI_CONFIG_DIR')) offenders.push(path.relative(ROOT, full));
          }
        }
      };
      walk(path.join(ROOT, dir));
    }
    assert.deepEqual(offenders, []);
  });
});

describe('the launcher finds the install the JS resolver resolves, for every runtime', () => {
  const homesPrefix = (() => {
    const end = snippetText.indexOf('; if _gsd_at');
    return snippetText.slice(0, end + 1);
  })();

  function runLauncher(home) {
    const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
    return spawnSync('sh', ['-c', script], {
      cwd: home,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      // A minimal environment: no *_CONFIG_DIR / *_HOME override, so the
      // descriptor defaults (`$HOME/.<dir>`) are what is probed.
      env: isolatedEnv({ home, path: process.env.PATH || '/usr/bin:/bin', base: {} }),
    });
  }

  const skipShell = process.platform === 'win32' ? 'POSIX shell launcher' : false;

  for (const id of RUNTIMES) {
    const configHome = registry.runtimes[id].runtime.configHome;
    if (!configHome || configHome.kind === 'none') continue;
    test(`${id}: _gsd_homes resolves ${configHome.kind} home identically to the JS resolver`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        // Make the descriptor's own probe marker true so the JS resolver picks this dir
        // (probeExists is `gsd-core/VERSION` or `skills`, depending on the kind).
        const jsDir = resolveConfigHomeFromDescriptor(configHome, {
          env: {},
          home,
          existsSync: (p) => fs.existsSync(p),
        });
        fs.mkdirSync(path.join(jsDir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'VERSION'), '0.0.0\n');
        if (configHome.probeExists) {
          // The resolver only tests existence of `<dir>/<probeExists>`; a marker FILE satisfies it for
          // both the `gsd-core/VERSION` and the `skills` spellings (mkdir would collide with VERSION).
          const marker = path.join(jsDir, configHome.probeExists);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
        }
        // Re-resolve now that the markers exist: the JS resolver and the launcher must agree.
        const jsAfter = resolveConfigHomeFromDescriptor(configHome, { env: {}, home, existsSync: (p) => fs.existsSync(p) });
        const result = runLauncher(home);
        assert.equal(result.status, 0, `launcher exited ${result.status}: ${result.stderr}`);
        assert.equal(
          fs.realpathSync(result.stdout),
          fs.realpathSync(path.join(jsAfter, 'gsd-core', 'bin', 'gsd-tools.cjs')),
        );
      } finally {
        cleanup(home);
      }
    });
  }

  for (const [id, legacy] of Object.entries(LEGACY_NON_REGISTRY_RUNTIME_HOMES)) {
    test(`${id}: the legacy non-registry home is probed`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        const dir = path.join(home, ...legacy.dir);
        fs.mkdirSync(path.join(dir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        const result = runLauncher(home);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs')));
      } finally {
        cleanup(home);
      }
    });
  }

  test('with no install anywhere the function reports failure (a miss is not a silent success)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const result = runLauncher(home);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.includes('gsd-tools.cjs') && fs.existsSync(result.stdout), false);
    } finally {
      cleanup(home);
    }
  });

  test('an env override wins over the default home (the same precedence as the JS resolver)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const custom = path.join(home, 'custom-claude');
      fs.mkdirSync(path.join(custom, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
      const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
      const result = spawnSync('sh', ['-c', script], {
        cwd: home,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: isolatedEnv({ home, path: process.env.PATH || '/usr/bin:/bin', claudeConfigDir: custom, base: {} }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs')));
    } finally {
      cleanup(home);
    }
  });
});
