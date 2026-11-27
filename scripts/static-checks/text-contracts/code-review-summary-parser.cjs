'use strict';

// #2694: the inline `node -e` frontmatter one-liners of the code-review and code-review-fix workflows must normalize
// CRLF before the boundary match (`content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)`): the runtime loads
// the .md verbatim, so only the shipped text can show a revert of the fix. Each workflow has at least three boundary
// sites, and none takes a raw `content.match(` against the boundary regex. The old test's other cases ran parsers and a
// boundary extraction defined inside the test file (replicas of the shipped one-liners), so no change to a repository
// file could fail them; they are dropped. Every pattern is a linear walk over one line.
// Was tests/code-review-summary-parser.test.cjs.

const WORKFLOWS = ['gsd-core/workflows/code-review.md', 'gsd-core/workflows/code-review-fix.md'];
const MIN_SITES = 3;
// The boundary regex literal as it ships, with the closing parenthesis of the `.match(` call: /^---\n([\s\S]*?)\n---/)
const BOUNDARY_SITE = '/^---\\n([\\s\\S]*?)\\n---/)';
const CRLF_LITERAL = '/\\r\\n/g';
const LF_LITERAL = "'\\n'";
const RAW_MATCH_OPEN = '/^---\\n';

const isSpace = (char) => char !== undefined && /\s/.test(char);
const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);
const skipSpaces = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};

const isBoundarySite = (line) => line.includes(BOUNDARY_SITE);

// /content\.replace\(\s*\/\\r\\n\/g\s*,\s*'\\n'\s*\)\.match\(/: each `\s*` precedes a non-blank literal.
function isNormalizedMatch(line) {
  const open = 'content.replace(';
  let at = line.indexOf(open);
  while (at !== -1) {
    let p = skipSpaces(line, at + open.length);
    if (line.startsWith(CRLF_LITERAL, p)) {
      p = skipSpaces(line, p + CRLF_LITERAL.length);
      if (line[p] === ',') {
        p = skipSpaces(line, p + 1);
        if (line.startsWith(LF_LITERAL, p)) {
          p = skipSpaces(line, p + LF_LITERAL.length);
          if (line.startsWith(').match(', p)) return true;
        }
      }
    }
    at = line.indexOf(open, at + 1);
  }
  return false;
}

// /(^|[^.])\bcontent\.match\(\s*\/\^---\\n/: a `content.match(` that starts a word and is not a method of something else.
function isRawContentMatch(line) {
  const open = 'content.match(';
  let at = line.indexOf(open);
  while (at !== -1) {
    const before = line[at - 1];
    if (before === undefined || (before !== '.' && !isWordChar(before))) {
      if (line.startsWith(RAW_MATCH_OPEN, skipSpaces(line, at + open.length))) return true;
    }
    at = line.indexOf(open, at + 1);
  }
  return false;
}

// The boundary sites of a workflow and the ones that lack the CRLF normalize. The text is LF-normalised by the engine,
// so splitting on LF is the old `split(/\r?\n/)`; a lone CR stays inside its line, as it did.
function scanSites(text) {
  const sites = [];
  const unsafe = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBoundarySite(lines[i])) continue;
    sites.push(i + 1);
    if (!isNormalizedMatch(lines[i]) || isRawContentMatch(lines[i])) unsafe.push(i + 1);
  }
  return { sites, unsafe };
}

module.exports = {
  id: 'code-review-summary-parser',
  issue: '#2694',
  walkers: { isBoundarySite, isNormalizedMatch, isRawContentMatch, scanSites },
  check(ctx) {
    for (const rel of WORKFLOWS) {
      ctx.doc(rel)
        .satisfies((text) => {
          const { sites } = scanSites(text);
          return sites.length >= MIN_SITES || `found ${sites.length}`;
        }, `expected at least ${MIN_SITES} frontmatter-boundary sites; if the workflow no longer uses this regex, update this contract`)
        .satisfies((text) => {
          const { unsafe } = scanSites(text);
          return unsafe.length === 0 || `line${unsafe.length === 1 ? '' : 's'} ${unsafe.join(', ')}`;
        }, `every frontmatter-boundary site must normalize CRLF before matching (regression of #2694)`);
    }
  },
};
