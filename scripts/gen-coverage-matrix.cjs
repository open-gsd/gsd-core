#!/usr/bin/env node
'use strict';

/**
 * gen-coverage-matrix.cjs (#6771): generates docs/reference/coverage-matrix.md, one row per slash command,
 * `gsd-tools` verb, config key, agent, hook, template and installer flag: where it is documented, whether each
 * option is documented there, and the Diataxis type of that page. Each item list is read from the surface's own
 * source and each verdict is a mechanical check of the docs text, so `--check` fails when the page is stale.
 *
 *   node scripts/gen-coverage-matrix.cjs            # print to stdout
 *   node scripts/gen-coverage-matrix.cjs --write    # write the committed file
 *   node scripts/gen-coverage-matrix.cjs --check    # exit 1 if the committed file is stale
 *   node scripts/gen-coverage-matrix.cjs --strict   # exit 1 if any item or option is undocumented
 *
 * The pure functions take their inputs as arguments so tests drive them with fixtures; `collectInputs` is the
 * only function that reads the repository.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'docs', 'reference', 'coverage-matrix.md');

/** Diataxis type of each documenting page. Pages not listed here render as `unclassified`. */
const DOC_TYPES = Object.freeze({
  'docs/COMMANDS.md': 'Reference',
  'docs/CLI-TOOLS.md': 'Reference',
  'docs/CONFIGURATION.md': 'Reference',
  'docs/INVENTORY.md': 'Reference',
  'docs/reference/agents.md': 'Reference',
  'docs/reference/templates.md': 'Reference',
  'docs/reference/installer-flags.md': 'Reference',
});

const FLAG_RE = /--[a-z][a-z0-9-]*/g;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Split Markdown into sections. A heading starts a section that ends at the next
 * heading of the same or a higher level; a `#` line inside a fenced code block is
 * not a heading. Returns `{ level, title, line, text }` where `text` is the section
 * body without the heading line.
 */
function parseSections(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const heads = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = HEADING_RE.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2], index: i });
  });
  return heads.map((h, n) => {
    let end = lines.length;
    for (let k = n + 1; k < heads.length; k++) {
      if (heads[k].level <= h.level) { end = heads[k].index; break; }
    }
    return { level: h.level, title: h.title, line: h.index + 1, text: lines.slice(h.index + 1, end).join('\n') };
  });
}

