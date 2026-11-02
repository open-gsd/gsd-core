// Regression for #5427: the guard lives in tests/helpers/pr-template-links.cjs (its header
// states what is checked). This file holds the example and parity tests and the template loop.
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');
const { extractLinks } = require('../scripts/gen-adr-index.cjs');
const {
  REPO, NEXT, hrefsIn, isBadLink, missingNext, repoPathOf, unresolvedAnchors, headingSet,
} = require('./helpers/pr-template-links.cjs');

const ROOT = path.join(__dirname, '..');
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
const hrefsOf = (f) => hrefsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'));

describe('heading anchors (#5427)', () => {
  test('reads ATX headings, including indented', () => {
    assert.deepEqual([...headingSet('# Title\n\n  ## Indented')], ['title', 'indented']);
  });
  test('reads setext headings; a rule after a blank line or an ATX heading is not one', () => {
    assert.deepEqual([...headingSet('# Title\nSub\n---\n  ## Indented')],
      ['title', 'sub', 'indented']);
    assert.deepEqual([...headingSet('Sub\n---\nTitle\n===\nTwo\nlines\n===')],
      ['sub', 'title', 'two-lines']);
    assert.deepEqual(
      [...headingSet('Para\n\n---\n# H\n---\n```\nFake\n---\n```\n- item\n---')], ['h']);
    assert.deepEqual([...headingSet('Set `commit_docs`\n===')], ['set-commit_docs']);
  });
  test('an em dash slugs like the features generator', () => {
    assert.deepEqual([...headingSet('## A — B')], [slugify('A — B')]);
    assert.deepEqual([...headingSet('## A — B')], ['a--b']);
  });
  test('four leading spaces is a code block, not a heading', () => {
    assert.equal(headingSet('    ## Code').size, 0);
  });
  test('indent limit is 3 spaces and level limit is 6 hashes', () => {
    assert.deepEqual([...headingSet('   ### Three\n###### Six\n####### Seven')], ['three', 'six']);
  });
  test('keeps underscores like GitHub', () => {
    assert.ok(headingSet('## Set `commit_docs` true').has('set-commit_docs-true'));
  });
  test('skips fenced headings and suffixes repeated slugs', () => {
    const md = '# A\n```\n## Fake\n```\n~~~~\n## Tilde\n~~~~\n## Same\n## Same\n## Same';
    assert.deepEqual([...headingSet(md)], ['a', 'same', 'same-1', 'same-2']);
  });
});

describe('heading anchors, fence edges (#5427)', () => {
  test('an info-string line inside a fence is content, not a closer', () => {
    assert.deepEqual([...headingSet('```\n```js\n## Fake\n```\n## Real')], ['real']);
  });
  test('an unclosed fence hides the rest of the file', () => {
    assert.deepEqual([...headingSet('# A\n```\n## Fake')], ['a']);
  });
  test('CRLF input yields clean slugs', () => {
    assert.deepEqual([...headingSet('# A b\r\n## C\r\n')], ['a-b', 'c']);
  });
});

describe('link extractor (#5427)', () => {
  const dest = fc.stringMatching(/^[A-Za-z0-9._/-]{1,20}$/);
  test('an unbalanced parenthesis is not a link', () => {
    for (const text of ['[a](x_(b)', '[a](x_(b "t")', '[a](x_((b))', '[a](']) {
      assert.deepEqual(hrefsIn(text), [], text);
    }
  });
  test('a `src=` or `href=` inside a URL is not an attribute', () => {
    assert.deepEqual(hrefsIn('[a](https://x/?src=1&href=2)'), ['https://x/?src=1&href=2']);
  });
  test('autolinks and bare URLs are out of scope: always absolute', () => {
    assert.deepEqual(hrefsIn('<https://x/a> and https://x/b'), []);
  });
  test('parity: agrees with the ADR gate extractLinks on shared inline links', () => {
    fc.assert(fc.property(dest, fc.constantFrom('', ' "t"', " 't'"), (d, t) => {
      const text = `[a](${d}${t})`;
      assert.deepEqual(extractLinks(text).map(({ target }) => target.split(' ')[0]), hrefsIn(text));
    }));
  });
});

