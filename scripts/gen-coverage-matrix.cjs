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
const SEPARATOR_ROW_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Deterministic, locale-free ordering (UTF-16 code units): the page must not depend on the machine's ICU data. */
function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split Markdown into sections. A `#` line inside a fenced code block is not a heading. Each section is
 * `{ level, title, line, end, own, text }`: `line` is the heading's 1-based line, `end` the 0-based index of the
 * first line after the section (the next heading of the same or a higher level), `own` the lines up to the next
 * heading of ANY level (the section's own prose, tables and code, without its subsections), and `text` every line
 * up to `end` (own text plus subsections).
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
    const ownEnd = n + 1 < heads.length ? heads[n + 1].index : lines.length;
    return {
      level: h.level,
      title: h.title,
      line: h.index + 1,
      end,
      own: lines.slice(h.index + 1, ownEnd).join('\n'),
      text: lines.slice(h.index + 1, end).join('\n'),
    };
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

/** True when `flag` occurs in `text` as a whole token: nothing identifier-like on either side (`--ws` is not in `--wsx`, `--ws_x` or `a---ws`). */
function hasFlag(text, flag) {
  return new RegExp('(?<![A-Za-z0-9-])' + escapeRe(flag) + '(?![A-Za-z0-9_-])').test(text);
}

/** True when `name` occurs in `text` as a whole token: not inside a longer identifier or path, and not as the stem of a file name (`/gsd-x.md`). */
function mentions(text, name) {
  return new RegExp('(?<![A-Za-z0-9._/-])' + escapeRe(name) + '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])').test(text);
}

/**
 * True when `text` has a line that invokes the verb (`gsd-tools [query] <name>`, `node gsd-tools.cjs [query] <name>`,
 * `gsd_run query <name>`) or a table row keyed by it (first cell a code span that starts with the verb name).
 */
function invokes(text, name) {
  const lead = '^\\s*(?:\\$\\s+)?(?:node\\s+\\S*gsd-tools(?:\\.cjs)?|gsd-tools(?:\\.cjs)?|gsd_run)\\s+(?:query\\s+)?';
  const usage = new RegExp(lead + escapeRe(name) + '(?![A-Za-z0-9_-])', 'm');
  const row = new RegExp('^\\s*\\|\\s*`(?:gsd-tools\\s+)?' + escapeRe(name) + '(?=[\\s`])', 'm');
  return usage.test(text) || row.test(text);
}

/**
 * The sections that document one of `names`. A section counts when its heading names one (`how: 'heading'`), or
 * when its heading or its own text does (`how: 'mention'`, the default), or when its own text invokes one
 * (`how: 'invoke'`: a heading or a usage line). Only a section's OWN text is searched, so a name mentioned under
 * a subsection belongs to that subsection and never to the page's top heading. `docs` is `[{ file, sections }]`.
 */
function sectionsDocumenting(docs, names, how = 'mention') {
  const out = [];
  for (const doc of docs) {
    for (const s of doc.sections) {
      const inTitle = names.some((n) => mentions(s.title, n));
      const hit = how === 'heading'
        ? inTitle
        : how === 'invoke'
          ? inTitle || names.some((n) => invokes(s.own, n))
          : inTitle || names.some((n) => mentions(s.own, n));
      if (hit) out.push({ file: doc.file, section: s });
    }
  }
  return out;
}

function locationOf(hit) {
  return { file: hit.file, anchor: githubAnchor(hit.section.title), title: hit.section.title };
}

/** An option counts as documented when it appears in the full text (own text plus subsections) of a documenting section. */
function rowFor(item, hits, options) {
  const documented = hits.length > 0;
  const missing = documented
    ? options.filter((o) => !hits.some((h) => hasFlag(h.section.title + '\n' + h.section.text, o)))
    : options.slice();
  return {
    item,
    where: documented ? locationOf(hits[0]) : null,
    optionsTotal: options.length,
    optionsDocumented: options.length - missing.length,
    missing,
  };
}

function cellsOf(line) {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

/**
 * Table rows of Markdown outside code fences, each with its header-named cells: `[{ line, cells, byHeader }]`
 * where `line` is the 0-based line and `byHeader` maps a lower-cased header cell to that row's cell. A row belongs
 * to the nearest header row above it in the same unbroken run of `|` lines.
 */
function tableRows(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const rows = [];
  let fence = null;
  let header = null;
  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
      header = null;
      return;
    }
    if (fence !== null) return;
    if (!/^\s*\|/.test(line)) { header = null; return; }
    if (SEPARATOR_ROW_RE.test(line)) return;
    const cells = cellsOf(line);
    const next = lines[i + 1];
    if (header === null && next !== undefined && SEPARATOR_ROW_RE.test(next)) {
      header = cells.map((c) => c.toLowerCase());
      return;
    }
    const byHeader = {};
    if (header !== null) header.forEach((h, k) => { byHeader[h] = cells[k] ?? ''; });
    rows.push({ line: i, cells, byHeader });
  });
  return rows;
}

