/**
 * Regression tests for #1343: parseDecisions() silently drops decision bullets
 * whose header contains anything other than an optional [bracket] tag before :**
 * (e.g. a parenthetical, em-dash, or free text).
 *
 * Covers:
 *   1. Parenthetical before colon now parses (this FAILS without the fix).
 *   2. Bracket tags still captured correctly and drive `trackable`.
 *   3. Bracket + parenthetical together.
 *   4. Parse-miss WARN floor: a genuinely unparseable bullet (colon inside
 *      pre-colon run) is excluded from results AND triggers console.warn.
 *   5. Non-regression: plain bullet + continuation line still parse.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecisions } = require('../gsd-core/bin/lib/decisions.cjs');

// ─── helper ──────────────────────────────────────────────────────────────────

function wrap(body) {
  return `<decisions>\n## Decisions\n\n${body}\n</decisions>\n`;
}

// ─── 1. Parenthetical before colon now parses ─────────────────────────────

describe('bug-1343: parenthetical before colon', () => {
  test('all three ids extracted when one bullet has a parenthetical before :**', () => {
    const md = wrap(
      '- **D-01:** a\n' +
      '- **D-02 (note before colon):** b\n' +
      '- **D-03 [robust]:** c\n'
    );
    const ds = parseDecisions(md);
    assert.deepStrictEqual(
      ds.map(d => d.id),
      ['D-01', 'D-02', 'D-03'],
      'D-02 with parenthetical must not be dropped'
    );
    assert.strictEqual(ds.length, 3);
  });

  test('text is preserved for parenthetical bullet', () => {
    const md = wrap('- **D-02 (note before colon):** b\n');
    const ds = parseDecisions(md);
    assert.strictEqual(ds[0].id, 'D-02');
    assert.strictEqual(ds[0].text, 'b');
  });
});

// ─── 2. Bracket tags still captured + drive trackable ────────────────────

describe('bug-1343: bracket tags captured and drive trackable', () => {
  test('[informational] tag makes trackable:false', () => {
    const md = wrap(
      '- **D-04 [informational]:** x\n' +
      '- **D-05:** y\n'
    );
    const ds = parseDecisions(md);
    const d04 = ds.find(d => d.id === 'D-04');
    const d05 = ds.find(d => d.id === 'D-05');
    assert.ok(d04, 'D-04 must be present');
    assert.ok(d04.tags.includes('informational'), 'D-04 tags must include informational');
    assert.strictEqual(d04.trackable, false, 'D-04 must be non-trackable');
    assert.ok(d05, 'D-05 must be present');
    assert.strictEqual(d05.trackable, true, 'D-05 must be trackable');
  });
});

// ─── 3. Bracket + parenthetical together ─────────────────────────────────

describe('bug-1343: bracket + parenthetical combined', () => {
  test('D-06 [robust] (note) parses correctly', () => {
    const md = wrap('- **D-06 [robust] (note):** z\n');
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].id, 'D-06');
    assert.ok(ds[0].tags.includes('robust'), 'tags must include robust');
    assert.strictEqual(ds[0].text, 'z');
  });
});

// ─── 4. Parse-miss WARN floor ────────────────────────────────────────────

describe('bug-1343: parse-miss WARN floor', () => {
  test('genuinely unparseable bullet (colon inside pre-colon run) is excluded and warns', () => {
    // `D-07 ratio 3:1` has a colon in the pre-colon run; after [^:*]* matches up
    // to the first colon, the `:**` anchor fails → bulletRe does not match → falls
    // through to the parse-miss guard, which must warn and skip.
    const md = wrap('- **D-07 ratio 3:1:** w\n');

    const warnMessages = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args) => {
        warnMessages.push(args.join(' '));
      };
      const ds = parseDecisions(md);
      assert.strictEqual(ds.length, 0, 'unparseable bullet must be excluded from results');
    } finally {
      console.warn = origWarn;
    }

    assert.ok(
      warnMessages.some(m => m.includes('D-07')),
      `expected a console.warn mentioning D-07, got: ${JSON.stringify(warnMessages)}`
    );
  });
});

// ─── Test A — malformed D-bullet must not corrupt previous decision's text ─

describe('bug-1343: malformed D-bullet does not corrupt previous decision text', () => {
  test('D-02 malformed flush: D-01 text stays clean, continuation does not attach', () => {
    // D-02 has a colon inside the pre-colon run ("ratio 3:1"), so bulletRe rejects
    // it and the parse-miss guard fires. Before this fix the guard skipped WITHOUT
    // flushing, leaving current=D-01; the following indented continuation line was
    // then mis-appended to D-01's text.
    const md = wrap(
      '- **D-01:** first decision\n' +
      '- **D-02 ratio 3:1:** malformed (unparseable, has colon in pre-colon run)\n' +
      '    indented continuation that must NOT attach to D-01\n' +
      '- **D-03:** third decision\n'
    );

    const warnMessages = [];
    const origWarn = console.warn;
    try {
      console.warn = (...args) => { warnMessages.push(args.join(' ')); };
      const ds = parseDecisions(md);

      assert.deepStrictEqual(
        ds.map(d => d.id),
        ['D-01', 'D-03'],
        'only D-01 and D-03 should be present (D-02 dropped)'
      );

      const d01 = ds.find(d => d.id === 'D-01');
      assert.ok(d01, 'D-01 must be present');
      assert.strictEqual(
        d01.text,
        'first decision',
        'D-01 text must be exactly "first decision", not polluted by continuation'
      );
      assert.ok(!d01.text.includes('indented'), 'D-01 text must NOT contain "indented"');

      const d03 = ds.find(d => d.id === 'D-03');
      assert.ok(d03, 'D-03 must be present');
    } finally {
      console.warn = origWarn;
    }

    assert.ok(
      warnMessages.some(m => m.includes('D-02')),
      `expected a console.warn mentioning D-02, got: ${JSON.stringify(warnMessages)}`
    );
  });
});

// ─── Test B — malformed/unterminated bracket tag: safe tagless trackable ──

describe('bug-1343: malformed/unterminated bracket tag parses as tagless trackable', () => {
  test('D-09 [informational: (missing ]) yields tags=[] and trackable=true', () => {
    // "- **D-09 [informational:** body" has no closing `]` so the optional bracket
    // group in bulletRe does not match, leaving tags=[]. The decision is still
    // captured because the ID and `:**` are intact.
    //
    // This is the intentional SAFE DIRECTION for the coverage gate: a tagless
    // trackable decision can only make the gate STRICTER (it counts toward required
    // decisions), never produce a false pass. An alternative that silently turned
    // the decision non-trackable could allow a gate bypass.
    const md = wrap('- **D-09 [informational:** body\n');
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1, 'D-09 should be present');
    assert.strictEqual(ds[0].id, 'D-09');
    assert.deepStrictEqual(ds[0].tags, [], 'tags must be empty (unclosed bracket not parsed)');
    assert.strictEqual(ds[0].trackable, true, 'trackable must be true (no non-trackable tag matched)');
  });
});

// ─── 5. Non-regression: plain bullet + continuation ───────────────────────

describe('bug-1343: non-regression — plain bullet + continuation', () => {
  test('D-08 with continuation line parses correctly', () => {
    const md = wrap(
      '- **D-08:** ok\n' +
      '  continuation text here\n'
    );
    const ds = parseDecisions(md);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].id, 'D-08');
    assert.ok(ds[0].text.includes('ok'), 'text must include bullet text');
    assert.ok(ds[0].text.includes('continuation'), 'text must include continuation');
  });

  test('existing numeric and bracket forms unchanged', () => {
    const md = wrap(
      '- **D-42:** numeric id\n' +
      '- **D-INFRA-01 [deferred]:** alphanumeric id\n'
    );
    const ds = parseDecisions(md);
    assert.deepStrictEqual(ds.map(d => d.id), ['D-42', 'D-INFRA-01']);
    assert.ok(ds[1].tags.includes('deferred'));
    assert.strictEqual(ds[1].trackable, false);
  });
});
