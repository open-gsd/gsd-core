#!/usr/bin/env node
'use strict';

/**
 * Drift guard for the dispatch-identity seam (#4630 Phase 3 / #6027, ADR-4630
 * Decision 4). `hooks/lib/dispatch-identity.js` owns the `[gsd:dispatch …]`
 * marker and its parser. Template drift: a marker in workflow/reference
 * markdown must round-trip through the owner. Parser drift: a `hooks/**` regex
 * parsing dispatch text is compared with `DISPATCH_PARSE_SOURCES`; sanction is
 * a dedicated `// dispatch-identity-owner: <reason>` line directly above.
 * Membership: every `--force-isolation` producer is in
 * `scripts/lib/dispatch-isolation-producer-sites.cjs`, and every entry has one;
 * sanction a doc example with `<!-- dispatch-isolation-site: <reason> -->`.
 * Usage: node scripts/lint-dispatch-identity-drift.cjs [--root <dir>]
 */

const fs = require('node:fs');
const path = require('node:path');

const owner = require('../hooks/lib/dispatch-identity.js');
const { PRODUCER_SITES } = require('./lib/dispatch-isolation-producer-sites.cjs');

const MARKDOWN_ROOTS = ['gsd-core/workflows', 'gsd-core/references'];
const HOOK_ROOT = 'hooks';
const OWNER_FILE = 'hooks/lib/dispatch-identity.js';

const HOOK_SANCTION_RE = /^\s*\/\/\s*dispatch-identity-owner:\s*\S/;
const SITE_SANCTION_RE = /^\s*<!--\s*dispatch-isolation-site:\s*\S[^]*-->\s*$/;

// A marker is canonical when the owner parses it and renders the same text
// back: the accepted shapes are whatever the owner emits, never restated here.
function isCanonicalMarker(found) {
  const parsed = owner.parseDispatchIdentity(found);
  if (parsed.source !== 'marker') return false;
  return owner.renderDispatchIdentityMarker({ phase: parsed.phase, plan: parsed.plan }) === found;
}

const NEAR_MARKER_RE = /\[\s*gsd[:\- _]dispatch\b[^\]\n]*\]?/gi;

function findTemplateDrift(text) {
  const out = [];
  const lines = String(text).split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    NEAR_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = NEAR_MARKER_RE.exec(line)) !== null) {
      const found = m[0];
      if (!isCanonicalMarker(found)) {
        out.push({ kind: 'template-drift', line: i + 1, found: found.trim() });
      }
    }
  });
  return out;
}

// A line that names the marker or the prose frame inside something that looks
// like a regex: a literal (`/…/`) or a `RegExp(` construction.
const PARSER_SIGNATURE_RE = /gsd:dispatch|execute\\{1,2}s[+*]plan|of\\{1,2}s[+*]phase/i;
const REGEX_CONTEXT_RE = /\/(?:[^/\\\n]|\\.)+\/[a-z]*|RegExp\(/;

function literalSources(line) {
  const sources = [];
  const lit = /\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/g;
  let m;
  while ((m = lit.exec(line)) !== null) sources.push(m[1]);
  const str = /RegExp\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  while ((m = str.exec(line)) !== null) {
    try {
      sources.push(JSON.parse(`"${m[2].replace(/\\\\/g, '\\\\').replace(/"/g, '\\"')}"`));
    } catch {
      sources.push(m[2]);
    }
  }
  return sources;
}

function findParserDrift(text, ownerSources) {
  const canon = new Set([ownerSources.marker, ownerSources.prose]);
  const out = [];
  const lines = String(text).split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (!PARSER_SIGNATURE_RE.test(line) || !REGEX_CONTEXT_RE.test(line)) return;
    let prev = i - 1;
    while (prev >= 0 && lines[prev].trim() === '') prev -= 1;
    if (prev >= 0 && HOOK_SANCTION_RE.test(lines[prev])) return;
    const verbatim = literalSources(line).some((src) => canon.has(src));
    out.push({
      kind: 'parser-drift',
      variant: verbatim ? 'verbatim-copy' : 'divergent-parser',
      line: i + 1,
      found: line.trim().slice(0, 160),
    });
  });
  return out;
}

