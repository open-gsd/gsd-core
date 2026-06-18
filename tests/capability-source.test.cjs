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
} = capSource;

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

    await assert.rejects(
      () =>
        resolveCapabilitySource('https://example.com/tarball-mismatch.tgz', {
          gsdHome,
          hostVersion: '1.5.0',
          integrity: badIntegrity,
          execOverrides: {
            tar: (_prog, args, _opts) => {
              // Should never be reached — integrity check fires first.
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

    // No staged directory must exist.
    const finalDir = path.join(gsdHome, '.gsd', 'capabilities', 'tarball-mismatch');
    assert.ok(!fs.existsSync(finalDir), 'staged dir must NOT exist after integrity mismatch');
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
