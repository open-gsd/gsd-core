'use strict';

// `first`, then `second` later with none of the characters in `stops` between them: the walk of /first[^stops]*second/
// (a dot is every character but LF, CR, U+2028 and U+2029). Neither marker may hold a stop character. Each stop-free
// segment of the text is searched once, so the walk stays linear however long a line is.
function precedesWithin(text, first, second, stops) {
  let from = 0;
  for (let at = 0; at <= text.length; at += 1) {
    if (at !== text.length && !stops.has(text[at])) continue;
    const segment = text.slice(from, at);
    const head = segment.indexOf(first);
    if (head !== -1 && segment.includes(second, head + first.length)) return true;
    from = at + 1;
  }
  return false;
}

module.exports = { precedesWithin };
