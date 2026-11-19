// Properties of the #5427 PR-template link guard (tests/helpers/pr-template-links.cjs).
// Expected values come from the class tables below, never from the guard's own predicates.
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');

const {
  REPO, NEXT, hrefsIn, isBadLink, unresolvedAnchors,
} = require('./helpers/pr-template-links.cjs');

const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,19}$/); // never `.` or `..`
const rel = fc.array(seg, { minLength: 1, maxLength: 3 }).map((a) => a.join('/'));
const title = fc.constantFrom('', ' "t"', " 't'");

describe('repo link grammar (#5427)', () => {
  const checked = ['blob', 'tree', 'raw', 'blame'];
  const noRef = ['issues', 'pull', 'pulls', 'discussions', 'actions', 'releases', 'wiki',
    'security', 'projects', 'labels', 'milestones', 'tags', 'branches', 'compare'];
  const ok = (arb) => arb.map((h) => [h, false]);
  const bad = (arb) => arb.map((h) => [h, true]);
  const classes = fc.oneof(
    ok(fc.tuple(fc.constantFrom(...checked), rel).map(([v, p]) => `${REPO}${v}/next/${p}`)),
    ok(fc.constantFrom(...checked).map((v) => `${REPO}${v}/next`)),
    ok(fc.tuple(fc.constantFrom(...noRef), rel).map(([v, p]) => `${REPO}${v}/${p}`)),
    ok(fc.constantFrom(...noRef).map((v) => `${REPO}${v}`)),
    ok(rel.map((p) => `https://GitHub.com/OPEN-GSD/GSD-CORE/blob/next/${p}`)),
    ok(rel.map((p) => `?template=${p}`)),
    // ref name: limit-1, limit, limit+1 of `next`, a case variant, another branch
    bad(fc.tuple(fc.constantFrom(...checked), fc.constantFrom('nex', 'nextx', 'Next', 'main'), rel)
      .map(([v, r, p]) => `${REPO}${v}/${r}/${p}`)),
    bad(fc.tuple(fc.constantFrom('edit', 'commits', 'Blob', 'bob', 'archive'), rel)
      .map(([v, p]) => `${REPO}${v}/next/${p}`)),
    bad(fc.tuple(fc.constantFrom(...noRef), rel).map(([v, p]) => `${REPO}${v}/../${p}`)),
    bad(fc.tuple(fc.constantFrom('.', '..', '%2e%2e', '.%2e'), rel)
      .map(([d, p]) => `${NEXT}${d}/${p}`)),
    bad(rel.map((p) => `https://github.com/open-gsd/gsd-corex/blob/next/${p}`)),
    bad(rel.map((p) => `http://github.com/open-gsd/gsd-core/blob/next/${p}`)),
    bad(rel.map((p) => `https://github.com.evil/open-gsd/gsd-core/blob/next/${p}`)),
    bad(rel.map((p) => `../${p}`)),
    // a doubled or trailing slash in the path
    bad(fc.tuple(fc.constantFrom(...checked), rel).map(([v, p]) => `${REPO}${v}/next//${p}`)),
    bad(fc.tuple(fc.constantFrom(...checked), rel).map(([v, p]) => `${REPO}${v}/next/${p}/`)),
    bad(fc.tuple(fc.constantFrom(...checked), fc.constantFrom('next', 'main'), rel)
      .map(([v, r, p]) => `${REPO}/${v}/${r}/${p}`)),
  );
  test('property: each link class is decided by construction', () => {
    fc.assert(fc.property(classes, ([h, isBad]) => assert.equal(isBadLink(h), isBad, h)));
  });
});

describe('line anchors (#5427)', () => {
  const targets = ['CONTRIBUTING.md?plain=1', 'scripts/ci-test-scope.cjs'];
  test('property: line anchors resolve exactly within 1..n', () => {
    const view = fc.constantFrom(...targets.map((t) => `${NEXT}${t}`),
      `${REPO}blame/next/CONTRIBUTING.md`);
    fc.assert(fc.property(view, fc.integer({ min: 1, max: 1000 }), (url, n) => {
      const seams = { linesOf: () => n };
      for (const k of new Set([0, 1, n - 1, n, n + 1])) {
        const inRange = k >= 1 && k <= n;
        for (const anchor of [`L${k}`, `L1-L${k}`]) {
          const found = unresolvedAnchors([`${url}#${anchor}`], 'tpl.md', seams);
          assert.equal(found.length === 0, inRange, `${url}#${anchor} n=${n}`);
        }
      }
    }));
  });
});

