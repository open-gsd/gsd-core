'use strict';

/**
 * capability-source.test.cjs — ADR-1244 Phase 3, Decision D3.
 *
 * Tests for resolveCapabilitySource + parseSpec:
 *   - parseSpec kind-detection table (all kinds + error cases)
 *   - local adapter: happy path, invalid manifest, engines.gsd incompatibility
 *   - registry kind: throws 'not yet implemented'
 *   - tarball adapter: integrity matching / mismatching (via injected HTTP seam)
 *   - security: shell metacharacters in specs/args → only reach exec override as
 *     argv array (not interpolated into a shell string)
 *   - security: capability id containing ../ → rejected
 *   - staging atomicity: validation failure leaves no dir under capabilities/
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cleanup, createTempDir } = require('./helpers.cjs');

// The module under test — loaded from the built .cjs artifact.
const capSource = require('../gsd-core/bin/lib/capability-source.cjs');
const {
  resolveCapabilitySource,
  parseSpec,
  _setCapabilitySourceHttpGet,
  _setHttpsGetImpl,
  MAX_RESPONSE_BYTES,
  MANIFEST_MAX_BYTES,
  MAX_STAGED_BUNDLE_BYTES,
  MAX_STAGED_BUNDLE_ENTRIES,
} = capSource;
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal but valid capability manifest for tests. */
function featureCap(id, extra = {}) {
  return {
    id,
    role: 'feature',
    version: '1.0.0',
    title: id,
    description: 'test capability',
    tier: 'standard',
    requires: [],
    engines: { gsd: '>=1.0.0' },
    runtimeCompat: { supported: ['*'], unsupported: [] },
    skills: [],
    agents: [],
    hooks: [],
    config: {},
    steps: [],
    contributions: [],
    gates: [],
    ...extra,
  };
}

/**
 * Create a temp directory with a capability.json inside.
 * Returns the directory path.
 */
function makeLocalCap(cap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-local-'));
  fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(cap), 'utf8');
  return dir;
}

/** Compute sha512-<base64> from a Buffer. */
function sha512b64(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

/** A minimal fs.Dirent-shaped object for synthetic streaming-opendir tests. */
function makeDirent(name, { file = false, dir = false, symlink = false } = {}) {
  return {
    name,
    isSymbolicLink: () => symlink,
    isDirectory: () => dir,
    isFile: () => file,
  };
}

// ---------------------------------------------------------------------------
// parseSpec — kind detection
// ---------------------------------------------------------------------------

describe('parseSpec — kind detection', () => {
  test('relative path ./foo → local', () => {
    const p = parseSpec('./my-cap');
    assert.strictEqual(p.kind, 'local');
    assert.strictEqual(p.raw, './my-cap');
  });

  test('relative path ../foo → local', () => {
    const p = parseSpec('../my-cap');
    assert.strictEqual(p.kind, 'local');
  });

  test('absolute path /home/user/my-cap → local', () => {
    const p = parseSpec('/home/user/my-cap');
    assert.strictEqual(p.kind, 'local');
  });

  test('npm: prefix → npm', () => {
    const p = parseSpec('npm:my-capability@1.0.0');
    assert.strictEqual(p.kind, 'npm');
    assert.strictEqual(p.target, 'my-capability@1.0.0');
  });

  test('tarball https URL ending .tgz → tarball', () => {
    const p = parseSpec('https://example.com/cap.tgz');
    assert.strictEqual(p.kind, 'tarball');
    assert.strictEqual(p.target, 'https://example.com/cap.tgz');
  });

  test('tarball https URL ending .tar.gz → tarball', () => {
    const p = parseSpec('https://example.com/cap.tar.gz');
    assert.strictEqual(p.kind, 'tarball');
  });

  test('git https URL ending .git → git', () => {
    const p = parseSpec('https://github.com/org/repo.git');
    assert.strictEqual(p.kind, 'git');
    assert.strictEqual(p.target, 'https://github.com/org/repo.git');
    assert.strictEqual(p.ref, undefined);
  });

  test('git URL with #<ref> → git with ref extracted', () => {
    const p = parseSpec('https://github.com/org/repo#v1.2.3');
    assert.strictEqual(p.kind, 'git');
    assert.strictEqual(p.ref, 'v1.2.3');
    assert.ok(!p.target.includes('#'), 'URL must not include # fragment');
  });

  test('git+ prefix → git', () => {
    const p = parseSpec('git+https://github.com/org/repo.git');
    assert.strictEqual(p.kind, 'git');
  });

  test('registry-style name@version (no scheme) → registry', () => {
    const p = parseSpec('my-org/capability@2.0.0');
    assert.strictEqual(p.kind, 'registry');
  });

  test('bare package name → registry', () => {
    const p = parseSpec('my-capability');
    assert.strictEqual(p.kind, 'registry');
  });

  test('empty string → throws', () => {
    assert.throws(() => parseSpec(''), /non-empty/i);
  });

  test('whitespace-only string → throws', () => {
    assert.throws(() => parseSpec('   '), /non-empty/i);
  });

  test('null coerced (wrong type) → throws', () => {
    // @ts-expect-error intentional wrong type for test
    assert.throws(() => parseSpec(null), /non-empty|string/i);
  });

  test('npm: with empty package spec → throws', () => {
    assert.throws(() => parseSpec('npm:'), /empty after "npm:"/i);
  });
});

// ---------------------------------------------------------------------------
// local adapter
// ---------------------------------------------------------------------------

describe('local adapter — happy path', () => {
  let gsdHome = '';
  let capDir = '';

  beforeEach(() => {
    gsdHome = createTempDir('gsd-home-');
    capDir = makeLocalCap(featureCap('test-cap-local'));
  });

  afterEach(() => {
    cleanup(gsdHome);
    cleanup(capDir);
  });

  test('resolves a valid local capability — staged dir exists with capability.json', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' });
    assert.strictEqual(result.id, 'test-cap-local');
    assert.strictEqual(result.version, '1.0.0');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir must exist');
    assert.ok(
      fs.existsSync(path.join(result.stagedDir, 'capability.json')),
      'capability.json must be present in staged dir'
    );
    assert.strictEqual(result.source, capDir);
  });

  test('staging creates the capability under <gsdHome>/.gsd/capabilities/<id>/', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' });
    const expectedDir = path.join(gsdHome, '.gsd', 'capabilities', 'test-cap-local');
    assert.strictEqual(result.stagedDir, expectedDir);
    assert.ok(fs.existsSync(expectedDir));
  });

  test('skipEnginesGate:true stages an engines-incompatible capability without throwing', async () => {
    const cap = featureCap('test-cap-local');
    cap.engines = { gsd: '>=99.0.0' };
    const incompatDir = makeLocalCap(cap);
    // Default: the engines gate throws.
    await assert.rejects(
      () => resolveCapabilitySource(incompatDir, { gsdHome, hostVersion: '1.6.0' }),
      /engines\.gsd/,
    );
    // skipEnginesGate: the resolver stages it (copy-only) and leaves the gate to the caller.
    const r = await resolveCapabilitySource(incompatDir, { gsdHome, hostVersion: '1.6.0', skipEnginesGate: true, promote: false });
    assert.strictEqual(r.id, 'test-cap-local');
    assert.ok(fs.existsSync(path.join(r.stagedDir, 'capability.json')));
    cleanup(incompatDir);
    cleanup(r.stagedDir);
  });

  test('promote:false validates but does NOT promote — returns the staging dir, final dir absent', async () => {
    const result = await resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0', promote: false });
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'test-cap-local');
    const stagingRoot = path.join(gsdHome, '.gsd', 'capabilities', '.staging');
    assert.notStrictEqual(result.stagedDir, finalDir, 'must not be the final dir');
    assert.ok(result.stagedDir.startsWith(stagingRoot), 'staged dir is under .staging');
    assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    assert.ok(!fs.existsSync(finalDir), 'final dir must NOT be created when promote:false');
  });
});

