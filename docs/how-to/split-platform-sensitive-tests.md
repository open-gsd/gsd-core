# Split platform-sensitive tests out of a heavy test file

The real-OS conformance lane (`test-conformance` in `.github/workflows/test.yml`) runs a
generated list of test **files** on Windows and macOS. `scripts/gen-platform-conformance-tier.cjs`
puts a file on that list when any line of it matches a platform signal — a symlink, a
`chmod`/mode-bit literal, `process.platform`, a `win32`/`darwin` literal, a Windows shell or env
var name, raw `child_process`, or a real shell interpreter. One such line puts every test in the
file on Windows.

When a large file carries its signal in only a few tests, split those tests into a
`<name>.platform.test.cjs` sibling. The sibling runs on the real-OS lane; the base file runs on
Linux only. Linux still runs both files, so no test is dropped.

This guide covers splitting a file, adding a new platform-sensitive test to a file that is
already split, and reading the generator's split errors.

## Before you start

- Find what matched. The generator reports files, not lines, so check each line:

  ```bash
  node -e "const {CATEGORIES}=require('./scripts/gen-platform-conformance-tier.cjs');const l=require('fs').readFileSync(process.argv[1],'utf8').split('\n');l.forEach((s,i)=>{const c=CATEGORIES.filter(k=>k.test(s)).map(k=>k.name);if(c.length)console.log(i+1,c.join(','),s.trim())})" tests/<name>.test.cjs
  ```

  A signal that sits on a multi-line construct (for example a `child_process` import used by a
  helper several lines away) shows up on the import line.

## Split a file

1. **Move each signal-carrying test into `tests/<name>.platform.test.cjs`.** Keep the test title
   and body unchanged, nest it under a `describe` with the same title as its original one, and
   bring the hooks, describe-scoped variables and helpers it uses. Duplicate small helpers rather
   than exporting them from a test file.
2. **List every moved test in the sibling's header comment** with the reason it needs a real OS,
   for example: `"(h) a SYMLINKED project path still resolves" — creates a real directory
   symlink; creation needs privilege on Windows (symlink-keyword)`.
3. **Clear the house idioms left in the base.** These are not platform behavior, so they do not
   move:
   - Running the CLI or `git` through raw `child_process` — route it through
     `tests/helpers/process-seam.cjs` (`runNode`, `runGit`), keeping the helper's return shape for
     its callers.
   - A `{ HOME: dir, USERPROFILE: dir }` env object that only keeps the developer's `~/.gsd/` out
     of the test — use `homeSandboxEnv(dir)` from `tests/helpers.cjs`. A test whose assertions
     are about files found under the home directory is platform-sensitive and moves instead.
   - A comment that only mentions a signal word — reword it without changing its meaning.
4. **Regenerate both tier lists:**

   ```bash
   node scripts/gen-platform-conformance-tier.cjs --write
   node scripts/gen-platform-conformance-tier.cjs --target macos --write
   ```

   The Windows list should now contain the sibling and not the base.
5. **Confirm no test was lost.** The number of `test(`/`it(` call sites in the base before the
   split must equal base plus sibling after it.

## Add a platform-sensitive test to a split file

Write it in the `.platform.test.cjs` sibling and add a line for it to the sibling's header. If you
write it in the base, `node scripts/gen-platform-conformance-tier.cjs --check` (run by
`npm run lint:generated-sync` and `npm run lint:ci`) fails, because a split base must stay free of
platform signals.

## Read a split error

The generator stops with `platform split invariant violated` and one line per problem. It never
drops a file from the real-OS list silently — every failure below is fixed by moving code or
reworking text, never by adding an exemption.

| Reason | What it means | Fix |
|---|---|---|
| `base-has-signal` | A base file that has a `.platform` sibling still carries the named signal(s). | Move the test that carries the signal into the sibling, or clear the idiom as in step 3 of the split. |
| `sibling-without-signal` | A `.platform.test.cjs` file carries no platform signal, so the real-OS lane would not select it and its header's reasons cannot be checked. | Move its tests back into the base and delete it, or move the test that actually needs a real OS into it. |
| `base-always-real-os` | The base is listed in `ALWAYS_REAL_OS`, which says the whole file needs a real OS, yet it was split. | Split only files outside `ALWAYS_REAL_OS`, or remove the entry with its reason if the need moved to the sibling. |

A file named `platform.test.cjs` with nothing before `.platform` is not a sibling, and neither is
a hyphenated name such as `platform-conformance-tier.test.cjs`.