/** GitHub's heading anchor: lowercase, drop punctuation other than `-` and `_`, spaces to `-`. */
function githubAnchor(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Unique `--flag` tokens of a string, in order of first appearance. */
function flagsOf(text) {
  return [...new Set(String(text || '').match(FLAG_RE) || [])];
}

let escapeRegexImpl = null;
/** The repo's own escaper (`src/pattern.cts`), loaded on first use: it is compiled output, built by `collectInputs`. */
function escapeRe(s) {
  if (escapeRegexImpl === null) escapeRegexImpl = require('../gsd-core/bin/lib/pattern.cjs').escapeRegex;
  return escapeRegexImpl(s);
}

/** True when `flag` occurs in `text` as a whole token (so `--ws` does not match `--wsx`). */
function hasFlag(text, flag) {
  return new RegExp(escapeRe(flag) + '(?![A-Za-z0-9-])').test(text);
}

/** True when `name` occurs in `text` delimited by characters that cannot continue an identifier. */
function mentions(text, name) {
  return new RegExp('(?<![A-Za-z0-9._/-])' + escapeRe(name) + '(?![A-Za-z0-9_-])').test(text);
}

/**
 * Sections of the given docs that mention any of `names`. `docs` is
 * `[{ file, sections }]`; the result keeps `file` and the section.
 */
function sectionsMentioning(docs, names) {
  const out = [];
  for (const doc of docs) {
    for (const s of doc.sections) {
      if (names.some((n) => mentions(s.title, n) || mentions(s.text, n))) out.push({ file: doc.file, section: s });
    }
  }
  return out;
}

function locationOf(hit) {
  return { file: hit.file, anchor: githubAnchor(hit.section.title), title: hit.section.title };
}

function rowFor(item, hits, options) {
  const documented = hits.length > 0;
  const missing = documented ? options.filter((o) => !hits.some((h) => hasFlag(h.section.title + '\n' + h.section.text, o))) : options.slice();
  return {
    item,
    where: documented ? locationOf(hits[0]) : null,
    optionsTotal: options.length,
    optionsDocumented: options.length - missing.length,
    missing,
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────

/**
 * Build the matrix model from collected inputs:
 *   commands:  [{ stem, argumentHint }]
 *   verbs:     [{ verb, aliases, flags: string[] }]
 *   configKeys: string[]
 *   agents:    string[]
 *   hooks:     string[]
 *   templates: string[]
 *   installerFlags: string[]
 *   docs:      { commands, cli, config, agents, inventory, templates, installer } — Markdown text
 */
function buildModel(inputs) {
  const d = inputs.docs;
  const sec = (file, text) => ({ file, sections: parseSections(text) });
  const commandsDoc = sec('docs/COMMANDS.md', d.commands);
  const cliDocs = [sec('docs/CLI-TOOLS.md', d.cli), commandsDoc];
  const configDoc = sec('docs/CONFIGURATION.md', d.config);
  const agentsDoc = sec('docs/reference/agents.md', d.agents);
  const templatesDoc = sec('docs/reference/templates.md', d.templates);
  const installerDoc = sec('docs/reference/installer-flags.md', d.installer);
  const inventoryLines = String(d.inventory).replace(/\r\n/g, '\n').split('\n');

  const surfaces = [];

  surfaces.push({
    id: 'commands',
    title: 'Slash commands',
    source: '`commands/gsd/*.md` (command name and `argument-hint` flags)',
    rule: 'A command is documented when a `COMMANDS.md` section headed by `/gsd-<command>` exists (or, for a command with no section of its own, any section that names it); each `--flag` of its `argument-hint` must appear in that section.',
    rows: inputs.commands
      .map((c) => {
        const name = '/gsd-' + c.stem;
        const all = sectionsMentioning([commandsDoc], [name]);
        // A section headed by the command wins; a command with no section of its own (the namespace routers are
        // described in a table) counts through any section that names it.
        const headed = all.filter((h) => mentions(h.section.title, name));
        return rowFor(name, headed.length ? headed : all, flagsOf(c.argumentHint));
      })
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'verbs',
    title: '`gsd-tools` verbs',
    source: '`docs/CLI-SURFACE-MANIFEST.json` (verb, aliases and declared flags)',
    rule: 'A verb is documented when a section of `CLI-TOOLS.md` or `COMMANDS.md` names it (dotted verbs also as `a b`); each declared flag must appear in a section that names the verb.',
    rows: inputs.verbs
      .map((v) => {
        const names = [...new Set([v.verb, v.verb.replace(/\./g, ' '), ...(v.aliases || [])])];
        return rowFor(v.verb, sectionsMentioning(cliDocs, names), v.flags.map((f) => '--' + f));
      })
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'config',
    title: 'Config keys',
    source: '`VALID_CONFIG_KEYS` in `src/config-schema.cts`',
    rule: 'A key is documented when `CONFIGURATION.md` has a table row that starts with the key and carries a type and a default; a key mentioned only in prose is listed as `prose`.',
    rows: inputs.configKeys
      .map((k) => {
        const rowLine = String(d.config).split('\n').find((l) => new RegExp('^\\|\\s*`' + escapeRe(k) + '`\\s*\\|').test(l));
        const hits = sectionsMentioning([configDoc], [k]);
        if (!hits.length) return { item: k, where: null, optionsTotal: 3, optionsDocumented: 0, missing: ['type', 'default', 'effect'], status: 'none' };
        if (rowLine) {
          const cells = rowLine.split('|').slice(1, -1).map((c) => c.trim());
          const missing = ['type', 'default', 'effect'].filter((_, i) => !cells[i + 1]);
          return { item: k, where: locationOf(hits[0]), optionsTotal: 3, optionsDocumented: 3 - missing.length, missing, status: 'table' };
        }
        return { item: k, where: locationOf(hits[0]), optionsTotal: 3, optionsDocumented: 0, missing: ['type', 'default', 'effect'], status: 'prose' };
      })
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'agents',
    title: 'Agents',
    source: '`agents/gsd-*.md` (non-compact)',
    rule: 'An agent is documented when `reference/agents.md` has a section whose heading names it.',
    rows: inputs.agents
      .map((a) => rowFor(a, sectionsMentioning([agentsDoc], [a]).filter((h) => mentions(h.section.title, a)), []))
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'hooks',
    title: 'Hooks',
    source: '`hooks/*.js` and `hooks/*.sh`',
    rule: 'A hook is documented when the hooks table of `INVENTORY.md` has a row for it with an event.',
    rows: inputs.hooks
      .map((h) => {
        const line = inventoryLines.find((l) => l.startsWith('| `' + h + '` |'));
        if (!line) return { item: h, where: null, optionsTotal: 1, optionsDocumented: 0, missing: ['event'] };
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        const hasEvent = Boolean(cells[1]);
        return {
          item: h,
          where: { file: 'docs/INVENTORY.md', anchor: 'hooks', title: 'Hooks' },
          optionsTotal: 1,
          optionsDocumented: hasEvent ? 1 : 0,
          missing: hasEvent ? [] : ['event'],
        };
      })
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'templates',
    title: 'Templates',
    source: '`gsd-core/templates/**` (the registry `README.md` excluded)',
    rule: 'A template is documented when `reference/templates.md` names its path relative to `gsd-core/templates/`.',
    rows: inputs.templates
      .map((t) => rowFor(t, sectionsMentioning([templatesDoc], [t]), []))
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  surfaces.push({
    id: 'installer',
    title: 'Installer flags',
    source: 'the option list printed by `node bin/install.js --help`',
    rule: 'A flag is documented when `reference/installer-flags.md` names it.',
    rows: inputs.installerFlags
      .map((f) => rowFor(f, sectionsMentioning([installerDoc], [f]), []))
      .sort((a, b) => a.item.localeCompare(b.item)),
  });

  return surfaces;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function typeOf(file) {
  return DOC_TYPES[file] || 'unclassified';
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function renderRow(row) {
  const where = row.where ? `[${cell(row.where.file.replace(/^docs\//, ''))}#${row.where.anchor}](${relLink(row.where)})` : '—';
  const type = row.where ? typeOf(row.where.file) : '—';
  const opts = row.optionsTotal === 0 ? 'n/a' : `${row.optionsDocumented}/${row.optionsTotal}`;
  const status = row.status ? ` (${row.status})` : '';
  const missing = row.missing.length ? row.missing.map((m) => '`' + m + '`').join(', ') : '—';
  return `| \`${cell(row.item)}\` | ${where}${status} | ${type} | ${opts} | ${missing} |`;
}

function relLink(where) {
  const rel = path.posix.relative('docs/reference', where.file);
  return `${rel}#${where.anchor}`;
}

function summaryOf(surface) {
  const total = surface.rows.length;
  const documented = surface.rows.filter((r) => r.where).length;
  const complete = surface.rows.filter((r) => r.where && r.optionsDocumented === r.optionsTotal).length;
  return { total, documented, complete };
}

function renderMatrix(surfaces) {
  const out = [];
  out.push('<!-- GENERATED by scripts/gen-coverage-matrix.cjs — do not edit by hand. Regenerate with: node scripts/gen-coverage-matrix.cjs --write -->');
  out.push('');
  out.push('# Documentation coverage matrix');
  out.push('');
  out.push('Which shipped item is documented where, and whether each of its options is documented there. Every item list is read from the surface\'s own source, and every verdict is a mechanical check of the documentation text; the rule for each surface is stated under its heading. The page is generated, and CI fails when it is stale.');
  out.push('');
  out.push('In the tables, **Documented in** is the first documenting section, **Type** is the Diataxis type of that page, **Options** is documented options over declared options, and **Missing** lists the options with no mention in a documenting section.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Surface | Items | Documented | Fully documented | Missing items | Missing options |');
  out.push('|---------|------:|-----------:|-----------------:|--------------:|----------------:|');
  for (const s of surfaces) {
    const { total, documented, complete } = summaryOf(s);
    const missingOptions = s.rows.reduce((n, r) => n + (r.where ? r.missing.length : 0), 0);
    out.push(`| [${s.title}](#${githubAnchor(s.title)}) | ${total} | ${documented} | ${complete} | ${total - documented} | ${missingOptions} |`);
  }
  for (const s of surfaces) {
    out.push('');
    out.push(`## ${s.title}`);
    out.push('');
    out.push(`**Source:** ${s.source}.`);
    out.push('');
    out.push(`**Rule:** ${s.rule}`);
    out.push('');
    out.push('| Item | Documented in | Type | Options | Missing |');
    out.push('|------|---------------|------|--------:|---------|');
    for (const r of s.rows) out.push(renderRow(r));
  }
  out.push('');
  return out.join('\n');
}

// ─── Inputs from the repository ──────────────────────────────────────────────

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listFiles(rel, filter) {
  const dir = path.join(ROOT, rel);
  const out = [];
  (function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), p);
      else if (filter(p)) out.push(p);
    }
  })(dir, '');
  return out.sort();
}

function frontmatterField(text, field) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return '';
  const m = new RegExp('^' + field + ':\\s*(.*)$', 'm').exec(fm[1]);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

function installerFlagsFromHelp() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) throw new ExitError(1, `node bin/install.js --help exited with status ${r.status}`);
  const text = r.stdout.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
  const flags = new Set();
  for (const line of text.split('\n')) {
    if (!/^\s+(-[a-z]\b|--[a-z])/.test(line)) continue;
    // Only the option column counts: the description after the gap can name other flags ("Alias of --windsurf").
    for (const f of line.trim().split(/\s{2,}/)[0].match(FLAG_RE) || []) flags.add(f);
  }
  return [...flags];
}

function collectInputs() {
  // The config schema is TypeScript compiled into the gitignored `gsd-core/bin/lib`; build it on demand like the hooks do.
  const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');
  ensureRuntimeBuild();
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
  const manifest = JSON.parse(read('docs/CLI-SURFACE-MANIFEST.json'));
  return {
    commands: listFiles('commands/gsd', (f) => f.endsWith('.md') && !f.includes('/')).map((f) => {
      const text = read('commands/gsd/' + f);
      // The router commands (`ns-workflow.md`, ...) are invoked by their frontmatter name, not their file name.
      const name = frontmatterField(text, 'name').replace(/^gsd[:-]/, '');
      return { stem: name || f.slice(0, -3), argumentHint: frontmatterField(text, 'argument-hint') };
    }),
    verbs: manifest.verbs.map((v) => ({ verb: v.verb, aliases: v.aliases || [], flags: Object.keys(v.flags || {}) })),
    configKeys: [...VALID_CONFIG_KEYS],
    agents: listFiles('agents', (f) => /^gsd-[^/]*\.md$/.test(f) && !f.includes('.compact.')).map((f) => f.slice(0, -3)),
    hooks: listFiles('hooks', (f) => /^[^/]*\.(js|sh)$/.test(f)),
    templates: listFiles('gsd-core/templates', (f) => f !== 'README.md'),
    installerFlags: installerFlagsFromHelp(),
    docs: {
      commands: read('docs/COMMANDS.md'),
      cli: read('docs/CLI-TOOLS.md'),
      config: read('docs/CONFIGURATION.md'),
      agents: read('docs/reference/agents.md'),
      inventory: read('docs/INVENTORY.md'),
      templates: read('docs/reference/templates.md'),
      installer: read('docs/reference/installer-flags.md'),
    },
  };
}

function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function gaps(surfaces) {
  const out = [];
  for (const s of surfaces) {
    for (const r of s.rows) {
      if (!r.where) out.push(`${s.title}: ${r.item} is not documented`);
      else if (r.missing.length) out.push(`${s.title}: ${r.item} lacks ${r.missing.join(', ')}`);
    }
  }
  return out;
}

function main() {
  const flag = process.argv[2];
  const surfaces = buildModel(collectInputs());
  const content = renderMatrix(surfaces);
  const rel = path.relative(ROOT, OUT_PATH);

  if (flag === '--check') {
    let committed;
    try {
      committed = fs.readFileSync(OUT_PATH, 'utf8');
    } catch {
      throw new ExitError(1, `${rel} is missing. Run:\n  node scripts/gen-coverage-matrix.cjs --write`);
    }
    if (normalize(committed) !== normalize(content)) {
      throw new ExitError(1, `${rel} is stale. Run:\n  node scripts/gen-coverage-matrix.cjs --write`);
    }
    console.log(`${rel} is up to date.`);
    return;
  }
  if (flag === '--strict') {
    const found = gaps(surfaces);
    if (found.length) throw new ExitError(1, `${found.length} documentation gap(s):\n  ${found.join('\n  ')}`);
    console.log('No documentation gaps.');
    return;
  }
  if (flag === '--write') {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, content, 'utf8');
    console.log(`Wrote ${rel}`);
    return;
  }
  process.stdout.write(content);
}

if (require.main === module) runMain(main);

module.exports = { parseSections, githubAnchor, flagsOf, hasFlag, mentions, sectionsMentioning, buildModel, renderMatrix, gaps, DOC_TYPES };
