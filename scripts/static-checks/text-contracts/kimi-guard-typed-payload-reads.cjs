'use strict';

// Typed-payload-read invariant for the guard hooks (#2547, PR #2595 review): a hook that reads a model-supplied path
// field off the payload (`tool_input.file_path`, `tool_info.path`, ...) tests its type. `[]` and `{}` are truthy, so an
// untyped read survives an `if (!filePath)` early-out and throws one line later into the outer
// `catch { process.exit(0) }`: crash-to-allow. The fixed and crashing reads are black-box identical, so this is a scan of
// the hook source (the whole hooks/ directory, so a new hook is swept in): comments are stripped, the source is split
// into statements at `;`, and a statement that reads a path field must contain `typeof`. A floor pins that the known
// readers still match the read pattern. Was tests/kimi-guard-typed-payload-reads.test.cjs.

const CONTAINERS = ['tool_input', 'tool_info', 'toolInfo'];
const FIELDS = ['file_path', 'path'];
// Files known to read a path field off the payload: a scan that matches nothing is a broken scan, not a clean repo.
const KNOWN_READERS = [
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-secret-read-guard.js',
  'gsd-windsurf-pre-write.js',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js',
];
const LINE_TERMINATORS = new Set(['\n', '\r', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);

const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);

function skipWhitespace(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

// The offset of the first read of a payload path field: a container name, optional whitespace, an optional `?`, a dot,
// optional whitespace, then `file_path` or `path` ending at a word boundary. -1 when there is none.
function findPathFieldRead(text) {
  for (let i = 0; i < text.length; i++) {
    if (!isWordChar(text[i]) || isWordChar(text[i - 1])) continue;
    for (const container of CONTAINERS) {
      if (!text.startsWith(container, i)) continue;
      let j = skipWhitespace(text, i + container.length);
      if (text[j] === '?') j += 1;
      if (text[j] !== '.') continue;
      j = skipWhitespace(text, j + 1);
      for (const field of FIELDS) {
        if (text.startsWith(field, j) && !isWordChar(text[j + field.length])) return i;
      }
    }
  }
  return -1;
}

function hasWord(text, word) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return true;
  }
  return false;
}

// Block comments, then line comments (a `//` not preceded by a colon, up to the next line terminator), removed.
function stripComments(source) {
  let out = '';
  let from = 0;
  for (;;) {
    const open = source.indexOf('/*', from);
    const close = open === -1 ? -1 : source.indexOf('*/', open + 2);
    if (close === -1) {
      out += source.slice(from);
      break;
    }
    out += source.slice(from, open);
    from = close + 2;
  }
  let result = '';
  for (let i = 0; i < out.length;) {
    if (out.startsWith('//', i) && (i === 0 || out[i - 1] !== ':')) {
      let end = i + 2;
      while (end < out.length && !LINE_TERMINATORS.has(out[end])) end += 1;
      i = end;
    } else {
      result += out[i];
      i += 1;
    }
  }
  return result;
}

// The untyped reads of a hook: each statement (text up to a `;`) that reads a path field and has no `typeof`.
function untypedReads(source) {
  const offenders = [];
  let start = 0;
  const consider = (from, to) => {
    const statement = source.slice(from, to);
    const at = findPathFieldRead(statement);
    if (at < 0 || hasWord(statement, 'typeof')) return;
    const line = source.slice(0, from + at).split('\n').length;
    offenders.push(`line ${line}: ${statement.slice(at).split('\n')[0].trim().slice(0, 90)}`);
  };
  for (let i = 0; i < source.length; i++) {
    if (source[i] === ';') {
      consider(start, i + 1);
      start = i + 1;
    }
  }
  consider(start, source.length);
  return offenders;
}

module.exports = {
  id: 'kimi-guard-typed-payload-reads',
  issue: '#2547',
  check(ctx) {
    for (const known of KNOWN_READERS) {
      ctx.doc(`hooks/${known}`).satisfies(
        (text) => findPathFieldRead(stripComments(text)) >= 0 || 'no path-field read matched',
        `${known} must still match the path-field read pattern: either the read was removed or the scan broke, and the gate would silently cover less than it claims`,
      );
    }
    for (const rel of ctx.list('hooks', '.js', 'the hooks are what the typed-read scan covers').filter((file) => file.split('/').length === 2)) {
      ctx.doc(rel).satisfies((text) => {
        const offenders = untypedReads(stripComments(text));
        return offenders.length === 0 || offenders.join('; ');
      }, 'a hook must not read a model-supplied payload path field without a typeof string test: [] and {} are truthy, pass an early-out and throw into the outer catch, which exits 0 (crash-to-allow, #2547); read it as typeof x === \'string\' ? x : \'\'');
    }
  },
};
