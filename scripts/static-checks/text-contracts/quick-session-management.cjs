'use strict';

// The /gsd-quick command routes the list, status and resume subcommands, sanitizes slugs and rejects path traversal,
// sanitizes directory names for display, carries a security_notes section, stops after displaying the list, reads
// status through frontmatter get, and shows the complete status (#2155). The original accepted `complete` alone for the
// last case (any use of the word); the contract asks for the `complete ✓` the file carries. Was
// tests/quick-session-management.test.cjs.

module.exports = {
  id: 'quick-session-management',
  issue: '#2155',
  check(ctx) {
    ctx.doc('commands/gsd/quick.md')
      .has('SUBCMD=list', 'missing list subcommand routing')
      .has('SUBCMD=status', 'missing status subcommand routing')
      .has('SUBCMD=resume', 'missing resume subcommand routing')
      .has(/sanitiz|\[a-z0-9/, 'missing slug sanitization')
      .has('security_notes', 'missing security_notes section')
      .has('STOP after displaying the list', 'the list subcommand should stop after display')
      // The original required `..` and `reject` anywhere; the file states the rule in one sentence.
      .has(/reject[^\n]{0,200}\.\./i, 'missing path traversal rejection for slugs')
      .has(/non-printable|ANSI/, 'missing directory name sanitization for display')
      .has(/frontmatter get|frontmatter\.get/, 'the list should use frontmatter get / frontmatter.get to read status')
      .has('complete ✓', 'the list should show the complete status');
  },
};
