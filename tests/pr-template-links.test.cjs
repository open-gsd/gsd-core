// Regression for #5427: the guard lives in tests/helpers/pr-template-links.cjs (its header
// states what is checked). This file holds the example tests and the template loop.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const {
  REPO, NEXT, hrefsIn, unreadForms, isBadLink, missingNext, repoPathOf, unresolvedAnchors,
  headingSet, anchorKind, lineCountOf, readRepoFile,
} = require('./helpers/pr-template-links.cjs');

const ROOT = path.join(__dirname, '..');
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
const hrefsOf = (f) => hrefsIn(readRepoFile(f));
// The 1-based line numbers of the lines unreadForms refuses.
const refused = (text) => unreadForms(text).map((entry) => Number.parseInt(entry, 10));
// An anchor list the guard gives is a subset of the ids GitHub renders for the same text.
const anchors = (md) => [...headingSet(md)];

describe('heading anchors (#5427)', () => {
  test('reads ATX headings, including indented', () => {
    assert.deepEqual(anchors('# Title\n\n  ## Indented'), ['title', 'indented']);
  });
  test('an em dash slugs like the features generator', () => {
    assert.deepEqual(anchors('## A — B'), [slugify('A — B')]);
    assert.deepEqual(anchors('## A — B'), ['a--b']);
  });
  test('a heading slugify cannot reproduce gets no anchor, so a link to it fails', () => {
    const md = '## Café\n## Ü1\n## See [x](y)\n## A [b][c]\n## _emph_ x\n'
      + '## <kbd>Ctrl</kbd> key\n## A &amp; B\n## Keep `snake_case` and snake_case';
    assert.deepEqual(anchors(md), ['keep-snake_case-and-snake_case']);
    for (const a of ['caf', 'caf-1', 'see-xy', 'a-bc', '_emph_-x', 'kbdctrlkbd-key', 'a-amp-b']) {
      assert.equal(headingSet(md).has(a), false, a);
    }
  });
  test('a tab or a non-ASCII space in a heading gives no anchor (GitHub drops it)', () => {
    const md = '## a\tb\n## a\u00a0b\n## a\u2003b\n## a b';
    assert.deepEqual(anchors(md), ['a-b']);
    assert.deepEqual(anchors('## a\tb\n## a\u00a0b\n## a\u2003b'), []);
  });
  test('an entity of 32 characters or fewer is unslugable; a longer run is plain text', () => {
    for (const [n, size] of [[31, 0], [32, 0], [33, 1]]) {
      assert.equal(headingSet(`## x &${'a'.repeat(n)};`).size, size, `entity of ${n}`);
    }
    assert.equal(headingSet('## x &;').size, 1);
  });
  test('a quoted heading, a list-marker heading and an <a id> give no anchor', () => {
    const md = '## A\n> ## Q\n- ## I\nt <a id="m"></a>\n<a name="n"></a>\n## After';
    assert.deepEqual(anchors(md), ['a']);
    assert.deepEqual(anchors('> ## Q\n- ## I\n## Real'), ['real']);
  });
  test('a quoted heading inside a fence is code, and a quoted fence opens no code', () => {
    assert.deepEqual(anchors('```\n> ## Fake\n```\n## Real'), ['real']);
    assert.deepEqual(anchors('```\n> ```\n## Fake\n```\n## Real'), ['real']);
    assert.deepEqual(anchors('> ```\n## Real'), ['real']);
    assert.deepEqual(anchors('> ```\n> ## Fake\n> ```\n> ## Quoted'), []);
  });
  test('a comment line stops the anchors after it', () => {
    assert.deepEqual(anchors('## A\n<!--\n## Cm\n-->\n## B'), ['a']);
    assert.deepEqual(anchors('<!-- <a id="c"></a> -->\n## B'), []);
  });
  test('a fence or `<` after indentation or a list marker stops the anchors after it', () => {
    for (const rest of [' ```\n## F', '1. ```\n## F', '* <b>\n## F', '<details>\n## F\n</details>',
      '- x\n\n    ```\n  ## F\n    ```', '- ~~~\n## F', '2) <!--\n## F', '</div>\n## F',
      '<?x\n## F', '<!DOCTYPE x>\n## F']) {
      assert.deepEqual(anchors(`## A\n${rest}`), ['a'], JSON.stringify(rest));
    }
  });
  test('`<` before a non-tag character and a fence in column 0 stop nothing', () => {
    assert.deepEqual(anchors('## A\na < b\n<= 3\n<-- x\n< 2\n```\nx\n```\n## B'), ['a', 'b']);
    assert.deepEqual(anchors('## A\n---\n## B\n- x\n- y\n## C'), ['a', 'b', 'c']);
    for (const run of ['- ``', '- ~~', '1. ``']) {
      assert.deepEqual(anchors(`## A\n${run}\n## F`), ['a', 'f'], JSON.stringify(run));
    }
  });
  test('a front matter `---` on line 1 stops the anchors; a later one does not', () => {
    assert.deepEqual(anchors('---\n# F\n---\n## G'), []);
    assert.deepEqual(anchors('## A\n---\n## B'), ['a', 'b']);
    assert.deepEqual(anchors('--\n# F\n--\n## G'), ['f', 'g']);
  });
  test('a `<!--` inside a code span still gives the span text a slug', () => {
    assert.deepEqual(anchors('## Marker `<!--` here\n## After'),
      [slugify('Marker `<!--` here'), 'after']);
    assert.deepEqual(anchors('## A `<!-- x -->` b'), [slugify('A `<!-- x -->` b')]);
  });
  test('indent limit is 3 spaces and level limit is 6 hashes', () => {
    assert.equal(headingSet('    ## Code').size, 0);
    assert.deepEqual(anchors('   ### Three\n##### Five\n###### Six\n####### Seven'),
      ['three', 'five', 'six']);
  });
  test('keeps underscores like GitHub', () => {
    assert.ok(headingSet('## Set `commit_docs` true').has('set-commit_docs-true'));
  });
  test('skips fenced headings and suffixes repeated slugs', () => {
    const md = '# A\n```\n## Fake\n```\n~~~~\n## Tilde\n~~~~\n## Same\n## Same\n## Same';
    assert.deepEqual(anchors(md), ['a', 'same', 'same-1', 'same-2']);
  });
  test('an info-string line inside a fence is content, not a closer', () => {
    assert.deepEqual(anchors('```\n```js\n## Fake\n```\n## Real'), ['real']);
  });
  test('an unclosed fence hides the rest of the file', () => {
    assert.deepEqual(anchors('# A\n```\n## Fake'), ['a']);
  });
  test('CRLF input yields clean slugs', () => {
    assert.deepEqual(anchors('# A b\r\n## C\r\n'), ['a-b', 'c']);
  });
  test('a heading code span of any length is code: `_` inside it is no emphasis', () => {
    for (const code of ['`_a`', `\`_${'a'.repeat(5000)}\``, '``a`_b``']) {
      const md = `## x ${code} y`;
      assert.deepEqual(anchors(md), [slugify(md.slice(3))], JSON.stringify(code));
    }
    assert.equal(headingSet('## x _a y').size, 0);
  });
});

