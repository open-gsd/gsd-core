'use strict';

const { scanFencedBlocks } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../../gsd-core/bin/lib/text-lines.cjs');

/**
 * Fold unquoted shell backslash-newline continuations into logical lines.
 *
 * A newline is continued only when the immediately preceding backslash run is
 * odd: the final backslash is consumed and every earlier pair stays literal.
 * This deliberately remains a text heuristic, not a shell parser; in
 * particular, a backslash-newline inside single quotes is a known blind spot.
 */
function foldShellContinuations(src) {
  return src.replace(
    /(^|[^\\])((?:\\\\)*)\\\n[ \t]*/gm,
    (_match, prefix, literalPairs) => `${prefix}${literalPairs} `,
  );
}

/** Return regex matches from logical lines inside closed bash/sh fences. */
function findShellFencedMatches(src, pattern) {
  const lines = splitLines(src);
  return scanFencedBlocks(lines).flatMap((block) => {
    if (block.closeLineIdx === -1) return [];
    const language = block.infoString.trim().toLowerCase();
    if (language !== 'bash' && language !== 'sh') return [];
    const body = lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n');
    return Array.from(
      foldShellContinuations(body).matchAll(pattern),
      (match) => match[0],
    );
  });
}

module.exports = { foldShellContinuations, findShellFencedMatches };