describe('local adapter — invalid manifest', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('manifest missing "version" field → throws AND no staged dir remains', async () => {
    const cap = featureCap('no-version-cap');
    delete cap.version;
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        (err) => {
          assert.ok(err instanceof Error, 'must throw an Error');
          return true;
        }
      );
    } finally {
      cleanup(capDir);
    }

    // No staged dir should remain.
    const capabilitiesDir = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capabilitiesDir)) {
      const entries = fs.readdirSync(capabilitiesDir).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'No capability dirs must remain after failure');
    }
  });

  test('manifest with invalid role → throws AND no staged dir remains', async () => {
    const cap = featureCap('bad-role-cap');
    cap.role = 'totally-invalid-role-xyz';
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /valid|role|validation/i
      );
    } finally {
      cleanup(capDir);
    }

    const capabilitiesDir = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capabilitiesDir)) {
      const entries = fs.readdirSync(capabilitiesDir).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'No capability dirs must remain after failure');
    }
  });

  test('missing capability.json → throws', async () => {
    const dir = createTempDir('no-manifest-');
    try {
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /capability\.json/i
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('local adapter — engines.gsd incompatibility', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('engines.gsd ">=99.0.0" with hostVersion 1.5.0 → throws before staging', async () => {
    const cap = featureCap('incompat-cap', { engines: { gsd: '>=99.0.0' } });
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /engines\.gsd|requires|incompatible/i
      );
    } finally {
      cleanup(capDir);
    }

    // No staged directory should exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'incompat-cap');
    assert.ok(!fs.existsSync(finalDir), 'staged dir must not exist for incompatible capability');
  });
});

// ---------------------------------------------------------------------------
// registry kind — explicit stub
// ---------------------------------------------------------------------------

describe('registry kind', () => {
  test('throws "not yet implemented" for registry specs', async () => {
    await assert.rejects(
      () => resolveCapabilitySource('my-cap@1.0.0', { gsdHome: os.tmpdir(), hostVersion: '1.5.0' }),
      /not yet implemented/i
    );
  });
});

// ---------------------------------------------------------------------------
// tarball adapter — integrity verification via injected HTTP seam
// ---------------------------------------------------------------------------

describe('tarball adapter — integrity via _setCapabilitySourceHttpGet', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null); // restore real transport
    cleanup(gsdHome);
  });

  test('matching integrity → resolves successfully', async () => {
    const cap = featureCap('tarball-cap');
    const tgzBuf = _fakeTarball(cap);
    const integrity = sha512b64(tgzBuf);

    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));

    // Inject a tar extractor that writes the capability.json to extractDir.
    const result = await resolveCapabilitySource(
      'https://example.com/tarball-cap.tgz',
      {
        gsdHome,
        hostVersion: '1.5.0',
        integrity,
        execOverrides: {
          tar: (_prog, args, _opts) => {
            // Name listing (assertSafeTarMembers step 1): safe member names.
            if (args[0] === '-tzf') {
              return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
            }
            // Verbose listing (assertSafeTarMembers step 2): regular file, no link.
            if (args[0] === '-tvzf') {
              return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
            }
            // Extraction pass: args = ['-xzf', tgzPath, '-C', extractDir]
            const extractDir = args[args.indexOf('-C') + 1];
            fs.writeFileSync(
              path.join(extractDir, 'capability.json'),
              JSON.stringify(cap),
              'utf8'
            );
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }
    );

    assert.strictEqual(result.id, 'tarball-cap');
    assert.ok(result.integrity && result.integrity.startsWith('sha512-'), 'integrity must be set');
    assert.ok(fs.existsSync(result.stagedDir));
  });

  test('mismatching integrity → throws BEFORE staging (no staged dir)', async () => {
    const cap = featureCap('tarball-mismatch');
    const tgzBuf = _fakeTarball(cap);
    const badIntegrity = 'sha512-' + Buffer.from('totally-wrong').toString('base64');

    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));

    let tarCalls = 0;
    await assert.rejects(
      () =>
        resolveCapabilitySource('https://example.com/tarball-mismatch.tgz', {
          gsdHome,
          hostVersion: '1.5.0',
          integrity: badIntegrity,
          execOverrides: {
            tar: (_prog, args, _opts) => {
              // Must never be reached — integrity check fires before any tar invocation.
              tarCalls++;
              const extractDir = args[args.indexOf('-C') + 1];
              fs.writeFileSync(
                path.join(extractDir, 'capability.json'),
                JSON.stringify(cap),
                'utf8'
              );
              return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
            },
          },
        }),
      /integrity mismatch|mismatch/i
    );

    // Integrity is verified over the raw .tgz bytes BEFORE any tar call — ordering invariant.
    assert.strictEqual(tarCalls, 0, 'tar must NOT be invoked — integrity verified over the .tgz bytes before extraction');

    // No staged directory must exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'tarball-mismatch');
    assert.ok(!fs.existsSync(finalDir), 'staged dir must NOT exist after integrity mismatch');
  });
});

// ---------------------------------------------------------------------------
// #1460 CS-1 — a supplied --integrity is NEVER silently ignored.
//   - npm: verified over the produced .tgz bytes (same SRI sha512 domain as tarball).
//   - git / local: REJECTED with an actionable error (no single byte-SRI artifact).
// revert-fails: with stageValidated's `integrity: null` restored on these adapters
// (the pre-fix behaviour), the npm-mismatch case would silently resolve and the
// git/local cases would silently resolve with integrity:null — every assert below
// would then fail.
// ---------------------------------------------------------------------------

