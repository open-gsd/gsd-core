'use strict';

// Every locale sibling of docs/reference/state-md.md mirrors its section structure (#3873, ADR-3473 section 8.8): each
// locale is missing no section the English reference declares. Heading text is translated per locale, so headings are
// aligned by the ordered sequence of their levels (a longest-common-subsequence alignment), and the section with no
// positional counterpart is reported. Was tests/docs-state-md-locale-parity.test.cjs.

const EN = 'docs/reference/state-md.md';
const LOCALES = ['ja-JP', 'zh-CN', 'ko-KR', 'pt-BR'];
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const ANCHOR_SECTION = 'Status lifecycle (ADR-2207)';

// The ATX headings (`#` to `######`) outside fenced code blocks, as the test read them: the marker, at least one
// whitespace character, then text that does not cross a line terminator.
function headings(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let marks = 0;
    while (marks < line.length && line[marks] === '#') marks += 1;
    if (marks < 1 || marks > 6 || marks >= line.length || !/\s/.test(line[marks])) continue;
    let start = marks;
    while (start < line.length && /\s/.test(line[start])) start += 1;
    const rest = line.slice(start);
    if (rest.includes('\r') || rest.includes(LINE_SEPARATOR) || rest.includes(PARAGRAPH_SEPARATOR)) continue;
    out.push({ level: '#'.repeat(marks), text: rest.trim() });
  }
  return out;
}

// The indices of `a` that take part in a longest common subsequence with `b`.
function lcsMatchedIndices(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      matched.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matched;
}

module.exports = {
  id: 'docs-state-md-locale-parity',
  issue: '#3873',
  check(ctx) {
    let english = null;
    ctx.doc(EN)
      .satisfies((text) => {
        english = headings(text);
        return english.length > 0 || 'no heading found';
      }, 'the English reference must declare at least one heading')
      .satisfies((text) => headings(text).some((heading) => heading.text === ANCHOR_SECTION) || 'no such heading', `the English reference must declare "### ${ANCHOR_SECTION}", the section behind #3853`);

    for (const locale of LOCALES) {
      ctx.doc(`docs/${locale}/reference/state-md.md`).satisfies((text) => {
        if (english === null) return true; // the English reference did not load: that finding stands alone
        const matched = lcsMatchedIndices(english.map((h) => h.level), headings(text).map((h) => h.level));
        const missing = english.filter((_, idx) => !matched.has(idx)).map((h) => `"${h.level} ${h.text}"`);
        return missing.length === 0 || `missing ${missing.join(', ')}`;
      }, `the ${locale} reference must keep every section the English schema reference declares`);
    }
  },
};
