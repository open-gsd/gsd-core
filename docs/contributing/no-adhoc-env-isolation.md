# `local/no-adhoc-env-isolation`: what it flags and what it does not

Epic #4635 gave child-env isolation for tests one owner, `tests/helpers/isolated-env.cjs` (#6033):
`isolatedEnv({ home })` builds the env a test hands to a child, and `isolatedPath({ without })`
builds a PATH the named tools cannot resolve from. The rule
(`eslint-rules/no-adhoc-env-isolation.cjs`, #6035, Phase 3) stops a new hand-written copy of either
from being added under `tests/**`, with no exemption surface. How to build an env with the helper is in
CONTRIBUTING.md, "The lint rule that enforces child-env isolation".

## What the rule recognises

The rule is a syntactic check on the forms below, not a check that a test isolates its env. It flags
these forms and no others; every other spelling is out of scope, whatever env it builds. A member
named below (`split`, `filter`, `delimiter`, `env`, `PATH`, `HOME`) may be written as an identifier,
a string key (`x['split'](…)`) or an expression-free template key (``x[`split`](…)``).

### Arm 1: an inline PATH split or filter (`inlinePathFilter`)

- A `.split(...)` call, with any argument, whose receiver is a process PATH read, unless the call's
  result is read only for `.length` (a count, not a filtered or rebuilt PATH). The call may be
  optional (`process.env.PATH?.split(…)`). A process PATH
  read is `process.env.PATH` or `process.env.Path` (the key Windows enumerates), where `process` is
  the bare identifier and `env` and `PATH` are identifiers or string keys
  (`process['env']['PATH']`); an optional chain over it (`process.env?.PATH`, `process?.env.PATH`);
  either operand of `||`, `??` or `&&` around one; either branch of `?:` around one; `String(...)`
  with exactly one argument around one; or an identifier declared once with `const` and initialised
  to one of these, including an identifier a destructuring pattern in that declaration binds
  (`const [p] = process.env.PATH`; one hop: a second hop, or a `let` or `var` alias, is not
  followed). This is
  #4411's `makeIsolatedPath`, which split the full system PATH, prepended a directory and re-joined
  it, isolating nothing, without ever calling `.filter`.
- `X.split(<delimiter>).filter(...)`, whatever `X` is, where `<delimiter>` is a member named
  `delimiter` (`path.delimiter`, `path.win32.delimiter`) or the bare identifier `delimiter`, and the
  split's result is called with `.filter` directly (`.filter(…)`, `?.filter(…)` or `.filter?.(…)`).
  The split may itself be an optional call (`x?.split(path.delimiter).filter(…)`). Only the
  split's first argument is read: `x.split(path.delimiter, 3).filter(…)` is flagged. This
  is the filter copy #4348 counted: its
  receiver was a parameter defaulting to `process.env.PATH`
  (`(basePath ?? '').split(path.delimiter).filter(...)`), so a rule keyed on reading
  `process.env.PATH` alone would miss it.

### Arm 2: direct HOME / USERPROFILE construction (`adhocHomeConstruction`)

- An object literal with a `HOME` or `USERPROFILE` key, written as an identifier (shorthand
  `{ HOME }` included), a string, or a computed string or expression-free template (`['HOME']`, ``
  [`HOME`] ``), reported once per object, unless the key's value cannot be a per-test sandbox (see
  "Values that cannot be a sandbox" below).
- An assignment, with any assignment operator (`=`, `+=`, `||=`, `??=`), to a member named `HOME` or
  `USERPROFILE` (`X.HOME`, `X['HOME']`, ``X[`HOME`]``) where `X` is not spelled `process.env`,
  `process['env']` or ``process[`env`]``, unless the assigned value cannot be a per-test sandbox.
  So `globalThis.process.env.HOME = x` and `const env = process.env; env.HOME = x` are flagged.

Both arms flag a form whatever else it does: a `csv.delimiter` split that is filtered, an object
with a `HOME` key whose value is a variable. Both build an env by hand in the case the rule exists
for: `{ ...process.env, HOME: tmp }`, `runNode([script], { env: { HOME: tmp } })`,
`childEnv.HOME = tmp`.

### Values that cannot be a sandbox

A per-test sandbox is a directory made for that test, so its path is not known when the file is
written. Arm 2 therefore skips a `HOME` or `USERPROFILE` property or assignment whose value is:

- a string literal or an expression-free template (`{ HOME: '/h' }`, ``{ HOME: `/h` }``): a fixture
  handed to a pure function, or the expected value in an assertion;
- a read of the same key off `process.env` (`{ HOME: process.env.HOME }`, `saved.HOME =
  process.env.HOME`): saving the ambient value, or passing it through unchanged. `HOME:
  process.env.USERPROFILE` is a different key and is flagged.

The rule reads the value, not where the object goes, so a fixed string is skipped even in an env
handed to a child process (`{ ...process.env, HOME: '/nonexistent' }`). That is deliberate: it
leaves the `GSD_*` values, the config-location variables and the PATH untouched, and it names one
directory shared by every test that uses it, so it is not the copy of `isolatedEnv()` the rule
exists to stop. It is also not hermetic. Build a child env with `isolatedEnv()` whenever the test
writes under its home.

Arm 1 skips a split of a process PATH read whose result is read only for `.length`
(`process.env.PATH.split(path.delimiter).length`): a count builds no PATH.

## Exempt file and the zero count

`tests/helpers/isolated-env.cjs` is the implementation and is excluded in `eslint.config.mjs`. It is
the only exemption: the rule takes no options, and there is no allowlist.

