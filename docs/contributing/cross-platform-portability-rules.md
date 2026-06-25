# Cross-platform portability lint rules

GSD must run on Windows as well as macOS/Linux. A family of AST-based ESLint rules (the
`local/*` plugin) enforces the `DEFECT.WINDOWS-*` portability classes documented in
[`CONTEXT.md`](../../CONTEXT.md) **at write-time (in your editor) and in CI**, so a
Windows-only defect is caught before it ships — not after it reaches the `windows-latest` CI
lane. The architecture and rationale are in [ADR-1703](../adr/1703-portability-enforcement-architecture.md);
this page is the practical reference + how-to.

These rules are **hard-fail with zero escape hatches**: there is no `// windows-portability-ok:`
comment and no `eslint-disable` for them (a `tests/portability-rule-disable-ban.test.cjs` check,
running outside ESLint, fails the build if you try). Legitimately platform-specific code must be
*structured* so the rule recognizes it (see "Platform guards" below) — not annotated around.

## Reference — the rules

| Rule | Flags | Surface |
|---|---|---|
| `local/no-path-literal-in-assert` | An `assert.equal`/`strictEqual`/`deepEqual`/`deepStrictEqual` or `expect(...).toBe`/`toEqual`/`toStrictEqual` where one operand is a **path-returning function call** and the other is a **hardcoded `/`-string literal** not normalized to POSIX. | `tests/**/*.test.cjs` |
| `local/no-posix-mode-bit-assert` | An equality assertion comparing a file **`.mode`** (e.g. `statSync(p).mode & 0o777`) to an **octal literal** — Windows reports `0o666`/`0o444`, never the requested mode. | `tests/**/*.test.cjs` |

(More rules land per the epic — see ADR-1703's catalog and [epic #1702](https://github.com/open-gsd/gsd-core/issues/1702).)

The set of path-returning functions is single-sourced in
[`eslint-rules/lib/portability-vocab.cjs`](../../eslint-rules/lib/portability-vocab.cjs) as
`PATH_RETURNING_FNS` (Node's `path.*`/`os.homedir`/`os.tmpdir` plus the project resolvers such as
`getGlobalConfigDir`, `resolveAgentDir`, `computePathPrefix`, …). A drift-guard test
(`tests/portability-vocab-drift.test.cjs`) parses `src/runtime-homes.cts` and **fails CI if a new
path resolver is added but not registered** in that list.

## How-to — fix a `no-path-literal-in-assert` violation

Why it fails on Windows: `path.join('a','b')` returns `a/b` on POSIX but `a\b` on Windows, so
`assert.equal(path.join('a','b'), '/a/b')` passes on your Mac/Linux machine and the docker gate,
then fails only on the `windows-latest` lane.

**Fix: normalize the ACTUAL operand to POSIX before comparing** — this is idempotent on POSIX
(a no-op when there are no backslashes) and *reveals* a malformed return rather than masking it:

```js
// ❌ flagged
assert.strictEqual(getGlobalConfigDir('claude'), '/custom/claude');

// ✅ compliant
assert.strictEqual(String(getGlobalConfigDir('claude')).replace(/\\/g, '/'), '/custom/claude');
```

Do **not** instead wrap the *expected* literal in `path.join(...)` to match the platform
separator — that passes everywhere but masks a wrong backslash-on-POSIX return (both sides wrong
together). Recognized normalizers: `.replace(/\\/g,'/')`, `.replace(/[\\/]/g,'/')`,
`.replaceAll('\\','/')`, `.replaceAll(path.sep,'/')`, `.split(path.sep).join('/')`,
`toPosixPath(...)`.

## How-to — fix a `no-posix-mode-bit-assert` violation

Windows does not honor POSIX file modes — `fs.statSync(p).mode` reads back `0o666` (writable) or
`0o444` (readonly), never the `0o644`/`0o755` you wrote. A mode-bit assertion is therefore a
POSIX-only precondition. **Gate it behind a platform check and keep the real behavioral assertion
running on every OS** (do not delete it — scope it):

```js
// ❌ flagged
assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);

// ✅ scope the POSIX-only precondition; keep the behavioral assertion cross-platform
if (process.platform !== 'win32') {
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);
}
assert.match(hookCommand, /^node /); // behavioral assertion — runs everywhere
```

Prefer asserting the *behavior* (command shape, runnability) over the raw mode bit where you can.

## Platform guards (the only "escape" — by structure, not annotation)

If an assertion is *genuinely* POSIX-only, gate it behind a Windows platform check the rule
recognizes — it then won't flag the guarded code. Recognized shapes:

```js
if (process.platform !== 'win32') {
  assert.equal(path.join(a, b), '/a/b');               // guarded → not flagged
}

if (process.platform === 'win32') return;              // early-return guard
assert.equal(path.join(a, b), '/a/b');                 // → not flagged

const isWindows = process.platform === 'win32';        // hoisted boolean (any name, binding-resolved)
if (!isWindows) assert.equal(path.join(a, b), '/a/b'); // → not flagged
```

The guard is recognized by control-dependence (it must actually dominate the assertion), is
binding-aware (a reassigned or `false`-initialized variable is not trusted), and handles
`os.platform()` and `node:test` skip returns. See
[`eslint-rules/lib/platform-guard.cjs`](../../eslint-rules/lib/platform-guard.cjs).

> **Note:** the `node:test` `test(name, { skip: isWindows ? … : false }, fn)` *option* object is
> NOT recognized as a platform guard. To scope a POSIX-only assertion use an
> `if (process.platform !== 'win32')` guard (or early-return) **inside** the callback.

## How-to — add a new path resolver

When you add a function that returns a filesystem path (e.g. in `src/runtime-homes.cts`), add its
name to `PATH_RETURNING_FNS` in `eslint-rules/lib/portability-vocab.cjs`. The drift-guard test
will fail until you do.

## Known boundaries

The rule matches by spelling and inspects the direct operand (or a `String(<pathcall>)` wrapper):

- It assumes `path`/`os` are the standard modules and the resolver names are the project's — a
  local variable that *shadows* one of those names in a test file is out of scope.
- Deeper wrapping (e.g. `realpathSync(path.join(...))`, `.toLowerCase()` on a path) is not
  inspected; assert against the path call directly or its `String(...)` wrap.
- For a genuine explicit-dir *pass-through* assertion (a resolver that returns its input
  verbatim), the `String(...).replace(/\\/g,'/')` remedy is a harmless no-op.