/** The deepest section whose range contains the 0-based line, or null. */
function sectionAt(sections, lineIndex) {
  let best = null;
  for (const s of sections) {
    if (s.line - 1 < lineIndex && lineIndex < s.end && (best === null || s.level >= best.level)) best = s;
  }
  return best;
}

function unquote(cell) {
  const m = /^`([^`]+)`$/.exec(cell.trim());
  return m ? m[1] : cell.trim();
}

/** The cell under the first header whose name is one of `names`, or null when the table has no such column. */
function column(row, names) {
  for (const n of names) if (Object.prototype.hasOwnProperty.call(row.byHeader, n)) return row.byHeader[n];
  return null;
}

function filled(value) {
  return value !== null && value.trim() !== '';
}

/** Flags printed in the option column of `node bin/install.js --help` (the text before the first run of two spaces). */
function parseHelpFlags(helpText) {
  const flags = new Set();
  for (const line of String(helpText).split('\n')) {
    if (!/^\s+(-[a-z]\b|--[a-z])/.test(line)) continue;
    for (const f of line.trim().split(/\s{2,}/)[0].match(FLAG_RE) || []) flags.add(f);
  }
  return [...flags];
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
  const inventoryDoc = sec('docs/INVENTORY.md', d.inventory);
  const configRows = tableRows(d.config);
  const inventoryRows = tableRows(d.inventory);

  const surfaces = [];

  surfaces.push({
    id: 'commands',
    title: 'Slash commands',
    source: '`commands/gsd/*.md` (command name and `argument-hint` flags)',
    rule: 'A command is documented when a `COMMANDS.md` section headed by `/gsd-<command>` exists (a command with no section of its own, such as a namespace router, counts through a section whose own text names it); each `--flag` of its `argument-hint` must appear in that section or its subsections.',
    rows: inputs.commands
      .map((c) => {
        const name = '/gsd-' + c.stem;
        const headed = sectionsDocumenting([commandsDoc], [name], 'heading');
        return rowFor(name, headed.length ? headed : sectionsDocumenting([commandsDoc], [name]), flagsOf(c.argumentHint));
      })
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'verbs',
    title: '`gsd-tools` verbs',
    source: '`docs/CLI-SURFACE-MANIFEST.json` (verb, aliases and declared flags)',
    rule: 'A verb is documented when a section of `CLI-TOOLS.md` or `COMMANDS.md` is headed by its name (dotted verbs also as `a b`, or an alias) or has a usage line that invokes it (`gsd-tools [query] <verb>`, `node gsd-tools.cjs [query] <verb>`, `gsd_run query <verb>`) or a table row keyed by it; a mention in prose does not count. Each declared flag must appear in that section or its subsections.',
    rows: inputs.verbs
      .map((v) => {
        const names = [...new Set([v.verb, v.verb.replace(/\./g, ' '), ...(v.aliases || [])])];
        return rowFor(v.verb, sectionsDocumenting(cliDocs, names, 'invoke'), v.flags.map((f) => '--' + f));
      })
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'config',
    title: 'Config keys',
    source: '`VALID_CONFIG_KEYS` in `src/config-schema.cts`',
    rule: 'A key is documented when `CONFIGURATION.md` has a table row whose first cell is the key. The row\'s own table must have a non-empty Type (or Options), Default and Description cell, read by column header; a table without such a column leaves that option missing. A key mentioned only in prose is listed as `prose`.',
    rows: inputs.configKeys
      .map((k) => {
        const row = configRows.find((r) => r.cells.length > 0 && unquote(r.cells[0]) === k);
        if (row) {
          const missing = [];
          if (!filled(column(row, ['type', 'options']))) missing.push('type');
          if (!filled(column(row, ['default']))) missing.push('default');
          if (!filled(column(row, ['description', 'effect']))) missing.push('effect');
          const where = sectionAt(configDoc.sections, row.line);
          return {
            item: k,
            where: where ? locationOf({ file: configDoc.file, section: where }) : { file: configDoc.file, anchor: '', title: '' },
            optionsTotal: 3,
            optionsDocumented: 3 - missing.length,
            missing,
            status: 'table',
          };
        }
        const hits = sectionsDocumenting([configDoc], [k]);
        if (hits.length === 0) return { item: k, where: null, optionsTotal: 3, optionsDocumented: 0, missing: ['type', 'default', 'effect'], status: 'none' };
        return { item: k, where: locationOf(hits[0]), optionsTotal: 3, optionsDocumented: 0, missing: ['type', 'default', 'effect'], status: 'prose' };
      })
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'agents',
    title: 'Agents',
    source: '`agents/gsd-*.md` (non-compact)',
    rule: 'An agent is documented when `reference/agents.md` has a section whose heading names it.',
    rows: inputs.agents
      .map((a) => rowFor(a, sectionsDocumenting([agentsDoc], [a], 'heading'), []))
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'hooks',
    title: 'Hooks',
    source: '`hooks/*.js`, `hooks/*.cjs` and `hooks/*.sh`',
    rule: 'A hook is documented when the table under the `Hooks` heading of `INVENTORY.md` has a row whose first cell is the file name and whose Event cell is not empty.',
    rows: inputs.hooks
      .map((h) => {
        const hooksSection = inventoryDoc.sections.find((s) => s.level === 2 && s.title === 'Hooks');
        const row = hooksSection
          ? inventoryRows.find((r) => r.line >= hooksSection.line && r.line < hooksSection.end && r.cells.length > 0 && unquote(r.cells[0]) === h)
          : undefined;
        if (!row) return { item: h, where: null, optionsTotal: 1, optionsDocumented: 0, missing: ['event'] };
        const hasEvent = filled(column(row, ['event']));
        const where = sectionAt(inventoryDoc.sections, row.line);
        return {
          item: h,
          where: locationOf({ file: inventoryDoc.file, section: where || hooksSection }),
          optionsTotal: 1,
          optionsDocumented: hasEvent ? 1 : 0,
          missing: hasEvent ? [] : ['event'],
        };
      })
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'templates',
    title: 'Templates',
    source: '`gsd-core/templates/**` (the registry `README.md` excluded)',
    rule: 'A template is documented when `reference/templates.md` names its path, either relative to `gsd-core/templates/` or in full.',
    rows: inputs.templates
      .map((t) => rowFor(t, sectionsDocumenting([templatesDoc], [t, 'gsd-core/templates/' + t]), []))
      .sort((a, b) => byName(a.item, b.item)),
  });

  surfaces.push({
    id: 'installer',
    title: 'Installer flags',
    source: 'the option list printed by `node bin/install.js --help`, plus every flag `bin/install.js` tests with `args.includes`',
    rule: 'A flag is documented when `reference/installer-flags.md` names it.',
    rows: inputs.installerFlags
      .map((f) => rowFor(f, sectionsDocumenting([installerDoc], [f]), []))
      .sort((a, b) => byName(a.item, b.item)),
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

/** One frontmatter field of a Markdown file, read with the repo's own parser (`src/frontmatter.cts`), never a hand-rolled fence. */
function frontmatterField(text, field) {
  const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
  const value = extractFrontmatter(text)[field];
  return typeof value === 'string' ? value : '';
}

