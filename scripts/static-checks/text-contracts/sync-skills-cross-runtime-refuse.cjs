'use strict';

// sync-skills refuses cross-runtime skill sync (#3025): skill content and layout are runtime-specific, so a verbatim
// `cp -r` from one runtime corrupts another. Step 1 carries a functional guard that compares each destination with the
// source runtime and exits non-zero inside its own loop, the refusal points the user at the installer, the guard runs
// before Step 5's copy, `--to all` is refused too, identity sync stays a supported no-op, and --from/--to are
// shape-validated before any interpolation (no command-substitution injection). Was
// tests/sync-skills-cross-runtime-refuse.test.cjs.

const GUARD_LOOP = 'for DEST in "${TO_RUNTIMES[@]}"';

module.exports = {
  id: 'sync-skills-cross-runtime-refuse',
  issue: '#3025',
  check(ctx) {
    // The test also matched `!=\s+"$FROM_RUNTIME"` by pattern; the literal order check below needs the same text with one
    // space, so the pattern could not fail on its own and is not repeated.
    const workflow = ctx.doc('gsd-core/workflows/sync-skills.md')
      .has(/cross-runtime skill sync is not supported/, 'the refusal must name the unsupported operation')
      .has(/npx -y @opengsd\/gsd-core@latest --global --<runtime>/, 'the refusal must print the installer command')
      .has(/\$DEST/, 'the refusal must name the refused destination runtime')
      .has(/grok has no dedicated installer flag/, 'the refusal must note grok aliasing rather than print a wrong --grok flag')
      .before('!= "$FROM_RUNTIME"', 'cp -r "$SRC_SKILLS_ROOT/$SKILL"', 'the guard must precede the cp -r copy so a cross-runtime destination is refused before any filesystem write')
      .has(/for DEST in "\$\{TO_RUNTIMES\[@\]\}"/, 'the guard must iterate the destination set')
      .has(/--to all/, 'the all expansion must stay part of the interface')
      .has('[no-op: source and destination are the same runtime]', 'the identity no-op message must remain')
      .has(/If .--from. == .--to./, 'identity handling must be retained in validation')
      .has(/is_runtime_id\(\)/, 'a runtime-id shape predicate must exist')
      .has(/\^\[a-z0-9\]\[a-z0-9-\]\*\$/, 'the predicate must require a lowercase-alphanumeric shape')
      .before('is_runtime_id()', '#3025: refuse cross-runtime skill sync', 'shape validation must precede the cross-runtime guard');
    // The exit 1 must be INSIDE the guard loop, not one of the unrelated exit 1s in Steps 2, 3 and 5.
    workflow.slice(GUARD_LOOP, 'done')
      .has(/exit 1/, 'the guard loop itself must exit non-zero (not an unrelated exit 1 elsewhere)');
  },
};
