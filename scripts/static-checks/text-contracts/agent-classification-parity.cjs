'use strict';

// Agent classification parity (#1171, #2526, #4407): docs/reference/agents.md section placement is the one source of truth for
// primary-versus-advanced classification. Every `### gsd-<name>` heading before "## Advanced and Specialized Agents" is
// primary, every one inside that section is an advanced stub, a shipped agent with no heading is inventory-only; the
// docs/INVENTORY.md "Primary doc" column agrees with that; the agents.md prose counts ("**N primary agents**", "N additional
// shipped agents") and the parenthetical slug list ("(a, b) have concise stubs") agree with the headings; every shipped
// agents/gsd-*.md is classified exactly once and has an INVENTORY row (and no row is a phantom); and each agent's
// `| **Tools** |` row in agents.md equals its `tools:` frontmatter verbatim (the #2526 drift class, one layer out; a section
// with a granted `tools:` and no row is a finding, so the row cannot vanish and take its assertion along). The parsers are the
// old test's, with every quantified regex written as a linear walk of the same language. Their differential properties are
// in tests/text-contracts.batch12.test.cjs. Was tests/agent-classification-parity.test.cjs.

const path = require('node:path');
const { loadLib } = require('./lib/load-lib.cjs');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');

const AGENTS_MD = 'docs/reference/agents.md';
const INVENTORY_MD = 'docs/INVENTORY.md';
const AGENTS_DIR = 'agents';
const FRONTMATTER_LIB = 'gsd-core/bin/lib/frontmatter.cjs';
const ADVANCED_TITLE = 'Advanced and Specialized Agents';
const CARDINALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };

const isBlank = (ch) => ch !== undefined && /\s/.test(ch);
const isWord = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
const allDigits = (token) => token !== '' && [...token].every(isDigit);
const skipBlanks = (text, at) => {
  let pos = at;
  while (isBlank(text[pos])) pos += 1;
  return pos;
};

// An h2 line: the walk of /^##(?!#)\s+\S/.
const isH2 = (line) => line.startsWith('##') && isBlank(line[2]) && line.slice(2).trim() !== '';

// The title of a heading of `hashes` hashes followed by whitespace, or null.
const headingTitle = (line, hashes) => (line.startsWith('#'.repeat(hashes)) && isBlank(line[hashes]) ? line.slice(hashes).trim() : null);

// The walk of /^##\s+Advanced and Specialized Agents\s*$/.
const isAdvancedSection = (line) => headingTitle(line, 2) === ADVANCED_TITLE;

// The agent slug of an `### gsd-<name>` heading, or null: the walk of /^###\s+(gsd-[\w-]+)\s*$/.
function agentHeading(line) {
  const title = headingTitle(line, 3);
  if (title === null || !title.startsWith('gsd-') || title.length === 'gsd-'.length) return null;
  return [...title.slice('gsd-'.length)].every((ch) => isWord(ch) || ch === '-') ? title : null;
}

// The agent headings of agents.md before and inside the Advanced section (a later h2 ends it; its headings are ignored).
function parseAgentsMd(raw) {
  const primaryHeadings = [];
  const advancedHeadings = [];
  let state = 'before';
  for (const line of raw.split('\n')) {
    if (isAdvancedSection(line)) {
      state = 'advanced';
      continue;
    }
    if (state === 'advanced' && isH2(line)) {
      state = 'past';
      continue;
    }
    const slug = agentHeading(line);
    if (slug === null) continue;
    if (state === 'before') primaryHeadings.push(slug);
    else if (state === 'advanced') advancedHeadings.push(slug);
  }
  return { primaryHeadings, advancedHeadings };
}

// The walk of /^##\s+Agents\b/.
function isAgentsSection(line) {
  if (!line.startsWith('##') || !isBlank(line[2])) return false;
  const rest = line.slice(2).trimStart();
  return rest.startsWith('Agents') && !isWord(rest['Agents'.length]);
}

const isSeparatorCell = (cell) => cell !== '' && [...cell].every((ch) => ch === '-' || ch === ':' || ch === ' ');