describe('link extractor (#5427)', () => {
  test('inline links and images are read, a title is not part of the destination', () => {
    assert.deepEqual(hrefsIn('[a](../a.md) ![i](p.png "t")'), ['../a.md', 'p.png']);
    assert.deepEqual(hrefsIn('[a](../x.md "t")'), ['../x.md']);
  });
  test('a link in a fence, comment, quote or HTML block is read; a code span hides it', () => {
    for (const text of ['<!--\n```\n-->\n[a](../x.md)', '<div>\n```\n</div>\n\n[a](../x.md)',
      '> > ```\n> [a](../x.md)\n> > ```', '> ```\n```\nx\n```\n> [a](../x.md)',
      '```\n[a](../x.md)\n```', '<!--\n[a](../x.md)\n-->']) {
      assert.deepEqual(hrefsIn(text), ['../x.md'], JSON.stringify(text));
    }
    assert.deepEqual(hrefsIn('`[c](../z.md)`'), []);
  });
  test('an unbalanced parenthesis is not a link', () => {
    for (const text of ['[a](x_(b)', '[a](x_(b "t")', '[a](x_((b))', '[a](']) {
      assert.deepEqual(hrefsIn(text), [], JSON.stringify(text));
    }
  });
  test('autolinks and bare URLs are out of scope: always absolute', () => {
    assert.deepEqual(hrefsIn('<https://x/a> and https://x/b'), []);
  });
  test('angle destinations stop at 999 characters', () => {
    const long = (n) => 'a'.repeat(n);
    for (const n of [998, 999]) {
      assert.deepEqual(hrefsIn(`[t](<${long(n)}>)`), [long(n)], `inline angle ${n}`);
    }
    assert.deepEqual(hrefsIn(`[t](<${long(1000)}>)`), [`<${long(1000)}>`]);
  });
  test('a destination ends at an ASCII space or control, not at a non-ASCII space', () => {
    assert.deepEqual(hrefsIn('[a](x\u00a0y)'), ['x\u00a0y']);
    assert.deepEqual(hrefsIn('[a](x\ty "t")'), ['x']);
  });
});