/** `{ ok: true, flags }` from `node bin/install.js --help` plus every `args.includes('--flag')` in the installer, or `{ ok: false, error }`. */
function installerFlags() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exited with status ${r.status}: ${String(r.stderr).trim().slice(0, 300)}`;
    return { ok: false, error: `node bin/install.js --help ${why}` };
  }
  const helpText = r.stdout.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
  const tested = [...read('bin/install.js').matchAll(/args\.includes\('(--[a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]);
  return { ok: true, flags: [...new Set([...parseHelpFlags(helpText), ...tested])] };
}

function collectInputs() {
  // The config schema is TypeScript compiled into the gitignored `gsd-core/bin/lib`; build it on demand like the hooks do.
  const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');
  ensureRuntimeBuild();
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
  const manifest = JSON.parse(read('docs/CLI-SURFACE-MANIFEST.json'));
  const flags = installerFlags();
  if (!flags.ok) throw new ExitError(1, flags.error);
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
    hooks: listFiles('hooks', (f) => /^[^/]*\.(js|cjs|sh)$/.test(f)),
    templates: listFiles('gsd-core/templates', (f) => f !== 'README.md'),
    installerFlags: flags.flags,
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

module.exports = { parseSections, githubAnchor, flagsOf, hasFlag, mentions, invokes, sectionsDocumenting, tableRows, parseHelpFlags, byName, buildModel, renderMatrix, gaps, DOC_TYPES };
