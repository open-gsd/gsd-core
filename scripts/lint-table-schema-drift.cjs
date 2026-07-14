#!/usr/bin/env node
'use strict';

/**
 * Table-schema drift lint (ADR-2143 §3 Generative-Fix-Divergence guard, §7
 * "prohibition with teeth", epic #2143).
 *
 * `TABLE_SCHEMAS` (`src/markdown-table.cts`, compiled to
 * `gsd-core/bin/lib/markdown-table.cjs`) is the single-source registry naming
 * every canonical GSD pipe-table's column-header shape. Each registered
 * variant's exact `| col | col |` header string MUST appear verbatim in the
 * ONE template/workflow file that emits that table — otherwise the writer and
 * the registry have silently drifted apart, the exact bug class this ADR
 * closes (#2137 — reader hard-codes a shape the writer doesn't emit; #2133 —
 * the `quick.md` writer and its shell guard disagree on column count; #2119 —
 * dual SECURITY.md writers with conflicting shapes).
 *
 * Modeled on scripts/lint-phase-id-drift.cjs / scripts/lint-package-identity-drift.cjs:
 * a standalone node script (not a node:test), wired into `lint:ci`, exit 0 clean /
 * exit 1 + message on drift.
 */

const fs = require('node:fs');
const path = require('node:path');

// Schema id -> the ONE canonical template/workflow file that must emit every
// variant's header verbatim (ADR-2143 §3).
const SCHEMA_SOURCE_FILES = {
  RoadmapProgress: path.join('gsd-core', 'templates', 'roadmap.md'),
  RequirementsTraceability: path.join('gsd-core', 'templates', 'requirements.md'),
  QuickTasks: path.join('gsd-core', 'workflows', 'quick.md'),
  Security: path.join('gsd-core', 'templates', 'SECURITY.md'),
};

/** Build the exact `| a | b | c |` header line for one schema variant. */
function buildHeader(variant) {
  return `| ${variant.columns.join(' | ')} |`;
}

/** Normalize whitespace around pipes so template formatting quirks (extra
 * spaces added by an editor, etc.) don't produce a false drift report. */
function normalize(line) {
  return line.replace(/[ \t]*\|[ \t]*/g, '|').trim();
}

/**
 * Pure: given `schemas` (a `TABLE_SCHEMAS`-shaped object) and a
 * `readFile(relPath) -> string|null` accessor, find every variant whose exact
 * header does not appear verbatim (pipe-whitespace normalized) in its
 * schema's registered source file. Returns
 * `[{ schemaId, label, header, file, reason }]`; empty when clean.
 */
function findTableSchemaDrift(schemas, readFile, sourceFiles = SCHEMA_SOURCE_FILES) {
  const violations = [];
  for (const [schemaId, variants] of Object.entries(schemas)) {
    const relPath = sourceFiles[schemaId];
    if (!relPath) {
      violations.push({
        schemaId,
        label: null,
        header: null,
        file: null,
        reason: 'no canonical source file registered for this schema id in SCHEMA_SOURCE_FILES',
      });
      continue;
    }

    const content = readFile(relPath);
    if (content == null) {
      for (const variant of variants) {
        violations.push({
          schemaId,
          label: variant.label,
          header: buildHeader(variant),
          file: relPath,
          reason: 'source file not found or unreadable',
        });
      }
      continue;
    }

    const normalizedLines = content.split(/\r?\n/).map(normalize);
    for (const variant of variants) {
      const expected = normalize(buildHeader(variant));
      if (!normalizedLines.includes(expected)) {
        violations.push({
          schemaId,
          label: variant.label,
          header: buildHeader(variant),
          file: relPath,
          reason: 'header not found verbatim in source file',
        });
      }
    }
  }
  return violations;
}

/**
 * Load the built seam and scan the real repo tree. Returns the same shape as
 * `findTableSchemaDrift`. If the seam hasn't been built yet (`npm run
 * build:lib`), reports a single actionable violation rather than throwing.
 */
function scanRepo(root) {
  const seamPath = path.join(root, 'gsd-core', 'bin', 'lib', 'markdown-table.cjs');
  let seam;
  try {
    seam = require(seamPath);
  } catch (e) {
    return [{
      schemaId: null,
      label: null,
      header: null,
      file: null,
      reason: `cannot load the markdown-table seam at ${path.relative(root, seamPath)} — run 'npm run build:lib' first (${e.message})`,
    }];
  }

  const readFile = (relPath) => {
    try {
      return fs.readFileSync(path.join(root, relPath), 'utf8');
    } catch {
      return null;
    }
  };

  return findTableSchemaDrift(seam.TABLE_SCHEMAS, readFile);
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write(
      'ok table-schema-drift: every TABLE_SCHEMAS variant header appears verbatim in its canonical template/workflow\n',
    );
    return;
  }
  process.stderr.write(
    'table-schema-drift: TABLE_SCHEMAS variant(s) whose header is absent from their canonical source file (ADR-2143 §3).\n',
  );
  process.stderr.write(
    'Either update the template/workflow to emit the registered header verbatim, or update\n' +
      'TABLE_SCHEMAS in src/markdown-table.cts to match — the two must never drift.\n',
  );
  for (const v of violations) {
    const id = v.label ? `${v.schemaId}.${v.label}` : (v.schemaId ?? '?');
    const loc = v.file ? ` (${v.file})` : '';
    const expected = v.header ? ` — expected ${JSON.stringify(v.header)}` : '';
    process.stderr.write(`  ${id}${loc}: ${v.reason}${expected}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findTableSchemaDrift, scanRepo, buildHeader, normalize, SCHEMA_SOURCE_FILES };
