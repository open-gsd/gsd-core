# `local/no-adhoc-env-isolation`: what it flags and what it does not

Epic #4635 gave child-env isolation for tests one owner, `tests/helpers/isolated-env.cjs` (#6033):
`isolatedEnv({ home })` builds the env a test hands to a child, and `isolatedPath({ without })`
builds a PATH the named tools cannot resolve from. The rule
(`eslint-rules/no-adhoc-env-isolation.cjs`, #6035, Phase 3) stops a new hand-written copy of either
from being added under `tests/**` while the remaining ones are migrated (Phases 4-7) and the
allowlist is deleted (Phase 8). How to build an env with the helper, and what to do when a count
fails, is in CONTRIBUTING.md, "The lint rule that enforces child-env isolation".

## Arm 1: an inline PATH split or filter (`inlinePathFilter`)

The rule flags two shapes:

- `X.split(...)` of any argument, where `X` reads `process.env.PATH` (or `process.env.Path`, the key
  Windows enumerates; `process['env']` too) directly, through either side of `||` / `??` / `&&`,
  either arm of `?:`, an optional chain, a one-argument `String(...)`, or a single `const` alias
  hop. This is #4411's `makeIsolatedPath`, which split the full system PATH, prepended a directory
  and re-joined it, isolating nothing, without ever calling `.filter`.
- `X.split(<delimiter>).filter(...)`, whatever `X` is, where `<delimiter>` is `path.delimiter` (any
  `*.delimiter` member) or a bare `delimiter` identifier. This is the filter copy #4348 counted: its
  receiver was a parameter defaulting to `process.env.PATH`
  (`(basePath ?? '').split(path.delimiter).filter(...)`), so a rule keyed on reading
  `process.env.PATH` alone would miss it.

A split of a PATH some other object carries (`result.path`, the `env` the code under test returned)
is not flagged unless it is filtered.

## Arm 2: direct HOME / USERPROFILE construction (`adhocHomeConstruction`)

The rule flags an object literal with a `HOME` or `USERPROFILE` key (identifier, string or computed
string key), reported once per object, and an assignment to `X.HOME` / `X.USERPROFILE` (or
`X['HOME']`) where `X` is not `process.env`. Both build an env by hand:
`{ ...process.env, HOME: tmp }`, `runNode([script], { env: { HOME: tmp } })`, `childEnv.HOME = tmp`.

## Exempt file, allowlist and count

`tests/helpers/isolated-env.cjs` is the implementation and is excluded in `eslint.config.mjs`. The
rule's `allowlist` option (repo-relative POSIX paths, resolved against the lint cwd, so lint runs
from the repository root) names the files that still carry a copy: an allowlisted file's violations
are counted but not reported, and a listed file with zero violations reports `staleAllowlistEntry`
so its entry is deleted. `eslint.config.mjs` passes the keys of
`eslint-rules/no-adhoc-env-isolation.allowlist.json`, which maps each listed file to its site count.

`tests/no-adhoc-env-isolation.rule.test.cjs` lints every `.cjs` file under `tests/` with the
allowlist emptied and inline config off, and fails when a listed file's count rises or falls, or an
unlisted file has a site, so the counts only fall. It also fails when ESLint lints fewer `.cjs`
files under `tests/` than are on disk: an ESLint ignore over a `tests/` subtree would hide that
subtree's copies from the rule and the count alike. The rule has no marker comment of its own. An
`eslint-disable` comment naming it hides a copy from lint output, but not from that count, so it
exempts nothing.

The rule and the count cover only the `.cjs` files under `tests/`, so the allowlist lists exactly
the remaining sites in those files. A copy in any other file is neither flagged nor counted: a
`.mjs`, `.js` or `.cts` file under `tests/`, or a file outside `tests/`, such as one under
`scripts/`.

## Known gaps (the ratchet is deliberately narrow)

These are shapes the rule is known not to flag. Each entry, and each flagged spelling it names, has
a row in `tests/no-adhoc-env-isolation.rule.test.cjs`, so a change that moves the boundary fails a
row.

- In-process mutation spelled `process.env.HOME = x` (or `['HOME']`) is not flagged: the isolation
  helper covers the env a test hands to a child process, and in-process isolation is `sandboxHome()`
  / `scrubConfigLocationEnv()` in `tests/helpers.cjs` (CONTRIBUTING.md). Other spellings of it are
  flagged: `globalThis.process.env.HOME = x`, `const env = process.env; env.HOME = x`, and
  `Object.assign(process.env, { HOME: x })` (an object literal).
- A PATH read the alias hop does not follow is not flagged unless its split is filtered:
  `const { PATH } = process.env`, `const env = process.env; env.PATH`,
  `globalThis.process.env.PATH`, and a template literal around it. Only a direct `process.env.PATH`
  read, through `||` / `??` / `&&`, `?:`, an optional chain, a one-argument `String(...)` or one
  `const` hop, is followed.
- A PATH filter written as a loop, over a split held in a variable, over a spread or `.map(...)` of
  the split, or over a split by a regular expression, whose receiver is not such a read is not
  flagged: only a split consumed directly by `.filter(...)` is.
- A filtered split by a string literal or a variable delimiter is not flagged when its receiver is
  not such a read: `basePath.split(':').filter(...)`, or
  `const SEP = isWin ? ';' : ':'; parts.split(SEP).filter(...)`. Only a `*.delimiter` member or a
  bare `delimiter` identifier counts as a path delimiter.
- A PATH set or assembled without a split is not flagged: a `PATH` key
  (`{ ...process.env, PATH: dir }`), an assignment to `env.PATH`, or a prepend by concatenation,
  template literal or `[...].join(delimiter)` around a `process.env.PATH` read.
- Removing HOME or USERPROFILE is not flagged: `delete env.HOME`, `delete env.USERPROFILE` or
  `Reflect.deleteProperty(env, 'HOME')` on a spread env is neither an assignment nor an object key.
- HOME or USERPROFILE set by a destructuring assignment (`[env.HOME, env.USERPROFILE] = [tmp, tmp]`,
  `({ home: env.HOME } = o)`) or by a class field spread into an env (`class E { HOME = tmp }`,
  `{ ...process.env, ...new E() }`) is not flagged.
- An object pattern with a `HOME` or `USERPROFILE` key is not flagged, with or without a default:
  `({ HOME } = o)`, `const { HOME = y } = o`, or a `({ USERPROFILE }) => …` parameter. It binds a
  local; an object built from that local (`{ ...process.env, HOME }`) is flagged.
- Windows' other home variables are not flagged: `HOMEDRIVE` / `HOMEPATH` keys, which `os.homedir()`
  falls back to when USERPROFILE is unset.
- A split of a direct `process.env.PATH` read is flagged whatever it is for, a diagnostic that only
  counts its entries included; and any `*.delimiter` argument counts as a path delimiter. The rule
  cannot tell a count from a copy, or `csv.delimiter` from `path.delimiter`.
- HOME built without a static key is not flagged: a variable key (`env[key]`),
  `Object.fromEntries([['HOME', x]])`, `Object.defineProperty` / `Reflect.set`, a `'HOME=' + x` env
  array entry, or `HOME=` inside a shell script string (`export HOME=...`).
- An object spread of the process env, `{ ...process.env }`, with no HOME/USERPROFILE key and no
  PATH filter is not flagged; any object with a `HOME` key is, whatever it is for.
- Key names match exactly: `Home` or `userprofile` keys are not flagged, and a `process.env.path`
  read is not followed (Windows env names are case-insensitive; only `PATH` and `Path` are read).
