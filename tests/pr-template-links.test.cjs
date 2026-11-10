// Regression for #5427: the guard lives in tests/helpers/pr-template-links.cjs (its header
// states what is checked). This file holds the example and parity tests and the template loop.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');
const { extractLinks, maskCode } = require('../scripts/gen-adr-index.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  REPO, NEXT, hrefsIn, isBadLink, nextRel, missingNext, repoPathOf, unresolvedAnchors, headingSet,
  anchorKind,
} = require('./helpers/pr-template-links.cjs');
const { isPrTemplate, isTemplateLinkDoc } = require('../scripts/ci-test-scope.cjs');

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
  test('a heading slugify cannot reproduce gets no anchor, so a link to it fails', () => {
    const md = '## Café\n## Ü1\n## See [x](y)\n## A [b][c]\n## _emph_ x\n'
      + '## Keep `snake_case` and snake_case';
    assert.deepEqual([...headingSet(md)], ['keep-snake_case-and-snake_case']);
    for (const a of ['caf', 'caf-1', 'see-xy', 'a-bc', '_emph_-x']) {
      assert.equal(headingSet(md).has(a), false, a);
    }
  });
  test('blockquote headings and <a id>/<a name> anchors count; code hides them', () => {
    const md = '## Quoted\n> ## Quoted\n> > Deep\n> ---\n<a id="manual"></a> <a name=\'old\'>\n'
      + '`<a id="code">`\n## After';
    assert.deepEqual([...headingSet(md)], ['quoted', 'quoted-1', 'deep', 'after', 'manual', 'old']);
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
});

describe('link extractor, edge forms (#5427)', () => {
  test('a `](` with no opening bracket is text; attribute text in an open tag is not prose', () => {
    assert.deepEqual(hrefsIn('stray ](../x.md) and [ok](../y.md) and [see [1]](../z.md)'),
      ['../y.md', '../z.md']);
    assert.deepEqual(hrefsIn('[a]\\](../x.md)\n\n](../w.md)'), []);
    assert.deepEqual(hrefsIn('\\\\[x](../y.md)'), ['../y.md']);
    assert.deepEqual(hrefsIn('\\[x](../y.md)'), []);
    assert.deepEqual(hrefsIn('<a title="[x](../old.md)">t</a>'), []);
    assert.deepEqual(hrefsIn('<a title="[x](../old.md)" href="../h.md">t</a>'), ['../h.md']);
  });
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
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${REPO}raw/next/CONTRIBUTING.md#nope`], 'tpl.md'),
      ['CONTRIBUTING.md#nope']);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md`, `${NEXT}no-such.md#a`,
      `${REPO}issues/1#a`], 'tpl.md'), []);
  });
  test('line anchors: ?plain=1, blame and non-markdown blob yes; rendered markdown no', () => {
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?plain=1#L274`,
      `${REPO}blame/next/CONTRIBUTING.md#L10`,
      `${NEXT}scripts/ci-test-scope.cjs#L10`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?plain=1#L5-L2`], 'tpl.md'),
      ['CONTRIBUTING.md#L5-L2']);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#L5`], 'tpl.md'),
      ['CONTRIBUTING.md#L5']);
    for (const rel of ['X.md', 'X.MD', 'X.Md']) {
      assert.equal(anchorKind({ segs: ['blob', 'next', rel], tail: '' }, rel), 'heading', rel);
    }
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
      `${REPO}issues/../blob/main/x`, `${REPO}/blob/main/x`, `${REPO}blob/next//x`,
      `${REPO}blob//next/x`, `${REPO}/`, `${NEXT}CONTRIBUTING.md/`, `${REPO}tree/next/docs/`];
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

