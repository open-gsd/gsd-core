#!/usr/bin/env node
'use strict';

/**
 * Runnable usage example for the Option-E predicate fact-store (ADR-1671).
 * Reference example only — not shipped, not part of the CI suite.
 *
 *   node examples/dynamic-context-management/demo.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const { parsePredicates, selectPredicates } = require('./context-predicates.cjs');

const md = fs.readFileSync(path.resolve(__dirname, '..', '..', 'CONTEXT.md'), 'utf8');
const { predicates, duplicates } = parsePredicates(md);
const classes = new Set(predicates.map((p) => p.klass));

process.stdout.write(
  `Parsed ${predicates.length} predicates across ${classes.size} classes; ` +
  `${duplicates.length} duplicate id(s).\n`,
);

const slice = selectPredicates(predicates, { prefix: 'PRED.k320' });
process.stdout.write(
  `\nselectPredicates({ prefix: 'PRED.k320' }) -> ${slice.length} matches ` +
  `(a JIT brief slice):\n`,
);
for (const p of slice) process.stdout.write(`  ${p.id} = ${p.value}\n`);
