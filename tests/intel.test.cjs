/**
 * Tests for gsd-core/bin/lib/intel.cjs
 *
 * Covers: query, status, diff, validate, snapshot, patch-meta,
 * extract-exports, enabled/disabled gating, and CLI routing via gsd-tools.
 */
// allow-test-rule: source-text-is-the-product — readFileSync assertions target API-SURFACE.md, which is the generated product of intelApiSurface; asserting on its text content is the only way to verify correct generation.

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  intelQuery,
  intelStatus,
  intelDiff,
  intelValidate,
  intelSnapshot,
  intelPatchMeta,
  intelExtractExports,
  intelApiSurface,
  ensureIntelDir,
  isIntelEnabled,
} = require('../gsd-core/bin/lib/intel.cjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function enableIntel(planningDir) {
  const configPath = path.join(planningDir, 'config.json');
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  config.intel = { enabled: true };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function writeIntelJson(planningDir, filename, data) {
  const intelPath = path.join(planningDir, 'intel');
  fs.mkdirSync(intelPath, { recursive: true });
  fs.writeFileSync(
    path.join(intelPath, filename),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function _writeIntelMd(planningDir, filename, content) {
  const intelPath = path.join(planningDir, 'intel');
  fs.mkdirSync(intelPath, { recursive: true });
  fs.writeFileSync(path.join(intelPath, filename), content, 'utf8');
}

// ─── Disabled gating ────────────────────────────────────────────────────────

describe('intel disabled gating', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('isIntelEnabled returns false when no config.json exists', () => {
    assert.strictEqual(isIntelEnabled(planningDir), false);
  });

  test('isIntelEnabled returns false when intel.enabled is not set', () => {
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ model_profile: 'balanced' }),
      'utf8'
    );
    assert.strictEqual(isIntelEnabled(planningDir), false);
  });

  test('isIntelEnabled returns true when intel.enabled is true', () => {
    enableIntel(planningDir);
    assert.strictEqual(isIntelEnabled(planningDir), true);
  });

  test('intelQuery returns disabled response when intel is off', () => {
    const result = intelQuery('test', planningDir);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.message.includes('disabled'));
  });

  test('intelStatus returns disabled response when intel is off', () => {
    const result = intelStatus(planningDir);
    assert.strictEqual(result.disabled, true);
  });

  test('intelDiff returns disabled response when intel is off', () => {
    const result = intelDiff(planningDir);
    assert.strictEqual(result.disabled, true);
  });

  test('intelValidate returns disabled response when intel is off', () => {
    const result = intelValidate(planningDir);
    assert.strictEqual(result.disabled, true);
  });
});

// ─── ensureIntelDir ─────────────────────────────────────────────────────────

describe('ensureIntelDir', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('creates intel directory if it does not exist', () => {
    const intelPath = ensureIntelDir(planningDir);
    assert.ok(fs.existsSync(intelPath));
    assert.ok(intelPath.endsWith('intel'));
  });

  test('returns existing intel directory without error', () => {
    fs.mkdirSync(path.join(planningDir, 'intel'), { recursive: true });
    const intelPath = ensureIntelDir(planningDir);
    assert.ok(fs.existsSync(intelPath));
  });
});

// ─── intelQuery ─────────────────────────────────────────────────────────────

