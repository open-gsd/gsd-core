// Link guard for #5427: a PR body renders a relative href against /pull/N, so it 404s.
// Checked: inline links, reference definitions and href/src/srcset attributes of HTML
// open tags, outside fenced code, code spans and HTML comments. A repo link must name no ref, or
// blob|tree|raw|blame on `next` to a path (and a heading or line anchor) that exists.
// `?template=` links stay (maintainer ruling on #5427).
// Every link to another host is bad too (an allowlist, not only relative links): a template
// links this repo and nothing else, so a lookalike host cannot pass.
// Out of scope: autolinks (<https://...>) and bare URLs always carry a scheme, so they
// are never relative.
// Anchors use scripts/gen-features.cjs `slugify` on the raw heading text. A heading it
// cannot reproduce (a non-ASCII letter or digit, a link, an HTML tag or entity, `_` emphasis)
// gets no anchor, so a link to it fails. Blockquote headings and `<a id>`/`<a name>` anchors count.
// Owners: the sectionizer reads fences, code spans and ATX headings; the ADR gate reads inline
// link syntax (extractLinks) and the case-exact path walk; scanHtml below reads HTML comments and
// tag attributes, which neither owner covers.
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../../scripts/gen-features.cjs');
const {
  extractLinks, existsCaseExact, realRootOrFallback,
} = require('../../scripts/gen-adr-index.cjs');
const {
  stripFencedCode, stripInlineCode, tokenizeHeadings,
} = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;

// One linear pass (ADR-3212 section 5) after the WHATWG tokenizer: it drops HTML comments and
// reads the attributes of open tags. A comment ends at the first `-->`, so `<!-->` is empty and
// an unclosed one hides the rest. A tag takes an attribute right after a quoted value and keeps
// an `=` inside an unquoted value; a quote with no partner ends the tag, which yields none.
const eat = (re, s, at) => {
  re.lastIndex = at;
  return re.exec(s)?.[0] ?? '';
};
const SKIP = /[\s/]*/y;
const SPACE = /\s*/y;
const TAG_NAME = /[A-Za-z][^\s/>]*/y;
const ATTR_NAME = /=?[^\s/>=]*/y;
const UNQUOTED = /[^\s>]*/y;
const scanHtml = (s) => {
  const attrs = [];
  const unclosed = new Set(); // a quote with no partner after one point has none after a later one
  const close = (q, at) => {
    const end = unclosed.has(q) ? -1 : s.indexOf(q, at);
    if (end < 0) unclosed.add(q);
    return end;
  };
  const tag = (start) => {
    const found = [];
    const name = eat(TAG_NAME, s, start + 1);
    let i = start + 1 + name.length;
    for (;;) {
      i += eat(SKIP, s, i).length;
      if (i >= s.length) return i;
      if (s[i] === '>') {
        attrs.push(...found);
        return i + 1;
      }
      const key = eat(ATTR_NAME, s, i);
      i += key.length;
      let j = i + eat(SPACE, s, i).length;
      let value;
      if (s[j] === '=') {
        j += 1 + eat(SPACE, s, j + 1).length;
        const q = s[j];
        if (q === '"' || q === "'") {
          const end = close(q, j + 1);
          if (end < 0) return j;
          value = s.slice(j + 1, end);
          i = end + 1;
        } else {
          value = eat(UNQUOTED, s, j);
          i = j + value.length;
        }
      }
      found.push({ tag: name.toLowerCase(), name: key.toLowerCase(), value });
    }
  };
  let text = '';
  let from = 0;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i)) {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 2);
      text += s.slice(from, i);
      if (end < 0) return { text, attrs };
      from = i = end + 3;
    } else {
      i = /[A-Za-z]/.test(s[i + 1] ?? '') ? tag(i) : i + 1;
    }
  }
  return { text: text + s.slice(from), attrs };
};
// What a reader sees: a quote marker is no content, and neither is a fence or a comment.
const unfenced = (text) => stripFencedCode(text.replace(/^(?: {0,3}>[ \t]?)+/gm, '')).text;
const prose = (text) => scanHtml(stripInlineCode(unfenced(text)));

