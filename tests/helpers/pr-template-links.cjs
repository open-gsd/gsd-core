// Link guard for #5427: a PR body renders a relative href against /pull/N, so it 404s.
// Checked: inline links, reference definitions and href/src/srcset attributes of HTML
// open tags, outside code and HTML comments. A repo link must name no ref, or
// blob|tree|raw|blame on `next` to a path (and a heading or line anchor) that exists.
// `?template=` links stay (maintainer ruling on #5427).
// Out of scope: autolinks (<https://...>) and bare URLs always carry a scheme, so they
// are never relative.
// Anchors use scripts/gen-features.cjs `slugify`: ASCII only, raw heading text, so a
// heading with non-ASCII text, a link or emphasis, a blockquote heading or an explicit
// `<a id>` is not modelled; no template links to one.
const fs = require('node:fs');
const path = require('node:path');

const { slugify } = require('../../scripts/gen-features.cjs');
const { maskCode, scanInlineLinks } = require('../../scripts/gen-adr-index.cjs');
const { tokenizeHeadings } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/open-gsd/gsd-core/';
const NEXT = `${REPO}blob/next/`;

const REF_LABEL = String.raw`\[(?:\\.|[^\]\\\n])+\]:`;
const REF_PREFIX = String.raw`^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))* *`
  + REF_LABEL + String.raw`[ \t]*(?:\r?\n[ \t]*)?`;
const REF_DEST = String.raw`(?:<([^>\n]*)>|(?!${REF_LABEL})(\S+))`;
const REF_TITLE = String.raw`(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$`;
const REFDEF = new RegExp(REF_PREFIX + REF_DEST + REF_TITLE, 'gm');

// Indented code (4+ spaces or a tab) follows a blank line or more code, and is not a list
// item's continuation. Indentation and list state are judged on the RAW line, because
// maskCode leaves a line that opens with an inline code span as blanks (D14); blank-ness
// is judged on the masked line.
const maskIndentedCode = (raw, masked) => {
  const rawLines = raw.split('\n');
  let afterBlank = true;
  let inList = false;
  return masked.split('\n').map((m, i) => {
    const blank = !m.trim();
    const indented = /^( {4}|\t)/.test(rawLines[i]);
    if (!blank && !indented) inList = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/.test(rawLines[i]);
    const code = indented && !blank && !inList && afterBlank;
    afterBlank = blank || code;
    return code ? m.replace(/\S/g, ' ') : m;
  }).join('\n');
};
// Everything GitHub renders as code.
const maskBlocks = (t) => maskIndentedCode(t, maskCode(t));
// A comment that starts where maskBlocks leaves its `<` is a comment; inside code it is code.
const maskComments = (text) => {
  let t = text;
  for (let i = t.indexOf('<!--'); i >= 0; i = t.indexOf('<!--', i + 4)) {
    const end = t.indexOf('-->', i + 4);
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
const attrsIn = (t) => [...t.matchAll(TAG)].flatMap(([, body]) => [...body.matchAll(ATTR)])
  .filter(([, name]) => URL_ATTRS.has(name.toLowerCase()))
  .flatMap(([, name, ...v]) => {
    const val = v.find((g) => g !== undefined);
    if (val === undefined) return [];
    const srcset = name.toLowerCase() === 'srcset';
    return srcset ? val.split(',').map(firstCandidate).filter(Boolean) : [val];
  });

const hrefsIn = (text) => {
  const t = maskBlocks(maskComments(text));
  const refs = [...t.matchAll(REFDEF)].map((m) => m.slice(1).find((g) => g !== undefined));
  // Attribute text of an HTML open tag is not prose: blanked for the link scan only
  // (the `<A>` of `[a](<A>)` has no attributes and stays).
  const prose = t.replace(TAG, (tag, body) => tag.replace(body, body.replace(/\S/g, ' ')));
  return [...scanInlineLinks(prose).map(({ dest }) => dest), ...attrsIn(t), ...refs];
};

// Host and owner/name are case-insensitive on GitHub, the view and the ref are not.
const REPO_URL = /^https:\/\/github\.com\/open-gsd\/gsd-core(?:\/([^?#]*))?([?#].*)?$/i;
const DOT_SEG = /^(?:\.|%2e){1,2}$/i;
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
// Never ok: a dot segment.
const isBadLink = (h) => {
  if (h.startsWith('?template=') || h === '#') return false;
  const link = repoLink(h);
  if (!link || link.segs.some((s) => DOT_SEG.test(s))) return true;
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
const missingNext = (hs, where) => hs.filter((h) => nextRel(h) !== undefined)
  .map((h) => repoPathOf(h, where))
  .filter((rel) => rel.split('/').includes('..') || !existsExact(rel));

// A paragraph followed by === or --- is a setext heading; maskCode supplies fences and code
// spans, the raw lines the text.
const blockStart =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|(?:[*_-][ \t]*){3,}$)/;
const indentedStart = /^( {4}|\t)/;
const setextHeadings = (md) => {
  const raw = md.split(/\r?\n/);
  const out = [];
  let para = [];
  maskCode(md).split(/\r?\n/).forEach((m, i) => {
    // a line that is only a code span is text
    const blank = !m.trim() && !/^ {0,3}`+[^`\s]/.test(raw[i]);
    if (para.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(m)) {
      out.push({ line: para[0] + 1, text: para.map((k) => raw[k].trim()).join(' ') });
      para = [];
    } else if (blank || blockStart.test(m) || (!para.length && indentedStart.test(m))) {
      para = [];
    } else {
      para.push(i);
    }
  });
  return out;
};

// GitHub anchors: headings inside fences do not exist (the sectionizer seam skips them), a
// repeated slug gets -1, -2, ...
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
const headingsOfFile = (rel) => headingSet(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const LINE_ANCHOR = /^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/;
// heading: rendered markdown (blob or tree, no ?plain=1).
// line: blame, ?plain=1 and non-markdown blob. none: raw.
const anchorKind = ({ segs, tail }, rel) => {
  const plain = new URLSearchParams(tail.split('#')[0]).get('plain') === '1';
  const md = rel.endsWith('.md');
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
  return m !== null && [m[1], m[2] ?? m[1]].every((n) => Number(n) >= 1 && Number(n) <= count);
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
  REPO, NEXT, hrefsIn, repoLink, isBadLink, nextRel, repoPathOf, missingNext,
  unresolvedAnchors, headingSet,
};
