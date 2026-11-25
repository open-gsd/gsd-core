'use strict';

// Linear walks of the word-boundary, bounded-window and whitespace-run patterns the contracts replace. Each text is
// walked once; a bounded window costs at most limit + 1 positions per start.

const WS = /\s/;

// `\w` of a pattern without the u flag: ASCII letters, digits and the underscore.
const isWordChar = (ch) => ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_');

// `\b` at index `i`: a word character on exactly one side.
const boundaryAt = (text, i) => isWordChar(text[i - 1]) !== isWordChar(text[i]);

// The first occurrence of `needle` inside [lo, hi), `\b`-bounded on both sides when `bounded`, or -1.
function findIn(text, lo, hi, needle, bounded) {
  const segment = text.slice(lo, hi);
  for (let k = segment.indexOf(needle); k !== -1; k = segment.indexOf(needle, k + 1)) {
    const i = lo + k;
    if (!bounded || (boundaryAt(text, i) && boundaryAt(text, i + needle.length))) return i;
  }
  return -1;
}

// `\bphrase\b`: the phrase with a word boundary on both ends.
const includesBounded = (text, phrase) => findIn(text, 0, text.length, phrase, true) !== -1;

// Some maximal run of word characters is one of `words` (`\b(?:a|b)\b`).
function hasWordRun(text, words) {
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const word = i < text.length && isWordChar(text[i]);
    if (word && start === -1) start = i;
    if (!word && start !== -1) {
      if (words.includes(text.slice(start, i))) return true;
      start = -1;
    }
  }
  return false;
}

// /first[^stops]*second/ with `\b` on either marker when asked (`bounds.first`, `bounds.second`): `first`, then `second`
// later, with none of the characters in `stops` between them. Each stop-free segment is searched once.
function precedesBounded(text, first, second, stops, bounds = {}) {
  let from = 0;
  for (let at = 0; at <= text.length; at += 1) {
    if (at !== text.length && !stops.has(text[at])) continue;
    const head = findIn(text, from, at, first, Boolean(bounds.first));
    if (head !== -1 && findIn(text, head + first.length, at, second, Boolean(bounds.second)) !== -1) return true;
    from = at + 1;
  }
  return false;
}

// /parts[0][^stops]{0,limit}parts[1][^stops]{0,limit}.../: each part follows the previous one within `limit` characters,
// none of them in `stops` (an empty set is `[\s\S]{0,limit}`). The search tries every placement, at most limit + 1 per part.
function windowChain(text, parts, limit, stops) {
  const place = (index, from) => {
    const part = parts[index];
    for (let at = text.indexOf(part, from); at !== -1; at = text.indexOf(part, at + 1)) {
      if (index > 0) {
        if (at - from > limit) return false;
        for (let i = from; i < at; i += 1) if (stops.has(text[i])) return false;
      }
      if (index === parts.length - 1 || place(index + 1, at + part.length)) return true;
    }
    return false;
  };
  return place(0, 0);
}

// `text.replace(/\s+/g, ' ')`: every run of whitespace is one space.
function collapseWhitespace(text) {
  let out = '';
  let inRun = false;
  for (let i = 0; i < text.length; i += 1) {
    if (WS.test(text[i])) {
      if (!inRun) out += ' ';
      inRun = true;
    } else {
      out += text[i];
      inRun = false;
    }
  }
  return out;
}

module.exports = { isWordChar, boundaryAt, findIn, includesBounded, hasWordRun, precedesBounded, windowChain, collapseWhitespace };
