'use strict';

const { scanFencedBlocks } = require('../../gsd-core/bin/lib/markdown-sectionizer.cjs');

// Parse documented shell calls without evaluating paths, variables or substitutions.
// Backtick spans also cover Markdown's inline command examples. Fence delimiters
// are presentation, while heredoc bodies are data (only their expansions execute).
function shellTokens(source, base = 0) {
  const tokens = [];
  let i = 0;
  let heredoc = null;
  const pending = [];

  function quotedEnd(start, quote) {
    let at = start + 1;
    while (at < source.length) {
      if (source[at] === quote) return at + 1;
      if (quote === '"' && source.startsWith('$(', at)) { at = substitutionEnd(at); continue; }
      if (quote !== "'" && source[at] === '\\') at++;
      at++;
    }
    return at;
  }

  function substitutionEnd(start) {
    let at = start + 2;
    let depth = 1;
    while (at < source.length) {
      const ch = source[at];
      if (ch === '\\') { at += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { at = quotedEnd(at, ch); continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return at + 1;
      at++;
    }
    return at;
  }

  function expansion(children) {
    const start = i;
    const end = substitutionEnd(start);
    children.push({ source: source.slice(start + 2, end - 1), base: base + start + 2 });
    i = end;
    return source.slice(start, end);
  }

  while (i < source.length) {
    const start = i;
    const ch = source[i];
    if (ch === '\\' && /^(?:\r?\n)/.test(source.slice(i + 1))) {
      i += source[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (ch === '\n') {
      tokens.push({ type: 'op', value: '\n', at: base + i++ });
      for (const doc of pending.splice(0)) {
        const bodyStart = i;
        while (i < source.length) {
          let end = source.indexOf('\n', i);
          if (end === -1) end = source.length;
          const line = source.slice(i, end).replace(/\r$/, '');
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
            if (!doc.literal) {
              // A heredoc expands substitutions, but its ordinary lines are not commands.
              const body = source.slice(bodyStart, i);
              const children = [];
              let pos = 0;
              while (pos < body.length) {
                if (body[pos] === '\\') { pos += 2; continue; }
                if (body.startsWith('$(', pos)) {
                  const saved = i;
                  i = bodyStart + pos;
                  expansion(children);
                  pos = i - bodyStart;
                  i = saved;
                } else pos++;
              }
              tokens.push({ type: 'word', value: '', children, at: base + bodyStart });
              tokens.push({ type: 'op', value: '\n', at: base + i });
            }
            i = Math.min(end + 1, source.length);
            break;
          }
          i = Math.min(end + 1, source.length);
        }
      }
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    // Angle-bracket placeholders in documentation represent a single shell word.
    const placeholder = source.slice(i).match(/^<[\w.-]+>/);
    const redirect = !placeholder && source.slice(i).match(/^(?:\d*(?:<<<|<<-|<<|>>|<>|>&|<&|>|<)|&>>?)/);
    if (redirect) {
      tokens.push({ type: 'redirect', value: redirect[0], at: base + i });
      heredoc = /<<-?$/.test(redirect[0]) ? { tabs: redirect[0].endsWith('-') } : null;
      i += redirect[0].length;
      continue;
    }
    const operator = !placeholder && source.slice(i).match(/^(?:&&|\|\||;;|[;|&()])/);
    if (operator) {
      tokens.push({ type: 'op', value: operator[0], at: base + i });
      i += operator[0].length;
      continue;
    }

    let value = '';
    const children = [];
    while (i < source.length && !/[\s;|&()<>]/.test(source[i])) {
      if (source[i] === "'") {
        const end = quotedEnd(i, "'");
        value += source.slice(i + 1, end - 1);
        i = end;
      } else if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"') {
          if (source.startsWith('$(', i)) value += expansion(children);
          else if (source[i] === '`') {
            const end = quotedEnd(i, '`');
            children.push({ source: source.slice(i + 1, end - 1), base: base + i + 1 });
            value += source.slice(i, end);
            i = end;
          }
          else if (source[i] === '\\' && /[$`"\\\r\n]/.test(source[i + 1] || '')) {
            i++;
            if (source[i] === '\r' && source[i + 1] === '\n') i++;
            if (source[i] !== '\n') value += source[i];
            i++;
          } else value += source[i++];
        }
        if (source[i] === '"') i++;
      } else if (source.startsWith('$(', i)) value += expansion(children);
      else if (source[i] === '`') {
        const end = quotedEnd(i, '`');
        children.push({ source: source.slice(i + 1, end - 1), base: base + i + 1 });
        value += source.slice(i, end);
        i = end;
      } else if (source[i] === '\\') {
        i++;
        if (source[i] === '\r' && source[i + 1] === '\n') i++;
        if (i < source.length && source[i] !== '\n') value += source[i];
        i++;
      } else value += source[i++];
    }
    if (placeholder && i === start) { value = placeholder[0]; i += value.length; }
    if (i === start) i++; // An incomplete document token must still make progress.
    tokens.push({ type: 'word', value, children, at: base + start });
    if (heredoc) {
      pending.push({ ...heredoc, delimiter: value, literal: /['"\\]/.test(source.slice(start, i)) });
      heredoc = null;
    }
  }
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}', 'time']);
const GLOBAL_VALUES = new Set(['--cwd', '--project-dir', '--ws', '--pick', '--default']);
const GLOBAL_FLAGS = new Set(['--raw', '--json-errors']);

function withoutGlobals(words, positions = false) {
  const result = [];
  for (let i = 0; i < words.length; i++) {
    if (GLOBAL_VALUES.has(words[i])) { i++; continue; }
    if (GLOBAL_FLAGS.has(words[i]) || /^(?:--cwd|--project-dir|--ws|--pick|--default|--exit-contract)=/.test(words[i])) continue;
    result.push(positions ? { value: words[i], index: i } : words[i]);
  }
  return result;
}

function queryArgv(words) {
  let i = 0;
  while (ASSIGNMENT.test(words[i] || '')) i++;
  if (words[i] === 'env') {
    i++;
    while (i < words.length) {
      if (['-u', '--unset', '-C', '--chdir'].includes(words[i])) { i += 2; continue; }
      if (words[i] === '--') { i++; break; }
      if (ASSIGNMENT.test(words[i]) || /^-(?:i|u.+)$|^--(?:ignore-environment|unset=|chdir=)/.test(words[i])) { i++; continue; }
      break;
    }
  }
  if (['command', 'exec'].includes(words[i])) i++;
  const basename = (word) => (word || '').split('/').pop();
  if (basename(words[i]) === 'node') {
    i++;
    if (!['$GSD_TOOLS', '${GSD_TOOLS}'].includes(words[i]) && basename(words[i]) !== 'gsd-tools.cjs') return null;
    i++;
  } else if (['gsd_run', 'gsd-tools', 'gsd-tools.cjs'].includes(basename(words[i])) || ['$GSD_TOOLS', '${GSD_TOOLS}'].includes(words[i])) i++;
  else return null;
  const tail = words.slice(i);
  const parts = withoutGlobals(tail, true);
  if (parts[0]?.value !== 'query' || !parts[1] || /[$`]|^</.test(parts[1].value)) return null;
  return { argv: parts.slice(1).map((part) => part.value), rawArgv: tail.slice(parts[0].index + 1) };
}

function queryCalls(content) {
  const calls = [];
  const source = content.replace(/\r\n/g, '\n');
  function visit(script, base = 0) {
    const tokens = shellTokens(script, base);
    for (const token of tokens) for (const child of token.children || []) visit(child.source, child.base);
    let words = [];
    let at = base;
    let redirectOperand = false;
    function finish() {
      const call = queryArgv(words);
      if (call) calls.push({ ...call, at });
      words = [];
      redirectOperand = false;
    }
    for (const token of tokens) {
      if (token.type === 'op') { finish(); continue; }
      if (token.type === 'redirect') { redirectOperand = true; continue; }
      if (redirectOperand) { redirectOperand = false; continue; }
      if (!words.length && KEYWORDS.has(token.value)) continue;
      if (!words.length) at = token.at;
      words.push(token.value);
    }
    finish();
  }
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const fenced = new Set();
  for (const block of scanFencedBlocks(lines)) {
    if (block.closeLineIdx === -1) continue;
    for (let line = block.openLineIdx; line <= block.closeLineIdx; line++) fenced.add(line);
    if (['', 'bash', 'sh', 'shell', 'zsh'].includes(block.infoString.trim())) {
      visit(lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'), offsets[block.openLineIdx + 1]);
    }
  }
  for (let line = 0; line < lines.length; line++) {
    if (fenced.has(line)) continue;
    let text = lines[line];
    for (const match of text.matchAll(/`([^`]+)`/g)) visit(match[1], offsets[line] + match.index + 1);
    text = text.replace(/`([^`]+)`/g, (span) => ' '.repeat(span.length));
    // Direct snippets outside fences still have shell continuation semantics.
    const start = line;
    while (/\\$/.test(text) && line + 1 < lines.length && !fenced.has(line + 1)) text += '\n' + lines[++line];
    const rawTokens = shellTokens(text);
    for (let at = 0; at < rawTokens.length; at++) {
      if (rawTokens[at].type !== 'redirect' || !/<<-?$/.test(rawTokens[at].value)) continue;
      const delimiter = rawTokens[at + 1]?.value;
      if (!delimiter) continue;
      while (line + 1 < lines.length && !fenced.has(line + 1)) {
        const next = lines[++line];
        text += '\n' + next;
        if ((rawTokens[at].value.endsWith('-') ? next.replace(/^\t+/, '') : next) === delimiter) break;
      }
    }
    visit(text, offsets[start]);
  }
  return calls.sort((a, b) => a.at - b.at);
}

function queryNames(content) {
  return queryCalls(content).map(({ argv }) => {
    const second = argv[1];
    return second && !second.startsWith('-') ? argv.slice(0, 2) : argv.slice(0, 1);
  });
}

function frontmatterCalls(content) {
  return queryCalls(content).flatMap(({ argv, rawArgv }) => {
    const start = argv[0] === 'frontmatter.get' ? 1 : argv[0] === 'frontmatter' && argv[1] === 'get' ? 2 : 0;
    if (!start || !argv[start]) return [];
    const fileIndex = withoutGlobals(rawArgv, true)[start].index;
    const args = rawArgv.slice(fileIndex + 1);
    const fieldArgs = withoutGlobals(args);
    const fieldIndex = fieldArgs.indexOf('--field');
    const field = fieldIndex >= 0 ? fieldArgs[fieldIndex + 1] : fieldArgs.find((arg) => arg.startsWith('--field='))?.slice(8) ?? fieldArgs[0];
    return [{ planExpression: argv[start], args, field }];
  });
}

module.exports = { queryCalls, queryNames, frontmatterCalls };