describe('link extractor, edge forms (#5427)', () => {
  test('attributes tolerate whitespace around = and srcset lists every candidate', () => {
    assert.deepEqual(hrefsIn('<a href = "../x.md"> <img src\n=\n\'y.png\'>'), ['../x.md', 'y.png']);
    assert.deepEqual(hrefsIn('<img srcset="a.png 1x, ../b.png 2x">'), ['a.png', '../b.png']);
    assert.deepEqual(hrefsIn('<source srcset = \'c.png\'>'), ['c.png']);
  });
  test('a reference definition may put the destination on the next line or in a list', () => {
    const texts = ['[a]:\n../x.md', '[a]:\r\n  ../x.md', '- [a]: ../x.md', '1. [a]: ../x.md',
      '> - [a]: ../x.md'];
    for (const t of texts) assert.deepEqual(hrefsIn(t), ['../x.md'], t);
    assert.deepEqual(hrefsIn('[a]:\n[b]: ../x.md'), ['../x.md']);
  });
  test('an escaped parenthesis in a bare destination is not nesting', () => {
    assert.deepEqual(hrefsIn('[a](rel\\(x)'), ['rel\\(x']);
    assert.deepEqual(hrefsIn('[a](rel\\)x "t")'), ['rel\\)x']);
  });
  test('indented code is not scanned; paragraph and list continuations are', () => {
    const code = ['    [a](../x.md)', '\t[a](../x.md)', 'text\n\n    [a](../x.md)',
      '    code\n    [a](../x.md)'];
    for (const t of code) assert.deepEqual(hrefsIn(t), [], t);
    const text = ['para\n    [a](../x.md)', '- item\n\n    [a](../x.md)',
      '- item\n\n      [a](../x.md)'];
    for (const t of text) assert.deepEqual(hrefsIn(t), ['../x.md'], t);
  });
  test('a line that opens with an inline code span still yields its links', () => {
    assert.deepEqual(hrefsIn('`code` [a](../x.md)'), ['../x.md']);
  });
  test('an attribute name is read only inside an open tag', () => {
    assert.deepEqual(hrefsIn('see href="x" in prose'), []);
    assert.deepEqual(hrefsIn('<a title="href=x" href="y">'), ['y']);
  });
});

describe('next-ref existence and anchors (#5427)', () => {
  test('tree, raw and blame links on next must exist like blob links', () => {
    const hs = [`${REPO}tree/next/no-such-dir`, `${REPO}raw/next/nope.md`,
      `${REPO}blame/next/nope.md`, `${NEXT}nope.md`, `${REPO}tree/next/docs`,
      `${NEXT}CONTRIBUTING.md`, `${REPO}issues/1`];
    assert.deepEqual(missingNext(hs, 'tpl.md'), ['no-such-dir', 'nope.md', 'nope.md', 'nope.md']);
  });
  test('the existence check is case-exact and rejects dot segments', () => {
    const hs = [`${NEXT}contributing.md`, `${NEXT}.github/../CONTRIBUTING.md`,
      `${NEXT}CONTRIBUTING.md/x`];
    assert.deepEqual(missingNext(hs, 'tpl.md'),
      ['contributing.md', '.github/../CONTRIBUTING.md', 'CONTRIBUTING.md/x']);
  });
  test('a malformed percent escape names the template and the link', () => {
    assert.throws(() => repoPathOf(`${NEXT}a%zz.md`, 'tpl.md'), /tpl\.md.*a%zz\.md/);
  });
  test('a heading anchor resolves on rendered markdown, behind a query, percent-decoded', () => {
    const real = DOCS_ANCHOR.split('#')[1];
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#${real}`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?x=1#${real}`], 'tpl.md'), []);
    assert.deepEqual(
      unresolvedAnchors([`${NEXT}CONTRIBUTING.md#nope`,
        `${NEXT}.github/pull_request_template.md#nope`], 'tpl.md'),
      ['CONTRIBUTING.md#nope', '.github/pull_request_template.md#nope']);
    const seams = { headingsOf: () => new Set(['x_y']) };
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#x%5Fy`], 'tpl.md', seams), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md`, `${NEXT}no-such.md#a`,
      `${REPO}issues/1#a`], 'tpl.md'), []);
  });
  test('line anchors: ?plain=1, blame and non-markdown blob yes; rendered markdown no', () => {
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?plain=1#L274`,
      `${REPO}blame/next/CONTRIBUTING.md#L10`,
      `${NEXT}scripts/ci-test-scope.cjs#L10`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#L5`], 'tpl.md'),
      ['CONTRIBUTING.md#L5']);
    const heading = DOCS_ANCHOR.split('#')[1];
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?plain=1#${heading}`], 'tpl.md'),
      [`CONTRIBUTING.md#${heading}`]);
  });
});

