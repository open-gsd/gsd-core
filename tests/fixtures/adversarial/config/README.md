# Adversarial JSONC Config Fixtures (#5989)

Reusable hostile inputs for the three JSONC readers: `bin/install.js`
`stripJsonComments`, `src/settings-jsonc.cts` `parseJsonc`, and
`src/jsonc-edit.cts` `parseJsonc`.

Per CONTRIBUTING's fixture-provenance rule (#2371), these files are
**hand-authored against the real `settings.json` JSONC shape** (trailing
commas, `//` and `/* */` comments, string values containing structural
characters) — none of them were produced by a repo writer.

Tests load them by relative path from
`tests/5989-jsonc-trailing-comma-parity.test.cjs` so the corpus can grow
without touching the readers.

Categories present (all three readers must agree on every case, #5989):

- `issue-example.json` — the verbatim issue example. The string value must
  survive as `x,}y`; the old post-strip cleanup regex rewrote it to `x}y`.
- `comma-bracket-in-string.json` / `array-corruptor.json` — the `,]` twin of
  the trap, in an object value and inside an array.
- `escaped-quote-corruptor.json` — `,}` inside a string whose interior
  contains an escaped quote; the string-state tracking must not lose the
  escape.
- `real-trailing-commas.json` — characterization: genuine JSONC trailing
  commas (object and array) must still be dropped.
- `trailing-comma-before-line-comment.json` — characterization: a trailing
  comma before a `//` comment still collapses.
- `comma-brace-in-line-comment.json` — `,}` inside a comment changes
  nothing.
- `double-comma-object.json` / `double-comma-array.json` — malformed input
  must still throw `SyntaxError` from `JSON.parse` in every reader; the
  fix must not silently repair `1,,}`.
- `eof-comma.json` — trailing comma at end of input: nothing follows it to
  drop it, so the EOF flush must leave the same malformed shape the old
  regex left behind — every reader throws.
- `comma-before-number.json` — a held comma followed by a plain char is
  flushed, not dropped: `[1, 2]` parses identically in all three readers.

## Unterminated block comment boundary (#5990)

Hand-authored for #5990: the block-comment skip in each reader must verify
its closing delimiter instead of walking to the end of input. These files
carry **no trailing newline** — the EOF boundary is the behavior under test.

Unterminated forms (every reader must throw `SyntaxError`):

- `unterminated-bare.json` — a bare `/*` opener with nothing after it.
- `unterminated-slash.json` — `/*/`: one slash is not the closer.
- `unterminated-star.json` — one char short of `*/`.
- `unterminated-word.json` — a dangling comment body at EOF.

Terminated controls (every reader must still parse the same value):

- `minimal-closer.json` — `/**/`, the shortest legal comment.
- `exact-eof-comment.json` — the closer ends exactly at EOF.
- `star-run-closer.json` — a star run before the closer.
- `opener-inside-string.json` — `/*` inside a string value followed by a
  real comment; the string must survive as `/*`.