describe('refused forms (#5427)', () => {
  test('a URL attribute is refused once an HTML tag has opened, in any case and quote', () => {
    for (const [text, lines] of [['<a href="../x.md">', [1]], ['<A HREF=x>', [1]],
      ["<img src='y'>", [1]], ['<img srcset="a 1x">', [1]], ['<a\nhref="x">', [2]],
      ['<b title="x <a href="../y.md">', [1]], ['<!-- <a href="x"> -->', [1]],
      ['`<a href="x">`', [1]], ['> <a href=x>', [1]],
      ['<kbd>x</kbd>\n\nsrc is a folder', [3]],
      ['<pre>\n\n<a\n\nhref="../x.md">y</a>\n</pre>', [5]]]) {
      assert.deepEqual(refused(text), lines, JSON.stringify(text));
    }
  });
  test('prose, a tag without a URL attribute and a URL query are not refused', () => {
    for (const text of ['see href="x" in prose', '<a title="t">', 'a < b and src',
      '[a](https://x/?src=1&href=2)', '[a](../x.md) and [b](y)', '`[c](../z.md)`']) {
      assert.deepEqual(refused(text), [], JSON.stringify(text));
    }
  });
  test('a definition is refused at any indent and in any container', () => {
    for (const text of ['   > [a]: x', '    > [a]: x', '  > [a]: x', '- [a]: x', '    [a]: x',
      '`[a]: x`', '[a]: <>', '[a]: <guide/my guide.md>']) {
      assert.deepEqual(refused(text), [1], JSON.stringify(text));
    }
    assert.deepEqual(refused('[a]:\n[b]: ../x.md'), [1, 2]);
    assert.deepEqual(refused('[foo\nbar]: ../x.md'), [2]);
    assert.deepEqual(hrefsIn('[a]:\n[b]: <https://x/y>'), []);
  });
  test('a `](` that extractLinks does not read as a link refuses its line', () => {
    for (const [text, lines] of [['[![i](a.png)](../x.md)', [1]], ['[a [b] c](../x.md)', [1]],
      ['[a](../x_(b).md)', [1]], ['[a\nb](../x.md)', [2]], ['\\`[a](../x.md)\\`', [1]]]) {
      assert.deepEqual(refused(text), lines, JSON.stringify(text));
    }
  });
});

