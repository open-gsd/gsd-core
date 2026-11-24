'use strict';

// No runtime-loaded markdown hardcodes a `node $HOME/.../gsd-tools.cjs` call: in the bash and sh blocks of agents/,
// commands/ and gsd-core/references/ (each directory must hold at least one such block), and in any line of
// gsd-core/workflows (#637, the quoted `node "$HOME/..."` form); and no workflow calls mktemp with a filename suffix
// after the XXXXXX run (#1520: BSD mktemp then yields a literal, colliding path). The probes are linear scans of
// each line, as the old patterns were. Bash blocks are found as the test found them: a column-0 bash or sh fence line
// opens, the next column-0 fence line closes. Folded: bug-637 and fix-1520. Was tests/no-hardcoded-home-gsd-tools.test.cjs.

const SCAN_DIRS = ['agents', 'commands', 'gsd-core/references'];
const WORKFLOWS = 'gsd-core/workflows';
const PREAMBLE_SKIP = ['_GSD_SHIM_NAME', 'GSD_TOOLS=', '[ -f'];
const SUFFIX_CHAR = /[.A-Za-z0-9_-]/;

const isSpace = (ch) => ch !== undefined && /\s/.test(ch);
const skipSpace = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};

// `node\s+[`"']?(?:$HOME|${HOME}|~)` followed anywhere later on the line by gsd-tools.cjs.
function hardcodedNodeCall(line) {
  for (let at = line.indexOf('node'); at !== -1; at = line.indexOf('node', at + 1)) {
    const afterNode = at + 'node'.length;
    let next = skipSpace(line, afterNode);
    if (next === afterNode) continue;
    if ('`"\''.includes(line[next] ?? '\0')) next += 1;
    for (const home of ['$HOME', '${HOME}', '~']) {
      if (line.startsWith(home, next) && line.indexOf('gsd-tools.cjs', next + home.length) !== -1) return true;
    }
  }
  return false;
}

// `node\s+"$HOME/[^"]*gsd-tools.cjs"`: the first quote after the opening one must close a path ending in gsd-tools.cjs.
function quotedHomeNodeCall(line) {
  const opening = 'node';
  for (let at = line.indexOf(opening); at !== -1; at = line.indexOf(opening, at + 1)) {
    const afterNode = at + opening.length;
    const next = skipSpace(line, afterNode);
    if (next === afterNode || !line.startsWith('"$HOME/', next)) continue;
    const start = next + '"$HOME/'.length;
    const close = line.indexOf('"', start);
    if (close !== -1 && line.slice(start, close).endsWith('gsd-tools.cjs')) return true;
  }
  return false;
}

// `mktemp\s+["']?\S*?X{3,}(?!X)[.A-Za-z0-9_-]`: a maximal run of three or more X, followed by a suffix character,
// inside the one token after mktemp.
function suffixedMktemp(line) {
  for (let at = line.indexOf('mktemp'); at !== -1; at = line.indexOf('mktemp', at + 1)) {
    const afterWord = at + 'mktemp'.length;
    const start = skipSpace(line, afterWord);
    if (start === afterWord) continue;
    let end = start;
    while (end < line.length && !isSpace(line[end])) end += 1;
    const token = line.slice(start, end);
    for (let i = 0; i < token.length;) {
      if (token[i] !== 'X') {
        i += 1;
        continue;
      }
      const runStart = i;
      while (token[i] === 'X') i += 1;
      if (i - runStart >= 3 && i < token.length && SUFFIX_CHAR.test(token[i])) return true;
    }
  }
  return false;
}

const firstWord = (text) => {
  let end = 0;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return text.slice(0, end);
};

// The bash and sh blocks of a file, as the test read them: a column-0 line of three backticks and bash or sh (any info
// string after a blank) opens a block, the next column-0 line of three backticks and blanks closes it, and any other
// fence line is plain text. An unterminated block runs to the end of the file; an empty unterminated block is dropped.
function bashBlocks(text) {
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, at) => {
    if (open === null) {
      if (!line.startsWith('```')) return;
      const word = firstWord(line.slice(3));
      if (word === 'bash' || word === 'sh') open = [];
      return;
    }
    if (line.startsWith('```') && line.slice(3).trim() === '') {
      blocks.push(open);
      open = null;
    } else {
      open.push({ line, number: at + 1 });
    }
  });
  if (open !== null && open.length > 0) blocks.push(open);
  return blocks;
}

const offenders = (text, probe) => text.split('\n').flatMap((line, at) => (probe(line) ? [`line ${at + 1}: ${line.trim()}`] : []));

module.exports = {
  id: 'no-hardcoded-home-gsd-tools',
  issue: '#637',
  walkers: { hardcodedNodeCall, quotedHomeNodeCall, suffixedMktemp, bashBlocks },
  check(ctx) {
    for (const dir of SCAN_DIRS) {
      let blockCount = 0;
      const files = ctx.list(dir, '.md', `${dir} holds the markdown scanned for hardcoded gsd-tools calls`);
      for (const rel of files) {
        ctx.doc(rel).satisfies((text) => {
          const blocks = bashBlocks(text);
          blockCount += blocks.length;
          const found = blocks.flatMap((block) => block
            .filter(({ line }) => hardcodedNodeCall(line) && !PREAMBLE_SKIP.some((skip) => line.includes(skip)))
            .map(({ line, number }) => `line ${number}: ${line.trim()}`));
          return found.length === 0 || `hardcoded invocation(s): ${found.join('; ')}`;
        }, 'a bash block must not hardcode a $HOME gsd-tools.cjs call (resolve it through gsd_run)');
      }
      if (files.length > 0 && blockCount < 1) ctx.fail(dir, `${dir}/ exists but contains 0 bash blocks: the scan would pass over nothing`);
    }

    for (const rel of ctx.list(WORKFLOWS, '.md', 'the workflows hold the markdown scanned for hardcoded gsd-tools and mktemp calls')) {
      ctx.doc(rel)
        .satisfies((text) => {
          const found = offenders(text, quotedHomeNodeCall);
          return found.length === 0 || found.join('; ');
        }, 'a workflow must invoke gsd-tools via the resolved gsd_run launcher, not a hardcoded node "$HOME/.../gsd-tools.cjs" path (#637)')
        .satisfies((text) => {
          const found = offenders(text, suffixedMktemp);
          return found.length === 0 || found.join('; ');
        }, 'a workflow mktemp template must keep XXXXXX as the final path component (create suffix-less, then mv to add the extension, #1520)');
    }
  },
};
