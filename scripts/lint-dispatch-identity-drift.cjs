#!/usr/bin/env node
'use strict';

/**
 * Drift guard for the dispatch-identity seam (#4630 Phase 3 / #6027, ADR-4630
 * Decision 4). `hooks/lib/dispatch-identity.js` owns the `[gsd:dispatch …]`
 * marker and its parser. Template drift: a marker in workflow/reference
 * markdown must round-trip through the owner. Parser drift: a `hooks/**` regex
 * parsing dispatch text is compared with `DISPATCH_PARSE_SOURCES`; sanction is
 * a dedicated `// dispatch-identity-owner: <reason>` line directly above.
 * Membership: every `--force-isolation` producer is in `PRODUCER_SITES` below,
 * and every entry there has one;
 * sanction a doc example with `<!-- dispatch-isolation-site: <reason> -->`.
 * A scan root that is missing is a finding, never a silent pass.
 * Usage: node scripts/lint-dispatch-identity-drift.cjs [--root <dir>]
 */

const fs = require('node:fs');
const path = require('node:path');

const owner = require('../hooks/lib/dispatch-identity.js');

// The canonical membership list for dispatch isolation: every markdown file
// that records a decision with `query dispatch-isolation … --force-isolation`.
// Declared here, once, and asserted against the scan both ways; never
// generate it from the scan, which would pass a hand-written site by
// construction. It lives in the lint, not `scripts/lib/`, which ships.
const PRODUCER_SITES = Object.freeze([
  'gsd-core/references/dispatch-isolation-gate.md',
  'gsd-core/workflows/diagnose-issues.md',
  'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
  'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md',
  'gsd-core/workflows/execute-plan.md',
  'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md',
  'gsd-core/workflows/quick.md',
]);

const MARKDOWN_ROOTS = ['gsd-core/workflows', 'gsd-core/references'];
const HOOK_ROOT = 'hooks';
const HOOK_EXTENSIONS = ['.js', '.cjs', '.mjs'];
const OWNER_FILE = 'hooks/lib/dispatch-identity.js';
// `hooks/dist/` is the build output of the hooks (a copy of the owner among
// them), present after `npm run build:hooks`; it is not source.
const HOOK_BUILD_OUTPUT = 'hooks/dist/';

const HOOK_SANCTION_RE = /^\s*\/\/\s*dispatch-identity-owner:\s*\S/;
const SITE_SANCTION_RE = /^\s*<!--\s*dispatch-isolation-site:\s*\S(?:(?!-->).)*-->\s*$/;

function splitLines(text) {
  return String(text).split(/\r\n|\r|\n/);
}

function previousNonBlank(lines, i) {
  let prev = i - 1;
  while (prev >= 0 && lines[prev].trim() === '') prev -= 1;
  return prev >= 0 ? lines[prev] : null;
}

// A marker is canonical when the owner parses it and renders the same text
// back: the accepted shapes are whatever the owner emits, never restated here.
function isCanonicalMarker(found) {
  const parsed = owner.parseDispatchIdentity(found);
  if (parsed.source !== 'marker') return false;
  return owner.renderDispatchIdentityMarker({ phase: parsed.phase, plan: parsed.plan }) === found;
}

// A bracketed `gsd` marker, including near-miss spellings and a marker whose
// word is assembled by a format placeholder (`[gsd:%s …]`, `[gsd:${WORD} …]`).
const NEAR_MARKER_RE = /\[\s*gsd[:\- _](?:dispatch\b|%s|\$\{?[A-Za-z_]\w*\}?)[^\]\n]*\]?/gi;

function findTemplateDrift(text) {
  const out = [];
  splitLines(text).forEach((line, i) => {
    NEAR_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = NEAR_MARKER_RE.exec(line)) !== null) {
      if (!isCanonicalMarker(m[0])) out.push({ kind: 'template-drift', line: i + 1, found: m[0].trim() });
    }
  });
  return out;
}

