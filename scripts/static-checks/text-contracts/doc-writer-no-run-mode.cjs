'use strict';

// gsd-doc-writer's templates cope with targets that have no runnable entry point (#4928): a secrets-only backend
// monorepo or an event-triggered handler has no CLI or HTTP surface. Each affected template carries the fallback
// ordering (build/test, then an explicit "no standalone run mode"), the critical rules check that a cited script's
// inputs exist, the normal start-script path is unchanged, and the canonical and compact variants agree. Was
// tests/doc-writer-no-run-mode.test.cjs.

const VARIANTS = ['agents/gsd-doc-writer.md', 'agents/gsd-doc-writer.compact.md'];
// The prose wraps at 100 columns, so the words may be split by a line break.
const NO_RUN_MODE = /no\s{1,20}standalone\s{1,20}run\s{1,20}mode/i;
const FALLBACK_ORDER = /build[\s\S]{0,80}test|test[\s\S]{0,80}build/i;

const section = (doc, tag) => doc.slice(`<${tag}>`, `</${tag}>`);

module.exports = {
  id: 'doc-writer-no-run-mode',
  issue: '#4928',
  check(ctx) {
    for (const rel of VARIANTS) {
      const doc = ctx.doc(rel);
      section(doc, 'template_getting_started')
        .has(NO_RUN_MODE, 'getting-started "First run" must fall back to an explicit "no standalone run mode"')
        .has(FALLBACK_ORDER, 'getting-started "First run" must fall back to build/test first')
        .has(/scripts\.start/, 'the normal path must be unchanged: start scripts are still the first choice in getting-started');
      section(doc, 'template_readme')
        .has(NO_RUN_MODE, 'README "Quick start" and "Usage examples" must not require a literal run command')
        .has(/scripts\.start/, 'the normal path must be unchanged: start scripts are still the first choice in the README');
      section(doc, 'template_readme_per_package')
        .has(NO_RUN_MODE, 'per-package README "Usage" must state there is no standalone run mode')
        .has(/event|handler|Lambda/i, 'per-package README "Usage" must name event-triggered handlers');
      section(doc, 'critical_rules')
        .has(/fixture/i, 'a cited script is only presented as working when fixtures exist')
        .has(/inputs/i, 'a cited script is only presented as working when its inputs exist')
        .has(/Makefile|package\.json script/i, 'the rule must cover a Makefile target or a package.json script')
        .has(/VERIFY/, 'the rule must mark unverifiable claims VERIFY');
    }
  },
};
