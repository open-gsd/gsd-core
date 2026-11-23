'use strict';

// Required-reading consistency (#2168, #3423): no agent file and no spawner surface (workflows, commands, references,
// templates, capabilities) uses the legacy <files_to_read> tag; every agent that carries a reading instruction uses
// required_reading (at least 20 do); the common-bug-patterns.md reference has its title, separator, categories and one
// bold bullet per pattern section, and gsd-debugger.md names it inside its <required_reading> block. Was
// tests/agent-required-reading-consistency.test.cjs (with the folded bug-patterns-reference cases).

const COMMON_BUG_PATTERNS = 'gsd-core/references/common-bug-patterns.md';
const DEBUGGER = 'agents/gsd-debugger.md';
const MIN_AGENTS_WITH_READING = 20;
const MIN_SPAWNER_FILES = 101; // the sweep must find more than 100 files
const SPAWNER_DIRS = ['gsd-core/workflows', 'commands', 'gsd-core/references', 'gsd-core/templates', 'capabilities'];
const EXPECTED_CATEGORIES = ['Off-by-One', 'Null', 'Async', 'State Management', 'Import', 'Environment', 'Data Shape', 'String Handling', 'File System', 'Error Handling'];
const MIN_CATEGORIES = 5;
const MIN_PATTERN_SECTIONS = 5;

// The text of the first <patterns> ... </patterns> span as the test took it: what follows the first opening tag up to the
// next opening tag or the closing tag, whichever comes first.
const patternsBlock = (text) => (text.split('<patterns>')[1] || '').split('</patterns>')[0];

module.exports = {
  id: 'agent-required-reading-consistency',
  issue: '#2168',
  check(ctx) {
    // The shipped roster: gsd-*.md directly under agents/, without the .compact.md siblings.
    const agents = ctx.list('agents', '.md', 'the agent files are what the required_reading migration covers')
      .filter((rel) => rel.split('/').length === 2)
      .filter((rel) => rel.split('/')[1].startsWith('gsd-') && !rel.endsWith('.compact.md'));
    let withReading = 0;
    for (const rel of agents) {
      const agent = rel.split('/')[1].replace(/\.md$/, '');
      ctx.doc(rel)
        .lacks('<files_to_read>', `${agent} still has <files_to_read> opening tag: migrate to <required_reading>`)
        .lacks('</files_to_read>', `${agent} still has </files_to_read> closing tag: migrate to </required_reading>`)
        .lacks('`<files_to_read>`', `${agent} still references \`<files_to_read>\` in prose: update to \`<required_reading>\``)
        .satisfies((text) => {
          if (!text.includes('required_reading') && !text.includes('files_to_read')) return true;
          withReading += 1;
          if (!text.includes('required_reading')) return `${agent} has reading instructions but does not use required_reading`;
          return !text.includes('files_to_read') || `${agent} still uses files_to_read: it must be migrated to required_reading`;
        }, 'an agent with reading instructions must use required_reading and not files_to_read');
    }
    if (withReading < MIN_AGENTS_WITH_READING) {
      ctx.fail('agents', `expected at least ${MIN_AGENTS_WITH_READING} agents with reading instructions, found ${withReading}`);
    }

    ctx.exists(COMMON_BUG_PATTERNS, 'the common-bug-patterns.md reference must exist');
    ctx.doc(COMMON_BUG_PATTERNS)
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

    ctx.doc(DEBUGGER)
      .has('common-bug-patterns.md', 'the debugger agent must reference common-bug-patterns.md')
      .slice('<required_reading>', '</required_reading>')
      .has('common-bug-patterns.md', 'common-bug-patterns.md must be inside the <required_reading> block');

    // Emit-side parity (#3423): the spawner surfaces must not emit the legacy tag either.
    let swept = 0;
    for (const dir of SPAWNER_DIRS) {
      for (const rel of ctx.list(dir, '.md', 'the spawner surfaces are what emit a <required_reading> block to an agent')) {
        swept += 1;
        ctx.doc(rel)
          .lacks('<files_to_read>', `${rel} still emits the legacy <files_to_read> tag: migrate to <required_reading> (#3423)`)
          .lacks('</files_to_read>', `${rel} still emits the legacy </files_to_read> tag: migrate to <required_reading> (#3423)`);
      }
    }
    if (swept < MIN_SPAWNER_FILES) ctx.fail('gsd-core', `expected a large spawner surface (more than 100 files), found ${swept}`);
  },
};