describe('#1460 CS-1 — supplied --integrity is verified or rejected per source (never silently dropped)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  /** Build a fake `npm pack` that writes a real .tgz of `tgzBytes` to the --pack-destination. */
  function fakeNpmPack(tgzBytes) {
    return (args) => {
      const destIdx = args.indexOf('--pack-destination');
      const dest = destIdx >= 0 ? args[destIdx + 1] : '';
      fs.writeFileSync(path.join(dest, 'cap.tgz'), tgzBytes);
      return { exitCode: 0, stdout: 'cap.tgz\n', stderr: '', signal: null, error: null };
    };
  }

  /** A tar override that lists safe members and writes `cap`'s capability.json on extract. */
  function fakeTar(cap) {
    return (_prog, args) => {
      if (args[0] === '-tzf') {
        return { exitCode: 0, stdout: 'package/capability.json\n', stderr: '', signal: null, error: null };
      }
      if (args[0] === '-tvzf') {
        return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 package/capability.json\n', stderr: '', signal: null, error: null };
      }
      const extractDir = args[args.indexOf('-C') + 1];
      const pkgDir = path.join(extractDir, 'package');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'capability.json'), JSON.stringify(cap), 'utf8');
      return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
    };
  }

  test('npm + matching --integrity (over the .tgz bytes) → resolves', async () => {
    const cap = featureCap('npm-int-ok');
    const tgzBytes = Buffer.from('a deterministic npm tarball payload for integrity', 'utf8');
    const integrity = sha512b64(tgzBytes);

    const result = await resolveCapabilitySource('npm:@org/npm-int-ok@^1.0.0', {
      gsdHome,
      hostVersion: '1.5.0',
      integrity,
      execOverrides: { npm: fakeNpmPack(tgzBytes), tar: fakeTar(cap) },
    });

    assert.strictEqual(result.id, 'npm-int-ok');
    assert.ok(result.integrity && result.integrity.startsWith('sha512-'), 'integrity must be recorded');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir must exist');
  });

  test('npm + MISMATCHING --integrity → throws BEFORE promote/staging (no final dir)', async () => {
    const cap = featureCap('npm-int-bad');
    const tgzBytes = Buffer.from('the real npm tarball bytes', 'utf8');
    const badIntegrity = 'sha512-' + Buffer.from('not-the-real-hash').toString('base64');

    let tarCalls = 0;
    const instrumentedTar = (_prog, args) => {
      // Must never be reached — integrity is verified over the .tgz bytes before any tar call.
      tarCalls++;
      return fakeTar(cap)(_prog, args);
    };

    await assert.rejects(
      () => resolveCapabilitySource('npm:@org/npm-int-bad@^1.0.0', {
        gsdHome,
        hostVersion: '1.5.0',
        integrity: badIntegrity,
        execOverrides: { npm: fakeNpmPack(tgzBytes), tar: instrumentedTar },
      }),
      /integrity mismatch|mismatch/i,
    );

    // Integrity is verified over the raw .tgz bytes BEFORE any tar call — ordering invariant.
    assert.strictEqual(tarCalls, 0, 'tar extraction must NOT run — integrity verified over the .tgz bytes before extraction');

    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'npm-int-bad');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after integrity mismatch');
  });

  test('git + any --integrity → throws an actionable error (no silent resolve)', async () => {
    // The integrity reject must fire BEFORE the clone — so execGit is never called.
    const gitCalls = [];
    const fakeGit = (...callArgs) => {
      gitCalls.push(callArgs);
      return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
    };

    await assert.rejects(
      () => resolveCapabilitySource('https://github.com/org/repo.git#v1.0.0', {
        gsdHome,
        hostVersion: '1.5.0',
        integrity: 'sha512-' + Buffer.from('anything').toString('base64'),
        execOverrides: { git: fakeGit },
      }),
      /integrity pinning is not supported for git sources|#sha:/i,
    );

    assert.strictEqual(gitCalls.length, 0, 'execGit must NOT run — rejection fires before the clone');
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'repo');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after git integrity rejection');
  });

  test('local + --integrity → throws an actionable error (no silent resolve)', async () => {
    const capDir = makeLocalCap(featureCap('local-int-cap'));
    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, {
          gsdHome,
          hostVersion: '1.5.0',
          integrity: 'sha512-' + Buffer.from('anything').toString('base64'),
        }),
        /integrity pinning is not supported for local sources/i,
      );
    } finally {
      cleanup(capDir);
    }

    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'local-int-cap');
    assert.ok(!fs.existsSync(finalDir), 'no final dir after local integrity rejection');
  });
});

// ---------------------------------------------------------------------------
// Security: shell metacharacters in spec / args → arrive as argv array
// ---------------------------------------------------------------------------

