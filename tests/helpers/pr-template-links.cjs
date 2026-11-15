// Link guard for #5427: a PR body renders a relative href against /pull/N, so it 404s.
// Checked: inline links, reference definitions and href/src/srcset attributes of HTML
// open tags, outside code and HTML comments. A repo link must name no ref, or
// blob|tree|raw|blame on `next` to a path (and a heading or line anchor) that exists.
// `?template=` links stay (maintainer ruling on #5427).
// Every link to another host is bad too (an allowlist, not only relative links): a template
// links this repo and nothing else, so a lookalike host cannot pass.
// Out of scope: autolinks (<https://...>) and bare URLs always carry a scheme, so they
// are never relative.
// Anchors use scripts/gen-features.cjs `slugify` on the raw heading text. A heading it
// cannot reproduce (a non-ASCII letter or digit, a link, an HTML tag or entity, `_` emphasis)
// gets no anchor, so a link to it fails. Blockquote headings and `<a id>`/`<a name>` anchors count.
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../../scripts/gen-features.cjs');
const {
  scanBlocks, scanInlineLinks, LINK_WS, existsCaseExact, realRootOrFallback,
} = require('../../scripts/gen-adr-index.cjs');
const { tokenizeHeadings } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;

// The block structure (what is code, a comment, a definition, a heading, a paragraph) is read by
// the ADR gate's scanBlocks, the one owner; this file reads links and anchors from its parts.

const NAME = /\s+[^\s"'<>/=]+/;
const VALUE = /(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`=]+))?/;
const TAG = new RegExp(`<[A-Za-z][A-Za-z0-9-]*((?:${NAME.source}${VALUE.source})*)\\s*/?>`, 'g');
// One attribute at a time: a quoted value is consumed whole, so `title="href=x"` yields nothing.
const ATTR = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g;
const URL_ATTRS = new Set(['href', 'src', 'srcset']);
const firstCandidate = (c) => c.trim().split(/\s+/)[0];
// A tag-shaped span right after `](` is a destination (`<x y>`), not a tag.
const PROSE_TAG = new RegExp(`(?<!\\]\\(${LINK_WS})${TAG.source}`, 'g');
const attrsIn = (t) => [...t.matchAll(TAG)].flatMap(([, body]) => [...body.matchAll(ATTR)])
  .filter(([, name]) => URL_ATTRS.has(name.toLowerCase()))
  .flatMap(([, name, ...v]) => {
    const val = v.find((g) => g !== undefined);
    if (val === undefined) return [];
    const srcset = name.toLowerCase() === 'srcset';
    return srcset ? val.split(',').map(firstCandidate).filter(Boolean) : [val];
  });

// Attribute text of an HTML open tag is not prose: blanked for the link scan only
// (the `<A>` of `[a](<A>)` has no attributes and stays).
const blankTags = (s) => s
  .replace(PROSE_TAG, (tag, body) => tag.replace(body, body.replace(/\S/g, ' ')));
const hrefsIn = (text) => {
  const { groups, markup, refs } = scanBlocks(text);
  const inline = groups
    .flatMap((g) => scanInlineLinks(blankTags(g.text)).map(({ dest }) => dest));
  return [...inline, ...attrsIn(markup), ...refs];
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
    throw new Error(`${where}: malformed percent escape in ${h}`);
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

// GitHub anchors: ATX headings (the sectionizer seam reads the lines scanBlocks marks), setext
// headings and `<a id>`/`<a name>` outside code and comments count; a repeated slug gets -1,
// -2, ...
// GitHub keeps non-ASCII letters and slugs the rendered text; slugify keeps neither, so
// such a heading gets no anchor and a link to it fails.
const unslugable = (text) => {
  const bare = text.replace(/`[^`\n]*`/g, '');
  return /(?!\p{ASCII})[\p{L}\p{N}]/u.test(text) || /\]\(|\]\[/.test(bare)
    || /<[A-Za-z/!]|&[A-Za-z0-9#]+;/.test(bare) // an HTML tag or entity renders to other text
    || /(?:^|\W)_|_(?:\W|$)/.test(bare);
};
const A_ID = /<a\s(?:[^>]*?\s)?(?:id|name)\s*=\s*["']([^"'\s>]+)["']/gi;
const headingSet = (source) => {
  const seen = new Map();
  const { markup, groups, atx } = scanBlocks(source);
  const setext = groups.filter((g) => g.heading !== undefined)
    .map((g) => ({ line: g.line, text: g.heading }));
  const headings = [...tokenizeHeadings(atx), ...setext].sort((a, b) => a.line - b.line);
  const slugs = headings.filter(({ text }) => !unslugable(text)).map(({ text }) => {
    const s = slugify(text);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  });
  return new Set([...slugs, ...[...markup.matchAll(A_ID)].map((m) => m[1])]);
};
const headingsOfFile = (rel) => headingSet(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const LINE_ANCHOR = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;
// heading: rendered markdown (blob or tree, no ?plain=1).
// line: blame, ?plain=1 and non-markdown blob. none: raw.
const anchorKind = ({ segs, tail }, rel) => {
  const plain = new URLSearchParams(tail.split('#')[0]).get('plain') === '1';
  const md = /\.md$/i.test(rel); // GitHub renders `.MD` as markdown too
  if (segs[0] === 'blame' || (segs[0] === 'blob' && (plain || !md))) return 'line';
  return REF_PAGE.has(segs[0]) && segs[0] !== 'raw' && md ? 'heading' : 'none';
};
const lineCountOf = (rel) => {
  const abs = path.join(ROOT, rel);
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
  REPO, NEXT, hrefsIn, isBadLink, nextRel, repoPathOf, missingNext,
  unresolvedAnchors, headingSet, anchorKind,
};
