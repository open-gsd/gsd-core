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
  maskCode, scanInlineLinks, linkDestination, linkTitleEnd, LINK_WS, BLANK,
  existsCaseExact, realRootOrFallback,
} = require('../../scripts/gen-adr-index.cjs');
const { tokenizeHeadings } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;

// A reference definition: its marker and label are read here, its destination and title by
// the ADR gate's grammar (linkDestination, linkTitleEnd), the one owner of both forms.
// A label holds no unescaped bracket, some text (judged on the unmasked line: a code span is
// text) and no blank line.
const REF_LABEL = String.raw`\[((?:\\[^]|[^\[\]\\])+)\]:`;
const LIST_MARKER = String.raw`(?:[-*+]|\d{1,9}[.)])`;
const REF_PREFIX = String.raw`^(?:[ \t]*(?:>|${LIST_MARKER}(?=[ \t])))*[ \t]*`
  + REF_LABEL + LINK_WS + String.raw`(?!${REF_LABEL})`;
const REF_HEAD = new RegExp(REF_PREFIX, 'dgm');
const REF_EOL = /[ \t]*$/ym;
const LABEL_TEXT = /^(?=[^]*\S)(?:\\[^]|[^[\]\\])+$/; // some text, no unescaped bracket
const endsLine = (u, e) => e >= 0 && Object.assign(REF_EOL, { lastIndex: e }).test(u);
// The definition's destination when its title (or, failing that, its destination) ends the line.
// `masked` (code blanked) finds a definition; `u` (comments blanked, code spans kept) is what
// it says: backticks in a label or a destination are text, not code.
// A definition that interrupts a paragraph is read too (GitHub shows it as text): the guard
// fails closed.
const refsIn = (masked, u) => [...masked.matchAll(REF_HEAD)].flatMap((m) => {
  if (!LABEL_TEXT.test(u.slice(...m.indices[1]))) return [];
  const at = m.index + m[0].length;
  const d = linkDestination(u, at);
  if (!d || d.end === at) return []; // a bare destination is not empty
  const end = [linkTitleEnd(u, d.end), d.end].find((e) => endsLine(u, e));
  return end === undefined || BLANK.test(u.slice(m.index, end)) ? [] : [d.dest];
});

// Indented code (4+ spaces or a tab) follows a blank line or more code, and is not a list
// item's continuation. Indentation and list state are judged on the RAW line, because
// maskCode leaves a line that opens with an inline code span as blanks; blank-ness
// is judged by isBlank.
const LIST_ITEM = new RegExp(`^ {0,3}${LIST_MARKER}[ \\t]`);
// A line is blank when maskCode leaves nothing and it does not open with an inline code span
// (a backtick run closed by a run of equal length later on the line; a fence line has no such
// closer). A line that is only a code span is text.
const SPAN_OPENS = /^\s*(`+)(?!`)[^]*?(?<!`)\1(?!`)/;
const isBlank = (masked, rawLine) => !masked.trim() && !SPAN_OPENS.test(rawLine);
const INDENTED = /^( {4}|\t)/;
// Per line: is it inside a list item? The one owner of list state. An item stays open across
// its indented text and lazy continuation lines; only an unindented line after a blank line
// ends it, and a line indented 4 or more leaves the state as it was.
const openItems = (rawLines, blanks) => {
  let open = false;
  let afterBlank = true;
  return rawLines.map((line, i) => {
    if (!blanks[i] && !INDENTED.test(line)) {
      open = LIST_ITEM.test(line) || (open && !(afterBlank && !/^ {2}/.test(line)));
    }
    afterBlank = blanks[i];
    return open;
  });
};
const maskIndentedCode = (raw, masked) => {
  const rawLines = raw.split('\n');
  const maskedLines = masked.split('\n');
  const blanks = maskedLines.map((m, i) => isBlank(m, rawLines[i]));
  const inList = openItems(rawLines, blanks);
  let afterBlank = true;
  return maskedLines.map((m, i) => {
    const code = INDENTED.test(rawLines[i]) && !blanks[i] && !inList[i] && afterBlank;
    afterBlank = blanks[i] || code;
    return code ? m.replace(/\S/g, ' ') : m;
  }).join('\n');
};
// Everything GitHub renders as code.
const maskBlocks = (t) => maskIndentedCode(t, maskCode(t));
// A comment that starts where maskBlocks leaves its `<` is a comment; inside code it is code.
const maskComments = (text) => {
  let t = text;
  for (let i = t.indexOf('<!--'); i >= 0; i = t.indexOf('<!--', i + 4)) {
    const end = t.indexOf('-->', i + 2); // `<!-->` and `<!--->` close at once
    if (end < 0 || maskBlocks(t)[i] !== '<') continue;
    t = t.slice(0, i) + t.slice(i, end + 3).replace(/\S/g, ' ') + t.slice(end + 3);
  }
  return t;
};

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