describe('link classification (#5427)', () => {
  test('bad: relative, other hosts, repo links off next or on an unread view; ok: the rest', () => {
    const bad = ['guide/x.md', '../CONTRIBUTING.md', '#a', 'https://evil.example/x',
      `${REPO}blob/main/CONTRIBUTING.md`, `${REPO}tree/main/docs`,
      `${REPO}raw/main/CONTRIBUTING.md`, `${REPO}blame/main/CONTRIBUTING.md`,
      `${REPO}commits/main`, `${REPO}edit/main/CONTRIBUTING.md`,
      `${REPO}archive/main.zip`, `${REPO}commits/next/docs`, `${REPO}edit/next/x`,
      `${REPO}Blob/next/x`, `${REPO}bob/next/x`, `${REPO}blob/next/../x`,
      `${REPO}blob/next/%2e%2e/x`,
      `${REPO}issues/../blob/main/x`];
    assert.deepEqual(bad.filter(isBadLink), bad);
    const ok = [`${NEXT}a.md`, `${REPO}tree/next/docs`, `${REPO}raw/next/a.md`,
      `${REPO}blame/next/a.md`, `${REPO}discussions/1`, `${REPO}issues/1`, `${REPO}pull/1`,
      `${REPO}actions`, REPO, REPO.slice(0, -1), '?template=fix.md', `${REPO}tree/next`,
      `${REPO}#readme`, `${REPO}compare/main...next`,
      'https://GitHub.com/OPEN-GSD/GSD-CORE/blob/next/x', '#'];
    assert.deepEqual(ok.filter(isBadLink), []);
  });
  test('repoPathOf decodes percent escapes and drops query and anchor', () => {
    assert.equal(repoPathOf(`${NEXT}my%20guide.md?plain=1#a`), 'my guide.md');
  });
});

describe('angle-enclosed destinations (#5427)', () => {
  const ABS = `${NEXT}guide/my%20guide.md`;
  test('inline: relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide](<guide/my guide.md>)');
    assert.deepEqual(hs, ['guide/my guide.md']);
    assert.deepEqual(hs.filter(isBadLink), hs);
  });
  test('reference definition: relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide]: <guide/my guide.md>');
    assert.deepEqual(hs, ['guide/my guide.md']);
    assert.deepEqual(hs.filter(isBadLink), hs);
  });
  test('angle-enclosed absolute destination is returned once', () => {
    assert.deepEqual(hrefsIn('[t](<https://x/a>)'), ['https://x/a']);
    assert.deepEqual(hrefsIn('[t]: <https://x/a>'), ['https://x/a']);
  });
  test('absolute encoded form is accepted in both', () => {
    for (const t of [`[guide](<${ABS}>)`, `[guide]: <${ABS}>`]) {
      assert.deepEqual(hrefsIn(t).filter(isBadLink), []);
    }
  });
});

describe('PR template links (#5427)', () => {
  const files = ['.github/pull_request_template.md',
    ...['fix', 'feature', 'enhancement', 'registry-entry']
      .map((n) => `.github/PULL_REQUEST_TEMPLATE/${n}.md`)];
  for (const f of files) {
    test(`${f}: no link is bad`, () => {
      assert.deepEqual(hrefsOf(f).filter(isBadLink), []);
    });
    test(`${f}: blob/next links point at existing repo paths`, () => {
      assert.deepEqual(missingNext(hrefsOf(f), f), []);
    });
    test(`${f}: anchors on next resolve`, () => {
      assert.deepEqual(unresolvedAnchors(hrefsOf(f), f), []);
    });
  }
  test('"Using the wrong template?" links keep ?template= (maintainer ruling on #5427)', () => {
    for (const f of files) assert.ok(hrefsOf(f).some((h) => h.startsWith('?template=')), f);
  });
  for (const n of ['feature', 'enhancement']) {
    test(`${n}: links the Documentation Updates anchor`, () => {
      const f = `.github/PULL_REQUEST_TEMPLATE/${n}.md`;
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
