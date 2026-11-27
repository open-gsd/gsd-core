'use strict';

// #6797 (ADR-4962 Decision 7, the parity-guard bullet of #4845): src/session-store.cts is the single owner of the
// per-session handoff filename grammar. A hook cannot require the compiled CLI, so a hook may carry a sanctioned inline
// copy, but every such copy must be registered in tests/fixtures/session-handoff-cases.json (`followers`), where
// tests/session-handoff-parity.test.cjs runs it over the shared case table and against the store. A file under hooks/
// or src/ that parses the grammar and is not registered would drift silently, so it is a finding here; a registry row
// naming a file that no longer exists is one too.

const REGISTRY = 'tests/fixtures/session-handoff-cases.json';
const OWNER = 'src/session-store.cts';
// A file parses the grammar when it tests a name against the `HANDOFF.` prefix or spells a keyed form. Bounded
// (no-unbounded-quantifier): the quote-and-paren window around the prefix is at most 8 characters.
const PARSES_GRAMMAR = /startsWith\([ \t]{0,8}['"`]HANDOFF\.['"`]|HANDOFF\.(?:latest|claimed)\./;

module.exports = {
  id: 'handoff-grammar-readers-registered',
  issue: '#6797',
  check(ctx) {
    const registry = ctx.doc(REGISTRY);
    const registered = new Set();
    registry.satisfies((text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return 'the registry is not valid JSON';
      }
      if (!Array.isArray(parsed.followers)) return 'the registry has no `followers` array';
      for (const follower of parsed.followers) {
        if (typeof follower.file !== 'string' || follower.file === '') return 'a follower has no `file`';
        registered.add(follower.file);
      }
      return true;
    }, 'tests/fixtures/session-handoff-cases.json must list its followers: the files that carry an inline copy of the handoff grammar');

    for (const rel of registered) ctx.exists(rel, 'a registered follower file must exist (remove its registry row when the copy is removed)');

    const files = [...ctx.list('hooks', '.js', 'the hooks are scanned for readers of the handoff grammar'),
      ...ctx.list('src', '.cts', 'the sources are scanned for readers of the handoff grammar')];
    for (const rel of files) {
      if (rel === OWNER) continue;
      // hooks/dist/ holds generated copies of the hooks (a build step, gitignored): the source hook is the reader.
      if (rel.startsWith('hooks/dist/')) continue;
      ctx.doc(rel).satisfies(
        (text) => !PARSES_GRAMMAR.test(text) || registered.has(rel) || `${rel} parses the handoff filename grammar but is not a registered follower`,
        `a reader of the handoff grammar other than ${OWNER} must be registered in ${REGISTRY} (followers), so the parity guard holds it to the store`,
      );
    }
  },
};
