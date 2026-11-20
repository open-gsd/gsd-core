// Link guard for #5427: a PR body renders a relative href against /pull/N, so it 404s.
// Links: every inline link and image, read line by line with the ADR gate's extractLinks, so a
// link in a code block, a comment, a quote or an HTML block is checked too (a template holds no
// relative link, not even in an example); only an inline code span hides one (extractLinks).
// A form this guard does not read exactly is refused, not read (unreadForms): a reference
// definition (any `]:`), a href/src/srcset attribute once an HTML tag has opened, and a line
// with a `](` that extractLinks does not read as a link (a nested bracket, an image inside a
// link, a line break or a parenthesis in a link) or an escaped backtick.
// A repo link must name no ref, or blob|tree|raw|blame on `next` to a path (and a heading or
// line anchor) that exists. `?template=` links stay (maintainer ruling on #5427).
// Every link to another host is bad too (an allowlist, not only relative links): a template
// links this repo and nothing else, so a lookalike host cannot pass.
// Autolinks (<https://...>) and bare URLs always carry a scheme, so they are never relative.
// Anchors: ATX headings outside fences (sectionizer), slugged with gen-features `slugify`. A
// heading the guard cannot place for sure gives no anchor, so a link to it fails: one in a
// block quote or after a list marker, one slugify cannot reproduce, an `<a id>`, and each
// heading after a line that may open code or HTML in a list item or an HTML block (unplaced).
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../../scripts/gen-features.cjs');
const {
  extractLinks, existsCaseExact, realRootOrFallback,
} = require('../../scripts/gen-adr-index.cjs');
const {
  stripInlineCode, scanFencedBlocks, tokenizeHeadings,
} = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;

// A destination is `<...>`, or the first run with no ASCII control or space (a non-ASCII space
// stays in it). 999 is this guard's own scan bound for the angle form.
const destOf = (raw) => {
  const rest = raw.slice(raw.search(/[^ \t]|$/));
  return /^<([^<>]{0,999})>/.exec(rest)?.[1] ?? rest.split(/[^!-~\u0080-\u{10FFFF}]/u)[0];
};
// Code spans are the sectionizer's: it blanks them before the gate's extractLinks reads a line.
const linksOf = (line) => extractLinks(stripInlineCode(line));
// Line by line: the gate's fence mask spans lines, and this guard checks code blocks too.
const hrefsIn = (text) => splitLines(text)
  .flatMap((line) => linksOf(line).map(({ target }) => destOf(target)));
