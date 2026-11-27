'use strict';

// The words appear in order in the text, each pair separated by at least one whitespace character (any \s) and with no
// word boundary required before the first word or after the last: the text-contract form of /w1\s+w2\s+w3/ over fixed
// words, as a linear walk. Shared by the contracts that read an ordered phrase out of a workflow or a command line.
function hasSequence(text, words) {
  let at = text.indexOf(words[0]);
  while (at !== -1) {
    let cursor = at + words[0].length;
    let matched = true;
    for (const word of words.slice(1)) {
      const start = cursor;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (cursor === start || !text.startsWith(word, cursor)) {
        matched = false;
        break;
      }
      cursor += word.length;
    }
    if (matched) return true;
    at = text.indexOf(words[0], at + 1);
  }
  return false;
}

module.exports = { hasSequence };
