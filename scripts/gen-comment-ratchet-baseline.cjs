#!/usr/bin/env node
'use strict';

/**
 * gen-comment-ratchet-baseline.cjs: writes eslint-rules/comment-ratchet.baseline.json
 * (ADR-6315 item 24, #6342).
 *
 * Lints the repository with the real eslint.config.mjs and an EMPTY baseline, so
 * the two comment rules report every site, and records how many each file has.
 * The baseline can only go down: run this after converting a file, and the file's
 * entry drops (at zero it is removed). `--check` exits 1 when the committed file
 * differs from what a run would write; the rules themselves fail only a
 * file with MORE sites than its entry, so an entry above the file's count (a PR that merged first and
 * removed a site) never breaks the queue; run `--write` to lower it.
 *
 * Usage: node scripts/gen-comment-ratchet-baseline.cjs [--write | --check]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'eslint-rules', 'comment-ratchet.baseline.json');
const KIND = { 'local/directive-names-issue': 'directive', 'local/max-comment-block-lines': 'block' };

/** @returns {Promise<Record<string, {directive?: number, block?: number}>>} */
async function measure() {
  const { ESLint } = require('eslint');
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: [{
      files: ['**/*.{cjs,js,mjs}', 'src/**/*.cts'],
      rules: Object.fromEntries(Object.keys(KIND).map((id) => [id, ['error', { baseline: {} }]])),
    }],
  });
  const results = await eslint.lintFiles(['.']);
  const counts = {};
  for (const result of results) {
    const rel = path.relative(ROOT, result.filePath).split(path.sep).join('/');
    for (const message of result.messages) {
      const kind = KIND[message.ruleId];
      if (!kind) continue;
      counts[rel] = counts[rel] || {};
      counts[rel][kind] = (counts[rel][kind] || 0) + 1;
    }
  }
  const sorted = {};
  for (const file of Object.keys(counts).sort()) sorted[file] = counts[file];
  return sorted;
}

const render = (counts) => `${JSON.stringify(counts, null, 2)}\n`;

async function main(argv = process.argv.slice(2)) {
  const counts = await measure();
  const text = render(counts);
  if (argv.includes('--check')) {
    const current = fs.existsSync(BASELINE) ? fs.readFileSync(BASELINE, 'utf8') : '';
    if (current === text) {
      process.stdout.write(`comment-ratchet baseline: up to date (${Object.keys(counts).length} files)\n`);
      return 0;
    }
    process.stderr.write('comment-ratchet baseline: stale; run node scripts/gen-comment-ratchet-baseline.cjs --write\n');
    return 1;
  }
  fs.writeFileSync(BASELINE, text);
  process.stdout.write(`comment-ratchet baseline: wrote ${Object.keys(counts).length} files\n`);
  return 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { measure, render, main };