// Code with comments and same-quote string concatenation removed, one entry
// per original line, so a regex assembled as `'\\[gsd:' + 'dispatch'` reads as
// the text it builds and line numbers stay the file's.
function codeLines(text) {
  const noBlock = String(text).replace(/\/\*[^]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
  return splitLines(noBlock).map((line) => {
    const joined = line.replace(/(['"`])\s*\+\s*\1/g, '');
    return /^\s*\/\//.test(joined) ? '' : joined.replace(/\s\/\/.*$/, '');
  });
}

// Spellings of "one or more whitespace" a hand-written regex can use.
const SPACE_ALTERNATIVES_RE = /\\{1,2}s[+*]?|\[ \]\+?|\[\\{1,2}s\]\+?| +/g;
const MARKER_SIGNATURE_RE = /gsd:dispatch/i;
const PROSE_SIGNATURE_RE = /execute plan\b.*\bof phase\b|\bexecute plan\b/i;
const REGEX_CONTEXT_RE = /\/(?:[^/\\\n]|\\.)+\/[a-z]*|RegExp\(/;

function literalRegexes(window) {
  const found = [];
  const lit = /\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/g;
  let m;
  while ((m = lit.exec(window)) !== null) found.push({ source: m[1], flags: m[2] });
  const str = /RegExp\(\s*(['"`])((?:\\.|(?!\1).)*)\1(?:\s*,\s*(['"`])([a-z]*)\3)?/g;
  while ((m = str.exec(window)) !== null) {
    // Read the JS string literal one escape level down (`\\s` is the regex `\s`).
    found.push({ source: m[2].replace(/\\(.)/g, '$1'), flags: m[4] || '' });
  }
  return found;
}

function findParserDrift(text, ownerSources) {
  const rawLines = splitLines(text);
  const code = codeLines(text);
  const out = [];
  let coveredThrough = -1;
  code.forEach((line, i) => {
    if (line.trim() === '' || i <= coveredThrough) return;
    // A `RegExp(` call may continue over the next lines; one finding covers them all.
    const isCall = /RegExp\(/.test(line);
    const window = isCall ? code.slice(i, i + 4).join(' ') : line;
    const spaced = window.replace(SPACE_ALTERNATIVES_RE, ' ');
    const names = MARKER_SIGNATURE_RE.test(window)
      || (PROSE_SIGNATURE_RE.test(spaced) && REGEX_CONTEXT_RE.test(window));
    if (!names) return;
    const prev = previousNonBlank(rawLines, i);
    if (prev !== null && HOOK_SANCTION_RE.test(prev)) return;
    const copies = literalRegexes(window).filter((r) => r.source === ownerSources.marker || r.source === ownerSources.prose);
    let variant = 'divergent-parser';
    if (copies.length > 0) {
      const same = copies.some((r) => [...r.flags].sort().join('') === [...(r.source === ownerSources.marker ? ownerSources.markerFlags : ownerSources.proseFlags)].sort().join(''));
      variant = same ? 'verbatim-copy' : 'verbatim-source-other-flags';
    }
    if (isCall) coveredThrough = i + 3;
    out.push({ kind: 'parser-drift', variant, line: i + 1, found: rawLines[i].trim().slice(0, 160) });
  });
  return out;
}

// A producer is a command that runs `query dispatch-isolation` with
// `--force-isolation`, under any runner or wrapper. Prose that quotes the
// command inside backticks, and shell comments, are not producers.
const QUERY_RE = /\bquery\s+dispatch-isolation\b/;

function findProducerSites(text) {
  const raw = splitLines(text);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const head = raw[i];
    const at = head.search(QUERY_RE);
    if (at < 0 || head.slice(0, at).includes('`') || /^\s*#/.test(head)) continue;
    let joined = head;
    let j = i;
    while (/\\\s*$/.test(joined) && j + 1 < raw.length) {
      j += 1;
      joined = `${joined.replace(/\\\s*$/, ' ')}${raw[j]}`;
    }
    if (!/--force-isolation\b/.test(joined)) continue;
    const prev = previousNonBlank(raw, i);
    out.push({ line: i + 1, sanctioned: prev !== null && SITE_SANCTION_RE.test(prev) });
  }
  return out;
}

function listFiles(dir, extensions) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inner = listFiles(abs, extensions);
      if (inner !== null) found.push(...inner);
    } else if (e.isFile() && extensions.some((ext) => e.name.endsWith(ext))) {
      found.push(abs);
    }
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
  const unlisted = new Set();

  for (const mdRoot of MARKDOWN_ROOTS) {
    const files = listFiles(path.join(root, mdRoot), ['.md']);
    if (files === null) {
      findings.push({ kind: 'scan-root-missing', file: mdRoot, line: 0, found: 'the markdown scan root cannot be read' });
      continue;
    }
    for (const abs of files) {
      const text = readOrNull(abs);
      if (text === null) continue;
      const file = rel(root, abs);
      for (const f of findTemplateDrift(text)) findings.push({ ...f, file });
      for (const site of findProducerSites(text)) {
        if (site.sanctioned) continue;
        siteFiles.add(file);
        if (!membership.includes(file) && !unlisted.has(file)) {
          unlisted.add(file);
          findings.push({ kind: 'unlisted-producer-site', file, line: site.line, found: 'query dispatch-isolation … --force-isolation' });
        }
      }
    }
  }
  for (const entry of membership) {
    if (!siteFiles.has(entry)) {
      findings.push({ kind: 'stale-membership-entry', file: entry, line: 0, found: 'no unsanctioned producer site remains in this file' });
    }
  }

  const hookFiles = listFiles(path.join(root, HOOK_ROOT), HOOK_EXTENSIONS);
  if (hookFiles === null) {
    findings.push({ kind: 'scan-root-missing', file: HOOK_ROOT, line: 0, found: 'the hook scan root cannot be read' });
  } else {
    if (!hookFiles.some((abs) => rel(root, abs) === OWNER_FILE)) {
      findings.push({ kind: 'scan-root-missing', file: OWNER_FILE, line: 0, found: 'the dispatch-identity owner is not where the lint expects it' });
    }
    for (const abs of hookFiles) {
      const file = rel(root, abs);
      if (file === OWNER_FILE || file.startsWith(HOOK_BUILD_OUTPUT)) continue;
      const text = readOrNull(abs);
      if (text === null) continue;
      for (const f of findParserDrift(text, owner.DISPATCH_PARSE_SOURCES)) findings.push({ ...f, file });
    }
  }
  return findings;
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
  process.stderr.write('Fix: render the marker with hooks/lib/dispatch-identity.js, parse with parseDispatchIdentity, or list the producer in PRODUCER_SITES in scripts/lint-dispatch-identity-drift.cjs.\n');
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
