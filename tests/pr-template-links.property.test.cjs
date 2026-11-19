// Properties of the #5427 PR-template link guard (tests/helpers/pr-template-links.cjs).
// Expected values come from the class tables below, never from the guard's own predicates.
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');

const {
  REPO, NEXT, hrefsIn, unreadForms, isBadLink, unresolvedAnchors, headingSet,
} = require('./helpers/pr-template-links.cjs');

const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,19}$/); // never `.` or `..`
const rel = fc.array(seg, { minLength: 1, maxLength: 3 }).map((a) => a.join('/'));

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
    bad(fc.tuple(fc.constantFrom('.', '..', '%2e%2e', '.%2e', '%2E%2E', '.%2E'), rel)
      .map(([d, p]) => `${NEXT}${d}/${p}`)),
    // CommonMark decodes an entity or an escape in a destination: either can spell `..`
    bad(rel.map((p) => `${REPO}issues/&#46;&#46;/${p}`)),
    bad(rel.map((p) => `${REPO}issues/\\.\\./${p}`)),
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
    fc.assert(fc.property(classes,
      ([h, isBad]) => assert.equal(isBadLink(h), isBad, JSON.stringify(h))));
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
          assert.equal(found.length === 0, inRange,
            JSON.stringify(`${url}#${anchor} n=${n}`));
        }
      }
    }));
  });
});

// Each form sits in each block context; the guard reads the link or refuses the line. The
// contexts are written by hand, never derived from the guard.
describe('link extractor properties (#5427)', () => {
  const dest = fc.stringMatching(/^[A-Za-z0-9._/-]{1,20}$/);
  const contexts = [(x) => x, (x) => `\`\`\`\n${x}\n\`\`\``, (x) => `~~~\n${x}`,
    (x) => `<!--\n${x}\n-->`, (x) => `<!--\n\`\`\`\n-->\n${x}`, (x) => `<!-- ${x}`,
    (x) => `> ${x}`, (x) => `> > \`\`\`\n> ${x}`, (x) => `- ${x}`, (x) => `    ${x}`,
    (x) => `<details>\n${x}\n</details>`, (x) => `<b title="x ${x}`];
  const read = (d) => [`[a](${d})`, `[a](<${d}>)`, `![i](${d} "t")`, `[a](${d} 't')`];
  const unread = (d) => [`[a]: ${d}`, `[a]:\n${d}`, `<a href="${d}">`, `<img src=${d}>`,
    `<img srcset="${d} 1x">`, `[![i](a.png)](${d})`, `[a [b]](${d})`, `[a](${d}_(b))`];
  const oneLine = (d) => [`[a]: ${d}`, `<a href='${d}'>`, `<img src=${d}>`];
  test('property: every inline form is read in every block context, CRLF included', () => {
    fc.assert(fc.property(dest, (d) => {
      for (const form of read(d)) {
        for (const wrap of contexts) {
          const text = wrap(form);
          assert.ok(hrefsIn(text).includes(d), JSON.stringify(text));
          assert.ok(hrefsIn(text.replaceAll('\n', '\r\n')).includes(d), JSON.stringify(text));
        }
      }
    }));
  });
  test('property: a form the guard cannot read exactly is refused in every context', () => {
    fc.assert(fc.property(dest, (d) => {
      for (const form of unread(d)) {
        for (const wrap of contexts) {
          const text = wrap(form);
          assert.ok(unreadForms(text).length > 0, JSON.stringify(text));
          assert.ok(unreadForms(text.replaceAll('\n', '\r\n')).length > 0, JSON.stringify(text));
        }
      }
    }));
  });
  test('property: a code span hides an inline link; a definition or attribute in one stays refused',
    () => {
      fc.assert(fc.property(dest, (d) => {
        for (const form of read(d)) assert.deepEqual(hrefsIn(`\`${form}\``), [], form);
        for (const form of oneLine(d)) {
          assert.ok(unreadForms(`\`${form}\``).length > 0, form);
        }
      }));
    });
  test('property: an angle destination keeps its spaces, with or without space before it', () => {
    const words = fc.array(dest, { minLength: 2, maxLength: 3 }).map((w) => w.join(' '));
    fc.assert(fc.property(words, fc.constantFrom('', ' '), fc.constantFrom('', ' "t"'),
      (d, pad, t) => assert.deepEqual(hrefsIn(`[a](${pad}<${d}>${t})`), [d])));
  });
  test('property: an empty destination yields one empty string', () => {
    fc.assert(fc.property(fc.constantFrom('', ' ', '  ', '<>', ' <>'), (ws) => {
      assert.deepEqual(hrefsIn(`[a](${ws})`), ['']);
    }));
  });
});

// The expected anchors come from the generated blocks: the real headings before the first block
// that opens code or HTML in a way the sectionizer cannot place. A code, quoted or list-marker
// heading is never an anchor.
describe('heading anchors by construction (#5427)', () => {
  const word = fc.stringMatching(/^[a-z]{3,8}$/);
  const real = ['real', 'indented'];
  const blocks = {
    real: (w) => `## ${w}`,
    indented: (w) => `   ## ${w}`,
    fenced: (w) => `\`\`\`\n## ${w}\n> \`\`\`\n\`\`\``,
    tilde: (w) => `~~~\n## ${w}\n~~~`,
    quoted: (w) => `> ## ${w}`,
    marked: (w) => `- ## ${w}`,
    listFence: () => '- ```',
    html: () => '<details>',
    comment: () => '<!--',
    indentFence: () => '    ```',
  };
  test('property: a heading counts only where the sectionizer places it', () => {
    const entry = fc.tuple(word, fc.constantFrom(...Object.keys(blocks)));
    fc.assert(fc.property(fc.uniqueArray(entry, { selector: ([w]) => w, maxLength: 8 }),
      (entries) => {
        const md = entries.map(([w, kind]) => blocks[kind](w)).join('\n\n');
        const stop = entries.findIndex(([, kind]) => !blocks[kind]('x').includes('##'));
        const placed = stop < 0 ? entries : entries.slice(0, stop);
        const expected = placed.filter(([, kind]) => real.includes(kind)).map(([w]) => w);
        assert.deepEqual([...headingSet(md)], expected, JSON.stringify(md));
      }));
  });
  test('property: a heading after a stop line is never an anchor', () => {
    const stops = ['- ```', '<details>', '<!--', '    ```', '1. <b>'];
    fc.assert(fc.property(word, fc.constantFrom(...stops), (w, stop) => {
      assert.deepEqual([...headingSet(`## ${w}\n${stop}\n## after`)], [w]);
    }));
  });
});
