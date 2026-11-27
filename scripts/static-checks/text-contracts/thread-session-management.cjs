'use strict';

// The thread workflow's subcommands and safety rules (#2156): list with open and resolved filters, close, status,
// a security_notes section, slug sanitization with path-traversal rejection, no heredoc (injection risk), creation
// through the Write tool, frontmatter with slug/title/status/created/updated, list reading the status through
// frontmatter get, and close setting resolved. The test accepted `..` plus `reject` anywhere and `status:` alone; the
// contract asks for a rejection of `..` in one place and for `status: open`, which the file carries. Was
// tests/thread-session-management.test.cjs.

module.exports = {
  id: 'thread-session-management',
  issue: '#2156',
  check(ctx) {
    ctx.doc('gsd-core/workflows/thread.md')
      .has(/list --open|LIST-OPEN/, 'missing the list --open filter')
      .has(/CLOSE|close <slug>/, 'missing the close subcommand')
      .has(/STATUS|status <slug>/, 'missing the status subcommand')
      .lacks("<< 'EOF'", 'the thread command still uses a quoted heredoc: injection risk')
      .lacks('<< EOF', 'the thread command still uses a heredoc: injection risk')
      .has('status: open', 'the thread template is missing the frontmatter status field')
      .has('security_notes', 'missing the security_notes section')
      .has(/sanitiz|\[a-z0-9/, 'missing slug sanitization')
      .has('Write tool', 'thread create mode should use the Write tool instead of a heredoc')
      .has(/frontmatter get|frontmatter\.get/, 'list mode should read the status via frontmatter get / frontmatter.get')
      .has('resolved', 'close mode should set the status to resolved')
      .has(/list --resolved|LIST-RESOLVED/, 'missing the list --resolved filter')
      .has(/reject[^\n]{0,200}\.\.|\.\.[^\n]{0,200}reject/, 'missing path traversal rejection for slugs')
      .has('slug:', 'the thread template is missing the slug frontmatter field')
      .has('title:', 'the thread template is missing the title frontmatter field')
      .has('status:', 'the thread template is missing the status frontmatter field')
      .has('created:', 'the thread template is missing the created frontmatter field')
      .has('updated:', 'the thread template is missing the updated frontmatter field');
  },
};