describe('angle-enclosed destinations (#5427)', () => {
  const ABS = `${NEXT}guide/my%20guide.md`;
  test('relative with spaces is extracted and rejected', () => {
    const hs = hrefsIn('[guide](<guide/my guide.md>)');
    assert.deepEqual(hs, ['guide/my guide.md']);
    assert.deepEqual(hs.filter(isBadLink), hs);
  });
  test('angle-enclosed absolute destination is returned once', () => {
    assert.deepEqual(hrefsIn('[t](<https://x/a>)'), ['https://x/a']);
  });
  test('absolute encoded form is accepted', () => {
    assert.deepEqual(hrefsIn(`[guide](<${ABS}>)`).filter(isBadLink), []);
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
    assert.throws(() => repoPathOf(`${NEXT}a%zz\n\r\u001b::add-mask::.md`, 'tpl.md'),
      (e) => ![...e.message].some((c) => c.charCodeAt(0) < 0x20) && e.link.includes('\n\r\u001b'));
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
        `${NEXT}docs/registries/README.md#nope`], 'tpl.md'),
      ['CONTRIBUTING.md#nope', 'docs/registries/README.md#nope']);
    const seams = { headingsOf: () => new Set(['x_y']) };
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#x%5Fy`], 'tpl.md', seams), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${REPO}raw/next/CONTRIBUTING.md#nope`], 'tpl.md'),
      ['CONTRIBUTING.md#nope']);
    const real2 = `CONTRIBUTING.md#${real}`;
    assert.deepEqual(unresolvedAnchors([`${REPO}raw/next/${real2}`,
      `${REPO}blame/next/${real2}`], 'tpl.md'), [real2, real2]);
    assert.deepEqual(unresolvedAnchors([`${REPO}tree/next/${real2}`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md`, `${NEXT}no-such.md#a`,
      `${REPO}issues/1#a`], 'tpl.md'), []);
  });
  test('an unresolved anchor names the line where the anchors stop', () => {
    const seams = { headingsOf: () => headingSet('## A\n<!--\n## B') };
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#b`], 'tpl.md', seams),
      ['CONTRIBUTING.md#b (anchors stop at line 2: "<!--")']);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#a`], 'tpl.md', seams), []);
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
  test('line anchors take a column on either end; the line and column hold 9 digits', () => {
    const view = `${NEXT}CONTRIBUTING.md?plain=1`;
    const seams = { linesOf: () => 1e10 };
    const found = (anchor) => unresolvedAnchors([`${view}#${anchor}`], 'tpl.md', seams);
    for (const anchor of ['L5C3', 'L5C3-L6C10', 'L5-L6C10', 'L5C3-L6', 'L99999999',
      'L5C99999999', 'L999999999', 'L5C999999999', 'L1-L99999999', 'L1-L999999999',
      'L1-L2C99999999', 'L1-L2C999999999']) {
      assert.deepEqual(found(anchor), [], anchor);
    }
    for (const anchor of ['L5C', 'LC3', 'L5C-L6', 'L1000000000', 'L5C1000000000',
      'L1-L1000000000', 'L1-L2C1000000000']) {
      assert.deepEqual(found(anchor), [`CONTRIBUTING.md#${anchor}`], anchor);
    }
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
      `${REPO}blob/next/%2e%2e/x`, `${REPO}blob/next/./x`, `${REPO}blob/next/%2e/x`,
      `${REPO}issues/&#46;&#46;/x`, `${REPO}issues/\\.\\./x`,
      `${REPO}issues/../blob/main/x`, `${REPO}/blob/main/x`, `${REPO}blob/next//x`,
      `${REPO}blob//next/x`, 'https://github.com/open-gsd/gsd-coreissues/1',
      `${REPO.slice(0, -1)}pull/1`, `${REPO}/`, `${NEXT}CONTRIBUTING.md/`,
      `${REPO}tree/next/docs/`];
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
    assert.ok(hrefsIn('[a]()').filter(isBadLink).length > 0);
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
  test('an existing file outside the repo is refused although fs.existsSync finds it', (t) => {
    const dir = createTempDir();
    t.after(() => cleanup(dir));
    fs.writeFileSync(path.join(dir, 'secret.md'), '# secret\n');
    const rel = path.relative(ROOT, path.join(dir, 'secret.md'));
    if (path.isAbsolute(rel)) return t.skip('the temp dir is on another drive than the repo');
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    assert.throws(() => readRepoFile(rel), /no such file inside the repo/);
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
    fs.mkdirSync(path.join(dir, 'PULL_REQUEST_TEMPLATE'));
    fs.writeFileSync(path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE', 'fix.md'), '');
    fs.writeFileSync(path.join(sub, 'x.md'), '');
    fs.writeFileSync(path.join(dir, 'pull_request_template.md'), '');
    fs.writeFileSync(path.join(dir, 'docs', 'pull_request_template.md'), '');
    fs.writeFileSync(path.join(dir, 'PULL_REQUEST_TEMPLATE', 'x.md'), '');
    assert.deepEqual(templateFiles(dir).sort(), ['.github/PULL_REQUEST_TEMPLATE/fix.md',
      'PULL_REQUEST_TEMPLATE/x.md', 'docs/pull_request_template.md', 'pull_request_template.md']);
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
  test('no reference definition or HTML link attribute stays unread',
    () => eachTemplate((f) => unreadForms(readRepoFile(f))));
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
