#!/usr/bin/env node
'use strict';

/**
 * Reference example (NOT shipped, NOT compiled, NOT installed) for ADR-1671,
 * "Dynamic context management platform" — the Option-E predicate fact-store.
 *
 * Builds a deterministic, drift-guarded index of every predicate fact in the
 * repo-root CONTEXT.md, and demonstrates a JIT "task -> relevant predicates"
 * selector. Self-contained: depends only on the sibling context-predicates.cjs.
 *
 * Usage (run from the repo root):
 *   node examples/dynamic-context-management/gen-context-index.cjs            # print index to stdout
 *   node examples/dynamic-context-management/gen-context-index.cjs --write    # write CONTEXT-INDEX.json (next to this file)
 *   node examples/dynamic-context-management/gen-context-index.cjs --check    # exit 1 if the committed sample is stale
 *   node examples/dynamic-context-management/gen-context-index.cjs --select <query>
 *
 * --select <query> tries, in order: exact class ("PRED"), dotted prefix
 * ("PRED.k320"), then free-text contains — the first non-empty match wins.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parsePredicates, selectPredicates, buildIndex } = require('./context-predicates.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTEXT_PATH = path.join(REPO_ROOT, 'CONTEXT.md');
const INDEX_PATH = path.join(__dirname, 'CONTEXT-INDEX.json');

function buildFreshIndex() {
  const markdown = fs.readFileSync(CONTEXT_PATH, 'utf8');
  const { predicates } = parsePredicates(markdown);
  return buildIndex(predicates);
}

function main(args) {
  const flag = args[0];

  if (flag === '--check') {
    const committed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const live = buildFreshIndex();
    if (JSON.stringify(committed, null, 2) !== JSON.stringify(live, null, 2)) {
      process.stderr.write(
        'CONTEXT-INDEX.json is stale. Run:\n' +
        '  node examples/dynamic-context-management/gen-context-index.cjs --write\n',
      );
      return 1;
    }
    process.stdout.write('CONTEXT-INDEX.json is up to date.\n');
    return 0;
  }

  if (flag === '--write') {
    const index = buildFreshIndex();
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
    const dupNote = index.duplicates.length > 0
      ? ` (${index.duplicates.length} duplicate id${index.duplicates.length !== 1 ? 's' : ''})`
      : '';
    process.stdout.write(
      `Wrote ${path.relative(REPO_ROOT, INDEX_PATH)}\n` +
      `  ${index.count} predicates, ${Object.keys(index.classes).length} classes${dupNote}\n`,
    );
    return 0;
  }

  if (flag === '--select') {
    const query = args[1];
    if (!query) {
      process.stderr.write('Usage: gen-context-index.cjs --select <query>\n');
      return 1;
    }
    const { predicates } = parsePredicates(fs.readFileSync(CONTEXT_PATH, 'utf8'));
    let results = selectPredicates(predicates, { klass: query });
    if (results.length === 0) results = selectPredicates(predicates, { prefix: query });
    if (results.length === 0) results = selectPredicates(predicates, { contains: query });
    if (results.length === 0) {
      process.stdout.write(`No predicates matched: ${query}\n`);
      return 0;
    }
    for (const p of results) process.stdout.write(`${p.id} = ${p.value}\n`);
    process.stdout.write(`\n(${results.length} predicate${results.length !== 1 ? 's' : ''} matched)\n`);
    return 0;
  }

  process.stdout.write(JSON.stringify(buildFreshIndex(), null, 2) + '\n');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
