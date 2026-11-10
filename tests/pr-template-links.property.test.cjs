// Properties of the #5427 PR-template link guard (tests/helpers/pr-template-links.cjs).
// Expected values come from the class tables below, never from the guard's own predicates.
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');

const {
  REPO, NEXT, hrefsIn, isBadLink, unresolvedAnchors,
} = require('./helpers/pr-template-links.cjs');
const { extractLinks } = require('../scripts/gen-adr-index.cjs');
const { isPrTemplate } = require('../scripts/ci-test-scope.cjs');

const seg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,19}$/); // never `.` or `..`
const rel = fc.array(seg, { minLength: 1, maxLength: 3 }).map((a) => a.join('/'));
const title = fc.constantFrom('', ' "t"', " 't'", ' (t)');

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
  test('property: a destination with nested balanced parentheses parses at every depth', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), title, (depth, t) => {
      const d = `x_${'('.repeat(depth)}b${')'.repeat(depth)}`;
      assert.deepEqual(hrefsIn(`[a](${d}${t})`), [d], d);
      assert.deepEqual(hrefsIn(`[a](<${d}>${t})`), [d], d);
    }));
  });
  test('property: a comment opens only outside code, in both nestings, and a line that '
    + 'opens with an inline code span still yields its links', () => {
    fc.assert(fc.property(dest, (d) => {
      const link = `[a](${d})`;
      // a fence opener inside a comment hides nothing after the comment
      assert.deepEqual(hrefsIn(`<!--\n\`\`\`\n-->\n${link}`), [d], 'opener in comment');
      // a `<!--` inside a fence or inline code opens no comment
      assert.deepEqual(hrefsIn(`\`\`\`\n<!--\n\`\`\`\n${link}\n-->`), [d], 'comment in fence');
      assert.deepEqual(hrefsIn(`\`<!--\` ${link} -->`), [d], 'comment in inline code');
      assert.deepEqual(hrefsIn(`\`code\` ${link}`), [d], 'line opens with a code span');
    }));
  });
  test('property: attributes are read only inside open tags', () => {
    fc.assert(fc.property(dest, dest, (d, e) => {
      assert.deepEqual(hrefsIn(`prose href="${d}" and src='${d}'`), [], 'prose');
      assert.deepEqual(hrefsIn(`<a title="href=${e}" href="${d}">`), [d], 'inside a quoted value');
      assert.deepEqual(hrefsIn(`<a title='src=${e}' src='${d}'>`), [d], 'single-quoted value');
    }));
  });
});

describe('PR template locations (#5427)', () => {
  const recase = (word) => fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((flags) => [...word].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(''));
  const where = fc.constantFrom('', 'docs/', '.github/');
  test('property: isPrTemplate holds for every location x casing and fails for near-misses', () => {
    fc.assert(fc.property(where, recase('pull_request_template'), seg, (dir, name, f) => {
      assert.ok(isPrTemplate(`${dir}${name}.md`), `${dir}${name}.md`);
      assert.ok(isPrTemplate(`${dir}${name}/${f}.md`), `${dir}${name}/${f}.md`);
      for (const near of [`${dir}${name}.md.bak`, `${dir}${name}.mdx`, `${dir}${name}s/${f}.md`,
        `${dir}${name}`, `${dir}sub/${name}.md`, `x${dir}${name}.md`, `${dir}${name}/`]) {
        assert.ok(!isPrTemplate(near), near);
      }
    }));
  });
});

describe('ADR gate extractLinks (#5427)', () => {
  const d = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,19}$/);
  const text = fc.stringMatching(/^[A-Za-z0-9 ]{0,10}$/);
  const ttl = fc.constantFrom('', ' "t"', " 't'");
  test('property: a bracket-free text and a parenthesis-free target give one link', () => {
    fc.assert(fc.property(text, d, ttl, (a, dest, t) => {
      assert.deepEqual(extractLinks(`[${a}](${dest}${t})`), [{ line: 1, target: dest + t }]);
    }));
  });
  test('property: an open parenthesis in the destination or a stray close bracket or newline'
    + ' in the text is no link; a close parenthesis ends the link; an open bracket restarts it',
  () => {
    fc.assert(fc.property(text, d, ttl, (a, dest, t) => {
      assert.deepEqual(extractLinks(`[${a}](${dest}(${t})`), []);
      assert.deepEqual(extractLinks(`[${a}](${dest})x${t})`), [{ line: 1, target: dest }]);
      for (const bad of [']', '\n']) {
        assert.deepEqual(extractLinks(`[${a}${bad}${a}](${dest}${t})`), []);
      }
      assert.deepEqual(extractLinks(`[${a}[${a}](${dest}${t})`), [{ line: 1, target: dest + t }]);
    }));
  });
});

describe('escapes and empty destinations (#5427)', () => {
  const n = fc.integer({ min: 0, max: 5 });
  const bs = (k) => '\\'.repeat(k);
  test('property: escaped label end', () => {
    fc.assert(fc.property(n, rel, (k, d) => {
      assert.deepEqual(hrefsIn(`[a${bs(k)}](${d})`), k % 2 ? [] : [d]);
    }));
  });
  test('property: escaped reference label', () => {
    fc.assert(fc.property(n, rel, (k, d) => {
      assert.deepEqual(hrefsIn(`[a${bs(k)}]: ${d}`), k % 2 ? [] : [d]);
    }));
  });
  test('property: an empty destination yields one empty string, never a link', () => {
    fc.assert(fc.property(fc.constantFrom('', ' ', '  ', '<>', ' <>'), (ws) => {
      assert.deepEqual(hrefsIn(`[a](${ws})`), ['']);
      assert.deepEqual(extractLinks(`[a](${ws})`), []);
    }));
  });
});
