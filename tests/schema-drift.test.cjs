/**
 * GSD Tools Tests - Schema Drift Detection
 *
 * Tests for schema-relevant file detection (plan-phase injection)
 * and post-execution schema drift gate (execute-phase verification).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');

// ─── Unit: detectSchemaFiles ─────────────────────────────────────────────────

const { detectSchemaFiles, detectSchemaOrm, checkSchemaDrift } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'schema-detect.cjs')
);

describe('detectSchemaFiles', () => {
  test('detects Payload CMS collection files', () => {
    const files = ['src/collections/Posts.ts', 'src/collections/Users.ts', 'src/lib/utils.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected, 'should detect schema files');
    assert.deepStrictEqual(result.matches, [
      'src/collections/Posts.ts',
      'src/collections/Users.ts',
    ]);
    assert.ok(result.orms.includes('payload'), 'should identify Payload CMS');
  });

  test('detects Payload CMS globals files', () => {
    const files = ['src/globals/Settings.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('payload'));
  });

  test('detects Prisma schema file', () => {
    const files = ['prisma/schema.prisma', 'src/index.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.deepStrictEqual(result.matches, ['prisma/schema.prisma']);
    assert.ok(result.orms.includes('prisma'));
  });

  test('detects Prisma multi-file schema', () => {
    const files = ['prisma/schema/user.prisma', 'prisma/schema/post.prisma'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.strictEqual(result.matches.length, 2);
    assert.ok(result.orms.includes('prisma'));
  });

  test('detects Drizzle schema files', () => {
    const files = ['drizzle/schema.ts', 'src/routes/api.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('drizzle'));
  });

  test('detects Drizzle schema in src/db/', () => {
    const files = ['src/db/schema.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('drizzle'));
  });

  test('detects Drizzle multi-file schemas', () => {
    const files = ['drizzle/users.ts', 'drizzle/posts.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('drizzle'));
  });

  test('detects Supabase migration files', () => {
    const files = ['supabase/migrations/20240101_add_users.sql'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('supabase'));
  });

  test('detects TypeORM entity files', () => {
    const files = ['src/entities/User.ts', 'src/entities/Post.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('typeorm'));
  });

  test('detects TypeORM migration files', () => {
    const files = ['src/migrations/1234567890-CreateUsers.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('typeorm'));
  });

  test('returns not detected for non-schema files', () => {
    const files = ['src/index.ts', 'src/utils/helpers.ts', 'package.json', 'README.md'];
    const result = detectSchemaFiles(files);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.matches.length, 0);
    assert.strictEqual(result.orms.length, 0);
  });

  test('returns empty for empty file list', () => {
    const result = detectSchemaFiles([]);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.matches.length, 0);
  });

  test('detects multiple ORMs in same file list', () => {
    const files = ['prisma/schema.prisma', 'src/collections/Posts.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected);
    assert.ok(result.orms.includes('prisma'));
    assert.ok(result.orms.includes('payload'));
  });

  test('handles Windows-style paths', () => {
    const files = ['src\\collections\\Posts.ts', 'src\\globals\\Settings.ts'];
    const result = detectSchemaFiles(files);
    assert.ok(result.detected, 'should detect schema files with backslash paths');
  });
});

// ─── Unit: detectSchemaOrm ───────────────────────────────────────────────────

describe('detectSchemaOrm', () => {
  test('returns push command for Payload CMS', () => {
    const info = detectSchemaOrm('payload');
    assert.ok(info.pushCommand);
    assert.ok(info.pushCommand.includes('payload'));
    assert.ok(info.envHint, 'should include env hint for non-TTY');
  });

  test('returns push command for Prisma', () => {
    const info = detectSchemaOrm('prisma');
    assert.ok(info.pushCommand.includes('prisma'));
  });

  test('returns push command for Drizzle', () => {
    const info = detectSchemaOrm('drizzle');
    assert.ok(info.pushCommand.includes('drizzle'));
  });

  test('returns push command for Supabase', () => {
    const info = detectSchemaOrm('supabase');
    assert.ok(info.pushCommand.includes('supabase'));
  });

  test('returns push command for TypeORM', () => {
    const info = detectSchemaOrm('typeorm');
    assert.ok(info.pushCommand.includes('typeorm'));
  });

  test('returns null for unknown ORM', () => {
    const info = detectSchemaOrm('unknown-orm');
    assert.strictEqual(info, null);
  });
});

// ─── Unit: checkSchemaDrift ──────────────────────────────────────────────────

describe('checkSchemaDrift', () => {
  test('returns no drift when no schema files changed', () => {
    const changedFiles = ['src/index.ts', 'package.json'];
    const executionLog = '';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('detects drift when schema files changed but no push executed', () => {
    const changedFiles = ['src/collections/Posts.ts', 'src/index.ts'];
    const executionLog = 'npm run build\nnpm run test';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, true);
    assert.strictEqual(result.blocking, true);
    assert.ok(result.schemaFiles.length > 0);
    assert.ok(result.orms.includes('payload'));
    assert.ok(result.message.length > 0);
  });

  test('no drift when schema files changed AND push was executed (payload)', () => {
    const changedFiles = ['src/collections/Posts.ts'];
    const executionLog = 'npx payload migrate\nnpm run build';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('no drift when schema files changed AND push was executed (prisma)', () => {
    const changedFiles = ['prisma/schema.prisma'];
    const executionLog = 'npx prisma db push\nnpm run build';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('no drift when schema files changed AND push was executed (drizzle)', () => {
    const changedFiles = ['drizzle/schema.ts'];
    const executionLog = 'npx drizzle-kit push\nnpm run test';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('no drift when schema files changed AND push was executed (supabase)', () => {
    const changedFiles = ['supabase/migrations/001_init.sql'];
    const executionLog = 'supabase db push\nnpm run test';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('no drift when schema files changed AND push was executed (typeorm)', () => {
    const changedFiles = ['src/entities/User.ts'];
    const executionLog = 'npx typeorm migration:run\nnpm run test';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.strictEqual(result.driftDetected, false);
    assert.strictEqual(result.blocking, false);
  });

  test('respects GSD_SKIP_SCHEMA_CHECK override', () => {
    const changedFiles = ['src/collections/Posts.ts'];
    const executionLog = 'npm run build';
    const result = checkSchemaDrift(changedFiles, executionLog, { skipCheck: true });
    assert.strictEqual(result.driftDetected, true);
    assert.strictEqual(result.blocking, false, 'should not block when skip override is set');
    assert.ok(result.skipped, 'should indicate the check was skipped');
  });

  test('detects drift with multiple ORMs and partial push', () => {
    const changedFiles = ['prisma/schema.prisma', 'src/collections/Posts.ts'];
    const executionLog = 'npx prisma db push';
    const result = checkSchemaDrift(changedFiles, executionLog);
    // Prisma was pushed but Payload was not
    assert.strictEqual(result.driftDetected, true);
    assert.strictEqual(result.blocking, true);
    assert.ok(result.unpushedOrms.includes('payload'));
    assert.ok(!result.unpushedOrms.includes('prisma'));
  });

  test('includes actionable message with push commands', () => {
    const changedFiles = ['prisma/schema.prisma'];
    const executionLog = '';
    const result = checkSchemaDrift(changedFiles, executionLog);
    assert.ok(result.message.includes('prisma'));
  });
});

// ─── CLI: verify schema-drift ────────────────────────────────────────────────

describe('verify schema-drift CLI command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject('gsd-schema-drift-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passes when no schema files in phase diff', () => {
    // Create a phase dir with a plan that modifies non-schema files
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'files_modified: [src/index.ts, src/utils.ts]',
      '---',
      '',
      'Plan content',
    ].join('\n'));

    const result = runGsdTools(['verify', 'schema-drift', '01-setup'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.drift_detected, false);
    assert.strictEqual(output.blocking, false);
  });

  test('detects drift when schema files in plan but no push evidence', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'files_modified: [src/collections/Posts.ts, src/index.ts]',
      '---',
      '',
      'Plan content',
    ].join('\n'));
    // No SUMMARY.md with push evidence
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), [
      '# Summary',
      '',
      '## Accomplishments',
      '- Added Post collection',
      '',
      '## Commands Run',
      '- npm run build',
      '- npm run test',
    ].join('\n'));

    const result = runGsdTools(['verify', 'schema-drift', '01-setup'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.drift_detected, true);
    assert.strictEqual(output.blocking, true);
  });

  test('passes when schema files in plan AND push evidence in summary', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'files_modified: [src/collections/Posts.ts]',
      '---',
      '',
      'Plan content',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), [
      '# Summary',
      '',
      '## Accomplishments',
      '- Added Post collection',
      '',
      '## Commands Run',
      '- npx payload migrate',
      '- npm run build',
    ].join('\n'));

    const result = runGsdTools(['verify', 'schema-drift', '01-setup'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.drift_detected, false);
    assert.strictEqual(output.blocking, false);
  });

  test('respects skip flag', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'files_modified: [src/collections/Posts.ts]',
      '---',
      '',
      'Plan content',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = runGsdTools(['verify', 'schema-drift', '01-setup', '--skip'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.blocking, false);
  });

  test('an invalid GSD_WORKSTREAM is a non-blocking payload, exit 0 (planningDir throws)', () => {
    // The CLI rejects a bad workstream before any verb runs; call the command directly.
    const { spawnSync } = require('node:child_process');
    const verifyPath = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'verify.cjs');
    const script = `require(${JSON.stringify(verifyPath)}).cmdVerifySchemaDrift(${JSON.stringify(tmpDir)}, '01-setup', false, false);`;
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: require('./helpers/timeouts.cjs').PROBE_TIMEOUT_MS,
      env: { ...process.env, GSD_WORKSTREAM: '../x' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.strictEqual(output.block, false);
    assert.strictEqual(output.drift_detected, false);
    assert.strictEqual(output.blocking, false);
    assert.match(output.message, /^exception: .*GSD_WORKSTREAM contains invalid path characters/);
  });
});

describe('#1571 regression: verify schema-drift resolves the phase by token, not substring', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject('gsd-schema-drift-1571-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Why this matters: a bare `entry.name.includes(phaseArg)` let a non-existent
  // phase silently match a *different* phase whose directory name merely contains
  // the requested token — e.g. requesting phase "1" matched "11-expansion" and ran
  // the drift gate against phase 11's migration files (a false positive on the wrong
  // phase). The fix uses the canonical phaseTokenMatches, matching find-phase /
  // verify phase-completeness. These assertions fail loudly if the matcher ever
  // regresses back to substring containment.
  function writePhase(dir) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), [
      '---',
      'files_modified: [src/collections/Posts.ts]',
      '---',
      '',
      'Plan content',
    ].join('\n'));
  }

  test('requesting a non-existent phase whose token is a substring of an existing dir reports not found', () => {
    // Only "11-expansion" exists. "1" is a substring of "11" but is NOT phase 1.
    writePhase('11-expansion');

    const result = runGsdTools(['verify', 'schema-drift', '1'], tmpDir);
    // An unresolvable phase is "could not look" (#5170): UNAVAILABLE, with the same non-blocking JSON.
    assert.strictEqual(result.exitCode, 69, `an unresolvable phase exits UNAVAILABLE: ${result.error}`);
    const output = JSON.parse(result.output);
    // Must NOT have matched 11-expansion. A wrong match yields an empty message and
    // a drift verdict computed from phase 11's files; the correct behaviour is a
    // "not found" message with no drift evaluation.
    assert.strictEqual(output.message, 'Phase directory not found: 1');
    assert.strictEqual(output.drift_detected, false);
    assert.strictEqual(output.block, false);
  });

  test('requesting the real phase by its token still resolves and runs the gate', () => {
    writePhase('11-expansion');

    const result = runGsdTools(['verify', 'schema-drift', '11'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    // Resolved to a real phase → gate ran (no "not found" message).
    assert.notStrictEqual(output.message, 'Phase directory not found: 11');
  });

  test('requesting the full directory name still resolves', () => {
    writePhase('11-expansion');

    const result = runGsdTools(['verify', 'schema-drift', '11-expansion'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.notStrictEqual(output.message, 'Phase directory not found: 11-expansion');
  });
});

// ─── #4562 / #5170: files_modified is read through the Frontmatter Module ─────────────────────
//
// The verb used to find a plan's files with `files_modified:\s*\[...\]`, which only knows the inline
// array: a YAML block sequence (the form most planners write) yielded NO files, so a plan that
// modified a schema file reported "no drift". It now reads the field the way phase-plan-index does
// (RawPlan.filesModified), and a plan it cannot read is `unreadable` — never "no files, no drift".

describe('verify schema-drift reads files_modified through the Frontmatter Module (#4562, #5170)', () => {
  const { spawnSync } = require('node:child_process');
  const { TEST_ENV_BASE } = require('./helpers.cjs');
  const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const { writeReadFailurePreload } = require('./helpers/fs-failure.cjs');
  const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
  const UNAVAILABLE = 69;
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempGitProject('gsd-schema-drift-4562-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writePlan(filesModifiedLines, eol = '\n') {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      ['---', 'phase: 01-setup', 'plan: 01', ...filesModifiedLines, 'autonomous: true', '---', '', 'Plan content', ''].join(eol),
    );
    // No push evidence anywhere: a schema file in the plan is drift.
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n\n## Commands Run\n- npm run build\n');
  }

  function drift() {
    const result = runGsdTools(['verify', 'schema-drift', '01-setup'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  const SCHEMA = 'src/collections/Posts.ts';

  test('a block sequence with ONE item is read: drift detected and blocking (#4562 fail-first)', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    const out = drift();
    assert.strictEqual(out.drift_detected, true);
    assert.strictEqual(out.blocking, true);
    assert.strictEqual(out.block, true);
    assert.deepStrictEqual(out.schema_files, [SCHEMA]);
  });

  test('a blocking drift verdict is exit 0 on both entry points: schema-drift is payload mode (#5170)', () => {
    // `verify schema-drift` and the capability gate `check verify.schema-drift` are one function, and the
    // gate dispatch reads `.block` from stdout and routes a NON-ZERO exit by `onError` (the drift gate is
    // `blocking: true, onError: skip`): a blocking verdict as exit 1 would be dropped as a skippable command
    // failure (wave-post-gate-hooks.md step 1, loop-hook-dispatch.md).
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    for (const argv of [['verify', 'schema-drift', '01-setup'], ['check', 'verify.schema-drift', '01-setup']]) {
      const result = runGsdTools(argv, tmpDir);
      assert.strictEqual(result.exitCode, 0, `${argv.join(' ')}: a delivered blocking verdict exits 0: ${result.error}`);
      const out = JSON.parse(result.output);
      assert.strictEqual(out.block, true);
      assert.strictEqual(out.drift_detected, true);
    }
  });

  test('a block sequence with N items is read in full: the schema file among them is found (#4562 fail-first)', () => {
    writePlan(['files_modified:', '  - src/index.ts', `  - ${SCHEMA}`, '  - src/utils.ts']);
    const out = drift();
    assert.strictEqual(out.drift_detected, true);
    assert.strictEqual(out.blocking, true);
    assert.deepStrictEqual(out.schema_files, [SCHEMA]);
  });

  test('control: a block sequence of non-schema files is no drift', () => {
    writePlan(['files_modified:', '  - src/index.ts', '  - src/utils.ts']);
    const out = drift();
    assert.strictEqual(out.drift_detected, false);
    assert.strictEqual(out.blocking, false);
  });

  test('the inline array form still works', () => {
    writePlan([`files_modified: [src/index.ts, ${SCHEMA}]`]);
    const out = drift();
    assert.strictEqual(out.drift_detected, true);
    assert.strictEqual(out.blocking, true);
    assert.deepStrictEqual(out.schema_files, [SCHEMA]);
  });

  test('CRLF line endings: the block sequence and the inline array give the same result', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`], '\r\n');
    const block = drift();
    assert.strictEqual(block.drift_detected, true);
    assert.deepStrictEqual(block.schema_files, [SCHEMA]);

    writePlan([`files_modified: [${SCHEMA}]`], '\r\n');
    const inline = drift();
    assert.strictEqual(inline.drift_detected, true);
    assert.deepStrictEqual(inline.schema_files, [SCHEMA]);
  });

  // The CLI child runs with a preload that makes fs.readFileSync throw EACCES for one path suffix:
  // deterministic, and not defeated by running as root (no chmod).
  function runWithReadFailure(suffix, args) {
    const preload = writeReadFailurePreload(tmpDir, suffix);
    return spawnSync(process.execPath, ['--require', preload, TOOLS_PATH, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE },
    });
  }

  test('an UNREADABLE plan is reported as unreadable (exit UNAVAILABLE), never "no files, no drift"', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    const r = runWithReadFailure('01-01-PLAN.md', ['verify', 'schema-drift', '01-setup']);
    assert.strictEqual(r.status, UNAVAILABLE, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.unreadable, true);
    assert.strictEqual(out.unreadable_file, '01-01-PLAN.md');
    assert.strictEqual(out.read_error, 'EACCES');
    assert.strictEqual(out.drift_detected, false, 'the existing payload shape is kept');
    assert.strictEqual(out.block, false, 'the verb stays non-blocking in its payload');
    assert.match(out.message, /could not read 01-01-PLAN\.md \(EACCES\)/);
  });

  test('an UNREADABLE summary is reported the same way', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    const r = runWithReadFailure('01-01-SUMMARY.md', ['verify', 'schema-drift', '01-setup']);
    assert.strictEqual(r.status, UNAVAILABLE, `stderr: ${r.stderr}`);
    assert.strictEqual(JSON.parse(r.stdout).unreadable_file, '01-01-SUMMARY.md');
  });

  test('control: the same read failure under --skip is moot — the gate is bypassed, exit 0', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    const r = runWithReadFailure('01-01-PLAN.md', ['verify', 'schema-drift', '01-setup', '--skip']);
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.block, false);
    assert.strictEqual(out.unreadable, undefined, 'no unreadable marker: the gate was bypassed, nothing was owed');
  });

  test('control: a readable plan exits 0 whether or not drift is found (the payload carries the verdict)', () => {
    writePlan(['files_modified:', `  - ${SCHEMA}`]);
    const r = spawnSync(process.execPath, [TOOLS_PATH, 'verify', 'schema-drift', '01-setup'], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...TEST_ENV_BASE },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    assert.strictEqual(JSON.parse(r.stdout).drift_detected, true);
  });
});
