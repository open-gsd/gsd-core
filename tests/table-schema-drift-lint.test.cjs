'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Table-schema drift lint (ADR-2143 §3 Generative-Fix-Divergence guard, §7
 * "prohibition with teeth", epic #2143, Phase 4).
 *
 * scripts/lint-table-schema-drift.cjs is the standalone lint (wired into
 * `lint:ci`) that fails the moment a `TABLE_SCHEMAS` variant's header drifts
 * from the one template/workflow file that emits it — the durable fix for
 * #2137 / #2133 / #2119 (reader and writer disagreeing on a table's shape).
 * These tests exercise its pure `findTableSchemaDrift()` with a synthetic
 * drifted schema (fail-first) and confirm the live repo passes `scanRepo()`.
 *
 * Also locks in the ADR-2143 §7 zero-orphaned-marker invariant: no literal
 * "pending #1372" / "pending #2143" marker remains anywhere in src/ (Phase 4
 * asserts zero of either, so a future author cannot silently re-introduce an
 * un-burned-down deferral marker).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findTableSchemaDrift, scanRepo, buildHeader } = require(
  path.join(ROOT, 'scripts', 'lint-table-schema-drift.cjs'),
);

describe('#2143 table-schema drift lint: findTableSchemaDrift (pure)', () => {
  test('a variant whose header appears verbatim in its source file is not drift', () => {
    const schemas = { Foo: [{ label: 'default', columns: ['A', 'B'] }] };
    const readFile = (rel) => (rel === 'foo.md' ? 'intro\n| A | B |\n|---|---|\n' : null);
    assert.deepEqual(findTableSchemaDrift(schemas, readFile, { Foo: 'foo.md' }), []);
  });

  test('a synthetic drifted schema (header absent from its source file) IS flagged (fail-first)', () => {
    // The registry claims a 3-column header but the file only ever emitted 2 —
    // exactly the writer/reader divergence ADR-2143 §3 targets.
    const schemas = { Foo: [{ label: 'default', columns: ['A', 'B', 'C'] }] };
    const readFile = (rel) => (rel === 'foo.md' ? 'intro\n| A | B |\n|---|---|\n' : null);
    const v = findTableSchemaDrift(schemas, readFile, { Foo: 'foo.md' });
    assert.equal(v.length, 1);
    assert.equal(v[0].schemaId, 'Foo');
    assert.equal(v[0].label, 'default');
    assert.equal(v[0].header, '| A | B | C |');
    assert.equal(v[0].file, 'foo.md');
  });

  test('whitespace-around-pipes differences are normalized (not false drift)', () => {
    const schemas = { Foo: [{ label: 'default', columns: ['A', 'B'] }] };
    const readFile = (rel) => (rel === 'foo.md' ? '|A|B|\n|-|-|\n' : null);
    assert.deepEqual(findTableSchemaDrift(schemas, readFile, { Foo: 'foo.md' }), []);
  });

  test('a schema id with no registered source file is flagged', () => {
    const schemas = { Untracked: [{ label: 'default', columns: ['X'] }] };
    const v = findTableSchemaDrift(schemas, () => null, {});
    assert.equal(v.length, 1);
    assert.equal(v[0].schemaId, 'Untracked');
    assert.match(v[0].reason, /no canonical source file registered/);
  });

  test('a missing/unreadable source file flags every variant of that schema', () => {
    const schemas = {
      Foo: [
        { label: 'a', columns: ['X'] },
        { label: 'b', columns: ['Y'] },
      ],
    };
    const v = findTableSchemaDrift(schemas, () => null, { Foo: 'missing.md' });
    assert.equal(v.length, 2);
    assert.ok(v.every((d) => d.reason === 'source file not found or unreadable'));
  });

  test('buildHeader renders the exact `| col | col |` shape', () => {
    assert.equal(buildHeader({ columns: ['Phase', 'Status'] }), '| Phase | Status |');
  });
});

describe('#2143 table-schema drift lint: the live repo is clean', () => {
  test('scanRepo finds zero drift against the current TABLE_SCHEMAS registry', () => {
    const violations = scanRepo(ROOT);
    assert.deepEqual(
      violations,
      [],
      'TABLE_SCHEMAS variant(s) drifted from their canonical template/workflow:\n'
        + violations.map((d) => `  ${d.schemaId}.${d.label} (${d.file}): ${d.reason}`).join('\n'),
    );
  });
});

describe('#2143 Phase 4: zero orphaned pending-marker literals in src/', () => {
  function walkCts(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkCts(full, acc);
      else if (entry.isFile() && entry.name.endsWith('.cts')) acc.push(full);
    }
    return acc;
  }

  test('no "pending #1372" or "pending #2143" literal marker remains in src/', () => {
    const srcDir = path.join(ROOT, 'src');
    const offenders = [];
    for (const file of walkCts(srcDir, [])) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      text.split(/\r?\n/).forEach((line, idx) => {
        if (line.includes('pending #1372') || line.includes('pending #2143')) {
          offenders.push(`${rel}:${idx + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `orphaned "pending #1372"/"pending #2143" marker(s) found (ADR-2143 §7 requires zero):\n  ${offenders.join('\n  ')}`,
    );
  });
});
