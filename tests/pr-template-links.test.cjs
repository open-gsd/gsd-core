// Regression for #5427: the guard lives in tests/helpers/pr-template-links.cjs (its header
// states what is checked). This file holds the example tests and the template loop.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  REPO, NEXT, hrefsIn, isBadLink, missingNext, repoPathOf, unresolvedAnchors, headingSet,
  anchorKind, lineCountOf, readRepoFile,
} = require('./helpers/pr-template-links.cjs');

const ROOT = path.join(__dirname, '..');
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
const hrefsOf = (f) => hrefsIn(readRepoFile(f));

describe('heading anchors (#5427)', () => {
  test('reads ATX headings, including indented', () => {
    assert.deepEqual([...headingSet('# Title\n\n  ## Indented')], ['title', 'indented']);
  });
  test('an em dash slugs like the features generator', () => {
    assert.deepEqual([...headingSet('## A — B')], [slugify('A — B')]);
    assert.deepEqual([...headingSet('## A — B')], ['a--b']);
  });
  test('a heading slugify cannot reproduce gets no anchor, so a link to it fails', () => {
    const md = '## Café\n## Ü1\n## See [x](y)\n## A [b][c]\n## _emph_ x\n'
      + '## <kbd>Ctrl</kbd> key\n## A &amp; B\n## Keep `snake_case` and snake_case';
    assert.deepEqual([...headingSet(md)], ['keep-snake_case-and-snake_case']);
    for (const a of ['caf', 'caf-1', 'see-xy', 'a-bc', '_emph_-x', 'kbdctrlkbd-key', 'a-amp-b']) {
      assert.equal(headingSet(md).has(a), false, a);
    }
  });
  test('blockquote headings and <a id>/<a name> anchors count; code hides them', () => {
    const md = '## Quoted\n> ## Quoted\n<a id="manual"></a> <a name=\'old\'>\n'
      + '`<a id="code">`\n## After';
    assert.deepEqual([...headingSet(md)], ['quoted', 'quoted-1', 'after', 'manual', 'old']);
  });
  test('a quoted heading inside a fence is code, a fenced quote block hides its own', () => {
    assert.deepEqual([...headingSet('```\n> ## Fake\n```\n## Real')], ['real']);
    assert.deepEqual([...headingSet('> ```\n> ## Fake\n> ```\n> ## Real')], ['real']);
  });
  test('a comment hides headings and <a id> anchors', () => {
    const md = '<!-- <a id="c"></a> -->\n<!--\n## Cm\n> ## Cq\n-->\n<a id="ok"></a>';
    assert.deepEqual([...headingSet(md)], ['ok']);
  });
  test('a `<!--` inside a code span is no comment: later headings and the span text stay', () => {
    assert.deepEqual([...headingSet('## Marker `<!--` here\n## After')],
      [slugify('Marker `<!--` here'), 'after']);
    assert.deepEqual([...headingSet('## A `<!-- x -->` b')], [slugify('A `<!-- x -->` b')]);
  });
  test('only the id and name attributes make an anchor, not data-id or aria-name', () => {
    assert.deepEqual([...headingSet('<a data-id="x" aria-name="y"></a>')], []);
    assert.deepEqual([...headingSet('<a href="u" id="z" class="c"></a>')], ['z']);
  });
  test('indent limit is 3 spaces and level limit is 6 hashes', () => {
    assert.equal(headingSet('    ## Code').size, 0);
    assert.deepEqual([...headingSet('   ### Three\n##### Five\n###### Six\n####### Seven')],
      ['three', 'five', 'six']);
  });
  test('keeps underscores like GitHub', () => {
    assert.ok(headingSet('## Set `commit_docs` true').has('set-commit_docs-true'));
  });
  test('skips fenced headings and suffixes repeated slugs', () => {
    const md = '# A\n```\n## Fake\n```\n~~~~\n## Tilde\n~~~~\n## Same\n## Same\n## Same';
    assert.deepEqual([...headingSet(md)], ['a', 'same', 'same-1', 'same-2']);
  });
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
  test('inline links, images, reference definitions and tag attributes are read', () => {
    const md = '[a](../a.md) ![i](p.png "t")\n[r]: ../r.md\n<a href="../h.md"> <img src=\'y.png\'>';
    assert.deepEqual(hrefsIn(md).sort(), ['../a.md', '../h.md', '../r.md', 'p.png', 'y.png']);
  });
  test('links in a fence, a comment or a code span are code, not links', () => {
    assert.deepEqual(hrefsIn('```\n[a](../x.md)\n```\n<!-- [b](../y.md) -->\n`[c](../z.md)`'), []);
    assert.deepEqual(hrefsIn('> ```\n> [a](../x.md)\n> ```\n> [b](../y.md)'), ['../y.md']);
  });
  test('an unbalanced parenthesis is not a link', () => {
    for (const text of ['[a](x_(b)', '[a](x_(b "t")', '[a](x_((b))', '[a](']) {
      assert.deepEqual(hrefsIn(text), [], JSON.stringify(text));
    }
  });
  test('a `src=` or `href=` inside a URL is not an attribute', () => {
    assert.deepEqual(hrefsIn('[a](https://x/?src=1&href=2)'), ['https://x/?src=1&href=2']);
  });
  test('autolinks and bare URLs are out of scope: always absolute', () => {
    assert.deepEqual(hrefsIn('<https://x/a> and https://x/b'), []);
  });
  test('attributes tolerate whitespace around = and srcset lists every candidate', () => {
    assert.deepEqual(hrefsIn('<a href = "../x.md"> <img src\n= \'y.png\'>'), ['../x.md', 'y.png']);
    assert.deepEqual(hrefsIn('<img srcset="a.png 1x, ../b.png 2x">'), ['a.png', '../b.png']);
    assert.deepEqual(hrefsIn('<source srcset = \'c.png\'>'), ['c.png']);
  });
  test('an attribute name is read only inside an open tag', () => {
    assert.deepEqual(hrefsIn('see href="x" in prose'), []);
    assert.deepEqual(hrefsIn('<a title="href=x" href="y">'), ['y']);
  });
  // Shapes of the WHATWG HTML tokenizer: an odd attribute drops only itself, never its siblings.
  test('an attribute may follow a quoted value with no space; `=` stays in an unquoted one', () => {
    assert.deepEqual(hrefsIn('<a title=a=b href="../x.md">'), ['../x.md']);
    assert.deepEqual(hrefsIn('<a href="../x.md"title="t" src=\'y.png\'>'), ['../x.md', 'y.png']);
    assert.deepEqual(hrefsIn('<a href=../x=1.md>'), ['../x=1.md']);
    assert.deepEqual(hrefsIn('<a data-x href=../x.md/>'), ['../x.md/']);
  });
  test('a tag with a quote that has no partner, or no closing `>`, yields nothing', () => {
    assert.deepEqual(hrefsIn('<a href="../x.md'), []);
    assert.deepEqual(hrefsIn('<a href="../x.md"'), []);
    assert.deepEqual(hrefsIn('<a href="x <img src=\'y.png\'>'), ['y.png']);
  });
  test('a quoted value keeps `>`, `<!--` and the other quote; an unquoted one ends at `>`', () => {
    assert.deepEqual(hrefsIn('<a title="a>b <!-- c" href="../x.md"> [l](../y.md)'),
      ['../y.md', '../x.md']);
    assert.deepEqual(hrefsIn('<a title="it\'s" href="../x.md">'), ['../x.md']);
    assert.deepEqual(hrefsIn('<a title=\'say "x"\' href="../x.md">'), ['../x.md']);
    assert.deepEqual(hrefsIn('<a title=a>b href="../x.md">'), []);
  });
  test('only an open tag starts a scan: end tags, `<` before a non-letter and bare `<`', () => {
    for (const text of ['', '<', '<>', '</a href="../x.md">', '<1 href="../x.md">',
      '< a href="../x.md">', 'a <']) {
      assert.deepEqual(hrefsIn(text), [], JSON.stringify(text));
    }
  });
  test('attribute names fold to lower case and may start with `=`; values may be empty', () => {
    assert.deepEqual(hrefsIn('<A HREF="../x.md">'), ['../x.md']);
    assert.deepEqual(hrefsIn('<a =x href="../x.md">'), ['../x.md']);
    assert.deepEqual(hrefsIn('<a href="">'), ['']);
    assert.deepEqual(hrefsIn('<a href=>'), ['']);
    assert.deepEqual(hrefsIn('<img srcset=", ,">'), []);
  });
  test('a comment ends at its first `-->`; `<!-->` is empty; an open one hides the rest', () => {
    assert.deepEqual(hrefsIn('<!--> [a](../x.md)'), ['../x.md']);
    assert.deepEqual(hrefsIn('<!---> [a](../x.md)'), ['../x.md']);
    assert.deepEqual(hrefsIn('<!-- a --> [a](../x.md) <!-- [b](../y.md) -->'), ['../x.md']);
    assert.deepEqual(hrefsIn('[a](../x.md) <!-- [b](../y.md)'), ['../x.md']);
  });
  test('labels and angle destinations stop at 999 characters', () => {
    const long = (n) => 'a'.repeat(n);
    for (const n of [998, 999]) {
      assert.deepEqual(hrefsIn(`[${long(n)}]: ../x.md`), ['../x.md'], `label ${n}`);
      assert.deepEqual(hrefsIn(`[t](<${long(n)}>)`), [long(n)], `inline angle ${n}`);
      assert.deepEqual(hrefsIn(`[t]: <${long(n)}>`), [long(n)], `definition angle ${n}`);
    }
    assert.deepEqual(hrefsIn(`[${long(1000)}]: ../x.md`), []);
    assert.deepEqual(hrefsIn(`[t](<${long(1000)}>)`), [`<${long(1000)}>`]);
    assert.deepEqual(hrefsIn(`[t]: <${long(1000)}>`), [`<${long(1000)}>`]);
  });
  test('a label holds at least one character', () => {
    assert.deepEqual(hrefsIn('[]: ../x.md'), []);
    assert.deepEqual(hrefsIn('[a]: ../x.md'), ['../x.md']);
  });
  test('a definition may break a line after the colon or in the label, not at a blank line', () => {
    assert.deepEqual(hrefsIn('[a]:\n  ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('[a]:\r\n../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('[foo\nbar]: ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('[foo\n\nbar]: ../x.md'), []);
  });
  test('a heading code span of any length is code: `_` inside it is no emphasis', () => {
    for (const code of ['`_a`', `\`_${'a'.repeat(5000)}\``, '``a`_b``']) {
      const md = `## x ${code} y`;
      assert.deepEqual([...headingSet(md)], [slugify(md.slice(3))], JSON.stringify(code));
    }
    assert.equal(headingSet('## x _a y').size, 0);
  });
  test('a quote marker takes at most 3 spaces of indent', () => {
    assert.deepEqual(hrefsIn('   > [a]: ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('    > [a]: ../x.md'), []);
  });
  test('a reference definition is indented at most 3 spaces', () => {
    assert.deepEqual(hrefsIn('   [a]: ../x.md'), ['../x.md']);
    assert.deepEqual(hrefsIn('    [a]: ../x.md'), []);
    assert.deepEqual(hrefsIn('  [a]: ../x.md'), ['../x.md']);
  });
  test('a title does not belong to the destination', () => {
    assert.deepEqual(hrefsIn('[a](../x.md "t")\n[b]: ../y.md "t"'), ['../x.md', '../y.md']);
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
  test('a malformed percent escape quotes control bytes in its message', () => {
    assert.throws(() => repoPathOf(`${NEXT}a%zz\n::add-mask::.md`, 'tpl.md'),
      (e) => !e.message.includes('\n') && e.link.includes('\n'));
  });
  test('a malformed percent escape names the template and the link', () => {
    assert.throws(() => repoPathOf(`${NEXT}a%zz.md`, 'tpl.md'),
      { where: 'tpl.md', link: `${NEXT}a%zz.md` });
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
  test('lineCountOf counts a last line with or without a trailing newline', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    for (const [text, n] of [['', 0], ['a', 1], ['a\n', 1], ['a\nb', 2], ['a\r\nb\r\n', 2]]) {
      fs.writeFileSync(path.join(dir, 'f.txt'), text);
      assert.equal(lineCountOf('f.txt', dir), n, JSON.stringify(text));
    }
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
      const kind = anchorKind({ segs: ['blob', 'next', rel], tail: '' }, rel);
      assert.equal(kind, 'heading', JSON.stringify(rel));
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
      `${NEXT}.../x`, `${NEXT}%2e%2e%2e/x`, `${REPO}blame/next/a.md`, `${REPO}discussions/1`,
      `${REPO}issues/1`, `${REPO}pull/1`,
      `${REPO}actions`, REPO, REPO.slice(0, -1), '?template=fix.md', `${REPO}tree/next`,
      `${REPO}#readme`, `${REPO}compare/main...next`,
      'https://GitHub.com/OPEN-GSD/GSD-CORE/blob/next/x', '#'];
    assert.deepEqual(ok.filter(isBadLink), []);
  });
  test('repoPathOf decodes percent escapes and drops query and anchor', () => {
    assert.equal(repoPathOf(`${NEXT}my%20guide.md?plain=1#a`), 'my guide.md');
  });
  test('an empty destination is reported by the guard', () => {
    assert.deepEqual(hrefsIn('[a]()'), ['']);
    assert.deepEqual(hrefsIn('[a](<>)'), ['']);
    assert.deepEqual(hrefsIn('[a]: <>'), ['']);
    assert.ok(hrefsIn('[a]()').filter(isBadLink).length > 0);
    assert.ok(hrefsIn('[a]: <>').filter(isBadLink).length > 0);
    assert.deepEqual(missingNext([''], 'x.md'), []);
    assert.deepEqual(missingNext([`${NEXT}CONTRIBUTING.md%2F`], 'x.md'), ['CONTRIBUTING.md/']);
    assert.deepEqual(missingNext([`${NEXT}.%2FCONTRIBUTING.md`], 'x.md'), ['./CONTRIBUTING.md']);
    assert.deepEqual(unresolvedAnchors([''], 'x.md'), []);
  });
});

describe('readRepoFile (#5427)', () => {
  // The refusal of a link out of the repo is the ADR gate's existsCaseExact, tested in
  // tests/adr-index-gate.test.cjs; this test pins that the helper reads through it.
  test('reads a repo file; a missing name, a wrong case or a path outside is refused', () => {
    assert.match(readRepoFile('CONTRIBUTING.md'), /^# /m);
    for (const rel of ['no-such-file.md', 'contributing.md', '../outside.md']) {
      assert.throws(() => readRepoFile(rel), /no such file inside the repo/, JSON.stringify(rel));
    }
  });
});

const entries = (root, dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .map((e) => ({ rel: path.posix.join(dir, e.name), dir: e.isDirectory() }));
// GitHub's PR-template locations: the root, docs/ and .github/, as pull_request_template.md or a
// file directly in a PULL_REQUEST_TEMPLATE/ directory (names case-insensitive).
const isPrTemplate = (rel) => /^pull_request_template(?:\.md|\/[^/]+)$/i
  .test(rel.replace(/^(?:\.github|docs)\//, ''));
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
    // quoted: a file name is data, and a raw newline could forge a `::command::` log line
    assert.ok(files.length >= 5, `templates: ${JSON.stringify(files)}`);
    assert.ok(files.includes('.github/pull_request_template.md'),
      `templates: ${JSON.stringify(files)}`);
    const failing = files.map((f) => [f, check(f, hrefsOf(f))]).filter(([, found]) => found.length);
    assert.deepEqual(Object.fromEntries(failing), {});
  };
  test('no link is bad', () => eachTemplate((f, hs) => hs.filter(isBadLink)));
  test('blob/next links point at existing repo paths',
    () => eachTemplate((f, hs) => missingNext(hs, f)));
  test('anchors on next resolve', () => eachTemplate((f, hs) => unresolvedAnchors(hs, f)));
  test('"Using the wrong template?" links keep ?template= and name an existing template', () => {
    const names = ['fix', 'feature', 'enhancement', 'registry-entry'];
    const files = names.map((n) => `.github/PULL_REQUEST_TEMPLATE/${n}.md`);
    const all = templateFiles();
    for (const f of ['.github/pull_request_template.md', ...files]) {
      const values = hrefsOf(f).filter((h) => h.startsWith('?template='))
        .map((h) => h.slice('?template='.length));
      assert.ok(values.length, JSON.stringify(f));
      // GitHub resolves the value against .github/PULL_REQUEST_TEMPLATE/, or .github/ for a path
      const missing = values.filter((v) => !all.includes(`.github/PULL_REQUEST_TEMPLATE/${v}`)
        && !all.includes(`.github/${v}`));
      assert.deepEqual(missing, [], JSON.stringify(f));
    }
  });
  for (const n of ['feature', 'enhancement']) {
    test(`${n}: links the Documentation Updates anchor`, () => {
      const f = `.github/PULL_REQUEST_TEMPLATE/${n}.md`;
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
