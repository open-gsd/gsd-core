'use strict';

// No shipped prose tells an agent to call the context7 tool that does not exist (#2943): the context7 MCP server
// registers exactly `resolve-library-id` and `query-docs`, not `get-library-docs`, and the stale name survived in
// prose (copied from upstream's own README), so agents called a tool the server does not register. The scan covers
// the shipped prose directories (tests, CHANGELOG and docs/RELEASE-NOTES-LEGACY.md, a historical record, are out);
// the canonical reference names query-docs with its libraryId / query parameters; and resolve-library-id is still
// named somewhere. Was tests/context7-tool-name-parity.test.cjs.

const SCAN_DIRS = ['agents', 'gsd-core/references', 'gsd-core/workflows', 'commands/gsd', 'skills', 'docs'];
const EXCLUDED_FILES = new Set(['docs/RELEASE-NOTES-LEGACY.md', 'CHANGELOG.md']);
const BANNED = 'mcp__context7__get-library-docs';
const KEPT = 'mcp__context7__resolve-library-id';
const MIN_SCAN_SURFACE = 50;

module.exports = {
  id: 'context7-tool-name-parity',
  issue: '#2943',
  check(ctx) {
    const files = SCAN_DIRS.flatMap((dir) => ctx.list(dir, '.md', 'the shipped prose is what the scan covers')).filter((rel) => !EXCLUDED_FILES.has(rel));
    if (files.length <= MIN_SCAN_SURFACE) ctx.fail('(scan surface)', `the scan surface must hold more than ${MIN_SCAN_SURFACE} markdown files (found ${files.length})`);

    let keptSomewhere = false;
    for (const rel of files) {
      ctx.doc(rel)
        .lacks(BANNED, `shipped prose must not instruct agents to call ${BANNED}: the context7 MCP server does not register it (only resolve-library-id and query-docs exist)`)
        .satisfies((text) => {
          if (text.includes(KEPT)) keptSomewhere = true;
          return true;
        }, 'collects whether resolve-library-id is named');
    }
    if (!keptSomewhere) ctx.fail('(scan surface)', `${KEPT} must still appear in shipped artifacts`);

    ctx.doc('gsd-core/references/research-documentation-lookup.md')
      .has('mcp__context7__query-docs', 'research-documentation-lookup.md must name mcp__context7__query-docs')
      .has(/query-docs` with `libraryId`|libraryId` and `query`/, 'query-docs must be documented with the libraryId / query params');
  },
};