// An href, src or srcset attribute (any case) takes its value after `=`, or on the next line when
// the name ends the line. After `/` only the `=` form counts: `/src/x.md` and `/src` are paths.
const URL_ATTR = /(?:^|[\s"'])(?:href|src|srcset)\s*(?:=|$)|\/(?:href|src|srcset)\s*=/i;
// The lines this guard refuses instead of reading, as `N: "line"`: see the header.
const unreadForms = (text) => {
  let tagged = false;
  return splitLines(text).flatMap((line, i) => {
    const tag = tagged ? 0 : line.search(/<[A-Za-z]/);
    tagged = tag >= 0; // an HTML block may span blank lines, so a tag marks the rest
    const refused = line.includes(']:') || (tagged && URL_ATTR.test(line.slice(tag)))
      || stripInlineCode(line).split('](').length - 1 > linksOf(line).length
      || line.includes('\\`');
    return refused ? [`${i + 1}: ${JSON.stringify(line)}`] : [];
  });
};

const REPO_BASE = REPO.slice(0, -1);
const DOT_SEG = /^(?:\.|%2e){1,2}$/i;
// The one rule for path segments, on the raw link (isBadLink) and on the decoded path
// (missingNext): a dot segment, a segment with `&` or `\` (CommonMark decodes an entity or an
// escape, so either can spell `..`), or an empty one (`gsd-core//blob/main/x`, `x/`,
// `x.md%2F`) in a path of more than one segment.
const badSegs = (segs) => segs.some((s) => DOT_SEG.test(s) || /[&\\]/.test(s))
  || (segs.length > 1 && segs.includes(''));
// The views whose path the existence check reads.
const REF_PAGE = new Set(['blob', 'tree', 'raw', 'blame']);
const NO_REF = new Set([
  '', 'issues', 'pull', 'pulls', 'discussions', 'actions', 'releases', 'wiki', 'security',
  'projects', 'labels', 'milestones', 'tags', 'branches', 'compare',
]);
// The one parse of a link into this repo; undefined for any other link. Host and owner/name
// are case-insensitive on GitHub, the view and the ref are not.
const repoLink = (h) => {
  const rest = h.slice(REPO_BASE.length);
  if (h.slice(0, REPO_BASE.length).toLowerCase() !== REPO_BASE || !/^(?:[/?#]|$)/.test(rest)) {
    return undefined;
  }
  const cut = rest.search(/[?#]|$/);
  const route = rest.slice(rest.startsWith('/') ? 1 : 0, cut);
  return { segs: route.split('/'), tail: rest.slice(cut) };
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
const existsExact = (rel, cache = DIR_CACHE) => existsCaseExact(path.join(ROOT, rel), cache,
  REAL_ROOT).exists;
// An empty segment after decoding (`x.md%2F`) is as bad as a raw one (isBadLink).
const missingNext = (hs, where) => hs.filter((h) => nextRel(h) !== undefined)
  .map((h) => repoPathOf(h, where))
  .filter((rel) => badSegs(rel.split('/')) || !existsExact(rel));

// GitHub keeps non-ASCII letters and slugs the rendered text; slugify keeps neither, so such
// a heading gets no anchor and a link to it fails. So do a link, an HTML tag or entity, `_`
// emphasis, and any whitespace but U+0020 (GitHub drops it, slugify makes it `-`).
const unslugable = (text) => {
  const bare = stripInlineCode(text);
  return /(?!\p{ASCII})[\p{L}\p{N}]/u.test(text) || /\]\(|\]\[/.test(bare)
    || /<[A-Za-z/!]|&[A-Za-z0-9#]{1,32};/.test(bare) // an HTML tag or entity renders other text
    || /(?:^|\W)_|_(?:\W|$)/.test(bare) || /[^\S ]/.test(text);
};
// A line that may open code or HTML inside a list item or an HTML block, where the sectionizer
// cannot place what follows: an HTML block start (`<` + letter, `/`, `!` or `?`, CommonMark 4.6)
// after any indentation or list marker, or a fence after them.
const unplaced = (line) => {
  const rest = line.slice(line.search(/[^ \t*+.)0-9-]|$/));
  return /^<[A-Za-z/!?]/.test(rest)
    || (rest.length < line.length && /^(?:`{3}|~{3})/.test(rest));
};
// GitHub anchors: ATX headings outside fences, up to the first unplaced line outside fence
// content (or a front matter `---` on line 1); a repeated slug gets -1, -2, ...
const headingSet = (source) => {
  const lines = splitLines(source);
  const code = new Set();
  for (const { openLineIdx: from, closeLineIdx: to } of scanFencedBlocks(lines)) {
    for (let i = from + 1; i <= (to < 0 ? lines.length - 1 : to); i++) code.add(i);
  }
  const at = lines.findIndex((l, i) => !code.has(i)
    && (unplaced(l) || (i === 0 && l.startsWith('---'))));
  const seen = new Map();
  const slugs = new Set(tokenizeHeadings(source)
    .filter(({ line, text }) => (at < 0 || line <= at) && !unslugable(text))
    .map(({ text }) => {
      const s = slugify(text);
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      return n ? `${s}-${n}` : s;
    }));
  // the stop line goes into the unresolved-anchor message, so a refusal names its cause
  const stop = at < 0 ? '' : `line ${at + 1}: ${JSON.stringify(lines[at])}`;
  return Object.assign(slugs, { stop });
};
// A repo file read through the gate's case-exact walk, which refuses a symlink out of the repo.
const readRepoFile = (rel, cache) => {
  if (!existsExact(rel, cache)) {
    throw Object.assign(new Error(`${JSON.stringify(rel)}: no such file inside the repo`), { rel });
  }
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
};
const headingsOfFile = (rel) => headingSet(readRepoFile(rel));

const LINE_ANCHOR = /^L(\d{1,9})(?:C\d{1,9})?(?:-L(\d{1,9})(?:C\d{1,9})?)?$/;
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
    const set = kind === 'heading' ? headingsOf(rel) : new Set();
    const ok = kind === 'heading' ? set.has(anchor)
      : kind === 'line' && lineAnchorOk(anchor, linesOf(rel));
    return ok ? [] : [`${rel}#${anchor}${set.stop ? ` (anchors stop at ${set.stop})` : ''}`];
  });
};

module.exports = {
  REPO, NEXT, hrefsIn, unreadForms, isBadLink, repoPathOf, missingNext,
  unresolvedAnchors, headingSet, anchorKind, lineCountOf, readRepoFile,
};
