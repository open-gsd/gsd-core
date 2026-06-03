'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function walkMd(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMd(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function extractSlashCommandTokens(markdown) {
  const tokenRe = /\/gsd-[a-z0-9-]+/gi;
  const tokens = new Set();
  let m;
  while ((m = tokenRe.exec(markdown)) !== null) {
    tokens.add(m[0]);
  }
  return tokens;
}

describe('bug #3054: user-facing docs should not reference removed /gsd-next command', () => {
  test('docs, workflows, and README surfaces use /gsd-progress --next instead', () => {
    const root = path.join(__dirname, '..');
    const files = [
      ...walkMd(path.join(root, 'docs')),
      ...walkMd(path.join(root, 'gsd-core', 'workflows')),
      ...fs.readdirSync(root).filter((f) => /^README.*\.md$/.test(f)).map((f) => path.join(root, f)),
    ];

    const offenders = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const tokens = extractSlashCommandTokens(content);
      if (tokens.has('/gsd-next')) offenders.push(path.relative(root, file));
    }

    assert.deepStrictEqual(offenders, [], `stale /gsd-next references remain in: ${offenders.join(', ')}`);
  });
});