`tests/no-adhoc-env-isolation.rule.test.cjs` lints every `.cjs` file under `tests/` with the rule on
and inline config off, and fails on any site. It also fails when ESLint lints fewer `.cjs` files
under `tests/` than are on disk: an ESLint ignore over a `tests/` subtree would hide that subtree's
copies from the rule and the count alike. It also fails if the allowlist file reappears or the
rule is given an option. The rule has no marker comment of its own. An `eslint-disable` comment
naming it hides a copy from lint output but not from that count, and an unused one fails
`npm run lint` through ESLint's unused-directive warning, so it exempts nothing.

The rule and the count cover only the `.cjs` files under `tests/`. A copy in any other file is
neither flagged nor counted: a `.mjs`, `.js` or `.cts` file under `tests/`, or a file outside
`tests/`, such as one under `scripts/`.

## Out of scope: examples

Any spelling that is not one of the forms above is not flagged. The examples below are spellings
that have been checked; they show where the boundary falls and are not a list of everything outside
it. Each example, and each form above, has a row in `tests/no-adhoc-env-isolation.rule.test.cjs`, so
a change that moves the boundary fails a row.

- In-process mutation spelled `process.env.HOME = x` (or `['HOME']`): the isolation helper covers
  the env a test hands to a child process, and in-process isolation is `sandboxHome()` /
  `scrubConfigLocationEnv()` in `tests/helpers.cjs` (CONTRIBUTING.md).
- Other variables that locate a home or config: `GSD_HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`,
  and Windows' `HOMEDRIVE` / `HOMEPATH`. The rule looks only at `HOME`, `USERPROFILE` and PATH.
  `isolatedEnv()` drops every ambient `GSD_*` value (the child sees `GSD_HOME` as an empty string,
  not an absent key) and blanks `CLAUDE_CONFIG_DIR` unless `claudeConfigDir` sets it; it does not
  set or blank `HOMEDRIVE` / `HOMEPATH`, so a fixture that reads them still inherits them on
  Windows.
- Key names that differ in case: `Home` or `userprofile` keys, and a `process.env.path` read
  (Windows env names are case-insensitive; only `PATH` and `Path` are read).
- A PATH read that is not a process PATH read: `const { PATH } = process.env`,
  `const env = process.env; env.PATH`, `const { env } = process; env.PATH`,
  `globalThis.process.env.PATH`, `require('node:process').env.PATH` (or `require('process')`),
  `(process?.env).PATH`, `process.env['PA' + 'TH']`, a template literal around a read, a second
  `const` hop, a `let` or `var` alias, or a PATH a function returns (`getPath()`). Their splits are
  flagged only when they match the second form of Arm 1.
- PATH taken apart without a direct `.split(...)` call on it:
  `String.prototype.split.call(process.env.PATH, …)`,
  `Reflect.apply(String.prototype.split, process.env.PATH, …)`, `process.env.PATH.split.call(…)`, or
  `process.env.PATH.match(…)` / `matchAll(…)`.
- On a receiver that is not a process PATH read, a delimiter split that `.filter(...)` does not
  consume directly: a loop over it, a split held in a variable, a spread, `.map(...)` or
  `.slice(...)` before the filter, `Array.from(...)`, `.reduce(...)`, or a parenthesised optional
  chain (`(x?.split(path.delimiter)).filter(…)`). Over a process PATH read every split is flagged
  by the first form of Arm 1, these shapes included (`process.env.PATH.split(path.delimiter).map(…)`).
- On a receiver that is not a process PATH read, a filtered split whose delimiter is not a
  `delimiter` member or identifier: a string literal (`basePath.split(':').filter(…)`), a variable
  (`const SEP = isWin ? ';' : ':'; parts.split(SEP).filter(…)`), a regular expression, or an
  optional member (`path?.delimiter`). Over a process PATH read every split is flagged, these
  included (`process.env.PATH.split(':').filter(…)`).
- A PATH set or assembled without a split: a `PATH` key (`{ ...process.env, PATH: dir }`), an
  assignment to `env.PATH`, or a prepend by concatenation, template literal or
  `[...].join(delimiter)` around a `process.env.PATH` read.
- HOME or USERPROFILE removed: `delete env.HOME`, `delete env.USERPROFILE` or
  `Reflect.deleteProperty(env, 'HOME')`.
- HOME or USERPROFILE set by something other than an assignment expression: the target of a
  destructuring assignment (`[env.HOME, env.USERPROFILE] = [tmp, tmp]`, `({ home: env.HOME } = o)`)
  or of a `for...of` / `for...in` loop (`for (env.HOME of [tmp]) {}`), an update (`env.HOME++`), or
  a class field spread into an env (`class E { HOME = tmp }`, `{ ...process.env, ...new E() }`).
- An object pattern with a `HOME` or `USERPROFILE` key, with or without a default: `({ HOME } = o)`,
  `const { HOME = y } = o`, or a `({ USERPROFILE }) => …` parameter. It binds a local; an object
  built from that local (`{ ...process.env, HOME }`) is flagged.
- HOME set without a static key: a variable key (`env[key]`), a computed key that is not a string or
  an expression-free template (`{ [k]: x }`, `{ ['HO' + 'ME']: x }`),
  `Object.fromEntries([['HOME', x]])`, an `Object.entries(...).map(...)` that substitutes HOME by
  comparing keys, `Object.defineProperty` / `Reflect.defineProperty` / `Reflect.set`,
  `Object.assign(env, JSON.parse('{"HOME": …}'))`, a `'HOME=' + x` env array entry, or `HOME=`
  inside a shell script string (`export HOME=...`).
- An object spread of the process env, `{ ...process.env }`, with no HOME/USERPROFILE key and no
  PATH filter.