describe('intelQuery', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty matches when no intel files exist', () => {
    const result = intelQuery('anything', planningDir);
    assert.strictEqual(result.total, 0);
    assert.deepStrictEqual(result.matches, []);
    assert.strictEqual(result.term, 'anything');
  });

  test('finds matches in JSON file keys', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'src/auth/controller.ts': { size: 1024, type: 'typescript' },
        'src/utils/logger.ts': { size: 512, type: 'typescript' },
      },
    });

    const result = intelQuery('auth', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].source, 'file-roles.json');
    assert.strictEqual(result.matches[0].entries[0].key, 'src/auth/controller.ts');
  });

  test('finds matches in JSON file values', () => {
    writeIntelJson(planningDir, 'dependency-graph.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        express: { version: '4.18.0', type: 'runtime', used_by: ['src/server.ts'] },
      },
    });

    const result = intelQuery('express', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].entries[0].key, 'express');
  });

  test('search is case-insensitive', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      entries: {
        'src/AuthController.ts': { type: 'typescript' },
      },
    });

    const result = intelQuery('authcontroller', planningDir);
    assert.strictEqual(result.total, 1);
  });

  test('finds matches in arch-decisions.json entries', () => {
    writeIntelJson(planningDir, 'arch-decisions.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'jwt-auth': { decision: 'Use JWT tokens for stateless authentication', status: 'accepted' },
        'rest-api': { decision: 'REST API endpoints for all services', status: 'accepted' },
      },
    });

    const result = intelQuery('JWT', planningDir);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.matches[0].source, 'arch-decisions.json');
  });

  test('searches across multiple intel files', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      entries: { 'src/auth.ts': { exports: ['authenticate'] } },
    });
    writeIntelJson(planningDir, 'api-map.json', {
      entries: { '/api/auth': { method: 'POST', handler: 'authenticate' } },
    });

    const result = intelQuery('auth', planningDir);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.matches.length, 2);
  });
});

// ─── intelStatus ────────────────────────────────────────────────────────────

describe('intelStatus', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports missing files as stale', () => {
    const result = intelStatus(planningDir);
    assert.strictEqual(result.overall_stale, true);
    assert.strictEqual(result.files['file-roles.json'].exists, false);
    assert.strictEqual(result.files['file-roles.json'].stale, true);
  });

  test('reports fresh files as not stale', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {},
    });

    const result = intelStatus(planningDir);
    assert.strictEqual(result.files['file-roles.json'].exists, true);
    assert.strictEqual(result.files['file-roles.json'].stale, false);
  });

  test('reports old files as stale', () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: oldDate },
      entries: {},
    });

    const result = intelStatus(planningDir);
    assert.strictEqual(result.files['file-roles.json'].stale, true);
    assert.strictEqual(result.overall_stale, true);
  });
});

// ─── intelDiff ──────────────────────────────────────────────────────────────

describe('intelDiff', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns no_baseline when no snapshot exists', () => {
    const result = intelDiff(planningDir);
    assert.strictEqual(result.no_baseline, true);
  });

  test('detects added files since snapshot', () => {
    // Save an empty snapshot
    const intelPath = ensureIntelDir(planningDir);
    fs.writeFileSync(
      path.join(intelPath, '.last-refresh.json'),
      JSON.stringify({ hashes: {}, timestamp: new Date().toISOString(), version: 1 }),
      'utf8'
    );

    // Add a file after snapshot
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const result = intelDiff(planningDir);
    assert.ok(result.added.includes('file-roles.json'));
  });

  test('detects changed files since snapshot', () => {
    // Write initial file
    writeIntelJson(planningDir, 'file-roles.json', { entries: { a: 1 } });

    // Take snapshot
    intelSnapshot(planningDir);

    // Modify file
    writeIntelJson(planningDir, 'file-roles.json', { entries: { a: 1, b: 2 } });

    const result = intelDiff(planningDir);
    assert.ok(result.changed.includes('file-roles.json'));
  });
});

// ─── intelSnapshot ──────────────────────────────────────────────────────────

describe('intelSnapshot', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('saves snapshot with file hashes', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const result = intelSnapshot(planningDir);
    assert.strictEqual(result.saved, true);
    assert.strictEqual(result.files, 1);
    assert.ok(result.timestamp);

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(planningDir, 'intel', '.last-refresh.json'), 'utf8')
    );
    assert.ok(snapshot.hashes['file-roles.json']);
  });
});

// ─── intelValidate ──────────────────────────────────────────────────────────

