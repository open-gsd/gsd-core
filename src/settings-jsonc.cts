/** JSONC parser shared by runtime settings readers. */

/** Strip line/block comments without removing comment-like text inside strings. */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
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
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

/** Parse JSONC, retaining the strict JSON fast path and its failure semantics. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}
