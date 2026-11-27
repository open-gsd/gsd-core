'use strict';

// Required-reading consistency (#2168, #3423): no agent file and no spawner surface (workflows, commands, references,
// templates, capabilities) uses the legacy <files_to_read> tag; every agent that carries a reading instruction uses
// required_reading (at least 20 do); the common-bug-patterns.md reference has its title, separator, categories and one
// bold bullet per pattern section, and gsd-debugger.md names it inside its <required_reading> block. Was
// tests/agent-required-reading-consistency.test.cjs (with the folded bug-patterns-reference cases). Every file is loaded
// through one handle (a file that is missing or empty is one finding), and a legacy tag is one finding per file.

const COMMON_BUG_PATTERNS = 'gsd-core/references/common-bug-patterns.md';
const DEBUGGER = 'agents/gsd-debugger.md';
const MIN_AGENTS_WITH_READING = 20;
const MIN_SPAWNER_FILES = 101; // the sweep must find more than 100 files
const SPAWNER_DIRS = ['gsd-core/workflows', 'commands', 'gsd-core/references', 'gsd-core/templates', 'capabilities'];
const EXPECTED_CATEGORIES = ['Off-by-One', 'Null', 'Async', 'State Management', 'Import', 'Environment', 'Data Shape', 'String Handling', 'File System', 'Error Handling'];
const MIN_CATEGORIES = 5;
const MIN_PATTERN_SECTIONS = 5;
const OPENING = '<files_to_read>';
const CLOSING = '</files_to_read>';

// The text of the first <patterns> ... </patterns> span as the test took it: what follows the first opening tag up to the
// next opening tag or the closing tag, whichever comes first.
const patternsBlock = (text) => (text.split('<patterns>')[1] || '').split('</patterns>')[0];

// The legacy tags a text carries: both, one, or none (an empty list).
const legacyTags = (text) => [OPENING, CLOSING].filter((tag) => text.includes(tag));

module.exports = {
  id: 'agent-required-reading-consistency',
  issue: '#2168',
  check(ctx) {
    // The shipped roster: gsd-*.md directly under agents/, without the .compact.md siblings.
    const agents = ctx.list('agents', '.md', 'the agent files are what the required_reading migration covers')
      .filter((rel) => rel.split('/').length === 2)
      .filter((rel) => rel.split('/')[1].startsWith('gsd-') && !rel.endsWith('.compact.md'));
    const handles = new Map();
    let withReading = 0;
    for (const rel of agents) {
      const agent = rel.split('/')[1].replace(/\.md$/, '');
      handles.set(rel, ctx.doc(rel)
        .satisfies((text) => {
          const tags = legacyTags(text);
          if (tags.length === 0) return true;
          return `${agent} still has the legacy ${tags.map((tag) => (tag === OPENING ? `${OPENING} opening tag` : `${CLOSING} closing tag`)).join(' and ')}: migrate to <required_reading>`;
        }, 'an agent must not carry the legacy <files_to_read> tags')
        .satisfies((text) => {
          if (!text.includes('required_reading') && !text.includes('files_to_read')) return true;
          withReading += 1;
          if (!text.includes('required_reading')) return `${agent} has reading instructions but does not use required_reading`;
          // A legacy tag is already reported above: the bare word is its own finding only when no tag carries it.
          return legacyTags(text).length > 0 || !text.includes('files_to_read') || `${agent} still uses files_to_read: it must be migrated to required_reading`;
        }, 'an agent with reading instructions must use required_reading and not files_to_read'));
    }
    if (withReading < MIN_AGENTS_WITH_READING) {
      ctx.fail('agents', `expected at least ${MIN_AGENTS_WITH_READING} agents with reading instructions, found ${withReading}`);
    }

    // Emit-side parity (#3423): the spawner surfaces must not emit the legacy tag either.
    let swept = 0;
    const spawner = new Map();
    for (const dir of SPAWNER_DIRS) {
      for (const rel of ctx.list(dir, '.md', 'the spawner surfaces are what emit a <required_reading> block to an agent')) {
        swept += 1;
        spawner.set(rel, ctx.doc(rel).satisfies((text) => {
          const tags = legacyTags(text);
          return tags.length === 0 || `${rel} still emits ${tags.join(' and ')}: migrate to <required_reading> (#3423)`;
        }, 'a spawner surface must not emit the legacy <files_to_read> tags'));
      }
    }
    if (swept < MIN_SPAWNER_FILES) ctx.fail('gsd-core', `expected a large spawner surface (more than 100 files), found ${swept}`);

    (spawner.get(COMMON_BUG_PATTERNS) || ctx.doc(COMMON_BUG_PATTERNS))
      .satisfies((text) => text.startsWith('# Common Bug Patterns'), 'the file must start with the "# Common Bug Patterns" title')
      .has('---', 'the file must contain a --- separator after the intro')
      .satisfies((text) => {
        const lower = text.toLowerCase();
        const found = EXPECTED_CATEGORIES.filter((category) => lower.includes(category.toLowerCase()));
        return found.length >= MIN_CATEGORIES || `expected at least ${MIN_CATEGORIES} categories, found ${found.length}: ${found.join(', ')}`;
      }, 'the reference must name at least 5 of the 10 expected bug categories')
      .satisfies((text) => {
        const sections = patternsBlock(text).split(/^## /m).slice(1);
        if (sections.length < MIN_PATTERN_SECTIONS) return `expected at least ${MIN_PATTERN_SECTIONS} pattern sections, got ${sections.length}`;
        const bare = sections.filter((section) => !/^- \*\*/m.test(section)).map((section) => section.split('\n')[0].trim());
        return bare.length === 0 || `pattern section(s) with no "- **" bullet item: ${bare.join('; ')}`;
      }, 'every pattern section inside <patterns> must have at least one bold bullet item');

    (handles.get(DEBUGGER) || ctx.doc(DEBUGGER))
      .has('common-bug-patterns.md', 'the debugger agent must reference common-bug-patterns.md')
      .slice('<required_reading>', '</required_reading>')
      .has('common-bug-patterns.md', 'common-bug-patterns.md must be inside the <required_reading> block');
  },
};
