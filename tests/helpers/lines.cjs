'use strict';
// Lines [from, to] of a workflow region, inclusive: first line containing `from`, first later line trimmed === `to`.
// Shared by tests/code-review-fix-pipeline-regression.test.cjs and shipped.cjs; throws on a missing marker.
module.exports = function lines(src, from, to) {
  const l = src.replace(/\r\n/g, '\n').split('\n');
  const a = l.findIndex((x) => x.includes(from));
  if (a < 0) throw new Error(`marker "${from}" not found`);
  const b = l.findIndex((x, k) => k >= a && x.trim() === to);
  if (b < 0) throw new Error(`end "${to}" not found`);
  return l.slice(a, b + 1).join('\n');
};
