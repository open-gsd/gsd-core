'use strict';

/**
 * Behavioral tests for scripts/gen-coverage-matrix.cjs (#6771).
 *
 * The generator's pure functions take their inputs as arguments, so every test here drives them with small
 * fixtures. The freshness of the committed docs/reference/coverage-matrix.md is enforced by
 * `npm run lint:generated-sync` (`gen-coverage-matrix.cjs --check`), not here.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  parseSections,
  githubAnchor,
  flagsOf,
  hasFlag,
  mentions,
  invokes,
  sectionsDocumenting,
  tableRows,
  parseHelpFlags,
  byName,
  buildModel,
  renderMatrix,
  gaps,
} = require('../scripts/gen-coverage-matrix.cjs');

const EMPTY_DOCS = { commands: '', cli: '', config: '', agents: '', inventory: '', templates: '', installer: '' };

function inputs(overrides = {}) {
  return {
    commands: [],
    verbs: [],
    configKeys: [],
    agents: [],
    hooks: [],
    templates: [],
    installerFlags: [],
    ...overrides,
    docs: { ...EMPTY_DOCS, ...(overrides.docs || {}) },
  };
}

function surface(model, id) {
  return model.find((s) => s.id === id);
}

describe('parseSections', () => {
  test('a section ends at the next heading of the same or a higher level; own text stops at any heading', () => {
    const md = ['# A', 'a body', '## B', 'b body', '### C', 'c body', '## D', 'd body'].join('\n');
    const s = parseSections(md);
    assert.deepEqual(s.map((x) => x.title), ['A', 'B', 'C', 'D']);
    assert.equal(s[1].text, 'b body\n### C\nc body');
    assert.equal(s[1].own, 'b body');
    assert.equal(s[0].own, 'a body');
    assert.equal(s[2].text, 'c body');
    assert.equal(s[3].text, 'd body');
  });

  test('a # line inside a fenced code block is not a heading', () => {
    const md = ['## Real', '```bash', '# a comment, not a heading', '```', 'after', '~~~', '## also not a heading', '~~~', '## Next'].join('\n');
    assert.deepEqual(parseSections(md).map((x) => x.title), ['Real', 'Next']);
  });

  test('reports the 1-based line of each heading and tolerates CRLF', () => {
    const s = parseSections('intro\r\n## One\r\ntext\r\n## Two');
    assert.deepEqual(s.map((x) => x.line), [2, 4]);
  });

  test('input with no heading yields no section', () => {
    assert.deepEqual(parseSections('just text\nmore text'), []);
  });
});

describe('githubAnchor', () => {
  test('drops backticks, slashes and punctuation, lowercases, and hyphenates spaces', () => {
    assert.equal(githubAnchor('`/gsd-plan-phase`'), 'gsd-plan-phase');
    assert.equal(githubAnchor('Hello, World!'), 'hello-world');
    assert.equal(githubAnchor('Knowledge Store, Research Cache and Resolver Commands'), 'knowledge-store-research-cache-and-resolver-commands');
  });
});

describe('flag and name matching', () => {
  test('hasFlag matches a whole flag token only: nothing identifier-like on either side', () => {
    assert.equal(hasFlag('use --ws here', '--ws'), true);
    assert.equal(hasFlag('use --ws', '--ws'), true);
    assert.equal(hasFlag('use --wsx here', '--ws'), false);
    assert.equal(hasFlag('use --w here', '--ws'), false);
    assert.equal(hasFlag('use --ws-foo here', '--ws'), false);
    assert.equal(hasFlag('use --ws_x here', '--ws'), false);
    assert.equal(hasFlag('a---ws here', '--ws'), false);
    assert.equal(hasFlag('`--ws`', '--ws'), true);
  });

  test('flagsOf returns the unique flags in first-appearance order', () => {
    assert.deepEqual(flagsOf('[--chain] [--text] [--chain] --a-b'), ['--chain', '--text', '--a-b']);
    assert.deepEqual(flagsOf(''), []);
    assert.deepEqual(flagsOf(undefined), []);
  });

  test('mentions does not match inside a longer identifier, a path or a file name', () => {
    assert.equal(mentions('run /gsd-plan-phase now', '/gsd-plan-phase'), true);
    assert.equal(mentions('run /gsd-plan-phase-extra now', '/gsd-plan-phase'), false);
    assert.equal(mentions('run /gsd-plan-phase.md now', '/gsd-plan-phase'), false);
    assert.equal(mentions('run /gsd-plan-phase. Next', '/gsd-plan-phase'), true);
    assert.equal(mentions('see docs/state.update.md', 'state.update'), false);
    assert.equal(mentions('gsd-tools state.update --x', 'state.update'), true);
  });

  test('invokes accepts usage lines and verb-keyed table rows, not prose', () => {
    assert.equal(invokes('node gsd-tools.cjs state update --x', 'state update'), true);
    assert.equal(invokes('  gsd-tools query learnings list', 'learnings list'), true);
    assert.equal(invokes('gsd_run query skills-root claude', 'skills-root'), true);
    assert.equal(invokes('| `learnings list` | none | x |', 'learnings list'), true);
    assert.equal(invokes('| `gsd-tools learnings list` | none |', 'learnings list'), true);
    assert.equal(invokes('Run the learnings list verb to see them', 'learnings list'), false);
    assert.equal(invokes('node gsd-tools.cjs state update-progress', 'state update'), false);
    assert.equal(invokes('| `learnings listing` | x |', 'learnings list'), false);
  });

  test('sectionsDocumenting searches a section\'s OWN text, so a name under a subsection never lands on the page heading', () => {
    const docs = [{ file: 'docs/A.md', sections: parseSections('# Page\nintro\n## Alpha\nnothing\n## Beta\nuses verb-x here') }];
    const hits = sectionsDocumenting(docs, ['verb-x']);
    assert.deepEqual(hits.map((h) => h.section.title), ['Beta']);
    assert.equal(hits[0].file, 'docs/A.md');
  });

  test('the heading mode ignores a mention in the body', () => {
    const docs = [{ file: 'docs/A.md', sections: parseSections('## `name-x`\nbody\n## Other\nmentions name-x here') }];
    assert.deepEqual(sectionsDocumenting(docs, ['name-x'], 'heading').map((h) => h.section.title), ['`name-x`']);
  });
});

describe('tableRows', () => {
  const md = [
    '| Setting | Type | Default | Description |',
    '|---|---|---|---|',
    '| `a.one` | boolean | `true` | does a thing |',
    '',
    '| Key | Default |',
    '|---|---|',
    '| `b.two` | `1` |',
    '```',
    '| not | a table |',
    '|---|---|',
    '| `c.three` | x |',
    '```',
  ].join('\n');

  test('each row is read under its own table header, in 4-, 2- and fenced contexts', () => {
    const rows = tableRows(md);
    assert.deepEqual(rows.map((r) => r.cells[0]), ['`a.one`', '`b.two`']);
    assert.equal(rows[0].byHeader.type, 'boolean');
    assert.equal(rows[0].byHeader.description, 'does a thing');
    assert.equal(rows[1].byHeader.default, '`1`');
    assert.equal('type' in rows[1].byHeader, false);
  });
});

describe('parseHelpFlags', () => {
  test('reads only the option column: flags named in a description are not options', () => {
    const help = [
      'Usage: install [options]',
      '    -g, --global               Install globally',
      '    --windsurf, --devin-desktop Alias of --windsurf  (see --devin-desktop)',
      '    --dry-run                  Preview and exit; same as --preview',
      'not an option line --nope',
    ].join('\n');
    assert.deepEqual(parseHelpFlags(help).sort(), ['--devin-desktop', '--dry-run', '--global', '--windsurf'].sort());
  });
});

describe('byName', () => {
  test('orders by code unit, independent of locale, and is a total order on distinct names', () => {
    assert.deepEqual(['b', 'A', 'a', '_', '-', '.'].sort(byName), ['-', '.', 'A', '_', 'a', 'b']);
    assert.equal(byName('x', 'x'), 0);
  });
});

describe('buildModel', () => {
  test('a command is documented by a section it heads, and its flags must appear in that section or its subsections', () => {
    const model = buildModel(inputs({
      commands: [{ stem: 'plan-phase', argumentHint: '[--chain] [--text]' }, { stem: 'ship', argumentHint: '' }],
      docs: { commands: '# Commands\n### `/gsd-plan-phase`\nUse `--chain` to continue.\n#### Detail\nAnd `--text`.\n### `/gsd-ship`\nShips.' },
    }));
    const rows = surface(model, 'commands').rows;
    const plan = rows.find((r) => r.item === '/gsd-plan-phase');
    assert.equal(plan.where.anchor, 'gsd-plan-phase');
    assert.deepEqual(plan.missing, []);
    const ship = rows.find((r) => r.item === '/gsd-ship');
    assert.equal(ship.optionsTotal, 0);
    assert.deepEqual(ship.missing, []);
  });

  test('a flag documented under a DIFFERENT command does not count (a document-level heading holds the whole page)', () => {
    const model = buildModel(inputs({
      commands: [{ stem: 'alpha', argumentHint: '[--only-beta]' }],
      docs: { commands: '# Reference\n### `/gsd-alpha`\nNothing here.\n### `/gsd-beta`\nUse `--only-beta`.' },
    }));
    const row = surface(model, 'commands').rows[0];
    assert.equal(row.where.anchor, 'gsd-alpha');
    assert.deepEqual(row.missing, ['--only-beta']);
  });

  test('a verb flag counts only in that verb\'s own usage, its following prose or its table row, not in a sibling verb\'s', () => {
    const cli = '# T\n## State\n```bash\ngsd-tools zzz\ngsd-tools other --ws\n```\n';
    const model = buildModel(inputs({ verbs: [{ verb: 'zzz', aliases: [], flags: ['ws'] }], docs: { cli } }));
    assert.deepEqual(surface(model, 'verbs').rows[0].missing, ['--ws']);
    const own = '# T\n## State\n```bash\ngsd-tools zzz [--ws]\ngsd-tools other\n```\n';
    assert.deepEqual(surface(buildModel(inputs({ verbs: [{ verb: 'zzz', aliases: [], flags: ['ws'] }], docs: { cli: own } })), 'verbs').rows[0].missing, []);
    const prose = '# T\n## State\n```bash\ngsd-tools zzz\ngsd-tools other\n```\n**zzz** takes `--ws`.\n\n**other** takes nothing.';
    assert.deepEqual(surface(buildModel(inputs({ verbs: [{ verb: 'zzz', aliases: [], flags: ['ws'] }], docs: { cli: prose } })), 'verbs').rows[0].missing, []);
  });

  test('a flags table that follows a verb\'s usage line belongs to that verb', () => {
    const cli = '# T\n## Milestone\n```bash\ngsd-tools zzz\n```\n| Flag | Effect |\n|---|---|\n| `--ws` | a workstream |\n';
    assert.deepEqual(surface(buildModel(inputs({ verbs: [{ verb: 'zzz', aliases: [], flags: ['ws'] }], docs: { cli } })), 'verbs').rows[0].missing, []);
  });

  test('a four-backtick fence holding a three-backtick line keeps its headings inside the fence', () => {
    const sections = parseSections('# A\n````md\n```\n## not a heading\n```\n````\n## B');
    assert.deepEqual(sections.map((s) => s.title), ['A', 'B']);
  });

  test('a table cell with an escaped pipe stays one cell, so later columns are read from the right cell', () => {
    const config = '# C\n| Key | Type | Default | Description |\n|---|---|---|---|\n| `a.b` | string \\| null | `null` | Explains it. |\n';
    const row = surface(buildModel(inputs({ configKeys: ['a.b'], docs: { config } })), 'config').rows[0];
    assert.deepEqual(row.missing, []);
    const empty = '# C\n| Key | Type | Default | Description |\n|---|---|---|---|\n| `a.b` | string \\| null | `null` | |\n';
    assert.deepEqual(surface(buildModel(inputs({ configKeys: ['a.b'], docs: { config: empty } })), 'config').rows[0].missing, ['effect']);
  });

  test('a key listed in two tables is judged by the table that carries all three columns', () => {
    const config = '# C\n| Key | Gate | When unset |\n|---|---|---|\n| `a.b` | x | y |\n\n| Key | Type | Default | Description |\n|---|---|---|---|\n| `a.b` | bool | `false` | Does it. |\n';
    assert.deepEqual(surface(buildModel(inputs({ configKeys: ['a.b'], docs: { config } })), 'config').rows[0].missing, []);
  });

  test('a command without a section of its own counts through a section whose own text names it', () => {
    const model = buildModel(inputs({
      commands: [{ stem: 'workflow', argumentHint: '' }],
      docs: { commands: '# C\n## Routers\n| Router | Covers |\n| `/gsd-workflow` | phases |' },
    }));
    assert.equal(surface(model, 'commands').rows[0].where.title, 'Routers');
  });

  test('an undocumented command reports no location and all its flags missing', () => {
    const model = buildModel(inputs({ commands: [{ stem: 'ghost', argumentHint: '[--a]' }] }));
    const row = surface(model, 'commands').rows[0];
    assert.equal(row.where, null);
    assert.deepEqual(row.missing, ['--a']);
  });

  test('a verb needs a heading or a usage or table-row invocation; a prose mention is not enough', () => {
    const model = buildModel(inputs({
      verbs: [
        { verb: 'state.update', aliases: [], flags: ['json', 'ws'] },
        { verb: 'alpha', aliases: ['a-alias'], flags: [] },
        { verb: 'prose-only', aliases: [], flags: [] },
        { verb: 'in.a.table', aliases: [], flags: ['x'] },
      ],
      docs: {
        cli: [
          '# CLI',
          '## State',
          '```bash',
          'node gsd-tools.cjs state update --json',
          '```',
          '## Aliases',
          '### `a-alias`',
          'text',
          '## Notes',
          'The prose-only verb is mentioned here, and `--ws` too.',
          '## Table',
          '| `in a table` | `--x` | out |',
        ].join('\n'),
      },
    }));
    const rows = surface(model, 'verbs').rows;
    const state = rows.find((r) => r.item === 'state.update');
    assert.equal(state.where.file, 'docs/CLI-TOOLS.md');
    assert.equal(state.where.anchor, 'state');
    assert.deepEqual(state.missing, ['--ws']);
    assert.ok(rows.find((r) => r.item === 'alpha').where, 'a heading naming an alias documents the verb');
    assert.equal(rows.find((r) => r.item === 'prose-only').where, null);
    const table = rows.find((r) => r.item === 'in.a.table');
    assert.equal(table.where.anchor, 'table');
    assert.deepEqual(table.missing, []);
  });

  test('a config key is read under its own table header: type or options, default, description', () => {
    const model = buildModel(inputs({
      configKeys: ['a.table', 'b.partial', 'c.prose', 'd.none', 'e.five', 'f.notype'],
      docs: {
        config: [
          '# Config',
          '## Keys',
          '| Setting | Type | Default | Description |',
          '|---|---|---|---|',
          '| `a.table` | boolean | `true` | does a thing |',
          '| `b.partial` | string |  | |',
          'The `c.prose` key is explained here.',
          '## Core',
          '| Setting | Type | Options | Default | Description |',
          '|---|---|---|---|---|',
          '| `e.five` | enum | `a`, `b` | `a` | picks one |',
          '## Legacy',
          '| Key | Default | Description |',
          '|---|---|---|',
          '| `f.notype` | `1` | an old one |',
        ].join('\n'),
      },
    }));
    const byKey = Object.fromEntries(surface(model, 'config').rows.map((r) => [r.item, r]));
    assert.equal(byKey['a.table'].status, 'table');
    assert.deepEqual(byKey['a.table'].missing, []);
    assert.equal(byKey['a.table'].where.anchor, 'keys');
    assert.deepEqual(byKey['b.partial'].missing, ['default', 'effect']);
    assert.equal(byKey['c.prose'].status, 'prose');
    assert.deepEqual(byKey['c.prose'].missing, ['type', 'default', 'effect']);
    assert.equal(byKey['d.none'].status, 'none');
    assert.equal(byKey['d.none'].where, null);
    assert.deepEqual(byKey['e.five'].missing, [], 'a five-column table is read by header, not by position');
    assert.deepEqual(byKey['f.notype'].missing, ['type'], 'a table without a Type or Options column leaves type missing');
  });

  test('an agent needs a section whose heading names it; a table mention alone does not count', () => {
    const model = buildModel(inputs({
      agents: ['gsd-planner', 'gsd-ghost'],
      docs: { agents: '# A\n## `gsd-planner`\nRole.\n## Matrix\n| gsd-ghost | Read |' },
    }));
    const rows = surface(model, 'agents').rows;
    assert.ok(rows.find((r) => r.item === 'gsd-planner').where);
    assert.equal(rows.find((r) => r.item === 'gsd-ghost').where, null);
  });

  test('a hook needs a row under the Hooks heading whose Event cell is not empty; a row in another table does not count', () => {
    const model = buildModel(inputs({
      hooks: ['a.js', 'b.js', 'c.js', 'd.js'],
      docs: {
        inventory: [
          '# Inventory',
          '## Agents',
          '| Hook | Event |',
          '|---|---|',
          '| `d.js` | `PreToolUse` |',
          '## Hooks',
          '| Hook | Event | Purpose |',
          '|---|---|---|',
          '| `a.js` | `PreToolUse` | x |',
          '| `b.js` |  | x |',
          '| `c.js` | (helper) | x |',
        ].join('\n'),
      },
    }));
    const rows = surface(model, 'hooks').rows;
    assert.deepEqual(rows.map((r) => [r.item, r.missing]), [['a.js', []], ['b.js', ['event']], ['c.js', []], ['d.js', ['event']]]);
    assert.equal(rows.find((r) => r.item === 'd.js').where, null);
    assert.equal(rows.find((r) => r.item === 'a.js').where.anchor, 'hooks');
  });

  test('a template is documented by its relative or full path; an installer flag by name', () => {
    const model = buildModel(inputs({
      templates: ['state.md', 'codebase/stack.md', 'codebase/other.md'],
      installerFlags: ['--claude', '--ghost'],
      docs: {
        templates: '# T\n## Project\n| `state.md` | x |\n## Map\n| `gsd-core/templates/codebase/stack.md` | y |',
        installer: '# I\n## Runtimes\n| `--claude` | x |',
      },
    }));
    assert.deepEqual(surface(model, 'templates').rows.map((r) => Boolean(r.where)), [false, true, true]);
    assert.deepEqual(surface(model, 'installer').rows.map((r) => Boolean(r.where)), [true, false]);
  });

  test('rows are sorted by item name regardless of input order', () => {
    const model = buildModel(inputs({ agents: ['gsd-z', 'gsd-a', 'gsd-m'] }));
    assert.deepEqual(surface(model, 'agents').rows.map((r) => r.item), ['gsd-a', 'gsd-m', 'gsd-z']);
  });
});

describe('renderMatrix and gaps', () => {
  const model = buildModel(inputs({
    commands: [{ stem: 'a', argumentHint: '[--x]' }, { stem: 'b', argumentHint: '' }],
    configKeys: ['k.prose', 'k.table'],
    docs: {
      commands: '# C\n### `/gsd-a`\ntext',
      config: '# K\n## S\nThe `k.prose` key.\n| Setting | Type | Default | Description |\n|---|---|---|---|\n| `k.table` | string | `x` | y |',
    },
  }));

  test('the summary counts items, documented, fully documented and missing', () => {
    const md = renderMatrix(model);
    assert.match(md, /\| \[Slash commands\]\(#slash-commands\) \| 2 \| 1 \| 0 \| 1 \| 1 \|/);
    assert.match(md, /GENERATED by scripts\/gen-coverage-matrix\.cjs/);
  });

  test('a row links the documenting section relative to docs/reference and states the page type', () => {
    const md = renderMatrix(model);
    assert.match(md, /\| `\/gsd-a` \| \[COMMANDS\.md#gsd-a\]\(\.\.\/COMMANDS\.md#gsd-a\) \| Reference \| 0\/1 \| `--x` \|/);
    assert.match(md, /\| `\/gsd-b` \| — \| — \| n\/a \| — \|/);
  });

  test('a config row shows how the key is documented: (table) or (prose)', () => {
    const md = renderMatrix(model);
    assert.match(md, /\| `k\.table` \| \[CONFIGURATION\.md#s\]\(\.\.\/CONFIGURATION\.md#s\) \(table\) \| Reference \| 3\/3 \| — \|/);
    assert.match(md, /\| `k\.prose` \| \[CONFIGURATION\.md#s\]\(\.\.\/CONFIGURATION\.md#s\) \(prose\) \| Reference \| 0\/3 \|/);
  });

  test('a page that is not in the type table renders as unclassified', () => {
    const odd = [{ id: 'x', title: 'X', source: 's', rule: 'r', rows: [{ item: 'i', where: { file: 'docs/other.md', anchor: 'h', title: 'H' }, optionsTotal: 0, optionsDocumented: 0, missing: [] }] }];
    assert.match(renderMatrix(odd), /\| `i` \| \[other\.md#h\]\(\.\.\/other\.md#h\) \| unclassified \| n\/a \| — \|/);
  });

  test('a pipe in an item name is escaped so the table keeps its columns', () => {
    const piped = [{ id: 'x', title: 'X', source: 's', rule: 'r', rows: [{ item: 'a|b', where: null, optionsTotal: 0, optionsDocumented: 0, missing: [] }] }];
    assert.match(renderMatrix(piped), /\| `a\\\|b` \|/);
  });

  test('gaps lists each undocumented item and each documented item with a missing option', () => {
    const found = gaps(model);
    assert.ok(found.includes('Slash commands: /gsd-a lacks --x'));
    assert.ok(found.includes('Slash commands: /gsd-b is not documented'));
    assert.ok(found.includes('Config keys: k.prose lacks type, default, effect'));
    assert.equal(found.some((g) => g.includes('k.table')), false);
  });
});

describe('properties', () => {
  const lineArb = fc.oneof(
    fc.constantFrom('```', '~~~', '```bash'),
    fc.string({ maxLength: 12 }).map((t) => '# ' + t.replace(/[\r\n]/g, ' ')),
    fc.string({ maxLength: 12 }).map((t) => '## ' + t.replace(/[\r\n]/g, ' ')),
    fc.string({ maxLength: 20 }).map((t) => t.replace(/[\r\n]/g, ' ')),
  );

  test('every reported heading is outside a fenced block of the input', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
        const sections = parseSections(lines.join('\n'));
        let fence = null;
        const inFence = new Set();
        lines.forEach((l, i) => {
          const f = /^\s{0,3}(```|~~~)/.exec(l);
          if (f) {
            if (fence === null) fence = f[1];
            else if (f[1] === fence) fence = null;
            return;
          }
          if (fence !== null) inFence.add(i + 1);
        });
        return sections.every((s) => !inFence.has(s.line));
      }),
    );
  });

  test('a section\'s text is exactly the lines between its heading and the next heading of its level or higher', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
        const sections = parseSections(lines.join('\n'));
        return sections.every((s, n) => {
          const next = sections.slice(n + 1).find((o) => o.level <= s.level);
          const stop = next ? next.line - 1 : lines.length;
          return s.text === lines.slice(s.line, stop).join('\n') && s.end === stop;
        });
      }),
    );
  });

  test('own text is exactly the lines up to the next heading of ANY level, and a prefix of the section text', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
        const sections = parseSections(lines.join('\n'));
        return sections.every((s, n) => {
          const stop = n + 1 < sections.length ? sections[n + 1].line - 1 : lines.length;
          return s.own === lines.slice(s.line, stop).join('\n') && s.text.startsWith(s.own);
        });
      }),
    );
  });

  test('flagsOf returns only flag-shaped tokens, each present in the input, with no duplicates', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        const flags = flagsOf(text);
        return new Set(flags).size === flags.length && flags.every((f) => /^--[a-z][a-z0-9-]*$/.test(f) && text.includes(f));
      }),
    );
  });

  test('a flag is always found in a text that contains it between non-identifier characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), fc.string({ maxLength: 10 }), (name, pad) => {
        const clean = pad.replace(/[A-Za-z0-9_-]/g, ' ');
        return hasFlag(`${clean} --${name} ${clean}`, `--${name}`);
      }),
    );
  });

  test('a flag glued to an identifier character on either side is never found', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), fc.constantFrom('a', '0', '_', '-'), (name, glue) => {
        return !hasFlag(`${glue}--${name}`, `--${name}`) && !hasFlag(`--${name}${glue}`, `--${name}`);
      }),
    );
  });
});