describe('intelValidate', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports errors for missing files', () => {
    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes('does not exist')));
  });

  test('reports warnings for missing _meta.updated_at', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });
    writeIntelJson(planningDir, 'api-map.json', { entries: {} });
    writeIntelJson(planningDir, 'dependency-graph.json', { entries: {} });
    writeIntelJson(planningDir, 'stack.json', { entries: {} });
    writeIntelJson(planningDir, 'arch-decisions.json', { entries: {} });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('missing _meta.updated_at')));
  });

  test('reports invalid JSON as error', () => {
    const intelPath = path.join(planningDir, 'intel');
    fs.mkdirSync(intelPath, { recursive: true });
    fs.writeFileSync(path.join(intelPath, 'file-roles.json'), 'not valid json', 'utf8');
    writeIntelJson(planningDir, 'api-map.json', { entries: {} });
    writeIntelJson(planningDir, 'dependency-graph.json', { entries: {} });
    writeIntelJson(planningDir, 'stack.json', { entries: {} });
    writeIntelJson(planningDir, 'arch-decisions.json', { entries: {} });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('invalid JSON')));
  });

  test('passes validation with complete fresh intel', () => {
    const now = new Date().toISOString();
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'dependency-graph.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'stack.json', {
      _meta: { updated_at: now },
      entries: {},
    });
    writeIntelJson(planningDir, 'arch-decisions.json', {
      _meta: { updated_at: now },
      entries: {},
    });

    const result = intelValidate(planningDir);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });
});

// ─── intelPatchMeta ─────────────────────────────────────────────────────────

describe('intelPatchMeta', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('patches _meta.updated_at and increments version', () => {
    writeIntelJson(planningDir, 'file-roles.json', {
      _meta: { updated_at: '2025-01-01T00:00:00Z', version: 1 },
      entries: {},
    });

    const filePath = path.join(planningDir, 'intel', 'file-roles.json');
    const result = intelPatchMeta(filePath);

    assert.strictEqual(result.patched, true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(data._meta.version, 2);
    assert.notStrictEqual(data._meta.updated_at, '2025-01-01T00:00:00Z');
  });

  test('creates _meta if missing', () => {
    writeIntelJson(planningDir, 'file-roles.json', { entries: {} });

    const filePath = path.join(planningDir, 'intel', 'file-roles.json');
    const result = intelPatchMeta(filePath);

    assert.strictEqual(result.patched, true);

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(data._meta.updated_at);
    assert.strictEqual(data._meta.version, 1);
  });

  test('returns error for missing file', () => {
    const result = intelPatchMeta('/nonexistent/file.json');
    assert.strictEqual(result.patched, false);
    assert.ok(result.error.includes('not found'));
  });

  test('returns error for invalid JSON', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not json', 'utf8');

    const result = intelPatchMeta(filePath);
    assert.strictEqual(result.patched, false);
    assert.ok(result.error.includes('Invalid JSON'));
  });
});

// ─── intelExtractExports ────────────────────────────────────────────────────

