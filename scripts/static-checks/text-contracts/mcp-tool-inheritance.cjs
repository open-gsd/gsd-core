'use strict';

// MCP tool grants of the GSD agents (#657, #1284, #2526): the executor and planner mention MCP tools (the executor names
// them); every researcher (project, phase, ui) declares the six research servers on its `tools:` frontmatter line; every
// MCP provider in the phase and project researchers' Step-C dispatch table is granted there; and no agent documents an
// `mcp__<server>__` namespace its `tools:` allowlist withholds (server-level, from the body and the description, with the
// frontmatter read through the canonical parser). Dropped as implied: the exa/tavily and firecrawl/jina parity checks and
// the repeated `mcp__ref__*` check (the required list demands all six tools), and the `MCP tool` alternative (it contains
// `mcp`). The old patterns with a dot, a lazy or a plain `+` are linear walks with the same stops. Was tests/mcp-tool-inheritance.test.cjs.
// The bare-name side (#6455): an agent that calls its tools as `mempalace_<tool>(` hides them from `referencedServers` (it
// reads literal `mcp__<server>__` namespaces), so a second rule pins that a body naming such calls grants MemPalace.

const path = require('node:path');
const { loadLib } = require('./lib/load-lib.cjs');
const { asciiLower } = require('./lib/ascii-lower.cjs');
const { LINE_ENDS } = require('./lib/line-ends.cjs');

const AGENTS_DIR = 'agents';
const FRONTMATTER_LIB = 'gsd-core/bin/lib/frontmatter.cjs';
const EXECUTOR = 'agents/gsd-executor.md';
const GUIDANCE_AGENTS = [EXECUTOR, 'agents/gsd-planner.md'];
const RESEARCHERS = ['agents/gsd-project-researcher.md', 'agents/gsd-phase-researcher.md', 'agents/gsd-ui-researcher.md'];
const STEP_C_RESEARCHERS = ['agents/gsd-phase-researcher.md', 'agents/gsd-project-researcher.md'];
const REQUIRED_TOOLS = ['mcp__context7__*', 'mcp__exa__*', 'mcp__firecrawl__*', 'mcp__tavily__*', 'mcp__ref__*', 'mcp__jina__*'];
const MIN_AGENTS = 20;
const GRANT_ALL = '*';
const MEMPALACE_SERVER = 'mempalace';

const isBlank = (ch) => ch !== undefined && /\s/.test(ch);
const isAlnum = (ch) => ch !== undefined && /[a-z0-9]/.test(ch);
const isIdChar = (ch) => ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
const isLowerIdChar = (ch) => ch !== undefined && /[a-z_]/.test(ch);
const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

// The `tools:` line of a document: the walk of /^tools:\s*(.+)$/m. After `tools:` the pattern's `\s*` may cross lines, and
// the `.+` then takes the rest of the line it lands on; at the end of the text the `\s*` gives back whitespace that is not a
// line end. Returns the captured text, or null.
function toolsLine(text) {
  for (let at = 0; at < text.length; at += 1) {
    if (!(at === 0 || LINE_ENDS.has(text[at - 1])) || !text.startsWith('tools:', at)) continue;
    const from = at + 'tools:'.length;
    let start = from;
    while (isBlank(text[start])) start += 1;
    if (start >= text.length) {
      start = text.length - 1;
      while (start >= from && LINE_ENDS.has(text[start])) start -= 1;
      if (start < from) continue;
    }
    let end = start;
    while (end < text.length && !LINE_ENDS.has(text[end])) end += 1;
    return text.slice(start, end);
  }
  return null;
}

