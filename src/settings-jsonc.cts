/** JSONC parser shared by runtime settings readers.
 * String cleanup and unterminated-comment defects are tracked in #5989 and #5990.
 */

/** Strip line/block comments without removing comment-like text inside strings. */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  // #5989: a comma seen outside a string is held, not emitted. It is dropped
  // only when the next emitted non-whitespace char is `}` or `]` (a JSONC
  // trailing comma) and flushed before any other emitted char. Comments are
  // skipped by this same pass, so `, /*c*/ }` collapses exactly as the old
  // post-strip regex `,\s*([}\]])` did — but that regex ran on stripped text,
  // where a `,}` inside a string was indistinguishable from structure and
  // rewrote values like "x,}y".
  let pendingComma = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] || '');
        i += 2;
        continue;
      }
      if (text[i] === stringChar) inString = false;
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      if (pendingComma) {
        result += ',';
        pendingComma = false;
      }
      inString = true;
      stringChar = text[i];
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      // #5990: the scan may stop at end of input — that is not a closed comment.
      if (i >= text.length) throw new SyntaxError('Unterminated block comment');
      i += 2;
      continue;
    }
    if (text[i] === ',') {
      // Consecutive commas keep failing exactly as before: the held comma is
      // flushed and this one takes its place.
      if (pendingComma) result += ',';
      pendingComma = true;
      i++;
      continue;
    }
    if (/\s/.test(text[i])) {
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === '}' || text[i] === ']') {
      pendingComma = false;
    } else if (pendingComma) {
      result += ',';
      pendingComma = false;
    }
    result += text[i];
    i++;
  }
  // EOF flush: nothing followed the comma to drop it, so the text keeps the
  // same malformed shape the old regex left behind ({"a":1, still fails).
  if (pendingComma) result += ',';
  return result;
}

/** Parse JSONC, retaining the strict JSON fast path and its failure semantics. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}
