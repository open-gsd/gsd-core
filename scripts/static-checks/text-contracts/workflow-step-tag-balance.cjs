'use strict';

// Every top-level workflow has balanced <step> / </step> tags, with fenced code stripped so an example inside a
// fence cannot count (#1864): settings-advanced.md once had an orphan </step> because its Model Policy section
// lacked an opening <step>, and that section stays wrapped in a model_policy step. Was
// tests/workflow-step-tag-balance.test.cjs.

const path = require('node:path');

// The fence rules have one owner (the markdown sectionizer); the test used it too.
const stripFencedCode = (text) => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs')).stripFencedCode(text).text;
const countOf = (text, pattern) => [...text.matchAll(pattern)].length;

module.exports = {
  id: 'workflow-step-tag-balance',
  issue: '#1864',
  check(ctx) {
    // The workflows directly under gsd-core/workflows (the test read the directory without descending).
    for (const rel of ctx.list('gsd-core/workflows', '.md', 'the workflows are what the balance is checked on').filter((file) => file.split('/').length === 3)) {
      ctx.doc(rel).satisfies((text) => {
        const stripped = stripFencedCode(text);
        const opens = countOf(stripped, /<step(\s|>)/g);
        const closes = countOf(stripped, /<\/step>/g);
        return opens === closes || `${opens} opens / ${closes} closes`;
      }, 'a workflow must have equal <step> opens and </step> closes (code fences stripped)');
    }
    ctx.doc('gsd-core/workflows/settings-advanced.md').satisfies((text) => {
      const stripped = stripFencedCode(text);
      const open = stripped.indexOf('<step name="model_policy">');
      const section = open === -1 ? -1 : stripped.indexOf('### Section 8 — Model Policy', open);
      return (section !== -1 && stripped.indexOf('</step>', section) !== -1) || 'expected <step name="model_policy"> ... ### Section 8 — Model Policy ... </step>';
    }, 'section 8 must be wrapped in <step name="model_policy">...</step>');
  },
};