// The MCP server ids named `mcp__<id>__` (ASCII letters and digits, any case), lower-cased: the walk of /mcp__([a-z0-9]+)__/gi.
function mcpServersIn(text) {
  const lower = asciiLower(text);
  const servers = new Set();
  let from = 0;
  for (let at = lower.indexOf('mcp__', from); at !== -1; at = lower.indexOf('mcp__', from)) {
    let end = at + 'mcp__'.length;
    while (isAlnum(lower[end])) end += 1;
    if (end > at + 'mcp__'.length && lower.startsWith('__', end)) {
      servers.add(lower.slice(at + 'mcp__'.length, end));
      from = end + 2;
    } else {
      from = at + 1;
    }
  }
  return servers;
}

// The dispatch-table rows of a researcher's "### Step C" section, or null when there is no such section.
function stepCTableRows(content) {
  const start = content.indexOf('### Step C');
  if (start === -1) return null;
  const rest = content.slice(start + 1);
  const nextHeading = rest.indexOf('\n### ');
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.split('\n').filter((line) => line.trimStart().startsWith('|')).join('\n');
}

// Server ids a body references as tool namespaces: the walk of /mcp__([A-Za-z0-9_-]+?)__/g. A one-character id is a prose
// metavariable and not a reference.
function referencedServers(body) {
  const servers = new Set();
  let from = 0;
  for (let at = body.indexOf('mcp__', from); at !== -1; at = body.indexOf('mcp__', from)) {
    const start = at + 'mcp__'.length;
    let length = 1;
    let found = -1;
    while (isIdChar(body[start + length - 1])) {
      if (body.startsWith('__', start + length)) {
        found = length;
        break;
      }
      length += 1;
    }
    if (found === -1) {
      from = at + 1;
      continue;
    }
    from = start + found + 2;
    if (found > 1) servers.add(asciiLower(body.slice(start, start + found)));
  }
  return servers;
}

// A scalar without its inline comment: the walk of .replace(/\s+#.*$/, ''). The comment starts at the first whitespace run
// followed by `#` whose rest holds no line end (the dot stops there).
function stripInlineComment(value) {
  const text = String(value);
  let lastLineEnd = -1;
  for (let at = 0; at < text.length; at += 1) if (LINE_ENDS.has(text[at])) lastLineEnd = at;
  for (let at = 0; at < text.length; at += 1) {
    if (!isBlank(text[at])) continue;
    let end = at;
    while (isBlank(text[end])) end += 1;
    // The `#` is at `end`; the rest after it must hold no line end.
    if (text[end] === '#' && lastLineEnd <= end) return text.slice(0, at);
    at = end;
  }
  return text;
}

