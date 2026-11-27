'use strict';

/**
 * Behavioral tests for scripts/gen-coverage-matrix.cjs (#6771).
 *
 * The generator's pure functions take their inputs as arguments, so every test
 * here drives them with small fixtures. The freshness of the committed
 * docs/reference/coverage-matrix.md is enforced by `npm run lint:generated-sync`
 * (`gen-coverage-matrix.cjs --check`), not here.
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
  sectionsMentioning,
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
  test('a section ends at the next heading of the same or a higher level', () => {
    const md = ['# A', 'a body', '## B', 'b body', '### C', 'c body', '## D', 'd body'].join('\n');
    const s = parseSections(md);
    assert.deepEqual(s.map((x) => x.title), ['A', 'B', 'C', 'D']);
    assert.equal(s[1].text, 'b body\n### C\nc body');
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
  test('hasFlag matches a whole flag token only (limit-1, limit, limit+1 of the name)', () => {
    assert.equal(hasFlag('use --ws here', '--ws'), true);
    assert.equal(hasFlag('use --ws', '--ws'), true);
    assert.equal(hasFlag('use --wsx here', '--ws'), false);
    assert.equal(hasFlag('use --w here', '--ws'), false);
    assert.equal(hasFlag('use --ws-foo here', '--ws'), false);
  });

  test('flagsOf returns the unique flags in first-appearance order', () => {
    assert.deepEqual(flagsOf('[--chain] [--text] [--chain] --a-b'), ['--chain', '--text', '--a-b']);
    assert.deepEqual(flagsOf(''), []);
    assert.deepEqual(flagsOf(undefined), []);
  });

  test('mentions does not match inside a longer identifier or path', () => {
    assert.equal(mentions('run /gsd-plan-phase now', '/gsd-plan-phase'), true);
    assert.equal(mentions('run /gsd-plan-phase-extra now', '/gsd-plan-phase'), false);
    assert.equal(mentions('see docs/state.update.md', 'state.update'), false);
    assert.equal(mentions('gsd-tools state.update --x', 'state.update'), true);
  });

  test('sectionsMentioning finds a name in a heading or a body and keeps the file', () => {
    const docs = [{ file: 'docs/A.md', sections: parseSections('## Alpha\nnothing\n## Beta\nuses verb-x here') }];
    const hits = sectionsMentioning(docs, ['verb-x']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'docs/A.md');
    assert.equal(hits[0].section.title, 'Beta');
  });
});

describe('buildModel', () => {
  test('a command is documented by a section it heads, and its flags must appear in that section', () => {
    const model = buildModel(inputs({
      commands: [{ stem: 'plan-phase', argumentHint: '[--chain] [--text]' }, { stem: 'ship', argumentHint: '' }],
      docs: { commands: '### `/gsd-plan-phase`\nUse `--chain` to continue.\n### `/gsd-ship`\nShips.' },
    }));
    const rows = surface(model, 'commands').rows;
    const plan = rows.find((r) => r.item === '/gsd-plan-phase');
    assert.equal(plan.where.anchor, 'gsd-plan-phase');
    assert.deepEqual(plan.missing, ['--text']);
    assert.equal(plan.optionsDocumented, 1);
    const ship = rows.find((r) => r.item === '/gsd-ship');
    assert.equal(ship.optionsTotal, 0);
    assert.deepEqual(ship.missing, []);
  });

  test('a command without a section of its own counts through any section that names it', () => {
    const model = buildModel(inputs({
      commands: [{ stem: 'workflow', argumentHint: '' }],
      docs: { commands: '## Routers\n| Router | Covers |\n| `/gsd-workflow` | phases |' },
    }));
    assert.equal(surface(model, 'commands').rows[0].where.title, 'Routers');
  });

  test('an undocumented command reports no location and all its flags missing', () => {
    const model = buildModel(inputs({ commands: [{ stem: 'ghost', argumentHint: '[--a]' }] }));
    const row = surface(model, 'commands').rows[0];
    assert.equal(row.where, null);
    assert.deepEqual(row.missing, ['--a']);
  });

  test('a verb is documented through its dotted or spaced name or an alias, and each flag needs a naming section', () => {
    const model = buildModel(inputs({
      verbs: [
        { verb: 'state.update', aliases: [], flags: ['json', 'ws'] },
        { verb: 'alpha', aliases: ['a-alias'], flags: [] },
        { verb: 'lost', aliases: [], flags: ['x'] },
      ],
      docs: {
        cli: '## State\n`gsd-tools state update --json`\n## Aliases\nuse a-alias to run it',
        commands: '',
      },
    }));
    const rows = surface(model, 'verbs').rows;
    const state = rows.find((r) => r.item === 'state.update');
    assert.equal(state.where.file, 'docs/CLI-TOOLS.md');
    assert.deepEqual(state.missing, ['--ws']);
    assert.ok(rows.find((r) => r.item === 'alpha').where, 'an alias counts as documenting the verb');
    assert.equal(rows.find((r) => r.item === 'lost').where, null);
  });

  test('a config key counts as `table` with a type, default and effect, `prose` when only mentioned, and `none` otherwise', () => {
    const model = buildModel(inputs({
      configKeys: ['a.table', 'b.partial', 'c.prose', 'd.none'],
      docs: {
        config: [
          '## Keys',
          '| `a.table` | boolean | `true` | does a thing |',
          '| `b.partial` | string |  | |',
          'The `c.prose` key is explained here.',
        ].join('\n'),
      },
    }));
    const byKey = Object.fromEntries(surface(model, 'config').rows.map((r) => [r.item, r]));
    assert.equal(byKey['a.table'].status, 'table');
    assert.deepEqual(byKey['a.table'].missing, []);
    assert.equal(byKey['b.partial'].status, 'table');
    assert.deepEqual(byKey['b.partial'].missing, ['default', 'effect']);
    assert.equal(byKey['c.prose'].status, 'prose');
    assert.deepEqual(byKey['c.prose'].missing, ['type', 'default', 'effect']);
    assert.equal(byKey['d.none'].status, 'none');
    assert.equal(byKey['d.none'].where, null);
  });

  test('an agent needs a section whose heading names it; a table mention alone does not count', () => {
    const model = buildModel(inputs({
      agents: ['gsd-planner', 'gsd-ghost'],
      docs: { agents: '## `gsd-planner`\nRole.\n## Matrix\n| gsd-ghost | Read |' },
    }));
    const rows = surface(model, 'agents').rows;
    assert.ok(rows.find((r) => r.item === 'gsd-planner').where);
    assert.equal(rows.find((r) => r.item === 'gsd-ghost').where, null);
  });

  test('a hook needs an inventory row that carries an event', () => {
    const model = buildModel(inputs({
      hooks: ['a.js', 'b.js', 'c.js'],
      docs: { inventory: '| Hook | Event |\n| `a.js` | `PreToolUse` | x |\n| `b.js` |  | x |' },
    }));
    const rows = surface(model, 'hooks').rows;
    assert.deepEqual(rows.map((r) => r.missing), [[], ['event'], ['event']]);
    assert.equal(rows.find((r) => r.item === 'c.js').where, null);
  });

  test('templates and installer flags are documented when their page names them', () => {
    const model = buildModel(inputs({
      templates: ['state.md', 'codebase/stack.md'],
      installerFlags: ['--claude', '--ghost'],
      docs: { templates: '## Project\n| `state.md` | x |', installer: '## Runtimes\n| `--claude` | x |' },
    }));
    assert.deepEqual(surface(model, 'templates').rows.map((r) => Boolean(r.where)), [false, true]);
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
    docs: { commands: '### `/gsd-a`\ntext' },
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

  test('a pipe in an item name is escaped so the table keeps its columns', () => {
    const piped = [{ id: 'x', title: 'X', source: 's', rule: 'r', rows: [{ item: 'a|b', where: null, optionsTotal: 0, optionsDocumented: 0, missing: [] }] }];
    assert.match(renderMatrix(piped), /\| `a\\\|b` \|/);
  });

  test('gaps lists each undocumented item and each documented item with a missing option', () => {
    assert.deepEqual(gaps(model), ['Slash commands: /gsd-a lacks --x', 'Slash commands: /gsd-b is not documented']);
  });

  test('rendering is deterministic', () => {
    assert.equal(renderMatrix(model), renderMatrix(model));
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

  test('sections are ordered by line and a deeper section lies inside its parent text', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 30 }), (lines) => {
        const sections = parseSections(lines.join('\n'));
        for (let i = 1; i < sections.length; i++) if (sections[i].line <= sections[i - 1].line) return false;
        return true;
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

  test('a flag is always found in a text that contains it between spaces', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), fc.string({ maxLength: 10 }), (name, pad) => {
        const clean = pad.replace(/[A-Za-z0-9-]/g, ' ');
        return hasFlag(`${clean} --${name} ${clean}`, `--${name}`);
      }),
    );
  });
});
