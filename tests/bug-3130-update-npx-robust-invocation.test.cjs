'use strict';
// allow-test-rule: reads product workflow markdown (update.md) to verify structural invocation contract — not a source-grep test

// Regression guard for bug #3130.
//
// Two failure modes were observed with the pre-fix npx invocation form:
//   1. Cache-stale: bare `npx -y @opengsd/gsd-core@<tag>` hits npx's local
//      cache and may pull an older version instead of the target tag.
//   2. Token-routing: Bash-tool wrappers misroute the `@` token in
//      `@opengsd/gsd-core@<tag>`, causing npm to error with
//      "Unknown command: @opengsd/gsd-core@<tag>".
//
// The robust form is:
//   npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core $ARGS
//
// `--package=` forces a fresh registry fetch, bypassing the npx cache.
// `--` clearly delineates npx flags from the run-command, preventing
// Bash-tool @-token misrouting.
// `$TAG` is a shell variable (latest by default, next under --next/--rc),
// set by the parse_update_channel step (#815).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UPDATE_WF = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');

const src = fs.readFileSync(UPDATE_WF, 'utf8');

test('bug #3130: update.md contains no bare npx invocations (cache-stale form)', () => {
  // Any occurrence of `npx -y @opengsd/gsd-core@<something>` without `--package=`
  // is the stale form that triggers the two failure modes.
  const stale = (src.match(/npx -y @opengsd\/gsd-core@\S+[^\n]*/g) || []);
  assert.deepEqual(
    stale,
    [],
    `Stale npx forms found in update.md (must use --package= form): ${stale.join('; ')}`,
  );
});

test('bug #3130: update.md has >=3 robust npx invocations (--package= + -- separator)', () => {
  // Three sibling invocations: local, global, and unknown/fallback.
  // The tag is now a $TAG variable (latest by default, next under --next/--rc).
  const robust = (src.match(/npx -y --package=@opengsd\/gsd-core@\S+ -- gsd-core/g) || []);
  assert.ok(
    robust.length >= 3,
    `Expected >=3 robust npx invocations in update.md, found ${robust.length}`,
  );
});
