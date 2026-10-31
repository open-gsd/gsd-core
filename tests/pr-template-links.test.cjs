// Regression for #5427: PR bodies render relative hrefs verbatim, so they
// resolve against /pull/N and 404. Every link outside code and HTML comments must be an absolute repo URL (blob links on `next`),
// except `?template=` links, which GitHub resolves against the compare page (maintainer ruling on #5427).
const { describe, test } = require('node:test');
const fc = require('./helpers/fast-check-setup.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../scripts/gen-features.cjs');
const { extractLinks, maskCode } = require('../scripts/gen-adr-index.cjs');
const { tokenizeHeadings } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..');
const GH = path.join(ROOT, '.github');
const DIR = path.join(GH, 'PULL_REQUEST_TEMPLATE');
// Inline links: an angle-enclosed or bare destination (bare: balanced parentheses, any depth), then an optional title.
const ANGLE = /\s*<([^>\n]*)>/y;
const TAIL = /(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/y;
const inlineDests = (t) => {
  const out = [];
  for (let i = t.indexOf(']('); i >= 0; i = t.indexOf('](', i + 2)) {
    ANGLE.lastIndex = i + 2;
    const m = ANGLE.exec(t);
    let j = m ? ANGLE.lastIndex : i + 2;
    let d = m?.[1];
    if (!m) {
      let depth = 0;
      while (/\s/.test(t[j] ?? '')) j++;
      const start = j;
      for (; j < t.length && !/\s/.test(t[j]); j++) {
        if (t[j] === '\\' && /\S/.test(t[j + 1] ?? '')) j++;
        else if (t[j] === '(') depth++;
        else if (t[j] === ')' && !depth--) break;
      }
      if (depth > 0) continue;
      d = t.slice(start, j);
    }
    TAIL.lastIndex = j;
    if (d && TAIL.test(t)) out.push(d);
  }
  return out;
};
const ATTR = /(?<=\s)(href|srcset|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+))/gi;
const REFDEF = new RegExp(String.raw`^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))* *\[[^\]\n]+\]:[ \t]*(?:\r?\n[ \t]*)?(?:<([^>\n]*)>|(?!\[[^\]\n]+\]:)(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$`, 'gm');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;
const DOCS_ANCHOR = 'CONTRIBUTING.md#documentation-updates--update-the-relevant-docs';
// Indented code (4+ spaces or a tab) follows a blank line or more code, and is not a list item's continuation.
const maskIndentedCode = (text) => {
  let afterBlank = true;
  let inList = false;
  return text.split('\n').map((l) => {
    const blank = !l.trim();
    const indented = /^( {4}|\t)/.test(l);
    if (!blank && !indented) inList = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(l);
    const code = indented && !blank && !inList && afterBlank;
    afterBlank = blank || code;
    return code ? l.replace(/\S/g, ' ') : l;
  }).join('\n');
};
// Links live outside code and HTML comments; maskCode (the ADR gate's masker) blanks fenced code and inline code.
const hrefsIn = (text) => {
  const t = maskIndentedCode(maskCode(text)).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/\S/g, ' '));
  const attrs = [...t.matchAll(ATTR)].flatMap(([, name, ...v]) => {
    const val = v.find((g) => g !== undefined);
    return name.toLowerCase() === 'srcset' ? val.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean) : [val];
  });
  const refs = [...t.matchAll(REFDEF)].map((m) => m.slice(1).find((g) => g !== undefined));
  return [...inlineDests(t), ...attrs, ...refs];
};
const read = (f) => fs.readFileSync(path.join(GH, f), 'utf8');
const hrefsOf = (f) => hrefsIn(read(f));
const REF_PAGE = /^(blob|tree|raw|blame)\//; // the repo pages whose path the existence check can read
const NO_REF = /^(?:issues|pull|pulls|discussions|actions|releases|wiki|security|projects|labels|milestones|tags|branches)(?:[/?#]|$)/;
// A repo link is ok when it names no ref (bare root, NO_REF pages) or its first path segment is followed by `next`.
const isBadLink = (h) => {
  if (h.startsWith('?template=') || h === REPO.slice(0, -1)) return false;
  const rest = h.slice(REPO.length);
  return !(h.startsWith(REPO) && (!rest || NO_REF.test(rest) || h.startsWith(`${REPO}${rest.split('/')[0]}/next/`)));
};
// The path of a blob/tree/raw/blame link on next, undefined for any other link.
const nextRel = (h) => {
  const kind = h.startsWith(REPO) && REF_PAGE.exec(h.slice(REPO.length))?.[1];
  const base = `${REPO}${kind}/next/`;
  return kind && h.startsWith(base) ? h.slice(base.length) : undefined;
};
const decode = (s, h, where) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new Error(`${where}: malformed percent escape in ${h}`);
  }
};
const repoPathOf = (h, where) => decode(nextRel(h).split(/[?#]/)[0], h, where); // drop ?plain=1 / #anchor

// Case-exact so a case-folding filesystem (macOS, Windows) cannot pass a link GitHub 404s.
const existsExact = (rel) => {
  let dir = ROOT;
  try {
    for (const seg of rel.split('/').filter(Boolean)) {
      if (!fs.readdirSync(dir).includes(seg)) return false;
      dir = path.join(dir, seg);
    }
  } catch {
    return false;
  }
  return true;
};
const missingNext = (hs, where) => hs.filter((h) => nextRel(h) !== undefined).map((h) => repoPathOf(h, where))
  .filter((rel) => rel.split('/').includes('..') || !existsExact(rel));
// Every #fragment on a markdown file on next (a ?query may precede it) must be a heading of that file; a missing file is missingNext's.
const headingsOfFile = (rel) => headingSet(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const unresolvedAnchors = (hs, where, headingsOf = headingsOfFile) => hs.filter((h) => nextRel(h)?.includes('#')).flatMap((h) => {
  const rel = repoPathOf(h, where);
  const anchor = decode(h.slice(h.indexOf('#') + 1), h, where);
  return rel.endsWith('.md') && existsExact(rel) && !headingsOf(rel).has(anchor) ? [`${rel}#${anchor}`] : [];
});

// A paragraph followed by === or --- is a setext heading; maskCode supplies fences and code spans, the raw lines the text.
const setextHeadings = (md) => {
  const raw = md.split(/\r?\n/);
  const out = [];
  let para = [];
  maskCode(md).split(/\r?\n/).forEach((m, i) => {
    const blank = !m.trim() && !/^ {0,3}`+[^`\s]/.test(raw[i]); // a line that is only a code span is text
    if (para.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(m)) {
      out.push({ line: para[0] + 1, text: para.map((k) => raw[k].trim()).join(' ') });
      para = [];
    } else if (blank || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|(?:[*_-][ \t]*){3,}$)/.test(m) || (!para.length && /^( {4}|\t)/.test(m))) {
      para = [];
    } else {
      para.push(i);
    }
  });
  return out;
};

// GitHub anchors: headings inside fences do not exist (the sectionizer seam skips them), a repeated slug gets -1, -2, ...
const headingSet = (md) => {
  const seen = new Map();
  const headings = [...tokenizeHeadings(md), ...setextHeadings(md)].sort((a, b) => a.line - b.line);
  return new Set(headings.map(({ text }) => {
    const s = slugify(text);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  }));
};

describe('heading anchors (#5427)', () => {
  test('reads ATX headings, including indented', () => {
    assert.deepEqual([...headingSet('# Title\n\n  ## Indented')], ['title', 'indented']);
  });
  test('reads setext headings; a rule after a blank line or an ATX heading is not one', () => {
    assert.deepEqual([...headingSet('# Title\nSub\n---\n  ## Indented')], ['title', 'sub', 'indented']);
    assert.deepEqual([...headingSet('Sub\n---\nTitle\n===\nTwo\nlines\n===')], ['sub', 'title', 'two-lines']);
    assert.deepEqual([...headingSet('Para\n\n---\n# H\n---\n```\nFake\n---\n```\n- item\n---')], ['h']);
    assert.deepEqual([...headingSet('Set `commit_docs`\n===')], ['set-commit_docs']);
  });
  test('an em dash slugs like the features generator', () => {
    assert.deepEqual([...headingSet('## A \u2014 B')], [slugify('A \u2014 B')]);
    assert.deepEqual([...headingSet('## A \u2014 B')], ['a--b']);
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
    assert.deepEqual([...headingSet('# A\n```\n## Fake\n```\n~~~~\n## Tilde\n~~~~\n## Same\n## Same\n## Same')],
      ['a', 'same', 'same-1', 'same-2']);
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
  const title = fc.constantFrom('', ' "t"', " 't'", ' (t)');
  const forms = (d, t) => [`[a](${d}${t})`, `[a](<${d}>${t})`, `<a href="${d}">`, `<a href='${d}'>`, `<a href=${d}>`,
    `<img src="${d}">`, `[a]: ${d}${t}`, `[a]: <${d}>${t}`, `> [a]: ${d}${t}`, `> > [a]: ${d}${t}`];
  test('property: every destination form yields the generated destination, CRLF included', () => {
    fc.assert(fc.property(dest, title, (d, t) => {
      for (const text of forms(d, t)) {
        assert.deepEqual(hrefsIn(text), [d], text);
        assert.deepEqual(hrefsIn(`${text}\r\n${text}\r\n`), [d, d], text);
      }
    }));
  });
  test('property: nothing is extracted from fenced code, inline code or HTML comments', () => {
    fc.assert(fc.property(dest, title, (d, t) => {
      for (const text of forms(d, t)) {
        for (const wrapped of [`\`\`\`\n${text}\n\`\`\``, `~~~\n${text}\n~~~`, `\`${text}\``, `<!-- ${text} -->`, `<!--\n${text}\n-->`]) {
          assert.deepEqual(hrefsIn(wrapped), [], wrapped);
        }
        assert.deepEqual(hrefsIn(`<!-- c -->\n${text}`), hrefsIn(text), text);
      }
    }));
  });
  test('property: a destination with nested balanced parentheses parses at every depth', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.constantFrom('', ' "t"', " 't'", ' (t)'), (depth, t) => {
      const d = `x_${'('.repeat(depth)}b${')'.repeat(depth)}`;
      assert.deepEqual(hrefsIn(`[a](${d}${t})`), [d], d);
      assert.deepEqual(hrefsIn(`[a](<${d}>${t})`), [d], d);
    }));
  });
  test('an unbalanced parenthesis is not a link', () => {
    for (const text of ['[a](x_(b)', '[a](x_(b "t")', '[a](x_((b))', '[a](']) assert.deepEqual(hrefsIn(text), [], text);
  });
  test('a `src=` or `href=` inside a URL is not an attribute', () => {
    assert.deepEqual(hrefsIn('[a](https://x/?src=1&href=2)'), ['https://x/?src=1&href=2']);
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
  test('a reference definition may put the destination on the next line or sit in a list item', () => {
    for (const t of ['[a]:\n../x.md', '[a]:\r\n  ../x.md', '- [a]: ../x.md', '1. [a]: ../x.md', '> - [a]: ../x.md']) {
      assert.deepEqual(hrefsIn(t), ['../x.md'], t);
    }
    assert.deepEqual(hrefsIn('[a]:\n[b]: ../x.md'), ['../x.md']);
  });
  test('an escaped parenthesis in a bare destination is not nesting', () => {
    assert.deepEqual(hrefsIn('[a](rel\\(x)'), ['rel\\(x']);
    assert.deepEqual(hrefsIn('[a](rel\\)x "t")'), ['rel\\)x']);
  });
  test('indented code is not scanned; paragraph and list continuations are', () => {
    for (const t of ['    [a](../x.md)', '\t[a](../x.md)', 'text\n\n    [a](../x.md)', '    code\n    [a](../x.md)']) assert.deepEqual(hrefsIn(t), [], t);
    for (const t of ['para\n    [a](../x.md)', '- item\n\n    [a](../x.md)', '- item\n\n      [a](../x.md)']) assert.deepEqual(hrefsIn(t), ['../x.md'], t);
  });
});

describe('next-ref existence and anchors (#5427)', () => {
  test('tree, raw and blame links on next must exist like blob links', () => {
    const hs = [`${REPO}tree/next/no-such-dir`, `${REPO}raw/next/nope.md`, `${REPO}blame/next/nope.md`, `${NEXT}nope.md`,
      `${REPO}tree/next/docs`, `${NEXT}CONTRIBUTING.md`, `${REPO}issues/1`];
    assert.deepEqual(missingNext(hs, 'tpl.md'), ['no-such-dir', 'nope.md', 'nope.md', 'nope.md']);
  });
  test('the existence check is case-exact and rejects dot segments', () => {
    assert.deepEqual(missingNext([`${NEXT}contributing.md`, `${NEXT}.github/../CONTRIBUTING.md`, `${NEXT}CONTRIBUTING.md/x`], 'tpl.md'),
      ['contributing.md', '.github/../CONTRIBUTING.md', 'CONTRIBUTING.md/x']);
  });
  test('a malformed percent escape names the template and the link', () => {
    assert.throws(() => repoPathOf(`${NEXT}a%zz.md`, 'tpl.md'), /tpl\.md.*a%zz\.md/);
  });
  test('an anchor on any linked markdown file on next must resolve, behind a query too, and is percent-decoded', () => {
    const real = DOCS_ANCHOR.split('#')[1];
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#${real}`, `${NEXT}CONTRIBUTING.md?plain=1#${real}`], 'tpl.md'), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md?plain=1#nope`, `${NEXT}.github/pull_request_template.md#nope`], 'tpl.md'),
      ['CONTRIBUTING.md#nope', '.github/pull_request_template.md#nope']);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md#x%5Fy`], 'tpl.md', () => new Set(['x_y'])), []);
    assert.deepEqual(unresolvedAnchors([`${NEXT}CONTRIBUTING.md`, `${NEXT}no-such.md#a`, `${REPO}issues/1#a`], 'tpl.md'), []);
  });
});

describe('link classification (#5427)', () => {
  test('bad: relative, other hosts, repo blob links off next; ok: next blob, repo pages, ?template=', () => {
    const bad = ['guide/x.md', '../CONTRIBUTING.md', '#a', 'https://evil.example/x', `${REPO}blob/main/CONTRIBUTING.md`,
      `${REPO}tree/main/docs`, `${REPO}raw/main/CONTRIBUTING.md`, `${REPO}blame/main/CONTRIBUTING.md`,
      `${REPO}commits/main`, `${REPO}edit/main/CONTRIBUTING.md`, `${REPO}archive/main.zip`];
    assert.deepEqual(bad.filter(isBadLink), bad);
    assert.deepEqual([`${NEXT}a.md`, `${REPO}tree/next/docs`, `${REPO}raw/next/a.md`, `${REPO}blame/next/a.md`, `${REPO}discussions/1`,
      `${REPO}issues/1`, `${REPO}pull/1`, `${REPO}actions`, REPO, REPO.slice(0, -1), `${REPO}commits/next/docs`, '?template=fix.md'].filter(isBadLink), []);
  });
  test('property: each class is built by construction, schemes and ?template= included', () => {
    const d = fc.stringMatching(/^[A-Za-z0-9._/-]{1,20}$/);
    const classed = fc.oneof(
      ...[(x) => x, (x) => `../${x}`, (x) => `mailto:${x}`, (x) => `javascript:${x}`, (x) => `https://evil.example/${x}`,
        (x) => `${x}?template=${x}`, (x) => `${REPO}blob/main/${x}`,
        (x) => `${REPO}tree/main/${x}`, (x) => `${REPO}raw/main/${x}`, (x) => `${REPO}blame/main/${x}`].map((mk) => d.map((x) => [mk(x), true])),
      ...[(x) => `?template=${x}`, (x) => `${NEXT}${x}`, (x) => `${REPO}tree/next/${x}`, (x) => `${REPO}raw/next/${x}`,
        (x) => `${REPO}blame/next/${x}`, (x) => `${REPO}discussions/${x}`].map((mk) => d.map((x) => [mk(x), false])),
    );
    fc.assert(fc.property(classed, ([h, bad]) => assert.equal(isBadLink(h), bad, h)));
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
    for (const t of [`[guide](<${ABS}>)`, `[guide]: <${ABS}>`]) assert.deepEqual(hrefsIn(t).filter(isBadLink), []);
  });
});

describe('PR template links (#5427)', () => {
  const files = ['pull_request_template.md', ...fs.readdirSync(DIR).filter((n) => n.endsWith('.md')).map((n) => `PULL_REQUEST_TEMPLATE/${n}`)];
  for (const f of files) {
    test(`${f}: no link is bad`, () => {
      assert.deepEqual(hrefsOf(f).filter(isBadLink), []);
    });
    test(`${f}: blob/next links point at existing repo paths`, () => {
      assert.deepEqual(missingNext(hrefsOf(f), f), []);
    });
    test(`${f}: anchors on next resolve to a heading`, () => {
      assert.deepEqual(unresolvedAnchors(hrefsOf(f), f), []);
    });
  }
  test('"Using the wrong template?" links keep ?template= (maintainer ruling on #5427)', () => {
    for (const f of ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE/fix.md', 'PULL_REQUEST_TEMPLATE/feature.md',
      'PULL_REQUEST_TEMPLATE/enhancement.md', 'PULL_REQUEST_TEMPLATE/registry-entry.md']) {
      assert.ok(hrefsOf(f).some((h) => h.startsWith('?template=')), f);
    }
  });
  for (const f of ['PULL_REQUEST_TEMPLATE/feature.md', 'PULL_REQUEST_TEMPLATE/enhancement.md']) {
    test(`${f}: links the Documentation Updates anchor`, () => {
      assert.ok(hrefsOf(f).some((h) => h.endsWith(DOCS_ANCHOR)), DOCS_ANCHOR);
    });
  }
});
