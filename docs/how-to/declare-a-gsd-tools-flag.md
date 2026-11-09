# Declare a flag on a gsd-tools command

Use this when you add a flag to a `gsd-tools` command, or add a new command, whose router lives in `gsd-core/bin/gsd-tools.cjs`. Every flag is declared in one registry, and the router reads it from there ([ADR-4909](../adr/4909-shipped-surface-contract-seam.md) D1). If a command is still listed under `undeclared` in [`CLI-SURFACE-MANIFEST.json`](../CLI-SURFACE-MANIFEST.json), its router parses its own flags until its migration issue lands. Leave such a command alone.

## 1. Declare the flag

Open `src/cli-surface.cts` and find the command's entry in `CLI_SURFACE`. The key is the canonical name: `state.update`, `milestone.complete`, `commit`. Add the flag to the list for its kind:

| The flag… | Add it to |
| --- | --- |
| takes one value | `valueFlags` |
| is a switch | `booleanFlags` |
| must be given | `requiredFlags`, as well as `valueFlags` |
| must have a value whenever it is passed | `nonEmptyFlags`, as well as `valueFlags` (`emptyValueFlags` / `emptyEqFlags` let a literal empty `''` / `--name=` through) |
| may also be written `--name=value` | `eqFlags`, as well as `valueFlags` |
| may be passed several times | `repeatableFlags`, as well as `valueFlags` |
| takes several words up to the next flag | `listFlags` or `multiwordFlags` (see [the flag kinds](../CLI-TOOLS.md#command-flags-and-the-cli-surface-manifest)) |

List a flag in `requiredFlags` only when the command cannot run without it. A requirement that depends on other flags, such as "exactly one of `--phase` and `--plan`", stays a check in the handler.

## 2. Read it in the router

The router parses the arguments before any filesystem, git or subprocess work (after reading the subcommand):

```js
const flags = parseNamedArgsOrExit(args, specFor('milestone.complete'), error);
```

Then read the value from `flags` (`flags['dry-run']`, `flags.name`). Do not read `args` for a flag. The ESLint rule `local/named-args-spec-from-registry` rejects `args.indexOf('--x')`, `args.includes('--x')`, `tok === '--x'` and inline specs in `gsd-tools.cjs`.

## 3. Regenerate the manifest

```bash
npm run build:lib
npm run gen:cli-surface-manifest
```

Commit `docs/CLI-SURFACE-MANIFEST.json` with the change. `npm run lint:generated-sync` fails while it is stale. `tests/cli-surface-parity.test.cjs` then runs the real command and checks three things:
- it accepts each declared flag;
- it rejects an undeclared one;
- it rejects a missing required one.

## Adding a new command

Add the router to `HOST_COMMAND_ROUTERS` and its entry to `CLI_SURFACE`. The parity test fails for a dispatchable command that is in neither `CLI_SURFACE` nor `UNDECLARED_VERBS`. `UNDECLARED_VERBS` may only shrink, so a new command must be declared.