describe('link extractor properties (#5427)', () => {
  const dest = fc.stringMatching(/^[A-Za-z0-9._/-]{1,20}$/);
  const forms = (d, t) => [`[a](${d}${t})`, `[a](<${d}>${t})`, `<a href="${d}">`, `<a href='${d}'>`,
    `<a href=${d}>`, `<img src="${d}">`, `[a]: ${d}${t}`, `[a]: <${d}>${t}`, `> [a]: ${d}${t}`,
    `> > [a]: ${d}${t}`];
  test('property: every destination form yields the generated destination, CRLF included', () => {
    fc.assert(fc.property(dest, title, (d, t) => {
      for (const text of forms(d, t)) {
        assert.deepEqual(hrefsIn(text), [d], text);
        assert.deepEqual(hrefsIn(`${text}\r\n${text}\r\n`), [d, d], text);
      }
    }));
  });
  test('property: an angle destination keeps its spaces, with or without space before it', () => {
    const words = fc.array(dest, { minLength: 2, maxLength: 3 }).map((w) => w.join(' '));
    fc.assert(fc.property(words, fc.constantFrom('', ' '), title, (d, pad, t) => {
      assert.deepEqual(hrefsIn(`[a](${pad}<${d}>${t})`), [d]);
      assert.deepEqual(hrefsIn(`[a]: ${pad}<${d}>${t}`), [d]);
    }));
  });
  test('property: nothing is extracted from fenced code, inline code or HTML comments', () => {
    fc.assert(fc.property(dest, title, (d, t) => {
      for (const text of forms(d, t)) {
        const wrapped = [`\`\`\`\n${text}\n\`\`\``, `~~~\n${text}\n~~~`, `\`${text}\``,
          `<!-- ${text} -->`, `<!--\n${text}\n-->`];
        for (const w of wrapped) assert.deepEqual(hrefsIn(w), [], w);
        assert.deepEqual(hrefsIn(`<!-- c -->\n${text}`), hrefsIn(text), text);
      }
    }));
  });
  test('property: attributes are read only inside open tags', () => {
    fc.assert(fc.property(dest, dest, (d, e) => {
      assert.deepEqual(hrefsIn(`prose href="${d}" and src='${d}'`), [], 'prose');
      assert.deepEqual(hrefsIn(`<a title="href=${e}" href="${d}">`), [d], 'inside a quoted value');
      assert.deepEqual(hrefsIn(`<a title='src=${e}' src='${d}'>`), [d], 'single-quoted value');
    }));
  });
  test('property: an empty destination yields one empty string', () => {
    fc.assert(fc.property(fc.constantFrom('', ' ', '  ', '<>', ' <>'), (ws) => {
      assert.deepEqual(hrefsIn(`[a](${ws})`), ['']);
    }));
  });
});

// The tag shapes follow the WHATWG tokenizer (states "attribute value (double-quoted)",
// "(single-quoted)", "(unquoted)", "after attribute value (quoted)"). The expected URLs come
// from the generated attribute list, never from the scanner.
describe('tag scanner properties (#5427)', () => {
  const value = fc.stringMatching(/^[A-Za-z0-9._/-]{1,12}$/);
  const attr = fc.record({
    name: fc.constantFrom('href', 'src', 'title', 'data-x', 'alt'),
    form: fc.constantFrom('dq', 'sq', 'unquoted', 'unquoted-eq', 'boolean'),
    value,
    more: value,
    gap: fc.constantFrom(' ', '  ', '\n', '\t'),
  });
  const render = ({ name, form, value: v, more }) => ({
    dq: `${name}="${v}"`, sq: `${name}='${v}'`, unquoted: `${name}=${v}`,
    'unquoted-eq': `${name}=${v}=${more}`, boolean: name,
  })[form];
  const expected = ({ name, form, value: v, more }) => {
    if (!['href', 'src'].includes(name) || form === 'boolean') return [];
    return [form === 'unquoted-eq' ? `${v}=${more}` : v];
  };
  test('property: each attribute of a tag is read, whatever its neighbours look like', () => {
    fc.assert(fc.property(fc.array(attr, { minLength: 1, maxLength: 6 }), (attrs) => {
      const quoted = (a) => a.form === 'dq' || a.form === 'sq';
      // after a quoted value the next attribute may follow with no space at all
      const body = attrs.map((a, i) => (i > 0 && quoted(attrs[i - 1]) && a.gap === ' ' ? '' : a.gap)
        + render(a)).join('');
      const tag = `<a${attrs[0].gap}${body.replace(/^\s+/, '')}>`;
      assert.deepEqual(hrefsIn(tag), attrs.flatMap(expected), tag);
    }));
  });
  // Linear time is a property of the scan, not of a clock (RULESET.TESTS.no-timing-assertion):
  // each attack has a result known by construction at any size; a quadratic scan hangs the run.
  const N = 30000;
  const attacks = [
    ['unclosed comments', '<!--'],
    ['open tags without end', '<a '],
    ['quotes without partner', '<a href="'],
    ['values without partner', '<a href=\'x\' b="'],
  ];
  for (const [label, unit] of attacks) {
    test(`scan attack stays linear: ${label}`, () => {
      assert.deepEqual(hrefsIn(unit.repeat(N)), []);
      assert.deepEqual(hrefsIn(`[a](../x.md) ${unit.repeat(N)}`), ['../x.md']);
    });
  }
  test('scan attack stays linear: one tag with many attributes', () => {
    assert.deepEqual(hrefsIn(`<a ${'href=x '.repeat(N)}>`), Array(N).fill('x'));
  });
});
