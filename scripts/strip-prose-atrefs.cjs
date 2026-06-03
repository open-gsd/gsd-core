#!/usr/bin/env node
/**
 * strip-prose-atrefs.cjs
 *
 * Removes redundant @~/.claude/gsd-core/ path tokens from prose lines
 * in <process> and <context> blocks. The path is already declared in
 * <execution_context> where it actually loads the file. Prose copies are
 * inert and add ~900 tokens/invocation of dead weight.
 *
 * Transformation rules (applied per matching line):
 *   - "Execute the X workflow from @PATH end-to-end." → "Execute end-to-end."
 *   - "Execute @PATH end-to-end."                    → "Execute end-to-end."
 *   - "Read and execute the X workflow from @PATH end-to-end." → "Execute end-to-end."
 *   - "Follow the X workflow at @PATH."              → "Execute end-to-end."
 *   - "Output the X reference from @PATH."           → "Execute end-to-end."
 *   - "**Follow the X** from `@PATH`."               → "**Follow the X.**"
 *   - "- If it is '...': ... from @PATH end-to-end." → strip path token only
 *   - "- Otherwise: ... from @PATH end-to-end."      → strip path token only
 *   - "- @PATH (label)"                              → "- (label)"
 *
 * Run with --dry-run to preview without writing.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DRY_RUN      = process.argv.includes('--dry-run');
const ROOT         = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

const AT_PATH_PATTERN = /@(?:~|\$HOME)\/.+?gsd-core\/[^\s`\)]+/;
const mkAtRe = () => new RegExp(AT_PATH_PATTERN.source, 'g');

function transformLine(line) {
  if (!AT_PATH_PATTERN.test(line)) return line;

  const trimmed = line.trim();

  // "- @PATH (label)"  →  "- (label)"
  if (/^- @(?:~|\$HOME)\//.test(trimmed)) {
    return line.replace(/^(\s*- )@(?:~|\$HOME)\/[^\s(]+\s*/, '$1');
  }

  // "**Follow the X workflow** from `@PATH`."  →  "**Follow the X workflow.**"
  // "**Follow the X workflow** from `@PATH`"   →  "**Follow the X workflow.**"
  if (/\*\*Follow the .+ workflow\*\* from `@/.test(trimmed)) {
    return line.replace(/\s+from `@(?:~|\$HOME)\/[^`]+`\.?/, '.');
  }

  // Routing bullet: keep everything except "from @PATH" or bare "@PATH"
  // "- If …: … from @PATH end-to-end." → strip path, keep bullet
  // "- Otherwise: … from @PATH end-to-end." → strip path, keep bullet
  if (/^- (?:If |Otherwise:|pass all)/.test(trimmed)) {
    return line
      .replace(/\s+from\s+@(?:~|\$HOME)\/\S+/g, '')
      .replace(/@(?:~|\$HOME)\/\S+/g, '');
  }

  // "Execute [the X workflow] [from] @PATH [end-to-end]."
  // "Read and execute …"  /  "Follow …"  /  "Output …"
  // → collapse to leading indent + "Execute end-to-end."
  const indent = line.match(/^(\s*)/)[1];
  return `${indent}Execute end-to-end.`;
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf-8');
  const lines    = original.split('\n');
  const out      = [];
  let inProse    = false; // true when inside <process> or <context> (not execution_context)

  for (const line of lines) {
    const t = line.trim();
    if (/<(process|context)>/.test(t) && !t.includes('execution_context')) inProse = true;
    if (/<\/(process|context)>/.test(t) && !t.includes('execution_context')) inProse = false;

    if (inProse && AT_PATH_PATTERN.test(line)) {
      const re = mkAtRe();
      re.lastIndex = 0;
      out.push(transformLine(line));
    } else {
      out.push(line);
    }
  }

  const result = out.join('\n');
  if (result === original) return false; // no change

  if (!DRY_RUN) fs.writeFileSync(filePath, result, 'utf-8');
  return true;
}

const files = fs.readdirSync(COMMANDS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => path.join(COMMANDS_DIR, f));

let changed = 0;
for (const f of files) {
  if (processFile(f)) {
    console.log(`${DRY_RUN ? '[dry]' : 'fixed'}: ${path.basename(f)}`);
    changed++;
  }
}
console.log(`\n${changed} file(s) ${DRY_RUN ? 'would be' : 'were'} modified.`);
