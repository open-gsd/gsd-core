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
// none of them in `stops` (an empty set is `[\s\S]{0,limit}`). The first part is searched over the whole text; every later part
// only inside the limit + part length characters after the previous one, so a placement costs at most that many positions.
function windowChain(text, parts, limit, stops) {
  const place = (index, from) => {
    const part = parts[index];
    const base = index === 0 ? 0 : from;
    const segment = index === 0 ? text : text.slice(from, from + limit + part.length);
    for (let k = segment.indexOf(part); k !== -1; k = segment.indexOf(part, k + 1)) {
      const at = base + k;
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

// A caller of a loaded library that never lets a throw end the contract: the first throw marks the library state failed, reports one
// finding for the library file and returns the fallback (so the checks that need it stay quiet and the others still run).
function libCaller(ctx, state, file) {
  return (fn, fallback) => {
    if (state.error) return fallback;
    try {
      return fn(state.lib);
    } catch (err) {
      state.error = `${file} threw: ${String(err && err.message !== undefined ? err.message : err)}`;
      ctx.fail(file, state.error);
      return fallback;
    }
  };
}

module.exports = { libCaller, isWordChar, boundaryAt, findIn, includesBounded, hasWordRun, precedesBounded, windowChain, collapseWhitespace };