describe('escaped brackets, empty destinations, reference labels (#5427)', () => {
  test('an escaped closing bracket is text, an even run is a link', () => {
    assert.deepEqual(hrefsIn('[a\\](../x.md)'), []);
    assert.deepEqual(hrefsIn('[a\\\\](../x.md)'), ['../x.md']);
    assert.deepEqual(extractLinks('[a\\](x.md)'), []);
  });
  test('an empty destination is reported by the guard and ignored by extractLinks', () => {
    assert.deepEqual(hrefsIn('[a]()'), ['']);
    assert.deepEqual(hrefsIn('[a](<>)'), ['']);
    assert.ok(hrefsIn('[a]()').filter(isBadLink).length > 0);
    assert.deepEqual(extractLinks('[a]()'), []);
    assert.deepEqual(extractLinks('[a](<>)'), []);
    assert.deepEqual(missingNext([''], 'x.md'), []);
    assert.deepEqual(missingNext([`${NEXT}CONTRIBUTING.md%2F`], 'x.md'), ['CONTRIBUTING.md/']);
    assert.deepEqual(missingNext([`${NEXT}.%2FCONTRIBUTING.md`], 'x.md'), ['./CONTRIBUTING.md']);
    assert.deepEqual(unresolvedAnchors([''], 'x.md'), []);
  });
  test('reference labels honour escaped brackets', () => {
    assert.deepEqual(hrefsIn('[a\\]b]: ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('[a\\]: ../x.md'), []);
    assert.deepEqual(hrefsIn('[a\\\\]: ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('[a]:\n[b\\]c]: ../x.md'), ['../x.md']);
  });
});

describe('angle-enclosed destinations (#5427)', () => {
  const ABS = `${NEXT}guide/my%20guide.md`;
  test('inline: relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide](<guide/my guide.md>)');
    assert.deepEqual(hrefsIn('[a](<x y>)'), ['x y']);
    assert.deepEqual(hrefsIn('[a]( <x y>)'), ['x y']);
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

// The pre-#5427 ADR-gate extractor, frozen as the oracle for the shared-scanner rewrite.
const oldExtractLinks = (text) => {
  const out = [];
  const re = /!?\[[^\][\n]*\]\(([^()\n]*)\)/g;
  maskCode(String(text)).split(/\r?\n/).forEach((l, i) => {
    re.lastIndex = 0;
    for (let m = re.exec(l); m !== null; m = re.exec(l)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
};

describe('ADR gate extractLinks over the shared scanner (#5427)', () => {
  test('agrees with the frozen regex implementation on every docs/adr file', () => {
    const dir = path.join(ROOT, 'docs', 'adr');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'docs/adr/*.md');
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.deepEqual(extractLinks(text), oldExtractLinks(text), f);
    }
  });
  test('pins the two intentional differences and the forms that keep their results', () => {
    assert.deepEqual(extractLinks('[a](x y)'), []);
    assert.deepEqual(extractLinks('[a]()'), []);
    assert.deepEqual(extractLinks('[a](x "t")'), [{ line: 1, target: 'x "t"' }]);
    assert.deepEqual(extractLinks('[a](<x y>)'), [{ line: 1, target: '<x y>' }]);
    assert.deepEqual(extractLinks('![i](p.png)'), [{ line: 1, target: 'p.png' }]);
  });
});

const entries = (root, dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .map((e) => ({ rel: path.posix.join(dir, e.name), dir: e.isDirectory() }));
// Every file GitHub reads as a PR template: root, docs/ and .github/, plain or in a directory.
const templateFiles = (root = ROOT) => ['.', 'docs', '.github']
  .flatMap((d) => entries(root, d))
  .flatMap((e) => (e.dir && isPrTemplate(`${e.rel}/x`) ? entries(root, e.rel) : [e]))
  .filter((e) => !e.dir)
  .map((e) => e.rel)
  .filter(isPrTemplate);

describe('templateFiles (#5427)', () => {
  test('lists files, never a subdirectory of a template directory', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    const sub = path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE', 'fix.md'), '');
    fs.writeFileSync(path.join(sub, 'x.md'), '');
    fs.writeFileSync(path.join(dir, 'pull_request_template.md'), '');
    assert.deepEqual(templateFiles(dir).sort(),
      ['.github/PULL_REQUEST_TEMPLATE/fix.md', 'pull_request_template.md']);
  });
});

describe('PR template links (#5427)', () => {
  const eachTemplate = (check) => {
    const files = templateFiles();
    assert.ok(files.length >= 5, `templates: ${files}`);
    assert.ok(files.includes('.github/pull_request_template.md'), `templates: ${files}`);
    const failing = files.map((f) => [f, check(f, hrefsOf(f))]).filter(([, found]) => found.length);
    assert.deepEqual(Object.fromEntries(failing), {});
  };
  test('no link is bad', () => eachTemplate((f, hs) => hs.filter(isBadLink)));
  test('blob/next links point at existing repo paths',
    () => eachTemplate((f, hs) => missingNext(hs, f)));
  test('every repo file a template links on next selects the guard (isTemplateLinkDoc)', () => {
    eachTemplate((f, hs) => hs.filter((h) => nextRel(h) !== undefined)
      .filter((h) => !isTemplateLinkDoc(repoPathOf(h, f))));
  });
  test('anchors on next resolve', () => eachTemplate((f, hs) => unresolvedAnchors(hs, f)));
  test('"Using the wrong template?" links keep ?template= and name an existing template', () => {
    const names = ['fix', 'feature', 'enhancement', 'registry-entry'];
    const files = names.map((n) => `.github/PULL_REQUEST_TEMPLATE/${n}.md`);
    const all = templateFiles();
    for (const f of ['.github/pull_request_template.md', ...files]) {
      const values = hrefsOf(f).filter((h) => h.startsWith('?template='))
        .map((h) => h.slice('?template='.length));
      assert.ok(values.length, f);
      // GitHub resolves the value against .github/PULL_REQUEST_TEMPLATE/, or .github/ for a path
      const missing = values.filter((v) => !all.includes(`.github/PULL_REQUEST_TEMPLATE/${v}`)
        && !all.includes(`.github/${v}`));
      assert.deepEqual(missing, [], f);
    }
  });
  for (const n of ['feature', 'enhancement']) {
    test(`${n}: links the Documentation Updates anchor`, () => {
      const f = `.github/PULL_REQUEST_TEMPLATE/${n}.md`;
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