// The INVENTORY "## Agents" table as a Map of slug to "Primary doc" cell, or null when the table has no `Agent | ... | Primary
// doc` header row. Rows end with the next h2; `.compact` rows are variant siblings and are not roster entries (#4407).
function parseInventoryMd(raw) {
  const result = new Map();
  let inSection = false;
  let docColumn = -1;
  for (const line of raw.split('\n')) {
    if (isAgentsSection(line)) {
      inSection = true;
      docColumn = -1;
      continue;
    }
    if (inSection && isH2(line)) break;
    if (!inSection || !line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (docColumn === -1) {
      const at = cells.indexOf('Primary doc');
      if (at !== -1 && cells[0] === 'Agent') docColumn = at;
      continue;
    }
    if (cells.every(isSeparatorCell)) continue;
    if (!cells[0].startsWith('gsd-') || cells.length <= docColumn || cells[0].endsWith('.compact')) continue;
    result.set(cells[0], cells[docColumn]);
  }
  return docColumn === -1 ? null : result;
}

// The N of the first `**N primary agent(s)**`: the walk of /\*\*(\d+)\s+primary\s+agents?\*\*/.
function proseCount(text) {
  for (let at = text.indexOf('**'); at !== -1; at = text.indexOf('**', at + 1)) {
    let pos = at + 2;
    while (isDigit(text[pos])) pos += 1;
    if (pos === at + 2 || !isBlank(text[pos])) continue;
    const digits = text.slice(at + 2, pos);
    pos = skipBlanks(text, pos);
    if (!text.startsWith('primary', pos)) continue;
    pos += 'primary'.length;
    if (!isBlank(text[pos])) continue;
    pos = skipBlanks(text, pos);
    if (!text.startsWith('agent', pos)) continue;
    pos += 'agent'.length;
    if (text[pos] === 's') pos += 1;
    if (text.startsWith('**', pos)) return parseInt(digits, 10);
  }
  return null;
}

// The first `N additional shipped agent(s)` with N a number or a cardinal word up to thirteen, any case, whole words: the walk of
// /\b((?:\d+|one|...|thirteen))\s+additional\s+shipped\s+agents?\b/i. Returns { word, count } or null.
function proseAdvancedCount(text) {
  const lower = asciiLower(text);
  for (let at = lower.indexOf('additional'); at !== -1; at = lower.indexOf('additional', at + 1)) {
    let pos = at + 'additional'.length;
    if (!isBlank(lower[pos])) continue;
    pos = skipBlanks(lower, pos);
    if (!lower.startsWith('shipped', pos)) continue;
    pos += 'shipped'.length;
    if (!isBlank(lower[pos])) continue;
    pos = skipBlanks(lower, pos);
    if (!lower.startsWith('agent', pos)) continue;
    pos += 'agent'.length;
    if (lower[pos] === 's') pos += 1;
    if (isWord(lower[pos])) continue;
    let end = at;
    if (!isBlank(lower[end - 1])) continue;
    while (isBlank(lower[end - 1])) end -= 1;
    let start = end;
    while (isWord(lower[start - 1])) start -= 1;
    const word = lower.slice(start, end);
    if (allDigits(word)) return { word, count: parseInt(word, 10) };
    if (Object.hasOwn(CARDINALS, word)) return { word, count: CARDINALS[word] };
  }
  return null;
}

// The slugs of the first `(a, b, ...) have concise stubs`, trimmed and lower-cased, or null: the walk of
// /\(([^)]+)\)\s+have concise stubs/. The capture runs to the first `)` after the `(`; each such `)` is tested once.
function parentheticalSlugs(text) {
  let close = -1;
  let tested = -1;
  for (let at = text.indexOf('('); at !== -1; at = text.indexOf('(', at + 1)) {
    if (close < at) {
      close = text.indexOf(')', at + 1);
      if (close === -1) return null;
    }
    if (close === at + 1 || close === tested) continue;
    tested = close;
    const pos = close + 1;
    if (!isBlank(text[pos])) continue;
    if (text.startsWith('have concise stubs', skipBlanks(text, pos))) {
      return text.slice(at + 1, close).split(',').map((slug) => asciiLower(slug.trim()));
    }
  }
  return null;
}

// The value of an `| **Tools** | value |` row, or null: the walk of /^\|\s*\*\*Tools\*\*\s*\|\s*(.*?)\s*\|\s*$/ on one line. The row
// ends at its last `|`; the value is what lies between the Tools cell's pipe and that one, trimmed, with no line terminator.
function toolsRowValue(line) {
  if (!line.startsWith('|')) return null;
  let pos = skipBlanks(line, 1);
  if (!line.startsWith('**Tools**', pos)) return null;
  pos = skipBlanks(line, pos + '**Tools**'.length);
  if (line[pos] !== '|') return null;
  const last = line.trimEnd().length - 1;
  if (line[last] !== '|' || last <= pos) return null;
  const value = line.slice(pos + 1, last).trim();
  return [...value].some((ch) => LINE_ENDS.has(ch)) ? null : value;
}

// The `### gsd-*` sections of agents.md with their first `**Tools**` row, split on LF or CRLF: [{ slug, line, row }].
function toolsSections(raw) {
  const lines = raw.split(/\r?\n/);
  const sections = [];
  lines.forEach((line, i) => {
    const slug = agentHeading(line);
    if (slug !== null) sections.push({ slug, start: i });
  });
  return sections.map((section, i) => {
    const end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
    for (let at = section.start; at < end; at += 1) {
      const value = toolsRowValue(lines[at]);
      if (value !== null) return { slug: section.slug, row: { value, line: at + 1 } };
    }
    return { slug: section.slug, row: null };
  });
}

const without = (items, set) => items.filter((item) => !set.has(item));

// The shipped roster of a recursive listing of agents/: the flat `gsd-*.md` files except `.compact.md` variants, as slugs. The same
// roster as listAgentFiles of tests/helpers/agent-roster.cjs, which a shipped contract cannot require; a parity property pins them.
const rosterOf = (listed) => listed
  .filter((rel) => rel.split('/').length === 2)
  .map((rel) => path.basename(rel, '.md'))
  .filter((slug) => slug.startsWith('gsd-') && !slug.endsWith('.compact'));

module.exports = {
  // The linear walks, exported for the differential properties of tests/text-contracts.batch12.test.cjs.
  walkers: { rosterOf, parseAgentsMd, parseInventoryMd, proseCount, proseAdvancedCount, parentheticalSlugs, toolsRowValue, toolsSections, isH2, agentHeading, isAgentsSection },
  id: 'agent-classification-parity',
  issue: '#1171',
  check(ctx, load = () => require(path.join(__dirname, '..', '..', '..', FRONTMATTER_LIB))) {
    const agentsDoc = ctx.doc(AGENTS_MD);
    const inventoryDoc = ctx.doc(INVENTORY_MD);
    let agents = null;
    let inventory = null;

    // A missing primary or advanced section is the one finding of that cause: the checks that compare against it are skipped.
    agentsDoc
      .satisfies((text) => {
        const parsed = parseAgentsMd(text);
        if (parsed.primaryHeadings.length === 0) return 'no ### gsd-* headings before the Advanced section';
        agents = parsed;
        return true;
      }, `${AGENTS_MD} must list the primary agents as ### gsd-* headings before "## ${ADVANCED_TITLE}"`)
      .satisfies(() => {
        if (agents === null || agents.advancedHeadings.length > 0) return true;
        agents = null;
        return 'no ### gsd-* headings inside the Advanced section';
      }, `${AGENTS_MD} must list the advanced agents as ### gsd-* headings inside "## ${ADVANCED_TITLE}"`);
    inventoryDoc.satisfies((text) => {
      inventory = parseInventoryMd(text);
      if (inventory === null) return 'no "Primary doc" column header in the Agents table: check the ## Agents heading and the header row';
      return inventory.size > 0 || 'no | gsd-* | rows parsed';
    }, `${INVENTORY_MD} must carry the agents table with a Primary doc column`);

    const listed = ctx.list(AGENTS_DIR, '.md', 'agents/ must hold the shipped agent definitions');
    const files = rosterOf(listed);
    if (listed.length > 0 && files.length === 0) ctx.fail(AGENTS_DIR, 'no agents/gsd-*.md files found');
    const fileSet = new Set(files);

    // The prose of agents.md: the primary count, the additional count, the parenthetical list.
    if (agents !== null) {
      agentsDoc
        .satisfies((text) => {
          const stated = proseCount(text);
          if (stated === null) return 'no "**N primary agents**" in the prose';
          return stated === agents.primaryHeadings.length || `the prose says ${stated} primary agents; ${agents.primaryHeadings.length} ### gsd-* headings precede the Advanced section`;
        }, 'the agents.md prose count of primary agents must equal the primary headings')
        .satisfies((text) => {
          const stated = proseAdvancedCount(text);
          if (stated === null) return 'no "N additional shipped agents" in the prose';
          return stated.count === agents.advancedHeadings.length || `the prose says "${stated.word} additional shipped agents"; ${agents.advancedHeadings.length} ### gsd-* headings are in the Advanced section`;
        }, 'the agents.md prose count of additional shipped agents must equal the advanced headings')
        .satisfies((text) => {
          const slugs = parentheticalSlugs(text);
          if (slugs === null) return 'no "(slug, slug, ...) have concise stubs" in the prose';
          const stated = new Set(slugs);
          const expected = new Set(agents.advancedHeadings.map((heading) => heading.slice('gsd-'.length)));
          const missing = without([...expected], stated);
          const extra = without([...stated], expected);
          return (missing.length === 0 && extra.length === 0) || `missing from the prose: ${JSON.stringify(missing)}; extra in the prose: ${JSON.stringify(extra)}`;
        }, 'the agents.md parenthetical slug list must equal the advanced headings');
    }

    // Roster completeness: each shipped agent is classified once and has an inventory row.
    if (agents !== null && files.length > 0) {
      const primary = new Set(agents.primaryHeadings);
      const advanced = new Set(agents.advancedHeadings);
      const inventoryOnly = files.filter((slug) => !primary.has(slug) && !advanced.has(slug));
      agentsDoc
        .satisfies(() => {
          const overlap = agents.primaryHeadings.filter((slug) => advanced.has(slug));
          return overlap.length === 0 || `in both the primary and the advanced sections: ${JSON.stringify(overlap)}`;
        }, 'no agent may appear in both the primary and the advanced sections')
        .satisfies(() => {
          const total = agents.primaryHeadings.length + agents.advancedHeadings.length + inventoryOnly.length;
          return total === files.length || `primary(${agents.primaryHeadings.length}) + advanced(${agents.advancedHeadings.length}) + inventory-only(${inventoryOnly.length}) = ${total}, not the ${files.length} agent files`;
        }, 'the classification counts must add up to the shipped agent files');
      if (inventory !== null) {
        inventoryDoc
          .satisfies(() => {
            const mismatches = [];
            for (const [slug, value] of inventory) {
              let expected = null;
              if (primary.has(slug)) expected = 'primary';
              else if (advanced.has(slug)) expected = 'advanced stub';
              else if (fileSet.has(slug)) expected = 'inventory only';
              if (expected !== null && value !== expected) mismatches.push(`${slug}: INVENTORY says "${value}", agents.md placement says "${expected}"`);
            }
            return mismatches.length === 0 || mismatches.join('; ');
          }, 'the INVENTORY "Primary doc" column must match the agents.md section placement')
          .satisfies(() => {
            const missing = files.filter((slug) => !inventory.has(slug));
            return missing.length === 0 || `shipped agents with no INVENTORY row: ${JSON.stringify(missing)}`;
          }, 'every shipped agent must have an INVENTORY row')
          .satisfies(() => {
            const phantom = [...inventory.keys()].filter((slug) => !fileSet.has(slug));
            return phantom.length === 0 || `INVENTORY rows with no agents/gsd-*.md file: ${JSON.stringify(phantom)}`;
          }, 'no INVENTORY row may name an agent that is not shipped');
      }
    }

    // The **Tools** rows equal the tools: frontmatter verbatim (#2526).
    const loaded = loadLib(load, FRONTMATTER_LIB);
    if (loaded.error) {
      ctx.fail(FRONTMATTER_LIB, loaded.error);
      return;
    }
    // One document per agent file, however many headings name it.
    const agentDocs = new Map();
    const agentDoc = (slug) => {
      if (!agentDocs.has(slug)) agentDocs.set(slug, ctx.doc(`${AGENTS_DIR}/${slug}.md`));
      return agentDocs.get(slug);
    };
    let sections = null;
    agentsDoc.satisfies((text) => {
      sections = toolsSections(text);
      return true;
    }, 'agents.md must be readable');
    for (const section of sections || []) {
      if (!fileSet.has(section.slug)) continue; // a heading with no file is the roster check's finding
      agentDoc(section.slug).satisfies((text) => {
        let fm;
        try {
          fm = loaded.lib.parseFrontmatter(text) || {};
        } catch (err) {
          return `the frontmatter cannot be parsed: ${err.message}`;
        }
        if (fm.tools === undefined || fm.tools === null) return true; // no tools: key means every tool: nothing to agree with
        const declared = Array.isArray(fm.tools) ? fm.tools.join(', ') : String(fm.tools);
        if (section.row === null) return 'its agents.md section has no "| **Tools** |" row, so its parity assertion would vanish';
        return section.row.value === declared || `${AGENTS_MD}:${section.row.line} says "${section.row.value}", the frontmatter says "${declared}"`;
      }, `${section.slug}: the agents.md **Tools** row must equal the tools: frontmatter verbatim: copy the line (#2526)`);
    }
  },
};
