// Regression for #5427: PR bodies render relative hrefs verbatim, so they
// resolve against /pull/N and 404. Only `?template=` links may be relative.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE');
const LINK = /\]\(([^)\s]+)\)/g;
const ANCHOR = /^https:\/\/github\.com\/open-gsd\/gsd-core\/blob\/next\/CONTRIBUTING\.md#(.+)$/;
const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const hrefsOf = (f) => [...fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(LINK)].map((m) => m[1]);

describe('PR template links (#5427)', () => {
  const headings = new Set(
    fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')
      .split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))),
  );
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.md'))) {
    test(`${f}: only ?template= links are relative`, () => {
      const bad = hrefsOf(f).filter((h) => !/^https?:\/\//.test(h) && !h.startsWith('?template='));
      assert.deepEqual(bad, []);
    });
    test(`${f}: CONTRIBUTING.md anchors resolve to a heading`, () => {
      for (const a of hrefsOf(f).map((h) => ANCHOR.exec(h)?.[1]).filter(Boolean)) {
        assert.ok(headings.has(a), a);
      }
    });
  }
});