const URL_ATTRS = new Set(['href', 'src', 'srcset']);
const firstCandidate = (c) => c.trim().split(/\s+/)[0];
const attrUrls = (attrs) => attrs
  .filter(({ name, value }) => URL_ATTRS.has(name) && value !== undefined)
  .flatMap(({ name, value }) =>
    name === 'srcset' ? value.split(',').map(firstCandidate).filter(Boolean) : [value]);

// A link destination is the first word of the parentheses, or the whole of an `<...>` form.
// A label takes the CommonMark limit of 999 characters. The angle destination takes the same
// number as this guard's own scan bound: it keeps the scan linear.
const destOf = (raw) => /^\s*<([^<>]{0,999})>/.exec(raw)?.[1] ?? raw.trim().split(/\s+/)[0];
const REF_DEF = /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*(?:<([^<>\n]{0,999})>|(\S+))/gm;
const hrefsIn = (text) => {
  const { text: src, attrs } = prose(text);
  const refs = [...src.matchAll(REF_DEF)].map((m) => m[1] ?? m[2]);
  return [...extractLinks(src).map(({ target }) => destOf(target)), ...attrUrls(attrs), ...refs];
};

// Host and owner/name are case-insensitive on GitHub, the view and the ref are not.
const REPO_URL = /^https:\/\/github\.com\/open-gsd\/gsd-core(?:\/([^?#]*))?([?#].*)?$/i;
const DOT_SEG = /^(?:\.|%2e){1,2}$/i;
// The one rule for path segments, on the raw link (isBadLink) and on the decoded path
// (missingNext): a dot segment, or an empty one (`gsd-core//blob/main/x`, `x/`, `x.md%2F`)
// in a path of more than one segment.
const badSegs = (segs) =>
  segs.some((s) => DOT_SEG.test(s)) || (segs.length > 1 && segs.includes(''));
// The views whose path the existence check reads.
const REF_PAGE = new Set(['blob', 'tree', 'raw', 'blame']);
const NO_REF = new Set([
  '', 'issues', 'pull', 'pulls', 'discussions', 'actions', 'releases', 'wiki', 'security',
  'projects', 'labels', 'milestones', 'tags', 'branches', 'compare',
]);
// The one parse of a link into this repo; undefined for any other link.
const repoLink = (h) => {
  const m = REPO_URL.exec(h);
  return m && { segs: (m[1] ?? '').split('/'), tail: m[2] ?? '' };
};
// Ok: `?template=`, `#`, a repo link naming no ref, or a checkable view on `next`.
// Never ok: a dot segment, or an empty segment (a doubled or trailing slash) in a path.
const isBadLink = (h) => {
  if (h.startsWith('?template=') || h === '#') return false;
  const link = repoLink(h);
  if (!link || badSegs(link.segs)) return true;
  const [view, ref] = link.segs;
  return !(NO_REF.has(view) || (REF_PAGE.has(view) && ref === 'next'));
};
// A blob/tree/raw/blame link on next: its repo path plus ?query#anchor.
// Undefined for any other link.
const nextRel = (h) => {
  const link = repoLink(h);
  const onNext = link && REF_PAGE.has(link.segs[0]) && link.segs[1] === 'next';
  return onNext ? link.segs.slice(2).join('/') + link.tail : undefined;
};
const decode = (s, h, where) => {
  try {
    return decodeURIComponent(s);
  } catch {
    // quoted: a template file is data, and a raw newline could forge a `::command::` log line
    throw Object.assign(
      new Error(`${JSON.stringify(where)}: malformed percent escape in ${JSON.stringify(h)}`),
      { where, link: h });
  }
};
// drop ?plain=1 / #anchor
const repoPathOf = (h, where) => decode(nextRel(h).split(/[?#]/)[0], h, where);

// The ADR gate owns the case-exact walk (a case-folding filesystem cannot pass a link GitHub
// 404s) and the symlink-escape refusal.
const REAL_ROOT = realRootOrFallback();
const DIR_CACHE = new Map();
const existsExact = (rel) => existsCaseExact(path.join(ROOT, rel), DIR_CACHE, REAL_ROOT).exists;
// An empty segment after decoding (`x.md%2F`) is as bad as a raw one (isBadLink).
const missingNext = (hs, where) => hs.filter((h) => nextRel(h) !== undefined)
  .map((h) => repoPathOf(h, where))
  .filter((rel) => badSegs(rel.split('/')) || !existsExact(rel));

// GitHub anchors: ATX headings and `<a id>`/`<a name>` outside code and comments count; a
// repeated slug gets -1, -2, ...
// GitHub keeps non-ASCII letters and slugs the rendered text; slugify keeps neither, so
// such a heading gets no anchor and a link to it fails.
const unslugable = (text) => {
  const bare = stripInlineCode(text);
  return /(?!\p{ASCII})[\p{L}\p{N}]/u.test(text) || /\]\(|\]\[/.test(bare)
    || /<[A-Za-z/!]|&[A-Za-z0-9#]+;/.test(bare) // an HTML tag or entity renders to other text
    || /(?:^|\W)_|_(?:\W|$)/.test(bare);
};
const anchorIds = (attrs) => attrs
  .filter(({ tag, name, value }) => tag === 'a' && (name === 'id' || name === 'name') && value
    && !/\s/.test(value))
  .map(({ value }) => value);
const headingSet = (source) => {
  const seen = new Map();
  const slugs = tokenizeHeadings(scanHtml(unfenced(source)).text)
    .filter(({ text }) => !unslugable(text))
    .map(({ text }) => {
      const s = slugify(text);
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      return n ? `${s}-${n}` : s;
    });
  return new Set([...slugs, ...anchorIds(prose(source).attrs)]);
};
// A repo file read through the gate's case-exact walk, which refuses a symlink out of the repo.
const readRepoFile = (rel) => {
  if (!existsExact(rel)) throw new Error(`${JSON.stringify(rel)}: no such file inside the repo`);
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
};
const headingsOfFile = (rel) => headingSet(readRepoFile(rel));

const LINE_ANCHOR = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;
// heading: rendered markdown (blob or tree, no ?plain=1).
// line: blame, ?plain=1 and non-markdown blob. none: raw.
const anchorKind = ({ segs, tail }, rel) => {
  const plain = new URLSearchParams(tail.split('#')[0]).get('plain') === '1';
  const md = /\.md$/i.test(rel); // GitHub renders `.MD` as markdown too
  if (segs[0] === 'blame' || (segs[0] === 'blob' && (plain || !md))) return 'line';
  return REF_PAGE.has(segs[0]) && segs[0] !== 'raw' && md ? 'heading' : 'none';
};
const lineCountOf = (rel, root = ROOT) => {
  const abs = path.join(root, rel);
  if (!fs.statSync(abs).isFile()) return 0;
  const text = fs.readFileSync(abs, 'utf8');
  let lines = 0; // an indexOf loop: CRLF-safe and accepted by local/no-crlf-fragile-split
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  return text && !text.endsWith('\n') ? lines + 1 : lines;
};
const lineAnchorOk = (anchor, count) => {
  const m = LINE_ANCHOR.exec(anchor);
  return m !== null && [m[1], m[2] ?? m[1]].every((n) => Number(n) >= 1 && Number(n) <= count)
    && Number(m[2] ?? m[1]) >= Number(m[1]);
};
// Every #fragment on a file on next must exist in the kind of view the link opens.
// A missing file is missingNext's.
const unresolvedAnchors = (hs, where, seams = {}) => {
  const { headingsOf = headingsOfFile, linesOf = lineCountOf } = seams;
  return hs.filter((h) => nextRel(h)?.includes('#')).flatMap((h) => {
    const rel = repoPathOf(h, where);
    const anchor = decode(h.slice(h.indexOf('#') + 1), h, where);
    if (!existsExact(rel) || anchor === '') return [];
    const kind = anchorKind(repoLink(h), rel);
    const ok = kind === 'heading' ? headingsOf(rel).has(anchor)
      : kind === 'line' && lineAnchorOk(anchor, linesOf(rel));
    return ok ? [] : [`${rel}#${anchor}`];
  });
};

module.exports = {
  REPO, NEXT, hrefsIn, isBadLink, repoPathOf, missingNext,
  unresolvedAnchors, headingSet, anchorKind, lineCountOf, readRepoFile,
};