describe('security: shell metacharacters do not escape into a shell string', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('git spec with shell metacharacters — captured as argv array, not shell string', async () => {
    const capturedCalls = [];

    // The injected execGit captures every call; we verify the spec appears verbatim
    // as an array element, never interpolated into a string with shell operators.
    const maliciousUrl = 'https://github.com/org/repo.git; rm -rf /tmp/evil';

    const fakeGit = (args, _opts) => {
      capturedCalls.push([...args]);
      // Simulate failing clone so we don't need a real repo.
      return { exitCode: 128, stdout: '', stderr: 'not a git repository', signal: null, error: null };
    };

    await assert.rejects(
      () =>
        resolveCapabilitySource(`git+${maliciousUrl}`, {
          gsdHome,
          hostVersion: '1.5.0',
          execOverrides: { git: fakeGit },
        }),
      /clone failed|git/i
    );

    // The call must have been made with the URL as a discrete argv element.
    assert.ok(capturedCalls.length > 0, 'execGit must have been called');
    const cloneCall = capturedCalls[0];
    // Argv must include the URL as a single token — never split or shell-interpolated.
    // The semicolon and "rm -rf" must be a single string element, not two elements.
    // The key security property: if we ran this in a shell, `; rm -rf /tmp/evil` would
    // be a separate command. By routing through argv array, it is inert.
    assert.ok(
      cloneCall.some((arg) => arg === maliciousUrl || arg.includes('rm -rf')),
      'malicious characters must appear in argv array (inert), not as a parsed shell command'
    );
    // None of the individual args should be shell commands like just 'rm' or '-rf'.
    const hasStandaloneRm = cloneCall.some((arg) => arg === 'rm');
    assert.ok(!hasStandaloneRm, 'shell metacharacters must not be parsed into separate argv elements');
  });

  test('npm spec with shell metacharacters is REJECTED before exec (execNpm uses a Windows shell)', async () => {
    const capturedCalls = [];
    const fakeNpm = (args) => {
      capturedCalls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'not found', signal: null, error: null };
    };
    for (const evil of ['`rm -rf /`', 'pkg; rm -rf', 'pkg && calc', 'pkg|cat /etc/passwd', 'pkg$(whoami)', 'pkg >out', "pkg'", 'pkg"x']) {
      await assert.rejects(
        () => resolveCapabilitySource(`npm:${evil}`, { gsdHome, hostVersion: '1.5.0', execOverrides: { npm: fakeNpm } }),
        /unsafe npm package spec/i,
        `npm:${evil} must be rejected at parse`
      );
    }
    assert.equal(capturedCalls.length, 0, 'execNpm must NEVER be called for an unsafe npm spec');
  });

  test('a valid npm spec reaches execNpm as a discrete argv element WITH --ignore-scripts', async () => {
    const capturedCalls = [];
    const fakeNpm = (args) => {
      capturedCalls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'not found', signal: null, error: null };
    };
    await assert.rejects(
      () => resolveCapabilitySource('npm:@org/cap@^1.2.0', { gsdHome, hostVersion: '1.5.0', execOverrides: { npm: fakeNpm } }),
      /npm pack failed|not found/i
    );
    const packCall = capturedCalls[0];
    assert.ok(packCall.includes('@org/cap@^1.2.0'), 'valid spec passed as a single discrete argv element');
    assert.ok(packCall.includes('--ignore-scripts'), 'npm pack MUST pass --ignore-scripts (no lifecycle code execution)');
    assert.ok(packCall.includes('pack'), 'must be `npm pack`, never `npm install`');
  });

  test('git transport allowlist: ext::/file:// transports are rejected at parse', async () => {
    for (const evil of ['git+ext::sh -c "evil"', 'git+file:///etc', 'git+fd::7']) {
      await assert.rejects(
        () => resolveCapabilitySource(evil, { gsdHome, hostVersion: '1.5.0' }),
        /unsupported git transport/i,
        `${evil} must be rejected`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Security: symlink + tar-slip rejection
// ---------------------------------------------------------------------------

describe('security: symlink and tar-slip rejection', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('local bundle containing a symlink is refused (copyFileSync would follow it)', async (t) => {
    const dir = createTempDir('gsd-local-symlink-');
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('symlink-cap')), 'utf8');
    // Plant a symlink pointing at a host file.
    const secret = createTempDir('gsd-secret-');
    t.after(() => cleanup(secret));
    fs.writeFileSync(path.join(secret, 'id_rsa'), 'PRIVATE', 'utf8');
    try {
      fs.symlinkSync(path.join(secret, 'id_rsa'), path.join(dir, 'leaked'));
    } catch {
      t.skip('symlink not supported on this platform');
      return;
    }
    await assert.rejects(
      () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
      /symlink/i
    );
    assert.ok(!fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities', 'symlink-cap')), 'no staged dir after symlink refusal');
  });

  test('tarball with a tar-slip member (..) is refused before extraction', async () => {
    const cap = featureCap('slip-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    let extracted = false;
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/slip.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              // Listing reveals a traversal member → must be rejected.
              return { exitCode: 0, stdout: 'capability.json\n../../../etc/evil\n', stderr: '', signal: null, error: null };
            }
            extracted = true; // extraction must NOT happen
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /unsafe member path/i
    );
    assert.equal(extracted, false, 'extraction must not run when a member path is unsafe');
  });

  test('tarball containing a SYMLINK member is refused before extraction', async () => {
    const cap = featureCap('symmember-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    let extracted = false;
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/sym.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              // Names look safe...
              return { exitCode: 0, stdout: 'capability.json\nleak\n', stderr: '', signal: null, error: null };
            }
            if (args[0] === '-tvzf') {
              // ...but the verbose listing reveals a symlink member → reject.
              return { exitCode: 0, stdout: '-rw-r--r-- 0 u g 10 Jan 1 2020 capability.json\nlrwxr-xr-x 0 u g 0 Jan 1 2020 leak -> /etc/passwd\n', stderr: '', signal: null, error: null };
            }
            extracted = true;
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /symlink or hardlink member/i
    );
    assert.equal(extracted, false, 'extraction must not run when a symlink member is present');
  });
});

// ---------------------------------------------------------------------------
// Security: capability id path traversal → rejected
// ---------------------------------------------------------------------------