const hrefsIn = (text) => {
  const uncommented = maskComments(text);
  const t = maskBlocks(uncommented);
  // Attribute text of an HTML open tag is not prose: blanked for the link scan only
  // (the `<A>` of `[a](<A>)` has no attributes and stays).
  const prose = t.replace(PROSE_TAG, (tag, body) => tag.replace(body, body.replace(/\S/g, ' ')));
  const inline = scanInlineLinks(prose).map(({ dest }) => dest);
  return [...inline, ...attrsIn(t), ...refsIn(t, uncommented)];
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

// A paragraph followed by === or --- is a setext heading; maskCode supplies fences and code
// spans, the raw lines the text.
const blockStart = new RegExp(
  String.raw`^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|${LIST_MARKER}[ \t]|(?:[*_-][ \t]*){3,}$)`,
);
const setextHeadings = (md) => {
  const raw = md.split(/\r?\n/);
  const out = [];
  let para = [];
  const masked = maskCode(md).split(/\r?\n/);
  const blanks = masked.map((m, i) => isBlank(m, raw[i]));
  const inList = openItems(raw, blanks); // a list item's lines head no setext heading
  masked.forEach((m, i) => {
    const blank = blanks[i];
    if (inList[i] && !blank) {
      para = [];
    } else if (para.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(m)) {
      out.push({ line: para[0] + 1, text: para.map((k) => raw[k].trim()).join(' ') });
      para = [];
    } else if (blank || blockStart.test(m) || (!para.length && INDENTED.test(m))) {
      para = [];
    } else {
      para.push(i);
    }
  });
  return out;
};

// GitHub anchors: headings inside fences do not exist (the sectionizer seam skips them), a
// repeated slug gets -1, -2, ...
// GitHub keeps non-ASCII letters and slugs the rendered text; slugify keeps neither, so
// such a heading gets no anchor and a link to it fails.
const unslugable = (text) => {
  const bare = text.replace(/`[^`\n]*`/g, '');
  return /(?!\p{ASCII})[\p{L}\p{N}]/u.test(text) || /\]\(|\]\[/.test(bare)
    || /<[A-Za-z/!]|&[A-Za-z0-9#]+;/.test(bare) // an HTML tag or entity renders to other text
    || /(?:^|\W)_|_(?:\W|$)/.test(bare);
};
// Blockquote content keeps its line number, so a quoted heading sorts and counts in place.
// A line that `masked` (maskBlocks) blanks is code, so it is no quote.
const unquote = (text, masked) => {
  const m = masked.split(/\r?\n/);
  return text.split(/\r?\n/)
    .map((l, i) => (/^ {0,3}>/.test(m[i]) ? l.replace(/^(?: {0,3}> ?)+/, '') : '')).join('\n');
};
const A_ID = /<a\s(?:[^>]*?\s)?(?:id|name)\s*=\s*["']([^"'\s>]+)["']/gi;
const headingSet = (source) => {
  const seen = new Map();
  const md = maskComments(source); // a comment renders nothing
  const masked = maskBlocks(md);
  const quoted = unquote(md, masked);
  const headings = [md, quoted].flatMap((t) => [...tokenizeHeadings(t), ...setextHeadings(t)])
    .sort((a, b) => a.line - b.line);
  const slugs = headings.filter(({ text }) => !unslugable(text)).map(({ text }) => {
    const s = slugify(text);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  });
  return new Set([...slugs, ...[...masked.matchAll(A_ID)].map((m) => m[1])]);
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
