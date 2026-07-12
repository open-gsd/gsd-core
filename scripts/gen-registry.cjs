#!/usr/bin/env node
'use strict';

/**
 * scripts/gen-registry.cjs — generates docs/registries/capability-registry.md
 * (and, once PR2 ships docs/registries/eos.json, docs/registries/eos-registry.md)
 * from the corresponding source JSON, via registry-schema.cjs#renderMarkdown.
 * Issue #2182.
 *
 * NOT to be confused with `scripts/gen-capability-registry.cjs`: that script
 * generates the RUNTIME capability manifest consumed by the host at runtime
 * (`gsd-core/bin/lib/capability-registry.cjs`, built from every
 * `capabilities/<id>/capability.json` declaration). THIS script instead
 * generates the human-facing DOCUMENTATION catalog pages
 * (`docs/registries/*.md`) from the third-party discoverability registry
 * source JSON (`docs/registries/{capabilities,eos}.json`). The two pipelines
 * are independent — do not conflate them.
 *
 * Usage:
 *   node scripts/gen-registry.cjs              # print rendered markdown(s) to stdout
 *   node scripts/gen-registry.cjs --write      # write the *-registry.md file(s)
 *   node scripts/gen-registry.cjs --check      # exit 1 if a committed *-registry.md is stale
 *
 * Root is resolved from process.cwd() (not __dirname) — mirrors
 * scripts/validate-registry.cjs so both are drivable as subprocesses against
 * isolated temp-fixture directories via `cwd`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { renderMarkdown } = require('./registry-schema.cjs');

const SOURCES = [
  { type: 'capability', jsonFile: 'capabilities.json', mdFile: 'capability-registry.md' },
  { type: 'eos', jsonFile: 'eos.json', mdFile: 'eos-registry.md' },
];

/**
 * The generator always writes LF; a Windows checkout (autocrlf) may present
 * committed files with CRLF. Normalize before comparing so `--check` only
 * fails on real content drift, not checkout-introduced line-ending noise.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeLineEndings(content) {
  return content.replace(/\r/g, '');
}

function getRegistriesDir() {
  return path.join(process.cwd(), 'docs', 'registries');
}

/**
 * Render the markdown for a single registry type from its committed source
 * JSON.
 *
 * Only `eos.json` is optional (pre-PR2, before that source JSON ships) —
 * an absent `eos.json` returns null and callers treat that as "nothing to
 * do". `capabilities.json` is the primary registry source: a missing
 * `capabilities.json` is ALWAYS an error (never a silent "up to date"
 * pass), mirroring the type distinction in `scripts/validate-registry.cjs`
 * (`type === 'eos' && !exists → continue`).
 *
 * @param {'capability'|'eos'} type
 * @returns {string|null}
 */
function renderFor(type) {
  const source = SOURCES.find((s) => s.type === type);
  if (!source) throw new Error(`gen-registry: unknown registry type "${type}"`);

  const jsonPath = path.join(getRegistriesDir(), source.jsonFile);
  if (!fs.existsSync(jsonPath)) {
    if (type === 'eos') return null;
    throw new ExitError(
      1,
      `${source.jsonFile} does not exist at ${jsonPath}. Run:\n  node scripts/gen-registry.cjs --write\n(after adding docs/registries/${source.jsonFile})`,
    );
  }

  const entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return renderMarkdown(entries, { type, sourceFile: source.jsonFile });
}

function main() {
  const [, , flag] = process.argv;
  const registriesDir = getRegistriesDir();
  let anyDrift = false;

  for (const { type, mdFile } of SOURCES) {
    const rendered = renderFor(type);
    if (rendered === null) continue; // source JSON absent (eos.json before PR2)

    const mdPath = path.join(registriesDir, mdFile);

    if (flag === '--check') {
      if (!fs.existsSync(mdPath)) {
        process.stderr.write(`${mdFile} does not exist. Run:\n  node scripts/gen-registry.cjs --write\n`);
        anyDrift = true;
        continue;
      }
      const committed = fs.readFileSync(mdPath, 'utf8');
      if (normalizeLineEndings(committed) !== normalizeLineEndings(rendered)) {
        process.stderr.write(`${mdFile} is stale. Run:\n  node scripts/gen-registry.cjs --write\n`);
        anyDrift = true;
      }
    } else if (flag === '--write') {
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(mdPath, rendered);
      process.stdout.write(`Wrote ${mdPath}\n`);
    } else {
      process.stdout.write(rendered + '\n');
    }
  }

  if (flag === '--check') {
    if (anyDrift) throw new ExitError(1, 'registry markdown is stale');
    process.stdout.write('docs/registries/*.md are up to date.\n');
  }

  return 0;
}

if (require.main === module) runMain(main);

module.exports = { main, renderFor, SOURCES, normalizeLineEndings };