describe('security: path traversal in capability id', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('capability id containing ../ is rejected before staging', async () => {
    // Build a local dir with a capability.json whose id contains path traversal.
    const cap = featureCap('../evil-escape');
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /invalid|path separator|kebab-case|\.\./i
      );
    } finally {
      cleanup(capDir);
    }

    // Nothing must have been written under gsdHome.
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    if (fs.existsSync(capRoot)) {
      const entries = fs.readdirSync(capRoot).filter((e) => e !== '.staging');
      assert.strictEqual(entries.length, 0, 'no capability must be staged with traversal id');
    }
  });

  test('capability id containing / is rejected', async () => {
    const cap = featureCap('org/evil');
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        /invalid|path separator|kebab-case/i
      );
    } finally {
      cleanup(capDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Staging atomicity: validation failure leaves no directory
// ---------------------------------------------------------------------------

describe('staging atomicity', () => {
  let gsdHome = '';

  beforeEach(() => { gsdHome = createTempDir('gsd-home-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('validation failure leaves no directory under capabilities/ (only .staging may exist briefly)', async () => {
    // Deliberately invalid cap: missing required fields beyond id/version.
    const cap = { id: 'atomicity-test', version: '1.0.0', role: 'totally-invalid-role-xyz' };
    const capDir = makeLocalCap(cap);

    try {
      await assert.rejects(
        () => resolveCapabilitySource(capDir, { gsdHome, hostVersion: '1.5.0' }),
        (err) => err instanceof Error
      );
    } finally {
      cleanup(capDir);
    }

    // The final capability directory must NOT exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'atomicity-test');
    assert.ok(!fs.existsSync(finalDir), 'Final capability dir must be absent after validation failure');

    // .staging dir should be cleaned up too (best-effort assertion — it's async).
    const stagingRoot = path.join(gsdHome, '.gsd', 'capabilities', '.staging');
    if (fs.existsSync(stagingRoot)) {
      const stagingEntries = fs.readdirSync(stagingRoot);
      assert.strictEqual(stagingEntries.length, 0, '.staging must be empty after cleanup');
    }
  });
});

// ---------------------------------------------------------------------------
// Fake tarball helper (not a real .tgz — the tar override bypasses extraction)
// ---------------------------------------------------------------------------

/**
 * Returns a Buffer that acts as a "tarball" for tests that inject a fake tar extractor.
 * The content is arbitrary; tests use the execOverrides.tar hook to write fixture files
 * into the extractDir instead of calling real tar.
 */
function _fakeTarball(cap) {
  // We just need a buffer; the injected tar override does the actual "extraction".
  return Buffer.from(JSON.stringify({ _fakeTarball: true, id: cap.id }), 'utf8');
}

// ---------------------------------------------------------------------------
// #1461 DOS-1 — realHttpsGet must BOUND the fetched response size. Without a cap,
// res.on('data') accumulates chunks and Buffer.concat'd into memory with no
// ceiling → a hostile/oversized tarball OOMs the process. Verified by injecting a
// fake low-level https.get (the _setHttpsGetImpl seam) that streams a response.
// ---------------------------------------------------------------------------

/**
 * Build a fake https.get implementation that drives realHttpsGet's streaming path.
 * @param chunks      array of Buffers to emit on the response 'data' events
 * @param headers     response headers (e.g. { 'content-length': '...' })
 * @param statusCode  response status (default 200)
 * Returns a function matching the https.get(url, opts, cb) shape. It captures whether
 * req.destroy() / res.destroy() were called so a test can assert the cap aborts the stream.
 */
function makeFakeHttpsGet(chunks, headers = {}, statusCode = 200) {
  const state = { reqDestroyed: false, resDestroyed: false, emittedBytes: 0, ended: false };
  const fn = (_url, _opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => { state.reqDestroyed = true; };
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    res.destroy = () => { state.resDestroyed = true; };
    // Drive the response on the next tick so realHttpsGet has attached its listeners.
    setImmediate(() => {
      cb(res);
      for (const c of chunks) {
        if (state.reqDestroyed || state.resDestroyed) break;
        state.emittedBytes += c.length;
        res.emit('data', c);
      }
      if (!state.reqDestroyed && !state.resDestroyed) {
        state.ended = true;
        res.emit('end');
      }
    });
    return req;
  };
  fn.state = state;
  return fn;
}

describe('#1461 DOS-1 — realHttpsGet bounds the response size (MAX_RESPONSE_BYTES)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-dos-home-'); });
  afterEach(() => {
    _setHttpsGetImpl(null); // restore the real https.get
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_RESPONSE_BYTES is a sane bounded cap (64 MiB)', () => {
    assert.strictEqual(MAX_RESPONSE_BYTES, 64 * 1024 * 1024, 'cap is generous but bounded');
  });

  test('a streamed body exceeding MAX_RESPONSE_BYTES is rejected and not buffered unboundedly', async () => {
    // Stream chunks whose cumulative length exceeds the cap. Each chunk is 1 MiB; we emit cap+2
    // chunks. With the cap in place the stream is destroyed after crossing MAX_RESPONSE_BYTES, so
    // far fewer than all chunks are ever emitted.
    const ONE_MIB = 1024 * 1024;
    const chunkCount = MAX_RESPONSE_BYTES / ONE_MIB + 2; // 66 chunks of 1 MiB
    const chunks = Array.from({ length: chunkCount }, () => Buffer.alloc(ONE_MIB, 0x61));
    const fake = makeFakeHttpsGet(chunks, {} /* no content-length → exercise the streaming guard */);
    _setHttpsGetImpl(fake);

    // REVERT-FAILS: without the per-`data` size guard in realHttpsGet, all chunks are accumulated
    // and the promise RESOLVES with an oversized body (then proceeds to integrity/extraction) —
    // assert.rejects below fails because nothing rejected.
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/huge.tgz', { gsdHome, hostVersion: '1.5.0' }),
      /exceeds .*bytes/i,
      'an oversized streamed body must reject with the size error'
    );
    // The stream was aborted: the request/response were destroyed and NOT every chunk was emitted.
    assert.ok(fake.state.reqDestroyed || fake.state.resDestroyed, 'the request/response is destroyed on overflow');
    assert.ok(fake.state.emittedBytes <= (MAX_RESPONSE_BYTES + ONE_MIB),
      'streaming stops shortly after crossing the cap (not all chunks buffered)');
    assert.ok(!fake.state.ended, 'the response never reaches end — it was cut off');
  });

  test('a content-length header over the cap is rejected BEFORE buffering any body', async () => {
    // Advertise an oversized content-length but emit NO data — the early header check must reject.
    const fake = makeFakeHttpsGet([], { 'content-length': String(MAX_RESPONSE_BYTES + 1) });
    _setHttpsGetImpl(fake);

    // REVERT-FAILS: without the content-length pre-check in realHttpsGet, the (empty) stream simply
    // ends and the promise RESOLVES — assert.rejects fails because nothing rejected.
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/lying.tgz', { gsdHome, hostVersion: '1.5.0' }),
      /exceeds .*bytes|content-length/i,
      'an over-cap content-length must reject before buffering'
    );
    assert.strictEqual(fake.state.emittedBytes, 0, 'no body bytes were buffered before rejection');
    assert.ok(fake.state.reqDestroyed || fake.state.resDestroyed, 'the request/response is destroyed on the header check');
  });

  test('CONTROL: a normal small tarball still fetches + installs through realHttpsGet', async () => {
    // A small valid body that passes the cap. The high-level _httpGet seam is NOT used here — we go
    // through the real realHttpsGet via the injected low-level https.get so the size-cap code path is
    // exercised on the happy path too. A tar override performs the "extraction".
    const cap = featureCap('dos-control-cap');
    const tgzBuf = _fakeTarball(cap);
    const fake = makeFakeHttpsGet([tgzBuf], { 'content-length': String(tgzBuf.length) });
    _setHttpsGetImpl(fake);

    const result = await resolveCapabilitySource('https://example.com/dos-control-cap.tgz', {
      gsdHome,
      hostVersion: '1.5.0',
      execOverrides: {
        tar: (_prog, args) => {
          if (args[0] === '-tzf') {
            return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
          }
          if (args[0] === '-tvzf') {
            return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
          }
          const extractDir = args[args.indexOf('-C') + 1];
          fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
        },
      },
    });

    assert.strictEqual(result.id, 'dos-control-cap', 'a normal small tarball resolves through the bounded fetch path');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir exists after a normal fetch+install');
    assert.ok(fake.state.ended, 'a within-cap body streams to completion');
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 2 (HIGH) — the resolver/staging must read every UNTRUSTED
// capability.json via the shared bounded reader (regular-file + size cap), NOT a
// raw fs.readFileSync. A repo-planted/extracted oversized (or FIFO/non-regular)
// manifest would otherwise read unbounded into memory (OOM) or BLOCK the resolver.
// A null/oversized/non-regular read → reject the source with a clear error.
// ---------------------------------------------------------------------------
describe('#1461 finding 2 — untrusted capability.json reads are size-bounded (no OOM/hang)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-manifest-bound-'); });
  afterEach(() => { cleanup(gsdHome); });

  test('MANIFEST_MAX_BYTES is a sane bounded cap (8 MiB)', () => {
    assert.strictEqual(MANIFEST_MAX_BYTES, 8 * 1024 * 1024, 'manifest cap is generous but bounded');
  });

  test('local: an OVERSIZED capability.json fails closed with a clear error (no OOM)', async () => {
    // Build a local bundle whose capability.json EXCEEDS the cap. The bounded reader's fstat-size
    // check refuses it WITHOUT reading the whole file into memory.
    const dir = createTempDir('gsd-cap-oversized-local-');
    try {
      // One byte over the cap is enough for the size check to refuse.
      const oversized = Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20); // spaces (still "JSON-ish" length-wise)
      fs.writeFileSync(path.join(dir, 'capability.json'), oversized);

      // REVERT-FAILS: with a raw fs.readFileSync of capability.json, the whole oversized file is read
      // into memory and JSON.parse fails with a SYNTAX error (not the bounded-reader size error). The
      // bounded reader rejects on the fstat size BEFORE reading — so the error message names the size.
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|size|maximum|not a regular file|cannot read/i,
        'an oversized local capability.json must be refused by the bounded reader',
      );
    } finally {
      cleanup(dir);
    }
    assert.ok(!fs.existsSync(path.join(gsdHome, '.gsd', 'capabilities')) ||
      fs.readdirSync(path.join(gsdHome, '.gsd', 'capabilities')).filter((e) => e !== '.staging').length === 0,
      'no capability is staged after an oversized manifest is refused');
  });

  test('CONTROL: a small valid local capability.json still resolves through the bounded reader', async () => {
    const dir = makeLocalCap(featureCap('bounded-control-cap'));
    try {
      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'bounded-control-cap', 'a small valid manifest still resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    } finally {
      cleanup(dir);
    }
  });

  test('local PRE-READ: an oversized capability.json is refused by the bounded reader (before any staging)', async () => {
    // HONEST SCOPE (#1461 finding 3): for a LOCAL source the adapter's bounded pre-read of
    // capability.json (to learn the id) runs FIRST and refuses an oversized manifest BEFORE staging —
    // so this proves the LOCAL PRE-READ bound, NOT the stageValidated staged re-read (an earlier
    // version of this test falsely claimed to exercise the staged re-read). The staged re-read is
    // covered directly below via _readManifestBounded.
    const dir = createTempDir('gsd-cap-oversized-stage-');
    try {
      const cap = featureCap('oversized-stage-cap');
      // A valid manifest padded past the cap via a large filler field — still parseable JSON shape but
      // over the byte cap, so the bounded reader refuses it on size.
      const padded = JSON.stringify({ ...cap, _filler: 'x'.repeat(MANIFEST_MAX_BYTES) });
      fs.writeFileSync(path.join(dir, 'capability.json'), padded);
      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|size|maximum|cannot read/i,
        'an oversized local capability.json must be refused by the bounded pre-read',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('staged re-read: the bounded manifest reader refuses an oversized staged capability.json directly', () => {
    // #1461 finding 3: exercise stageValidated's bounded re-read WITHOUT the local pre-read shadowing
    // it. _readManifestBounded is the exact reader stageValidated uses on the COPIED manifest; an
    // oversized staged file is refused on size (fail-closed), not read unbounded.
    //
    // REVERT-FAILS: with a raw fs.readFileSync in the staged re-read, this would read the whole
    // oversized file and either OOM or surface a JSON SyntaxError, not the bounded size refusal.
    const dir = createTempDir('gsd-cap-stagedread-direct-');
    try {
      const padded = Buffer.alloc(MANIFEST_MAX_BYTES + 1, 0x20); // spaces — over the cap by one byte.
      fs.writeFileSync(path.join(dir, 'capability.json'), padded);
      assert.throws(
        () => capSource._readManifestBounded(path.join(dir, 'capability.json'), 'capability.json not found'),
        /exceeds|size|maximum|not a regular file|cannot read|not found/i,
        'the bounded staged re-read refuses an oversized manifest on size',
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 1 (HIGH) — the STAGED bundle directory is byte-bounded UNIFORMLY.
// realHttpsGet is capped, but copyDirRecursive / git clone / npm pack / tar
// extraction RESULTS were only TIMEOUT-bounded, so a huge source tree / repo /
// package / tar bomb could fill disk during staging. stageValidated now enforces
// ONE aggregate byte-budget (MAX_STAGED_BUNDLE_BYTES) over the staged dir via a
// BOUNDED streaming walk AFTER staging and BEFORE validation/promotion — a single
// chokepoint that covers EVERY adapter (tar / npm / git / local).
// ---------------------------------------------------------------------------
describe('#1461 finding 1 — the staged bundle dir is aggregate-byte-bounded (uniform DoS bound)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-stagebudget-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_STAGED_BUNDLE_BYTES is a sane bounded cap (128 MiB)', () => {
    assert.strictEqual(MAX_STAGED_BUNDLE_BYTES, 128 * 1024 * 1024, 'staged-bundle cap is generous but bounded');
  });

  test('local: a staged bundle whose TOTAL bytes exceed the budget is refused before promotion', async () => {
    // A valid small manifest (so id/validation pass), plus a sibling artifact whose size pushes the
    // bundle TOTAL over the budget. The bounded streaming walk in stageValidated sums regular-file
    // bytes and fails closed BEFORE validation/promotion.
    //
    // REVERT-FAILS: without the staged-dir aggregate budget, copyDirRecursive copies the oversized
    // artifact into staging and the source resolves+promotes normally — the oversized bundle lands on
    // disk. With the budget, the bounded walk throws and the source never resolves.
    const dir = createTempDir('gsd-cap-stagebudget-local-');
    try {
      fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('stagebudget-cap')), 'utf8');
      // One byte over the budget across a single artifact is enough for the cumulative counter to trip.
      // ftruncate makes a sparse file so we don't actually write 128 MiB of real bytes (st.size still
      // reports the full length, which is what the budget walk sums).
      const big = path.join(dir, 'artifact.bin');
      const fd = fs.openSync(big, 'w');
      try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }

      await assert.rejects(
        () => resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' }),
        /staged bundle|exceeds|budget|maximum|too large/i,
        'an over-budget staged bundle must be refused before promotion',
      );
    } finally {
      cleanup(dir);
    }
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-budget bundle is refused');
    // The staging dir for the rejected bundle must be cleaned up (atomicity).
    const stagingRoot = path.join(capRoot, '.staging');
    if (fs.existsSync(stagingRoot)) {
      assert.strictEqual(fs.readdirSync(stagingRoot).length, 0, '.staging must be empty after an over-budget refusal');
    }
  });

  test('tarball: an extracted bundle over the budget is refused at the common staging chokepoint', async () => {
    // Drives the budget via the tarball adapter to prove the chokepoint is adapter-agnostic: the tar
    // override "extracts" an oversized artifact next to a valid manifest; stageValidated's budget walk
    // (after copyDirRecursive) rejects it.
    const cap = featureCap('stagebudget-tar-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    await assert.rejects(
      () => resolveCapabilitySource('https://example.com/big.tgz', {
        gsdHome, hostVersion: '1.5.0',
        execOverrides: {
          tar: (_prog, args) => {
            if (args[0] === '-tzf') {
              return { exitCode: 0, stdout: 'capability.json\nbomb.bin\n', stderr: '', signal: null, error: null };
            }
            if (args[0] === '-tvzf') {
              return {
                exitCode: 0,
                stdout:
                  '-rw-r--r-- 0 user group 10 Jan  1 2020 capability.json\n' +
                  '-rw-r--r-- 0 user group 10 Jan  1 2020 bomb.bin\n',
                stderr: '', signal: null, error: null,
              };
            }
            // "extraction": write a valid manifest + an oversized (sparse) artifact into extractDir.
            const extractDir = args[args.indexOf('-C') + 1];
            fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
            const fd = fs.openSync(path.join(extractDir, 'bomb.bin'), 'w');
            try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }
            return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
          },
        },
      }),
      /staged bundle|exceeds|budget|maximum|too large/i,
      'an over-budget extracted tarball must be refused at the staging chokepoint',
    );
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-budget tarball is refused');
  });

  test('CONTROL: a within-budget bundle still resolves + promotes normally', async () => {
    const dir = makeLocalCap(featureCap('stagebudget-control-cap'));
    try {
      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'stagebudget-control-cap', 'a within-budget bundle resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 1 (HIGH, ROUND 2) — copyDirRecursive itself is STREAMING +
// BUDGETED, so the COPY can never materialize a whole hostile directory.
//
// The post-copy assertStagedBundleWithinBudget walk is bounded, but it runs
// AFTER copyDirRecursive. The OLD copyDirRecursive used
// `fs.readdirSync(src, { withFileTypes: true })`, which materializes the ENTIRE
// directory-entry array into memory BEFORE the budget walk can run — so a
// hostile source tree with a directory holding millions of tiny entries
// (fetch < 64 MiB, but a colossal dirent array) OOMs the process during the
// COPY, before the post-copy budget can fail closed. copyDirRecursive now
// streams each directory via fs.opendirSync + dir.readSync() and threads a
// cumulative entry + byte counter, throwing the MOMENT either cap is exceeded —
// DURING the copy, before reading/copying the rest.
// ---------------------------------------------------------------------------
describe('#1461 finding 1 (ROUND 2) — copyDirRecursive streams + budgets the copy (no full materialization)', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-copybudget-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('MAX_STAGED_BUNDLE_ENTRIES is exported as a sane bounded cap (100k)', () => {
    assert.strictEqual(MAX_STAGED_BUNDLE_ENTRIES, 100_000, 'staged-bundle entry cap is generous but bounded');
  });

  test('a source dir with more than MAX_STAGED_BUNDLE_ENTRIES entries is refused, and the copy NEVER readdirSyncs the source', async () => {
    // ANTI-VACUOUS, two-pronged:
    //   (1) the bounded entry error fires (fail closed), AND
    //   (2) the COPY enumerated the source via opendirSync/readSync — it did NOT call the
    //       whole-array `fs.readdirSync(src, { withFileTypes:true })` materialization on the source.
    //
    // We don't actually create 100k real files (slow + disk). Instead we monkeypatch fs.opendirSync to
    // return a SYNTHETIC Dir whose readSync() yields lazily-generated tiny-file dirents far past the cap,
    // while a real on-disk capability.json + a few real files back the source so non-enumeration fs ops
    // still work. We also spy fs.readdirSync to PROVE the whole-array materialization is never used on
    // the source during the copy.
    //
    // REVERT-FAILS: reverting copyDirRecursive to `fs.readdirSync(src, { withFileTypes:true })` makes the
    // copy call readdirSync on the source (assertion (2) fails) AND would materialize the entire (here
    // synthetic, effectively unbounded) dirent array before any cap could trip.
    const src = createTempDir('gsd-cap-copybudget-src-');
    try {
      fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(featureCap('copybudget-cap')), 'utf8');

      const TOTAL_SYNTH = MAX_STAGED_BUNDLE_ENTRIES + 50_000; // far past the cap
      let readSyncCalls = 0;
      let readdirOnSrc = 0;
      let opendirOnSrc = 0;

      const realOpendir = fs.opendirSync;
      const realReaddir = fs.readdirSync;
      const realLstat = fs.lstatSync;
      const realCopyFile = fs.copyFileSync;

      // Make any per-entry lstat/copy of a synthetic file a no-op (the files don't exist on disk).
      fs.lstatSync = function patchedLstat(p, ...rest) {
        if (typeof p === 'string' && /[/\\]synth-\d+\.txt$/.test(p)) {
          return {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
            size: 1,
          };
        }
        return realLstat.call(this, p, ...rest);
      };
      fs.copyFileSync = function patchedCopyFile(s, d, ...rest) {
        if (typeof s === 'string' && /[/\\]synth-\d+\.txt$/.test(s)) return undefined;
        return realCopyFile.call(this, s, d, ...rest);
      };

      fs.readdirSync = function patchedReaddir(p, ...rest) {
        if (p === src) readdirOnSrc++;
        return realReaddir.call(this, p, ...rest);
      };

      fs.opendirSync = function patchedOpendir(p, ...rest) {
        if (p === src) {
          opendirOnSrc++;
          let i = 0;
          // A streaming Dir that yields the real manifest first, then synthetic tiny files lazily.
          return {
            readSync() {
              readSyncCalls++;
              if (i === 0) { i++; return makeDirent('capability.json', { file: true }); }
              if (i <= TOTAL_SYNTH) { const n = i++; return makeDirent(`synth-${n}.txt`, { file: true }); }
              return null;
            },
            closeSync() {},
            [Symbol.iterator]() { return this; },
          };
        }
        return realOpendir.call(this, p, ...rest);
      };

      try {
        await assert.rejects(
          () => resolveCapabilitySource(src, { gsdHome, hostVersion: '1.5.0' }),
          /entry count exceeds|maximum of 100000|too many entries/i,
          'a source with more than the entry cap must be refused during the streaming copy',
        );
      } finally {
        fs.opendirSync = realOpendir;
        fs.readdirSync = realReaddir;
        fs.lstatSync = realLstat;
        fs.copyFileSync = realCopyFile;
      }

      // (2a) The copy enumerated the source via the streaming opendir/readSync path.
      assert.ok(opendirOnSrc >= 1, 'copyDirRecursive must opendirSync the source (streaming)');
      assert.ok(readSyncCalls >= 1, 'copyDirRecursive must readSync the source (streaming)');
      // (2b) The copy did NOT use the whole-array readdirSync materialization on the source.
      assert.strictEqual(readdirOnSrc, 0, 'copyDirRecursive must NOT readdirSync the source (no full materialization)');
      // (2c) It aborted at ~the cap, NOT after enumerating all TOTAL_SYNTH entries.
      assert.ok(
        readSyncCalls <= MAX_STAGED_BUNDLE_ENTRIES + 5,
        `streaming copy must abort at ~the cap (readSync called ${readSyncCalls}, cap ${MAX_STAGED_BUNDLE_ENTRIES})`,
      );
    } finally {
      cleanup(src);
    }
    // Atomicity: nothing promoted; .staging cleaned up.
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-entry-budget bundle is refused');
    const stagingRoot = path.join(capRoot, '.staging');
    if (fs.existsSync(stagingRoot)) {
      assert.strictEqual(fs.readdirSync(stagingRoot).length, 0, '.staging must be empty after an over-entry refusal');
    }
  });

  test('a source whose copied bytes exceed the budget is refused DURING the copy (cumulative byte counter)', async () => {
    // The streaming copy threads a cumulative BYTE counter too: an oversized regular file trips the byte
    // cap during the copy, before the rest of the tree is read/copied.
    //
    // REVERT-FAILS: the old copyDirRecursive copied everything unconditionally and relied solely on the
    // post-copy walk; if that post-copy walk were ALSO removed (and copy not budgeted), the oversized
    // artifact would land in staging. With the in-copy byte budget the copy itself fails closed.
    const src = createTempDir('gsd-cap-copybudget-bytes-');
    try {
      fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(featureCap('copybudget-bytes-cap')), 'utf8');
      const big = path.join(src, 'artifact.bin');
      const fd = fs.openSync(big, 'w');
      try { fs.ftruncateSync(fd, MAX_STAGED_BUNDLE_BYTES + 1); } finally { fs.closeSync(fd); }

      await assert.rejects(
        () => resolveCapabilitySource(src, { gsdHome, hostVersion: '1.5.0' }),
        /exceeds|budget|maximum|too large|staged bundle/i,
        'an over-byte-budget source must be refused during the streaming copy',
      );
    } finally {
      cleanup(src);
    }
    const capRoot = path.join(gsdHome, '.gsd', 'capabilities');
    assert.ok(!fs.existsSync(capRoot) ||
      fs.readdirSync(capRoot).filter((e) => e !== '.staging').length === 0,
      'no capability is promoted after an over-byte-budget bundle is refused');
  });

  test('CONTROL: a normal small source still stages through the streaming copy', async () => {
    const dir = createTempDir('gsd-cap-copybudget-control-');
    try {
      fs.writeFileSync(path.join(dir, 'capability.json'), JSON.stringify(featureCap('copybudget-control-cap')), 'utf8');
      fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested', 'extra.txt'), 'hello', 'utf8');

      const result = await resolveCapabilitySource(dir, { gsdHome, hostVersion: '1.5.0' });
      assert.strictEqual(result.id, 'copybudget-control-cap', 'a within-budget bundle resolves');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'capability.json')), 'staged manifest present');
      assert.ok(fs.existsSync(path.join(result.stagedDir, 'nested', 'extra.txt')), 'nested file copied through the streaming copy');
      assert.strictEqual(fs.readFileSync(path.join(result.stagedDir, 'nested', 'extra.txt'), 'utf8'), 'hello', 'nested file bytes preserved');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// #1461 finding 2 (MED) — the spoofable parseTarMemberSize header-size parse was
// REMOVED. The staged-dir aggregate budget (finding 1) is now the real bound on
// the extracted RESULT, so the fragile/spoofable BSD-vs-GNU date-token size scan
// is gone. The tar NAME/TYPE guards (traversal, symlink, hardlink) remain and a
// within-name/type tarball still resolves through extraction.
// ---------------------------------------------------------------------------
describe('#1461 finding 2 — tar header-size parse removed; NAME/TYPE guards remain', () => {
  let gsdHome = '';
  beforeEach(() => { gsdHome = createTempDir('gsd-cap-tarsize-removed-'); });
  afterEach(() => {
    _setCapabilitySourceHttpGet(null);
    cleanup(gsdHome);
  });

  test('the spoofable per-member size cap export (MAX_TAR_MEMBER_BYTES) is REMOVED', () => {
    // REVERT-FAILS: if parseTarMemberSize / its export are re-introduced, this asserts the constant
    // is gone (the spoofable BSD-owner="Jan" mis-anchor fail-open is no longer relied upon).
    assert.strictEqual(capSource.MAX_TAR_MEMBER_BYTES, undefined, 'the spoofable per-member tar size cap is removed');
  });

  test('a tar with a HUGE declared member size (formerly rejected by the size parse) now extracts — and the staged budget is the real bound', async () => {
    // This listing once tripped the per-member size cap. With that removed, the NAME/TYPE guards pass
    // and extraction proceeds; a WITHIN-budget extracted result resolves normally. (An over-budget
    // result would be caught by finding 1's staged-dir budget, exercised in the finding-1 suite.)
    const cap = featureCap('tarsize-removed-cap');
    const tgzBuf = _fakeTarball(cap);
    _setCapabilitySourceHttpGet(() => Promise.resolve({ statusCode: 200, body: tgzBuf }));
    const result = await resolveCapabilitySource('https://example.com/huge-decl.tgz', {
      gsdHome, hostVersion: '1.5.0',
      execOverrides: {
        tar: (_prog, args) => {
          if (args[0] === '-tzf') {
            return { exitCode: 0, stdout: 'capability.json\n', stderr: '', signal: null, error: null };
          }
          if (args[0] === '-tvzf') {
            // A wildly large DECLARED size in the column — formerly rejected, now ignored.
            return { exitCode: 0, stdout: '-rw-r--r-- 0 user group 999999999999 Jan  1 2020 capability.json\n', stderr: '', signal: null, error: null };
          }
          const extractDir = args[args.indexOf('-C') + 1];
          fs.writeFileSync(path.join(extractDir, 'capability.json'), JSON.stringify(cap), 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null };
        },
      },
    });
    assert.strictEqual(result.id, 'tarsize-removed-cap', 'a huge-declared-size tar with safe names/types now extracts');
    assert.ok(fs.existsSync(result.stagedDir), 'staged dir exists after extraction');
  });
});