// `tools:` as a token list (split on commas and whitespace); null means no `tools:` key at all (inherits everything).
function toolTokens(tools) {
  if (tools === undefined || tools === null) return null;
  const items = Array.isArray(tools) ? tools : [tools];
  const tokens = [];
  for (const item of items) {
    let current = '';
    for (const ch of stripInlineComment(item)) {
      if (ch === ',' || isBlank(ch)) {
        if (current !== '') tokens.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current !== '') tokens.push(current);
  }
  return tokens;
}

// Server ids granted by any accepted grant spelling; GRANT_ALL means every server.
function grantedServers(tokens) {
  const servers = new Set();
  for (const token of tokens) {
    if (!token.startsWith('mcp__')) continue;
    let rest = token.slice('mcp__'.length);
    // A bare `mcp__*` is a wildcard over every server; a bare `mcp__` (no star) is a typo and grants nothing.
    if (rest !== '' && [...rest].every((ch) => ch === '*')) {
      servers.add(GRANT_ALL);
      continue;
    }
    while (rest.endsWith('*')) rest = rest.slice(0, -1);
    const server = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
    if (server) servers.add(asciiLower(server));
  }
  return servers;
}

// The MCP servers an agent documents but does not grant, or null when its `tools:` key is absent. `lib` is the canonical
// frontmatter parser; the scanned surface is the body plus the frontmatter description, never `tools:` itself.
function ungrantedServers(content, lib) {
  const fm = lib.parseFrontmatter(content) || {};
  const tokens = toolTokens(fm.tools);
  if (tokens === null) return { tokens: null, granted: new Set(), ungranted: [] };
  const granted = grantedServers(tokens);
  if (granted.has(GRANT_ALL)) return { tokens, granted, ungranted: [] };
  const documented = `${String(fm.description ?? '')}\n${lib.stripFrontmatter(content)}`;
  return { tokens, granted, ungranted: [...referencedServers(documented)].filter((server) => !granted.has(server)).sort() };
}

// The tool names a body calls bare as `mempalace_<name>(`: the walk of /\bmempalace_([a-z_]+)\s*\(/g. The word boundary
// means a longer identifier (xmempalace_foo() is not a call); the run needs one character, so a bare `mempalace_(` is not
// one either; what precedes `(` is the pattern's `\s*`. An underscore-spelled config word in parentheses (e.g.
// `mempalace_enabled(true)`) counts as a call: accepted, none exists in the shipped agents (real keys are dotted,
// `mempalace.enabled`) and the failure message names the remedy (#6455 review note).
function bareMempalaceCalls(text) {
  const names = new Set();
  for (let at = text.indexOf('mempalace_'); at !== -1; at = text.indexOf('mempalace_', at + 1)) {
    if (at > 0 && isWordChar(text[at - 1])) continue;
    let end = at + 'mempalace_'.length;
    while (isLowerIdChar(text[end])) end += 1;
    if (end === at + 'mempalace_'.length) continue;
    let gap = end;
    while (isBlank(text[gap])) gap += 1;
    if (text[gap] === '(') names.add(text.slice(at + 'mempalace_'.length, end));
  }
  return [...names].sort();
}

// The bare MemPalace calls an agent makes while its `tools:` allowlist withholds the grant; [] when the grant is present
// or the `tools:` key is absent (inherits everything). `lib` is the canonical frontmatter parser; the scanned surface is
// the body plus the frontmatter description, never `tools:` itself — the bare-name side of #2526 (#6455).
function ungrantedMempalaceCalls(content, lib) {
  const fm = lib.parseFrontmatter(content) || {};
  const tokens = toolTokens(fm.tools);
  if (tokens === null) return [];
  const granted = grantedServers(tokens);
  if (granted.has(GRANT_ALL) || granted.has(MEMPALACE_SERVER)) return [];
  return bareMempalaceCalls(`${String(fm.description ?? '')}\n${lib.stripFrontmatter(content)}`);
}

const mentionsMcp = (text) => asciiLower(text).includes('mcp') || text.includes('context7') || text.includes('available tools');
const namesMcpTools = (text) => text.includes('MCP') || text.includes('mcp__');

module.exports = {
  // The linear walks, exported for the differential properties of tests/text-contracts.batch12.test.cjs and the #6455 rule rows of tests/6455-mempalace-curator-grant.test.cjs.
  walkers: { toolsLine, mcpServersIn, stepCTableRows, referencedServers, stripInlineComment, toolTokens, grantedServers, ungrantedServers, bareMempalaceCalls, ungrantedMempalaceCalls, mentionsMcp, namesMcpTools },
  id: 'mcp-tool-inheritance',
  issue: '#2526',
  check(ctx, load = () => require(path.join(__dirname, '..', '..', '..', FRONTMATTER_LIB))) {
    // One document per path, however many assertions read it.
    const docs = new Map();
    const docOf = (rel) => {
      if (!docs.has(rel)) docs.set(rel, ctx.doc(rel));
      return docs.get(rel);
    };

    for (const rel of GUIDANCE_AGENTS) docOf(rel).satisfies(mentionsMcp, `${path.basename(rel)} should mention MCP tool availability/usage`);
    // Naming MCP tools implies mentioning MCP, so a failed mention is the one finding of the executor's guidance.
    docOf(EXECUTOR).satisfies((text) => namesMcpTools(text) || !mentionsMcp(text), 'gsd-executor.md should reference MCP tools (MCP or mcp__)');

    // The tools: line of each researcher, read once from its frontmatter (a `tools:` line in the body is not a grant); a missing line is one finding and skips what depends on it.
    const tools = new Map();
    for (const rel of new Set([...RESEARCHERS, ...STEP_C_RESEARCHERS])) {
      docOf(rel).frontmatter().satisfies((text) => {
        const line = toolsLine(text);
        if (line === null) return 'no such line';
        tools.set(rel, line);
        return true;
      }, `${path.basename(rel)} must have a tools: frontmatter line`);
    }
    for (const rel of RESEARCHERS) {
      if (!tools.has(rel)) continue;
      const missing = REQUIRED_TOOLS.filter((tool) => !tools.get(rel).includes(tool));
      docOf(rel).satisfies(() => missing.length === 0 || `missing ${missing.join(', ')}`,
        `${path.basename(rel)} tools: line must declare the research MCP servers (#657)`);
    }

    // Step-C dispatch table <-> tools: grant parity (#1284).
    for (const rel of STEP_C_RESEARCHERS) {
      if (!tools.has(rel)) continue;
      docOf(rel).satisfies((text) => {
        const rows = stepCTableRows(text);
        if (rows === null) return 'no "### Step C" section';
        const referenced = mcpServersIn(rows);
        if (referenced.size === 0) return 'the table references no mcp__ provider';
        const granted = mcpServersIn(tools.get(rel));
        const missing = [...referenced].filter((server) => !granted.has(server));
        return missing.length === 0 || `not granted in tools: frontmatter: ${missing.join(', ')}`;
      }, `${path.basename(rel)}: every MCP provider in its Step-C dispatch table must be granted as mcp__<server>__* (add it to the profile in scripts/research-profiles.cjs)`);
    }

    // No agent documents an MCP namespace its tools: allowlist withholds (#2526).
    const listed = ctx.list(AGENTS_DIR, '.md', 'agents/ must hold the agent definitions');
    const files = listed.filter((rel) => rel.split('/').length === 2);
    if (listed.length > 0 && files.length < MIN_AGENTS) {
      ctx.fail(AGENTS_DIR, `expected agents/ to hold the agent definitions, found ${files.length} (at least ${MIN_AGENTS})`);
    }
    const loaded = loadLib(load, FRONTMATTER_LIB);
    if (loaded.error) {
      ctx.fail(FRONTMATTER_LIB, loaded.error);
      return;
    }
    let analyzed = 0;
    let anyGrant = false;
    for (const rel of files) {
      docOf(rel).satisfies((text) => {
        let result;
        try {
          result = ungrantedServers(text, loaded.lib);
        } catch (err) {
          return `the frontmatter cannot be parsed: ${err.message}`;
        }
        analyzed += 1;
        if (result.tokens !== null && result.granted.size > 0) anyGrant = true;
        return result.ungranted.length === 0 || `documents mcp__${result.ungranted.join('__*, mcp__')}__* but its tools: allowlist grants none of them`;
      }, `${path.basename(rel)}: those calls can never dispatch, so the instruction is dead (#2526): grant the namespace, drop the block, or spell a placeholder mcp__<SERVER>__*`);
      // No agent calls bare `mempalace_*` tools its tools: allowlist withholds (#6455, the bare-name side of #2526).
      docOf(rel).satisfies((text) => {
        let calls;
        try {
          calls = ungrantedMempalaceCalls(text, loaded.lib);
        } catch {
          // The #2526 arm above already reports this file; a second copy would double its findings.
          return true;
        }
        return calls.length === 0 || `calls ${calls.map((name) => `mempalace_${name}()`).join(', ')}`;
      }, `${path.basename(rel)}: those calls can never dispatch, so the instruction is dead (#6455): grant mcp__mempalace__* or mcp__* in tools:, or drop the calls`);
    }
    if (analyzed > 0 && !anyGrant) ctx.fail(AGENTS_DIR, 'no agent grants any mcp__ namespace: the grant parser is not matching');
  },
};