describe('intelExtractExports', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts CJS module.exports object keys', () => {
    const filePath = path.join(tmpDir, 'example.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'function doStuff() {}',
      'function helper() {}',
      'module.exports = {',
      '  doStuff,',
      '  helper,',
      '};',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'module.exports');
    assert.ok(result.exports.includes('doStuff'));
    assert.ok(result.exports.includes('helper'));
  });

  test('extracts ESM named exports', () => {
    const filePath = path.join(tmpDir, 'example.mjs');
    fs.writeFileSync(filePath, [
      'export function greet() {}',
      'export const VERSION = "1.0";',
      'export class Widget {}',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.ok(result.exports.includes('greet'));
    assert.ok(result.exports.includes('VERSION'));
    assert.ok(result.exports.includes('Widget'));
  });

  test('extracts ESM export block', () => {
    const filePath = path.join(tmpDir, 'example.js');
    fs.writeFileSync(filePath, [
      'function foo() {}',
      'function bar() {}',
      'export { foo, bar };',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.ok(result.exports.includes('foo'));
    assert.ok(result.exports.includes('bar'));
  });

  test('returns empty exports for nonexistent file', () => {
    const result = intelExtractExports('/nonexistent/file.js');
    assert.deepStrictEqual(result.exports, []);
    assert.strictEqual(result.method, 'none');
  });

  // ── Behavior-lock: dedup + order (green before AND after Set conversion) ──

  test('dedup: duplicate exports.X assignments yield each name exactly once', () => {
    // exports.foo appears twice — result must contain 'foo' exactly once
    const filePath = path.join(tmpDir, 'dedup-exports-x.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.foo = 1;',
      'exports.bar = 2;',
      'exports.foo = 3;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'exports.X');
    assert.deepStrictEqual(result.exports, ['foo', 'bar']);
  });

  test('order: CJS exports.X preserves first-seen insertion order', () => {
    // Names appear in source order: charlie, alpha, bravo
    const filePath = path.join(tmpDir, 'order-cjs.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.charlie = 1;',
      'exports.alpha = 2;',
      'exports.bravo = 3;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'exports.X');
    assert.deepStrictEqual(result.exports, ['charlie', 'alpha', 'bravo']);
  });

  test('dedup: ESM export block with repeated name yields name exactly once', () => {
    // export { foo, foo } — foo must appear once
    const filePath = path.join(tmpDir, 'dedup-esm-block.mjs');
    fs.writeFileSync(filePath, [
      'function foo() {}',
      'export { foo, foo };',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['foo']);
  });

  test('merge order: CJS exports appear before ESM exports, each name once', () => {
    // exports.X = CJS side; export function / export const = ESM side
    // Expected order: CJS-first then ESM additions
    const filePath = path.join(tmpDir, 'merge-order.mjs');
    fs.writeFileSync(filePath, [
      "exports.cjsFirst = 1;",
      "export function esmSecond() {}",
      "export const esmThird = 3;",
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'mixed');
    assert.deepStrictEqual(result.exports, ['cjsFirst', 'esmSecond', 'esmThird']);
  });

  test('export default collapse: only export default (anon) yields ["default"]', () => {
    // A file with only `export default <value>` — no named exports, no default fn/class
    // The collapse guard (esmExports.length === 0 at time of check) produces ["default"]
    const filePath = path.join(tmpDir, 'default-only.mjs');
    fs.writeFileSync(filePath, 'export default 42;', 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['default']);
  });

  test('export default collapse: export default fn + named exports — no "default" collapse', () => {
    // export default function myFunc() {} → myFunc is extracted (named default fn)
    // export const named → also extracted
    // "default" literal does NOT appear because esmExports is not empty when anon-default check runs
    const filePath = path.join(tmpDir, 'default-fn-plus-named.mjs');
    fs.writeFileSync(filePath, [
      'export default function myFunc() {}',
      'export const named = 1;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.strictEqual(result.method, 'esm');
    assert.deepStrictEqual(result.exports, ['myFunc', 'named']);
  });

  test('return shape: exports is a plain Array (callers use .includes/.length)', () => {
    const filePath = path.join(tmpDir, 'shape-check.cjs');
    fs.writeFileSync(filePath, [
      "'use strict';",
      'exports.foo = 1;',
    ].join('\n'), 'utf8');

    const result = intelExtractExports(filePath);
    assert.ok(Array.isArray(result.exports), 'exports must be a plain Array');
    assert.ok('file' in result, 'result must have file field');
    assert.ok('method' in result, 'result must have method field');
  });
});

// ─── CLI routing via gsd-tools ──────────────────────────────────────────────

describe('gsd-tools intel subcommands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('intel status returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel query returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'query', 'test'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel status returns file status when enabled', () => {
    enableIntel(path.join(tmpDir, '.planning'));
    const result = runGsdTools(['intel', 'status'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.ok(output.files);
    assert.strictEqual(output.overall_stale, true);
  });

  test('intel validate reports errors for missing files when enabled', () => {
    enableIntel(path.join(tmpDir, '.planning'));
    const result = runGsdTools(['intel', 'validate'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.valid, false);
    assert.ok(output.errors.length > 0);
  });

  test('unknown intel subcommand error lists api-surface', () => {
    const result = runGsdTools(['intel', 'nonexistent-subcmd'], tmpDir);
    assert.strictEqual(result.success, false);
    const errorText = result.error || '';
    assert.ok(errorText.includes('api-surface'), 'error message must list api-surface');
  });

  test('flag-looking intel subcommand treated as unknown, not crash', () => {
    const result = runGsdTools(['intel', '--api-surface'], tmpDir);
    assert.strictEqual(result.success, false);
    const errorText = result.error || '';
    assert.ok(errorText.includes('Unknown intel subcommand'), 'must emit typed unknown-subcommand error');
  });

  test('intel api-surface returns disabled message when not enabled', () => {
    const result = runGsdTools(['intel', 'api-surface'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.disabled, true);
  });

  test('intel api-surface writes API-SURFACE.md when enabled with populated api-map.json', () => {
    const planningDir = path.join(tmpDir, '.planning');
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'intelQuery': { method: 'function', handler: 'intelQuery', role: 'query intel files' },
        'intelStatus': { method: 'function', handler: 'intelStatus', role: 'report freshness' },
      },
    });
    const result = runGsdTools(['intel', 'api-surface'], tmpDir);
    assert.strictEqual(result.success, true);
    const output = JSON.parse(result.output);
    assert.ok(output.written, 'result must include written path');
    assert.strictEqual(output.symbolCount, 2);
    const mdContent = fs.readFileSync(output.written, 'utf8');
    assert.ok(mdContent.includes('intelQuery'), 'API-SURFACE.md must list intelQuery symbol');
    assert.ok(mdContent.includes('intelStatus'), 'API-SURFACE.md must list intelStatus symbol');
  });
});

// ─── intelApiSurface ────────────────────────────────────────────────────────

describe('intelApiSurface', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    planningDir = path.join(tmpDir, '.planning');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns disabled response when intel is off', () => {
    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.message.includes('disabled'));
  });

  test('writes API-SURFACE.md with symbol entries from api-map.json', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {
        'authenticate': { method: 'POST', handler: 'authController', role: 'user login' },
        'createUser': { method: 'POST', handler: 'userController', role: 'user registration' },
      },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 2);
    assert.ok(result.written.endsWith('API-SURFACE.md'));

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('authenticate'), 'must include symbol name authenticate');
    assert.ok(content.includes('createUser'), 'must include symbol name createUser');
    assert.ok(content.includes('authController'), 'must include field value authController');
  });

  test('writes API-SURFACE.md with incomplete banner when api-map.json is absent', () => {
    enableIntel(planningDir);
    // No api-map.json written

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 0);
    assert.ok(result.written.endsWith('API-SURFACE.md'));

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('Incomplete'), 'must contain Incomplete banner when no entries');
    assert.ok(content.includes('unknown'), 'must say treat absence as "unknown"');
  });

  test('writes API-SURFACE.md with incomplete banner when entries is empty object', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: {},
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.symbolCount, 0);

    const content = fs.readFileSync(result.written, 'utf8');
    assert.ok(content.includes('Incomplete'), 'empty entries must still emit incomplete banner');
  });

  test('returns stale=false for fresh api-map.json', () => {
    enableIntel(planningDir);
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: new Date().toISOString() },
      entries: { 'myFunc': { method: 'function' } },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.stale, false);
  });

  test('returns stale=true for old api-map.json', () => {
    enableIntel(planningDir);
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeIntelJson(planningDir, 'api-map.json', {
      _meta: { updated_at: oldDate },
      entries: { 'myFunc': { method: 'function' } },
    });

    const result = intelApiSurface(planningDir);
    assert.strictEqual(result.stale, true);
  });

  test('return shape has written, symbolCount, stale fields', () => {
    enableIntel(planningDir);
    const result = intelApiSurface(planningDir);
    assert.ok('written' in result, 'result must have written field');
    assert.ok('symbolCount' in result, 'result must have symbolCount field');
    assert.ok('stale' in result, 'result must have stale field');
  });
});
