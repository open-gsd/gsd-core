'use strict';
const assert = require('node:assert/strict');
// Lines [from, to] of a workflow region, inclusive: first line containing `from`, first later line trimmed === `to`.
// Shared by tests/code-review-fix-pipeline-regression.test.cjs and shipped.cjs; throws on a missing marker.
function lines(src, from, to) {
  const l = src.replace(/\r\n/g, '\n').split('\n');
  const a = l.findIndex((x) => x.includes(from));
  if (a < 0) throw new Error(`marker "${from}" not found`);
  const b = l.findIndex((x, k) => k >= a && x.trim() === to);
  if (b < 0) throw new Error(`end "${to}" not found`);
  return l.slice(a, b + 1).join('\n');
}

/** Slice the workflow text of a single <step name="...">…</step> region. */
function stepRegion(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found in workflow`);
  const close = src.indexOf('</step>', open);
  assert.notStrictEqual(close, -1, `step "${name}" has no closing </step>`);
  return src.slice(open, close + '</step>'.length);
}

// Extract the bash fence out of a named <step>, so a test can RUN it rather than grep it.
// Line-scanned rather than matched with a multiline regex: an ad-hoc fence regex trips
// local/no-adhoc-markdown-parsing, and a bare \n against readFileSync content trips
// local/no-crlf-fragile-split (Windows autocrlf yields \r\n). Same shape as bashFences() in
// tests/code-review-pipeline-regression.test.cjs, which solved this first.
function stepFence(src, name) {
  const open = src.indexOf(`<step name="${name}">`);
  assert.notStrictEqual(open, -1, `step "${name}" not found`);
  const close = src.indexOf('</step>', open);
  const lines = src.slice(open, close).replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^```bash\s*$/.test(lines[i])) { start = i + 1; continue; }
    if (start !== -1 && /^```\s*$/.test(lines[i])) return lines.slice(start, i).join('\n');
  }
  assert.fail(`step "${name}" carries no bash fence`);
}

module.exports = Object.assign(lines, { stepRegion, stepFence });