const PRODUCER_RE = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\$\(\s*)?gsd_run\s+query\s+dispatch-isolation\b/;

function findProducerSites(text) {
  const raw = String(text).split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (!PRODUCER_RE.test(raw[i])) continue;
    let joined = raw[i];
    let j = i;
    while (/\\\s*$/.test(joined) && j + 1 < raw.length) {
      j += 1;
      joined = `${joined.replace(/\\\s*$/, ' ')}${raw[j]}`;
    }
    if (!/--force-isolation\b/.test(joined)) continue;
    let prev = i - 1;
    while (prev >= 0 && raw[prev].trim() === '') prev -= 1;
    out.push({ line: i + 1, sanctioned: prev >= 0 && SITE_SANCTION_RE.test(raw[prev]) });
  }
  return out;
}

function listFiles(dir, ext) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...listFiles(abs, ext));
    else if (e.isFile() && e.name.endsWith(ext)) found.push(abs);
  }
  return found;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function rel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function scanDispatchIdentityDrift({ root, membership = PRODUCER_SITES } = {}) {
  const findings = [];
  const siteFiles = new Set();

  for (const mdRoot of MARKDOWN_ROOTS) {
    for (const abs of listFiles(path.join(root, mdRoot), '.md')) {
      const text = readOrNull(abs);
      if (text === null) continue;
      const file = rel(root, abs);
      for (const f of findTemplateDrift(text)) findings.push({ ...f, file });
      for (const site of findProducerSites(text)) {
        if (site.sanctioned) continue;
        siteFiles.add(file);
        if (!membership.includes(file)) {
          findings.push({ kind: 'unlisted-producer-site', file, line: site.line, found: 'gsd_run query dispatch-isolation … --force-isolation' });
        }
      }
    }
  }
  // Report each unlisted file once.
  const seen = new Set();
  const deduped = findings.filter((f) => {
    if (f.kind !== 'unlisted-producer-site') return true;
    if (seen.has(f.file)) return false;
    seen.add(f.file);
    return true;
  });

  for (const entry of membership) {
    if (!siteFiles.has(entry)) {
      deduped.push({ kind: 'stale-membership-entry', file: entry, line: 0, found: 'no producer site remains in this file' });
    }
  }

  for (const abs of listFiles(path.join(root, HOOK_ROOT), '.js')) {
    const file = rel(root, abs);
    if (file === OWNER_FILE) continue;
    const text = readOrNull(abs);
    if (text === null) continue;
    for (const f of findParserDrift(text, owner.DISPATCH_PARSE_SOURCES)) deduped.push({ ...f, file });
  }
  return deduped;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(__dirname, '..');
  const findings = scanDispatchIdentityDrift({ root });
  if (findings.length === 0) {
    process.stdout.write(`ok dispatch-identity-drift: markers, hook parsers and ${PRODUCER_SITES.length} producer sites all derive from the owners\n`);
    return;
  }
  process.stderr.write('dispatch-identity-drift: the dispatch-identity format, its parser, or the producer-site list diverged from its single owner (ADR-4630 Decision 4):\n');
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    process.stderr.write(`  [${f.kind}${f.variant ? `:${f.variant}` : ''}] ${where}  ${f.found}\n`);
  }
  process.stderr.write('Fix: render the marker with hooks/lib/dispatch-identity.js, parse with parseDispatchIdentity, or list the producer in scripts/lib/dispatch-isolation-producer-sites.cjs.\n');
  process.stderr.write('A deliberate exception is a dedicated line above the site: `// dispatch-identity-owner: <reason>` (hooks) or `<!-- dispatch-isolation-site: <reason> -->` (markdown).\n');
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findTemplateDrift,
  findParserDrift,
  findProducerSites,
  scanDispatchIdentityDrift,
};
