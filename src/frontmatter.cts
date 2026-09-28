/**
 * Frontmatter — YAML frontmatter parsing, serialization, and CRUD commands
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/frontmatter.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 *
 * ADR-3473 §8.1 (#3881): the read path is no longer a hand-rolled line
 * scanner. `parseGuardedYamlRegion` now parses through the vendored `js-yaml`
 * (`./vendor/js-yaml.cjs`, verbatim `node_modules/js-yaml/dist/js-yaml.js`)
 * under `FAILSAFE_SCHEMA` + `json: true` — every scalar comes back a string
 * (today's contract, no adapter needed) and duplicate keys overwrite
 * (last-wins, the documented invariant). What js-yaml does NOT do —
 * anchors/alias refusal, the #3257 comment channel, the #1882 truncation
 * probe, null-byte preservation and object-list flattening for the existing
 * string-shaped value contract — is layered on top, in one place, below.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error } = ioMod;
import { platformReadSync as safeReadFile, platformWriteSync } from './shell-command-projection.cjs';
import { textEncodingError } from './validate.cjs';
import { splitLines } from './text-lines.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import unusableInputMod = require('./unusable-input.cjs');
const { UNUSABLE_REASON, warnUnusableInput } = unusableInputMod;
import { load as yamlLoad, dump as yamlDump, FAILSAFE_SCHEMA, YAMLException } from './vendor/js-yaml.cjs';

// ─── Types ────────────────────────────────────────────────────────────────────

type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;

// ─── Parsing engine ───────────────────────────────────────────────────────────

/**
 * Base js-yaml options for every parse in this module (ADR-3473 §8.1 §3.1/§3.3).
 * `FAILSAFE_SCHEMA` resolves only `!!str`/`!!seq`/`!!map` — every scalar comes
 * back a string, which is today's contract and needs no coercion layer.
 * `json: true` makes duplicate keys overwrite (last-wins) instead of throwing,
 * which is the documented behavior `tests/fixtures/adversarial/frontmatter/
 * duplicate-keys.md` pins.
 */
const YAML_LOAD_OPTS = { schema: FAILSAFE_SCHEMA, json: true };

/**
 * How many parsed keys an unterminated region must yield before it is reported as a
 * truncated frontmatter rather than left alone as ordinary Markdown. See the rationale on
 * `extractFrontmatter`; exported for tests so the boundary is asserted against the constant
 * rather than a magic number duplicated in the suite.
 */
const UNTERMINATED_KEY_THRESHOLD = 2;

/**
 * Does every non-empty line of an unterminated region look like frontmatter?
 *
 * The key count alone cannot separate a truncated write from ordinary Markdown, because a
 * thematic break above a short labelled preamble parses as keys too:
 *
 *     ---
 *     Author: Jane Doe
 *     Reviewed-by: John Smith
 *
 *     Ordinary prose, and no second `---` anywhere.
 *
 * Raising the threshold only moves that boundary — two labelled lines are as common in prose as
 * one. What actually distinguishes the two is what follows: a write interrupted part-way through
 * a frontmatter block ends mid-block, so *every* line in the region is still frontmatter-shaped,
 * whereas a document merely opening with a rule goes on to prose. So the region must be
 * uniformly frontmatter-shaped AND carry enough keys to be worth reporting; either test alone
 * has a false-positive class the other closes. This heuristic is deliberately a raw-text scan,
 * independent of whichever parser counts the keys (see `countKeysBeforeTruncation`) — it is the
 * guard that keeps a stricter parser from turning "opens with a rule" into a false positive.
 */
function isFrontmatterShaped(region: string): boolean {
  const lines = splitLines(region).filter((line) => line.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every((line) => (
    /^\s*[a-zA-Z0-9_-]+:/.test(line)   // key: value
    || /^\s*-\s+/.test(line)           // - list item
    || /^\s+\S/.test(line)             // indented continuation of a nested value
  ));
}

/**
 * #3257: a Symbol-keyed channel that carries full-line (column-0 `#`) YAML
 * comments through a parse → reconstruct round-trip. Comments are otherwise
 * unrepresentable on the Frontmatter object (Record<string, ...>) and were
 * silently dropped by reconstructFrontmatter. The Symbol is invisible to
 * Object.entries / Object.keys / JSON.stringify / for-in, so every existing
 * reader is unchanged; only reconstructFrontmatter reads it. Leading comments
 * are attached to the top-level key that follows them; comments after the last
 * key go to `trailing`. Only set when a comment is actually seen, so comment-less
 * frontmatter parses byte-identically to before.
 *
 * `leading` (and `inline`) are keyed by `commentPathKey` of the key path the comment belongs
 * to — `["status"]` for a top-level key, `["progress","total"]` for a nested one — so a
 * top-level key literally named `a.b` never shares an entry with sub-key `b` of map `a`.
 * `inline` holds a comment that sits on its key's own line (`a: 1  # note`), verbatim from
 * the whitespace before its `#`; only `spliceFrontmatter` sets it, for the one key it
 * regenerates (see `segmentComments`).
 */
const FULL_LINE_COMMENTS = Symbol('fullLineComments');
type FullLineCommentChannel = { leading: Record<string, string[]>; trailing: string[]; inline?: Record<string, string> };

/**
 * The comment-channel entry name of a key path: the JSON array of its key segments, which no
 * two different paths share whatever characters a key holds (found while implementing #5105 —
 * a dot-joined path read a top-level key named `a.b` as sub-key `b` of map `a`).
 */
function commentPathKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

/**
 * The mapping key a line opens and the line's indentation, or null for a line that opens no
 * key (a list item, a flow or scalar continuation, a comment). The key is read exactly as
 * `segmentKeyOf` reads a top-level one — a quoted key unescaped, a plain key ending at the
 * first `:` followed by whitespace — at any indentation. At indent > 0 the no-space bare-key
 * fallback is disabled (see `segmentKeyOf`'s docblock): a nested continuation line like
 * `  https://x` is not misread as opening key `https`.
 */
function channelKeyLine(line: string): { indent: number; key: string } | null {
  const indent = /^\s*/.exec(line)?.[0].length ?? 0;
  const k = segmentKeyOf(line.slice(indent), indent);
  return k ? { indent, key: k.key } : null;
}

/**
 * ADR-3473 §8.1 §0.3 (#3881, consequence 2): a Symbol-keyed marker carried on the `{}`
 * `extractFrontmatter` returns when the region failed to parse (malformed YAML, or a refused
 * anchor/alias/merge key — consequence 6). Mirrors `FULL_LINE_COMMENTS` exactly: invisible to
 * `Object.keys`/`Object.entries`/`JSON.stringify`/`for-in`, so the 70 call sites that never
 * inspect it are unaffected, while the 8 `hasFrontmatter = Object.keys(...).length > 0` sites
 * consult it to tell "genuinely empty" apart from "unparseable" and avoid reassembling the
 * document without its (unparsed but still present) frontmatter block. Those 8 call sites (7 in
 * `state-transition.cts` behind `isUnparseableFrontmatter`/`rawFrontmatterPrefix`, plus 1 more in
 * `state.cts`'s `cmdStateCompletePhase`) are wired on this branch — this module sets and exports
 * the marker; the callers consume it.
 */
const FRONTMATTER_UNPARSEABLE = Symbol('frontmatterUnparseable');

function unparseableResult(): Frontmatter {
  // Plain-prototype (post-remote-runner-fix, #3881): the PUBLIC parse surface must keep
  // handing callers ordinary `{}`-shaped objects — `assert.deepStrictEqual` compares
  // prototypes, and 50+ existing call sites/tests compare against object literals. The
  // Symbol marker is still attached via `Object.defineProperty` rather than bracket
  // assignment, which is what actually matters for prototype-pollution safety: a data
  // property named e.g. `__proto__` set through `defineProperty` never invokes the
  // inherited `Object.prototype.__proto__` accessor setter the way `fm[k] = v` would.
  const fm: Record<string, unknown> = {};
  Object.defineProperty(fm, FRONTMATTER_UNPARSEABLE, {
    value: true, writable: true, enumerable: true, configurable: true,
  });
  return fm as Frontmatter;
}

/**
 * Convert an internal, possibly null-prototype, YAML-derived value tree into an ordinary
 * plain-prototype tree for the public parse surface (post-remote-runner-fix, #3881).
 *
 * The internal construction (`normalizeParsedValue`, `restoreNullBytesDeep`,
 * `extractCommentChannel`) deliberately builds with `Object.create(null)` so a hostile key
 * like `__proto__`/`constructor`/`toString` is always a genuine own data property and never
 * resolves to (or overwrites) an inherited `Object.prototype` member WHILE THE TREE IS BEING
 * BUILT. That safety property has nothing to do with what prototype the FINAL object callers
 * receive — `assert.deepStrictEqual` compares prototypes, so handing back a null-prototype
 * object silently broke every caller comparing against `{}` object literals (57+ tests). This
 * walks the tree exactly once at the return boundary and re-homes every string/number-keyed
 * own property onto an ordinary `{}` via `Object.defineProperty` (never `out[k] = v`), which
 * is what keeps the copy itself safe: `defineProperty` always creates a real own data
 * property, even for a key literally named `__proto__`, and never triggers the inherited
 * setter the way bracket assignment would.
 *
 * The `FULL_LINE_COMMENTS` Symbol channel is copied across by reference, NOT recursed into —
 * it stays null-prototype. It is purely internal plumbing (only `reconstructFrontmatter` /
 * `propagateCommentChannel`, both in this module, ever read `channel.leading[key]` with an
 * arbitrary user-authored key), invisible to every external reader (`Object.keys` /
 * `Object.entries` / `JSON.stringify` / `for-in` all skip symbols), and re-plaining it would
 * reopen the exact `leading[key]` inherited-member bug the null prototype exists to close.
 */
function toPlainValueTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlainValueTree);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      Object.defineProperty(out, k, {
        value: toPlainValueTree((value as Record<string, unknown>)[k]),
        writable: true, enumerable: true, configurable: true,
      });
    }
    for (const s of Object.getOwnPropertySymbols(value)) {
      Object.defineProperty(out, s, {
        value: (value as Record<symbol, unknown>)[s], // internal channel: copied raw, not recursed
        writable: true, enumerable: true, configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 6, corrected post-#3881-review): `FAILSAFE_SCHEMA` still resolves
 * anchors, aliases and merge keys — that is core YAML mechanics, not tag resolution, so no
 * schema choice disables it. A hostile 7-line frontmatter (`&a [...]` fanned out through nested
 * aliases) expands to tens of megabytes in a few milliseconds, and `.planning/` documents are
 * user-authored, untrusted input. Corpus occurrences of anchors/aliases/merge keys today: zero,
 * so refusing them costs nothing.
 *
 * This was originally a raw-text line regex, and it was bypassable: a quoted key (`"a": &x 1`),
 * a flow mapping (`{b: &x 1, c: *x}`) or a flow sequence (`[&x "q", *x]`) all define/use an
 * anchor while never matching the "bareword key, then `&`/`*`" line shape the regex checked —
 * so the exact expansion this guard exists to stop went straight through unrefused. Detecting a
 * YAML anchor with a regex is re-implementing a YAML parser in order to guard a YAML parser; the
 * fix is to let the real parser report it instead of re-deriving anchor syntax by hand. js-yaml's
 * `load` accepts a `listener` invoked once per parse event with the parser's internal `State`;
 * `state.anchor` is non-null on every event belonging to an anchored node, in every spelling
 * above (verified by execution against all four), so throwing the instant it is set aborts the
 * parse before any alias expansion happens — the 303-byte quoted-key bomb refuses in ~1ms rather
 * than expanding to ~35MB. A `<<: *base` merge key is refused too, because it can only ever
 * reference a previously anchored node — the alias itself trips `state.anchor`. A merge key with
 * NO alias (`<<: {b: 1}`) carries no anchor and is not separately refused: under
 * `FAILSAFE_SCHEMA` (no `!!merge` type resolution) it never actually merges — it parses as an
 * ordinary literal `"<<"` string key with a normal, non-expanding nested map — so it carries none
 * of the resource-exhaustion risk this guard exists for.
 */
/** Thrown from inside the `listener` callback below; never surfaced past `refuseAnchorsAndAliases`. */
class AnchorDetectedSignal extends Error {}

function refuseAnchorsAndAliases(yaml: string): void {
  try {
    yamlLoad(yaml, {
      ...YAML_LOAD_OPTS,
      listener: (_event: string, state: { anchor?: string | null }) => {
        // Thrown FROM INSIDE the listener, not merely recorded and checked after `load`
        // returns: js-yaml keeps parsing (and, for an alias, keeps EXPANDING) past a listener
        // that only sets a flag, which reintroduces the exact resource-exhaustion window this
        // guard exists to close. Throwing here aborts the parse immediately, before any
        // expansion — the billion-laughs fixture refuses in ~1-2ms rather than building the
        // ~35MB tree first and discarding it.
        if (state.anchor !== null && state.anchor !== undefined) throw new AnchorDetectedSignal();
      },
    });
  } catch (e) {
    if (e instanceof AnchorDetectedSignal) {
      throw new YAMLException(
        'frontmatter: anchors, aliases and merge keys are refused (ADR-3473 §8.1)',
      );
    }
    // Any other failure (malformed YAML unrelated to anchors) is reported by the real parse
    // in parseGuardedYamlRegion; this pre-pass only exists to refuse anchors/aliases early.
  }
}

/**
 * ADR-3473 §8.1 (consequence 7): js-yaml rejects a literal U+0000 unconditionally, under every
 * schema. The fixture invariant (`null-byte-value.md`) is "preserve or normalize; never truncate
 * silently", so the byte is swapped for a private-use sentinel before the parse and restored in
 * every resulting string afterward — preserving the exact byte rather than normalizing it away.
 *
 * CORRECTED (post-#3881-review, finding 3): the round-trip was non-injective. `restoreNullBytesDeep`
 * rewrites EVERY U+E000 in the parsed tree back to U+0000 — including one the document author
 * legitimately wrote — so a document containing a literal U+E000 (with or without an actual NUL
 * elsewhere) came back corrupted: its own U+E000 silently became a NUL. Rather than pick a
 * "provably absent" sentinel (unprovable in general — any fixed codepoint can itself appear in
 * user-authored input), `refuseIfSentinelPresent` makes the substitution provably reversible by
 * refusing outright whenever the RAW region already contains U+E000, before any substitution
 * happens — consistent with this module's existing refusal path (anchors/aliases/merge keys) for
 * "cannot faithfully round-trip this input." Once refused, the sentinel is guaranteed absent from
 * the input the escape/restore pair actually operates on, and the substitution is injective by
 * construction.
 */
const NULL_BYTE_SENTINEL = String.fromCharCode(0xE000);

function refuseIfSentinelPresent(yaml: string): void {
  if (yaml.includes(NULL_BYTE_SENTINEL)) {
    throw new YAMLException(
      'frontmatter: contains the reserved null-byte-escape sentinel U+E000 — refused rather than ' +
        'silently corrupted on restore (ADR-3473 §8.1)',
    );
  }
}

function escapeNullBytesForParse(yaml: string): string {
  return yaml.indexOf('\u0000') === -1 ? yaml : yaml.split('\u0000').join(NULL_BYTE_SENTINEL);
}

function restoreNullBytesDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes(NULL_BYTE_SENTINEL) ? value.split(NULL_BYTE_SENTINEL).join('\u0000') : value;
  }
  if (Array.isArray(value)) return value.map(restoreNullBytesDeep);
  if (value && typeof value === 'object') {
    // Null-prototype (post-#3881-review, finding 3): an ordinary {} here silently DROPS a
    // top-level key literally named __proto__ -- out['__proto__'] = v on a normal object
    // invokes the inherited Object.prototype.__proto__ SETTER (reassigning the object's own
    // prototype) instead of creating a data property, so key: __proto__ in a document
    // vanishes from the parsed result with no error. Confirmed by execution: ---\n__proto__:
    // hello\nz: 1\n---\n parsed to {z: "1"}, silently dropping the __proto__ key entirely.
    // Object.create(null) has no such setter, so the assignment below is always a genuine
    // own data property, for every key including __proto__ itself.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const restoredKey = k.includes(NULL_BYTE_SENTINEL) ? k.split(NULL_BYTE_SENTINEL).join(String.fromCharCode(0)) : k;
      out[restoredKey] = restoreNullBytesDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 3): js-yaml resolves `- test: a b` (and the three other spellings
 * of the same value — `"a b"`, `'a b'`, `{test: a b}`) to ONE tree shape, `[{test: "a b"}]` —
 * unlike the legacy scanner, whose output was a function of the raw source line and therefore
 * produced four different strings for those four spellings (ADR-3473 40-design.md §0.1). No
 * adapter over a tree can recover a distinction the tree does not carry, so this renders a single
 * canonical string per object-list item instead, keeping the existing value SHAPE (an array of
 * strings) that `sliceFrontmatterLayout`, the `[object Object]` guard and
 * `noOpObjectListSetError` all depend on. Choosing structured (non-string) values is fork (b) —
 * out of scope for this phase.
 */
function flattenScalarForDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(flattenScalarForDisplay).join(', ')}]`;
  if (typeof value === 'object') return flattenObjectListItem(value as Record<string, unknown>);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function flattenObjectListItem(item: Record<string, unknown>): string {
  return Object.entries(item)
    .map(([k, v]) => `${k}: ${flattenScalarForDisplay(v)}`)
    .join(', ');
}

/**
 * Recursively normalize a parsed js-yaml tree to this module's historical contract:
 *  - `null`/`undefined` in an object-value slot becomes `{}` (consequence 1 — matches the
 *    legacy scanner's empty-value handling exactly, so `reconstructFrontmatter` — which omits
 *    null-valued keys — still round-trips a bare `key:` line instead of deleting it);
 *  - `null`/`undefined` inside an array becomes `''` (arrays are always string[] in this
 *    module's contract);
 *  - a map or nested array found as an array ITEM is flattened to a canonical string
 *    (consequence 3);
 *  - every other scalar is already a string under `FAILSAFE_SCHEMA` and passes through.
 */
function normalizeParsedValue(value: unknown, inArray: boolean): unknown {
  if (value === null || value === undefined) return inArray ? '' : {};
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        return Array.isArray(item) ? flattenScalarForDisplay(item) : flattenObjectListItem(item as Record<string, unknown>);
      }
      return normalizeParsedValue(item, true);
    });
  }
  if (typeof value === 'object') {
    // Null-prototype (post-#3881-review, finding 3): a top-level YAML key named `constructor`,
    // `__proto__`, `toString`, `valueOf` or `hasOwnProperty` is ordinary user-authored input
    // (`.planning/` frontmatter), not an attack — but on an ordinary `{}` it resolves to the
    // inherited Object.prototype member instead of `undefined`, which crashes downstream
    // bracket reads (`commentChannel?.leading[key]`) and silently mis-answers `fm[field]`
    // lookups in `cmdFrontmatterGet`. `Object.create(null)` severs the prototype chain so every
    // reader of a parsed Frontmatter object gets a real bracket-read contract: present or
    // `undefined`, never an inherited function.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeParsedValue(v, false);
    }
    return out;
  }
  return value;
}

/**
 * ADR-3473 §8.1 (consequence 5): the #3257 comment scan used to key off the legacy parser's own
 * `[a-zA-Z0-9_-]+:` key regex — a Unicode key (e.g. `相:`) never matched it, so a comment above
 * one silently attached to the WRONG key once js-yaml owns the real (Unicode-inclusive) key set.
 * This attributes each pending column-0 comment block against js-yaml's own parsed top-level key
 * list, in document order, by matching the literal key text at column 0 rather than re-deriving a
 * key shape independently — so it can never disagree with what was actually parsed.
 */
function extractCommentChannel(yaml: string, orderedKeys: string[]): FullLineCommentChannel | undefined {
  const lines = splitLines(yaml);
  // #3742: pending full-line comments carry their indentation so an INDENTED
  // comment (`  # note` above a nested key) can attach to the nested key that
  // follows it — recorded under its key path (`["progress","total_phases"]`,
  // see `commentPathKey`) that reconstructFrontmatter re-emits at the same
  // nesting depth. Column-0 comments keep the exact pre-#3742 behavior
  // (top-level key attachment).
  let pending: Array<{ indent: number; line: string }> = [];
  let channel: FullLineCommentChannel | undefined;
  let keyIdx = 0;
  // Stack of enclosing mapping keys with their indentation, for key-path
  // construction on nested key lines. Only indented keys push here.
  const pathStack: Array<{ indent: number; key: string }> = [];

  const attach = (segments: string[], comments: Array<{ indent: number; line: string }>): void => {
    if (!channel) channel = { leading: Object.create(null) as Record<string, string[]>, trailing: [] };
    // Null-prototype `leading` (post-#3881-review, finding 3): every lookup is an
    // own-property-or-undefined read, whatever key text a user-authored path holds.
    channel.leading[commentPathKey(segments)] = comments.map((c) => c.line);
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    const commentMatch = /^(\s*)#/.exec(line);
    if (commentMatch) {
      pending.push({ indent: commentMatch[1].length, line });
      continue;
    }
    // A list item (`- foo: bar`) is not a mapping key (#3742 review): `channelKeyLine`
    // reads no key from it, so it falls through to the pending-drop below.
    const keyLine = channelKeyLine(line);
    if (keyLine) {
      const { indent, key } = keyLine;
      if (indent === 0) {
        // Top-level: keep the pre-#3742 orderedKeys walk — the comment
        // attaches only to the next EXPECTED top-level key.
        if (keyIdx < orderedKeys.length && key === orderedKeys[keyIdx]) {
          const col0 = pending.filter((c) => c.indent === 0);
          if (col0.length) attach([key], col0);
          keyIdx++;
          // A top-level mapping key opens a nesting context for the indented
          // keys that follow it (#3742 dotted-path attachment).
          pathStack.length = 0;
          pathStack.push({ indent: 0, key });
          pending = [];
          continue;
        }
      } else {
        // Nested key line: a pending comment at the SAME indentation attaches
        // to this key under its key path. Deeper/misaligned pending
        // comments were not leading this key — drop them, matching the
        // top-level rule's "attach only when a key follows" discipline.
        while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) pathStack.pop();
        const sameIndent = pending.filter((c) => c.indent === indent);
        if (sameIndent.length && key.length > 0) {
          attach([...pathStack.map((e) => e.key), key], sameIndent);
        }
        pathStack.push({ indent, key });
        pending = [];
        continue;
      }
    }
    // A non-comment line that is not the next expected top-level key start: any comments
    // pending before it were not actually leading a key (malformed/unusual input) — drop
    // rather than misattach, matching the prior scan's "attach only when a key follows" shape.
    pending = [];
  }

  const col0Trailing = pending.filter((c) => c.indent === 0);
  if (col0Trailing.length) {
    if (!channel) channel = { leading: Object.create(null) as Record<string, string[]>, trailing: [] };
    channel.trailing = col0Trailing.map((c) => c.line);
  }
  return channel;
}

/**
 * Parse one already-delimited YAML region into a Frontmatter object, via the vendored js-yaml
 * (ADR-3473 §8.1). Throws (a `YAMLException`, or a plain `Error` from `refuseAnchorsAndAliases`)
 * on anything js-yaml itself cannot parse or that this module refuses outright; callers decide
 * whether to surface that as `unparseableResult()` or use it as a truncation signal.
 *
 * Renamed from `parseYamlRegion` (post-#3881-review, finding 2): §8.1 says `parseYamlRegion` is
 * "deleted, not patched" — the hand-rolled line scanner that name identified IS gone, but the
 * name itself survived on a new function with two callers (`extractFrontmatter` and
 * `countKeysBeforeTruncation`) that could not be inlined without duplicating the
 * refusal/null-byte/comment-channel glue below. Renaming closes that gap literally: nothing in
 * this module still answers to the old hand-rolled scanner's name.
 *
 * RESTORED (fix #3881/#3881-followup-2, closes the #3705-shaped regression reported against
 * `tests/smart-entry.unit.test.cjs:867`/`tests/smart-entry.property.test.cjs`): a prior revision
 * of this function fell back, on a throw, to TWO hand-rolled re-implementations of YAML dialect —
 * `repairAmbiguousColonValues` (below) for `key: value: extra`-shaped ambiguous colons, and
 * `repairMalformedInlineArrays`/`splitLegacyInlineArrayItems` for a malformed/unclosed `[...]`.
 * Both were deleted in 810e5e508 after a sweep of every tracked `*.md` file in this repo (910
 * files) showed disabling each repair independently changed the parse result for zero documents.
 *
 * THAT SWEEP MEASURED THE WRONG POPULATION. `repairAmbiguousColonValues`'s one real dependent is
 * not a document committed anywhere in this repo — it is user hand-edited STATE.md content that
 * exists only on end users' machines and is pinned here by `tests/smart-entry.unit.test.cjs` (see
 * its own in-file comment: "silently re-opened #2571/#2570 for hand-edited STATE.md that omits
 * the template em dash"). The exact shape: `last_activity: 2026-06-08: reviewed the PR queue` — a
 * colon-separated date+description a user typed by hand instead of the template's ` — ` (em dash)
 * separator. js-yaml correctly refuses this as genuinely ambiguous YAML (a colon+space inside an
 * unquoted scalar opens a nested mapping key); the old hand-rolled scanner tolerated it by taking
 * everything after the first `key:` verbatim. A future sweep of tracked `.md` files will AGAIN
 * show zero dependents for this exact reason — the dependent never lives in this repo's tree, it
 * lives in a user's own `.planning/STATE.md`. Do not delete this again on that evidence alone;
 * `tests/smart-entry.unit.test.cjs` and the frontmatter-level row in
 * `tests/feat-3881-yaml-parser-consequences.test.cjs` are the actual proof the dependent exists.
 *
 * `repairMalformedInlineArrays`/`splitLegacyInlineArrayItems` stay deleted: their zero-dependents
 * finding was reverified directly (frontmatter/smart-entry/verify/roadmap suites all pass without
 * them) and, unlike the colon repair, nothing in the test suite or #2570/#2571 documents a
 * hand-edited-STATE.md shape that depends on inline-array leniency.
 */
function loadWithAmbiguousColonRepair(yaml: string): unknown {
  try {
    return yamlLoad(yaml, YAML_LOAD_OPTS);
  } catch (e) {
    const repaired = repairAmbiguousColonValues(yaml);
    if (repaired === yaml) throw e; // nothing to repair — surface the original error
    try {
      return yamlLoad(repaired, YAML_LOAD_OPTS);
    } catch {
      throw e; // repair didn't help (still invalid, possibly for another reason) — surface the original
    }
  }
}

/**
 * Double-quote (and escape) any column-0 `key: value` line whose (single-line) value contains an
 * unquoted colon+whitespace or a trailing bare colon — the exact shape that reads as an ambiguous
 * nested mapping key to a real YAML parser (`key: value: extra`, `key: value:`). Lines that are
 * already safely quoted or open a flow/block collection (`"`, `'`, `[`, `{`) are left untouched
 * (js-yaml already handles those); an empty value (`key:` alone, opening a nested block) is left
 * untouched too, since repairing it would change a legitimate nested-map opener into a scalar.
 * Only column-0 lines are considered — an indented line is either already-valid nested content or
 * a genuinely different malformation this repair does not claim to fix.
 *
 * Restored (fix #3881/#3881-followup-2) — see `loadWithAmbiguousColonRepair`'s docblock for why a
 * tracked-document sweep cannot see this function's one real dependent (hand-edited STATE.md,
 * #2571/#2570, pinned by `tests/smart-entry.unit.test.cjs`).
 */
function repairAmbiguousColonValues(yaml: string): string {
  return splitLines(yaml)
    .map((line) => {
      const m = /^([A-Za-z0-9_][A-Za-z0-9_-]*):[ \t](.+)$/.exec(line);
      if (!m) return line;
      const [, key, value] = m;
      if (/^["'[{]/.test(value)) return line; // already safely quoted/collection-opened
      if (!/:(?:[ \t]|$)/.test(value)) return line; // no ambiguous colon in the value
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join('\n');
}

function parseGuardedYamlRegion(yaml: string): Frontmatter {
  refuseAnchorsAndAliases(yaml);
  refuseIfSentinelPresent(yaml);
  const escaped = escapeNullBytesForParse(yaml);
  const raw: unknown = loadWithAmbiguousColonRepair(escaped);
  const normalized = normalizeParsedValue(raw, false);
  const root: Record<string, unknown> =
    normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? (normalized as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const restored = restoreNullBytesDeep(root) as Frontmatter;

  const commentChannel = extractCommentChannel(yaml, Object.keys(restored));
  if (commentChannel) {
    (restored as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] = commentChannel;
  }
  // Plain-prototype at the public-surface boundary (post-remote-runner-fix, #3881): see
  // `toPlainValueTree`'s docblock. Everything above this line stays null-prototype internally.
  return toPlainValueTree(restored) as Frontmatter;
}

/**
 * ADR-3473 §8.1 (consequence 4): the #1882 truncation probe used to run the SAME parser
 * (`parseGuardedYamlRegion`) over an unterminated region and count its keys — deliberately, so a second
 * "does this look like YAML?" matcher could never drift from the real parser. js-yaml is stricter
 * than the old scanner, though: the dominant real truncation shape (fence opened, well-formed
 * keys, then the document body follows with no closing fence) is *invalid* YAML — a plain-text
 * paragraph at column 0 right after a block mapping raises `bad indentation of a mapping entry`
 * — so a naive "parse the whole region, count keys on success" port yields 0 keys and goes
 * silent on exactly the case #1882 exists for.
 *
 * CORRECTED (post-#3881-review, finding 5): the original recovery — re-parse ONLY the exact
 * prefix named by `e.mark.line` — regressed on every realistic truncation shape actually
 * checked by execution: an unquoted-colon value (`title: a: b`) and a mis-indented sibling
 * key (`  plan: 2`) both raise "bad indentation of a mapping entry" ON the offending line
 * itself, so `mark.line` names that SAME line and slicing BEFORE it drops the offending
 * line's own key entirely — undercounting by exactly the key the probe most needs to see. An
 * open flow collection (`list: [a, b`) raises its error on the (nonexistent) line AFTER the
 * region's end, so the "marked prefix" still contains the same unterminated `[` and the retry
 * parse fails too, falling through to a hard `0`. And a refused anchor/alias/merge key throws
 * a mark-LESS `YAMLException` (`refuseAnchorsAndAliases`, thrown from inside the parse
 * `listener` before js-yaml attaches position info) — the `e.mark` guard was never entered at
 * all, hard `0` again, even though every other key in the region is perfectly valid.
 *
 * A first fix attempt tried shrinking the region line-by-line and re-parsing through the SAME
 * real parser only — still no second matcher. It did NOT recover any of the three shapes above:
 * the offending line in the first two IS the malformed token, at every possible prefix boundary
 * that includes it, so no amount of shrinking ever makes it parse; the only prefix that ever
 * succeeds is the one line BEFORE it, i.e. exactly the original bug's undercount. A parser-only
 * strategy cannot report a key whose own line is genuinely invalid YAML — the same limitation
 * that made the mark-based recovery fail in the first place. This means "the one real parser,
 * never a hand-rolled matcher" is unreachable for the truncation-probe's actual job (a lower-
 * bound COUNT of what looks like a key line, not a validity judgment) — this file already
 * accepts an independent raw-text matcher for the adjacent question of "is this shaped like
 * frontmatter" (`isFrontmatterShaped`, used by this probe's only caller), so `countKeysBeforeTruncation`
 * takes the MAX of two lower bounds: how many keys the real parser can recover from the longest
 * parseable line-prefix (still the primary signal — correct on the dominant fence-then-prose
 * shape, and on any prefix boundary that genuinely IS the truncation point), and how many
 * column-0 `key:`-shaped lines the raw text contains (recovers the three regressed shapes,
 * whose offending key line the parser can never count). Neither alone is sufficient; together
 * they never under-report a key that either signal can see.
 */
function countKeysBeforeTruncation(region: string): number {
  const parsed = parsedKeyCount(region);
  const textual = countTopLevelKeyShapedLines(region);
  return Math.max(parsed, textual);
}

/** How many keys the real parser recovers from the longest line-prefix of `region` that parses
 * cleanly (the whole region itself, when it parses outright). Bounded to at most `region`'s own
 * line count re-parses — no worse than the whole-region parse already paid for on the caller's
 * unterminated-region path, which is itself bounded by ordinary `.planning/` document sizes (the
 * huge-bounded fixture parses successfully on the FIRST try and never reaches the shrink loop).
 */
function parsedKeyCount(region: string): number {
  try {
    return Object.keys(parseGuardedYamlRegion(region)).length;
  } catch {
    const lines = splitLines(region);
    for (let n = lines.length - 1; n >= 1; n--) {
      const prefix = lines.slice(0, n).join('\n');
      if (prefix.trim() === '') continue;
      try {
        return Object.keys(parseGuardedYamlRegion(prefix)).length;
      } catch {
        continue;
      }
    }
    return 0;
  }
}

/** How many `key:`-shaped lines `region` textually contains — the raw-text lower bound that
 * recovers a key whose OWN line is malformed YAML (an unquoted colon in the value, or a
 * mis-indented sibling that reads as an "indented continuation" to the real parser), which no
 * re-parse of any prefix can ever count (see `countKeysBeforeTruncation`'s docblock). Matches
 * ANY indentation, not only column 0 — the mis-indented-sibling shape is, by construction, a key
 * the author intended as top-level but indented by mistake; requiring column 0 here would just
 * relocate the exact undercount finding 5 reports. Deliberately the SAME key-shape pattern this
 * file already uses for the sibling shape check (`isFrontmatterShaped`'s first branch) — ASCII-
 * only is an accepted, precedented scope limit for this raw-text heuristic, not a new one.
 */
function countTopLevelKeyShapedLines(region: string): number {
  return splitLines(region).filter((line) => /^\s*[A-Za-z0-9_-]+:/.test(line)).length;
}

/**
 * Extract frontmatter from a document.
 *
 * Returns `{}` when the document has no frontmatter — and, unchanged since #1882, also
 * returns `{}` when the frontmatter fence was opened and never closed. That return value is
 * deliberately preserved: ADR-1411's amendment requires the fallback to stay, because
 * changing it would break callers that treat "absent" and "unusable" identically. What #1882
 * adds is that the second case is no longer *silent*.
 *
 * The discriminator is the reason this is not simply "opened but never closed". A Markdown
 * document whose first line is a thematic break (`---`) takes that exact branch, so flagging
 * on the missing fence alone reports corruption on perfectly good Markdown. Instead the
 * unterminated region's key count (see `countKeysBeforeTruncation`) is reported only when it
 * yields **two or more** keys AND the region is uniformly frontmatter-shaped raw text
 * (`isFrontmatterShaped`).
 *
 * Two, not one, and the extra key is doing real work. A single `key: value` line is genuinely
 * ambiguous: `---` followed by `Note: this is a paragraph.` — or `Author:`, `TODO:`, `See:` —
 * is ordinary technical writing, a thematic break above a labelled line, and it parses as
 * exactly one key. There is no textual signal that separates it from a write interrupted
 * after its first key, so the threshold is set where the ambiguity ends. The cost is a false
 * negative on a file truncated after exactly one key; the benefit is silence on a very common
 * Markdown shape. That direction is deliberate and matches the choice already made at zero
 * keys: a false positive on valid Markdown is worse than a missed edge, because the
 * diagnostic is unconditional and cannot be turned off. Every GSD artefact this guards
 * (STATE.md, PLAN.md, ROADMAP.md, SUMMARY.md, agent/command docs) carries two or more
 * frontmatter keys, so the realistic interruption window stays covered.
 *
 * A closed region that js-yaml itself cannot parse (malformed YAML, or a refused
 * anchor/alias/merge key — ADR-3473 §8.1 consequence 6) returns `{}` carrying the
 * `FRONTMATTER_UNPARSEABLE` Symbol (consequence 2) rather than a bare, indistinguishable `{}`.
 *
 * @param content Raw document text.
 * @param sourcePath Optional resolved path, used to name the file in the diagnostic and to
 *   key its deduplication. Optional because this function has 50-odd call sites and several
 *   hold only an in-memory string; those dedup on a content digest instead.
 */
/**
 * The frontmatter REGION of a document: the text between the opening `---`
 * fence at byte 0 and its closing fence.
 *
 * One fence parser, not two (#3850 review round 2, B1). `extractFrontmatter`
 * and `frontmatterListEntries` need the identical answer to "where does the
 * frontmatter start and stop" — same BOM tolerance (#2977), same byte-0-only
 * fence rule, same CR handling before the closing fence — and differ only in
 * what they do with the region text afterwards. A second copy of this logic is
 * the `DEFECT.GENERATIVE-FIX` shape: it silently stops agreeing the first time
 * either is taught something.
 *
 * `terminated: false` is the fence-opened-but-never-closed case. It is not an
 * error here because the two callers disagree about it: `extractFrontmatter`
 * runs the #1882 truncation probe over the region and may warn, while
 * `frontmatterListEntries` has no array to return and gives up. So the shape
 * is reported and the decision is left to them.
 *
 * `content` is returned alongside because it is the BOM-STRIPPED text, and a
 * caller reporting on the document (the truncation diagnostic) must describe
 * the same bytes the offsets were computed against.
 */
function frontmatterRegion(
  content: string,
): { region: string; terminated: boolean; content: string } | null {
  // The fence rules — BOM tolerance (#2977), the byte-0 opening fence, the whole-line closing
  // fence, an adjacent empty block — live in `locateFrontmatterFence`, the one owner every
  // fence consumer reads (found while implementing #5105: four copies of this answer disagreed).
  const fence = locateFrontmatterFence(content);
  if (!fence) return null;
  const stripped = content.slice(fence.bom.length);
  if (!fence.closed) {
    return { region: content.slice(fence.openEnd), terminated: false, content: stripped };
  }
  return { region: content.slice(fence.openEnd, fence.bodyEnd), terminated: true, content: stripped };
}

/**
 * The closed frontmatter BLOCK of a document for a writer: `bom` (the leading BOM, or ''),
 * `block` (from the opening `---` through the closing `---`, both fences included, no line
 * ending after the closing fence) and `rest` (everything after it), so
 * `bom + block + rest === content`. Read from `locateFrontmatterFence`, so a writer and every
 * reader agree on where the block is — BOM, CRLF and an empty block included (found while
 * implementing #5105: two private fence regexes disagreed with the reader on a BOM document
 * and on a block holding only a blank line). Null when there is no block or it is unterminated.
 */
function frontmatterBlock(content: string): { bom: string; block: string; rest: string } | null {
  const fence = locateFrontmatterFence(content);
  if (!fence || !fence.closed) return null;
  return {
    bom: fence.bom,
    block: content.slice(fence.bom.length, fence.closingFenceEnd),
    rest: content.slice(fence.closingFenceEnd),
  };
}

function extractFrontmatter(content: string, sourcePath?: string): Frontmatter {
  // Fence location (BOM strip, byte-0 rule, CR handling) lives in
  // `frontmatterRegion` so this and `frontmatterListEntries` cannot drift
  // apart on where the frontmatter is.
  const found = frontmatterRegion(content);
  if (!found) return {};

  if (!found.terminated) {
    const keyCount = countKeysBeforeTruncation(found.region);
    if (keyCount >= UNTERMINATED_KEY_THRESHOLD && isFrontmatterShaped(found.region)) {
      warnUnusableInput({
        reason: UNUSABLE_REASON.FRONTMATTER_UNTERMINATED,
        source: sourcePath,
        content: found.content,
      });
    }
    return {};
  }

  try {
    return parseGuardedYamlRegion(found.region);
  } catch {
    return unparseableResult();
  }
}

/**
 * The entries of a top-level frontmatter ARRAY key, VERBATIM — as the values
 * YAML actually describes rather than the display-flattened strings
 * `extractFrontmatter` returns (#3850).
 *
 * `extractFrontmatter` renders each object entry for HUMANS —
 * `normalizeParsedValue` maps `{test, resolution}` to `"test: …, resolution: …"`
 * via `flattenObjectListItem`. That is the right contract for a reader printing
 * a list, and the wrong one for a reader that needs to branch on a specific
 * field: `status`, `resolution` and `reason` are recoverable from that string
 * only by re-parsing prose, which cannot distinguish a real `resolution:` field
 * from the same text inside a quoted `truth:`.
 *
 * This returns the same entries BEFORE that display step, off the same
 * `extractFrontmatter` parse path — same BOM strip (#2977), same byte-0 fence
 * rule (shared via `frontmatterRegion`), same anchor/alias and sentinel guards,
 * same ambiguous-colon repair. It is deliberately NOT a second parser: a
 * hand-rolled fence regex or entry slicer re-loses whatever the real one
 * learned, which is the `DEFECT.GENERATIVE-FIX` shape.
 *
 * EVERY element is returned, at its own index, whatever its type (#3850 review
 * round 3, Blocker). An earlier revision filtered to objects, which compacted
 * the array: a caller numbering entries by array position then numbered the
 * SURVIVORS, so a list mixing object and non-object entries lost rows outright
 * and mis-numbered the rest — the same silently-vanishing-row defect this whole
 * issue exists to close, triggered by entry shape instead of file status.
 * Deciding what a non-object entry MEANS is a caller's judgement (the two
 * readers in `uat.cts` answer it differently and both are right for their own
 * vocabulary); dropping it is nobody's.
 *
 * Returns `null` when the document has no frontmatter, the frontmatter is
 * unterminated or unparseable, the key is absent, or the key is not an array —
 * "nothing to iterate" cases the caller should not have to tell apart.
 */
function frontmatterListEntries(content: string, key: string): unknown[] | null {
  const field = rawFrontmatterField(content, key);
  // `Array.isArray` narrows an `unknown` to `any[]`, and returning that
  // unchecked is how `any` escapes a guarded parser into every caller. The
  // element type genuinely IS unknown here — that is the point of this
  // function — so say so.
  if (!field || !Array.isArray(field.value)) return null;
  return field.value as unknown[];
}

/**
 * One top-level frontmatter key's value VERBATIM — before the display flattening
 * `extractFrontmatter` applies — off the same guarded parse path (`frontmatterRegion`, the
 * anchor/alias and sentinel guards, the ambiguous-colon repair). Null when the document has
 * no closed, parseable frontmatter mapping or the key is not an own key of it.
 */
function rawFrontmatterField(content: string, key: string): { value: unknown } | null {
  const found = frontmatterRegion(content);
  if (!found || !found.terminated) return null;

  let raw: unknown;
  try {
    refuseAnchorsAndAliases(found.region);
    refuseIfSentinelPresent(found.region);
    raw = restoreNullBytesDeep(loadWithAmbiguousColonRepair(escapeNullBytesForParse(found.region)));
  } catch {
    // Same posture as `extractFrontmatter`: an unparseable region is "no
    // frontmatter", never a throw into a caller that was only reading a field.
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return null;
  return { value: (raw as Record<string, unknown>)[key] };
}

/**
 * Escape a string for emission inside a YAML double-quoted scalar (#1779). ADR-3473 §8.1
 * (#3881): routed through the vendored js-yaml's `dump()` (forced double-quoted style) rather
 * than a hand-rolled character-class replace chain, so the writer shares the same escaping
 * engine the reader now uses. js-yaml emits control-char escapes as uppercase hex (`\x1F`);
 * this repo has emitted lowercase (`\x1f`) since #1779, so the hex digits are lowercased after
 * dump to keep serialized output byte-stable across the migration FOR THE CASES the old
 * hand-rolled chain actually covered (backslash/quote/newline/tab/CR, and every C0 control
 * plus DEL via \xHH). It is NOT byte-stable end-to-end (post-#3881-review, finding 4,
 * verified by execution): the old chain left BEL/NUL unescaped-as-hex (`\x07`/`\x00`) and
 * left NEL/NBSP/LINE SEPARATOR/PARAGRAPH SEPARATOR/BOM as raw literal bytes entirely (they
 * fall outside its `\u0000-\u001f\u007f` class); js-yaml's dump instead emits the YAML-named
 * escapes `\a`/`\0`/`\N`/`\_`/`\L`/`\P` for those six, and a `\uXXXX` escape for the BOM and
 * any lone UTF-16 surrogate. The serialized TEXT differs from pre-migration output for these
 * codepoints, but the round-trip is equivalence-preserving, not merely byte-preserving: every
 * one of `\a`/`\0`/`\N`/`\_`/`\L`/`\P`/`\uXXXX` is a YAML double-quoted-scalar escape that
 * resolves back to the EXACT source codepoint on re-parse (confirmed by execution — see
 * `tests/frontmatter.unit.test.cjs`'s pinned cases). scalarNeedsDoubleQuoting was extended in
 * the same review round to also route lone surrogates through this quoted+escaped path,
 * because they were previously emitted bare and produced genuinely UNPARSEABLE YAML.
 *
 * Renamed from `escapeDoubleQuoted` (post-#3881-review, finding 2): §8.1 says this function is
 * "deleted, not patched" — like `parseGuardedYamlRegion`, the hand-rolled character-class chain
 * is gone, but unlike that function this one HAS no other caller inside this module to hide the
 * old name's survival behind, so the rename is a straight mechanical propagation to its three
 * call sites (`reconstructFrontmatter` here, plus `commands.cts` and
 * `runtime-artifact-conversion.cts`, both updated in this change — no ADR amendment needed).
 */
function escapeDoubleQuotedScalar(s: string): string {
  const dumped = yamlDump(s, { schema: FAILSAFE_SCHEMA, forceQuotes: true, quotingType: '"', lineWidth: -1 });
  const withoutTrailingNewline = dumped.endsWith('\n') ? dumped.slice(0, -1) : dumped;
  const interior = withoutTrailingNewline.slice(1, -1); // strip the outer double-quote pair
  return interior.replace(/\\x([0-9A-Fa-f]{2})/g, (_m, hex: string) => `\\x${hex.toLowerCase()}`);
}

/**
 * A plain (unquoted) scalar that would mis-parse or round-trip lossily when
 * emitted bare must instead go through the double-quoted + escaped form
 * (#1779): the empty string (bare `k:` reloads as null), an embedded `"`/`\`
 * or control char, a leading YAML indicator (quote, `&`/`*`/`!` anchor/alias/
 * tag, `|`/`>` block scalar, flow `[]{},`, `#`, reserved `%`/`@`/backtick, or
 * `-`/`?`/`:` before a space), or leading/trailing whitespace. This helper is
 * the correctness complement of `escapeDoubleQuotedScalar`: it broadens the *trigger*
 * for quoting without broadening the lossy object-list handling deferred to
 * #1572/#1660.
 */
function scalarNeedsDoubleQuoting(s: string): boolean {
  if (s === '') return true;
  if (/["\\\u0000-\u001f\u007f]/.test(s)) return true;
  // Always-unsafe leading indicators, or leading/trailing whitespace.
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) return true;
  // `-` `?` `:` only start a plain scalar safely when NOT followed by a space.
  if (/^[-?:](\s|$)/.test(s)) return true;
  // Post-#3881-review, finding 4 (found while verifying escapeDoubleQuotedScalar's byte-
  // stability claim): an unpaired UTF-16 surrogate (U+D800-U+DFFF) is outside YAML's
  // printable-character set, so js-yaml's loader refuses it ("the stream contains
  // non-printable characters") the instant it is emitted bare. No other trigger above
  // catches it -- not whitespace, not a C0/C1 control, not a leading indicator -- so a bare
  // emission was genuinely invalid YAML: reconstructFrontmatter produced text
  // extractFrontmatter could not re-parse, silently collapsing to {} via
  // unparseableResult(). Confirmed by execution: reconstructFrontmatter({weird: '\uD800'})
  // round-tripped to undefined before this fix. Routing it through the quoted +
  // escapeDoubleQuotedScalar path (which already emits the \uD800 escape) fixes the
  // round-trip.
  if (/[\uD800-\uDFFF]/.test(s)) return true;
  return false;
}

/**
 * #3706 — Does this value need double-quoting when written as an AGENT
 * frontmatter scalar (`model:`, `variant:`)?
 *
 * Deliberately a superset of `scalarNeedsDoubleQuoting` rather than a second,
 * competing predicate: that one answers "can this open a plain scalar safely",
 * which is necessary but not sufficient for a value that must ROUND-TRIP as the
 * exact string it went in as. Keeping both here is the point — they are two
 * answers to one question and drift the moment they live apart.
 *
 * The extra clauses, each an observed mis-parse rather than a precaution:
 *
 *   - a non-alphanumeric first character. `scalarNeedsDoubleQuoting` rejects the
 *     indicators that cannot OPEN a scalar, but YAML still resolves plenty of
 *     values that open legally: `~` and `.inf`/`.nan` become null and floats,
 *     and a leading sign or dot (`+1`, `-0`, `.5`) becomes a number. Requiring
 *     alphanumeric-first covers that whole family at once, and costs nothing:
 *     every real model ID and effort level starts alphanumeric.
 *   - a trailing `:` — `model: foo:` is read as a nested mapping key and fails
 *     the whole frontmatter with "bad indentation of a mapping entry".
 *   - a boolean/null word — YAML 1.1 readers resolve `no`/`y`/`off`/`null` to
 *     non-strings, so a variant named `no` arrives as `false`.
 *   - a numeric-looking value, including the YAML 1.1 sexagesimal form: `12:30`
 *     resolves to the integer 750, and `:` is legal mid-identifier here.
 *   - a date. `2026-08-25` starts alphanumeric and survives every clause above,
 *     yet YAML resolves it to a Date object rather than a string.
 */
const YAML_WORD_SCALAR_RE = /^(?:y|n|yes|no|true|false|on|off|null)$/i;
const YAML_NUMERIC_RE = /^(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?)$/;
// YAML 1.1 timestamp: a bare ymd, optionally followed by a time part.
const YAML_TIMESTAMP_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ].*)?$/;

function agentScalarNeedsDoubleQuoting(s: string): boolean {
  if (scalarNeedsDoubleQuoting(s)) return true;
  if (!/^[A-Za-z0-9]/.test(s)) return true;
  // A plain scalar ENDS at `: ` or ` #` wherever they appear — the base
  // predicate only inspects the first character, because its question is
  // whether the scalar can legally open. `a: b` makes the line a nested
  // mapping (a parse error at this indent) and `a #b` silently truncates to
  // `a`. Both were found by the round-trip property, not by inspection.
  if (/:\s/.test(s) || /\s#/.test(s)) return true;
  if (s.endsWith(':')) return true;
  if (YAML_WORD_SCALAR_RE.test(s)) return true;
  if (YAML_NUMERIC_RE.test(s)) return true;
  if (YAML_TIMESTAMP_RE.test(s)) return true;
  return false;
}

/**
 * #4053 — Quote a numeric-looking scalar that is not all-digit (`22.10`,
 * `1.0`, `1e3`, `0x1F`) so a spec YAML reader keeps it a string: bare `22.10`
 * reloads as the float 22.1 and collides with `22.1`, a different phase.
 *
 * All-digit strings stay bare as a deliberate, scoped trade-off — not a
 * safety guarantee. A leading-zero value (`02`, `017`) also mis-parses under
 * a spec reader (to 2, 17). It is left unquoted because zero-padded ids
 * (`plan: 01`, `phase: 02`) are the pervasive GSD convention, quoting them
 * all is the blanket quoting #4053 asked to avoid, and the loss is padding
 * rather than identity: `02` and `2` normalize to the same phase; `22.1` and
 * `22.10` do not.
 */
function generalScalarNeedsNumericQuoting(s: string): boolean {
  return YAML_NUMERIC_RE.test(s) && !/^\d+$/.test(s);
}

/**
 * A list item `reconstructFrontmatter` may write inside an inline `[a, b]` list: a string
 * that reads back as itself there. A flow indicator (`,[]{}`), a `: ` or ` #` (a flow
 * mapping pair, a comment) or anything that needs quoting as a plain scalar would split,
 * truncate or re-type the item, so such a list is written in block form instead, where
 * `blockSequenceItem` quotes the item (found while implementing #5105).
 */
function isPlainFlowSequenceItem(item: unknown): boolean {
  return typeof item === 'string' && !/[,[\]{}]|:(?:\s|$)|\s#/.test(item) && !scalarNeedsDoubleQuoting(item);
}

/** One block-sequence item as `reconstructFrontmatter` writes it: quoted whenever bare would misread. */
function blockSequenceItem(item: unknown): string {
  // A null item reads back as '' (see `readBackProjection`), so it is written as one.
  if (item === null || item === undefined) return '""';
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  if (typeof item !== 'string') return String(item);
  return item.includes(':') || item.includes('#') || scalarNeedsDoubleQuoting(item) ? `"${escapeDoubleQuotedScalar(item)}"` : item;
}

/** A nested mapping's scalar value as `reconstructFrontmatter` writes it: quoted whenever bare would misread. */
function nestedScalar(value: unknown): string {
  const sv = String(value);
  return sv.includes(':') || sv.includes('#') || scalarNeedsDoubleQuoting(sv) || generalScalarNeedsNumericQuoting(sv) ? `"${escapeDoubleQuotedScalar(sv)}"` : sv;
}

function reconstructFrontmatter(obj: Frontmatter): string {
  const lines: string[] = [];
  // #3257: read the full-line-comment channel (set by parseGuardedYamlRegion when comments
  // were present). Object.entries skips the Symbol key, so the data loop is unchanged.
  const commentChannel = (obj as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] as FullLineCommentChannel | undefined;
  // A key's leading full-line comments and its inline comment, by exact key path.
  const leadingOf = (segments: string[]): string[] | undefined => commentChannel?.leading[commentPathKey(segments)];
  const inlineOf = (segments: string[]): string => commentChannel?.inline?.[commentPathKey(segments)] ?? '';
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    // #3257: re-emit this key's leading full-line comments before the key itself.
    const leading = leadingOf([key]);
    if (leading) for (const c of leading) lines.push(c);
    const inline = inlineOf([key]);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []${inline}`);
      } else if (value.every(isPlainFlowSequenceItem) && value.length <= 3 && (value).join(', ').length < 60) {
        lines.push(`${key}: [${(value).join(', ')}]${inline}`);
      } else {
        lines.push(`${key}:${inline}`);
        for (const item of value) {
          lines.push(`  - ${blockSequenceItem(item)}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:${inline}`);
      for (const [subkey, subval] of Object.entries(value)) {
        if (subval === null || subval === undefined) continue;
        // #3742: re-emit a nested key's leading full-line comments (channel
        // path `[parent, subkey]`) at the subkey's own indentation.
        const nestedLeading = leadingOf([key, subkey]);
        if (nestedLeading) for (const c of nestedLeading) lines.push(`  ${c.trimStart()}`);
        const subInline = inlineOf([key, subkey]);
        if (Array.isArray(subval)) {
          if (subval.length === 0) {
            lines.push(`  ${subkey}: []${subInline}`);
          } else if (subval.every(isPlainFlowSequenceItem) && subval.length <= 3 && (subval).join(', ').length < 60) {
            lines.push(`  ${subkey}: [${(subval).join(', ')}]${subInline}`);
          } else {
            lines.push(`  ${subkey}:${subInline}`);
            for (const item of subval) {
              lines.push(`    - ${blockSequenceItem(item)}`);
            }
          }
        } else if (typeof subval === 'object') {
          lines.push(`  ${subkey}:${subInline}`);
          for (const [subsubkey, subsubval] of Object.entries(subval as Record<string, unknown>)) {
            if (subsubval === null || subsubval === undefined) continue;
            // #3742: same nested-comment re-emission one level deeper
            // (`[parent, sub, subsub]`).
            const deepLeading = leadingOf([key, subkey, subsubkey]);
            if (deepLeading) for (const c of deepLeading) lines.push(`    ${c.trimStart()}`);
            const deepInline = inlineOf([key, subkey, subsubkey]);
            if (Array.isArray(subsubval)) {
              if (subsubval.length === 0) {
                lines.push(`    ${subsubkey}: []${deepInline}`);
              } else {
                lines.push(`    ${subsubkey}:${deepInline}`);
                for (const item of subsubval) {
                  lines.push(`      - ${blockSequenceItem(item)}`);
                }
              }
            } else {
              lines.push(`    ${subsubkey}: ${nestedScalar(subsubval)}${deepInline}`);
            }
          }
        } else {
          lines.push(`  ${subkey}: ${nestedScalar(subval)}${subInline}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{') || scalarNeedsDoubleQuoting(sv) || generalScalarNeedsNumericQuoting(sv)) {
        lines.push(`${key}: "${escapeDoubleQuotedScalar(sv)}"${inline}`);
      } else {
        lines.push(`${key}: ${sv}${inline}`);
      }
    }
  }
  // #3257: re-emit any trailing full-line comments (those after the last key).
  if (commentChannel?.trailing?.length) {
    for (const c of commentChannel.trailing) lines.push(c);
  }
  return lines.join('\n');
}

/**
 * #3257: copy the full-line-comment channel from `source` onto `target`, filtering
 * `leading` to keys still present in `target` (a deleted key's annotation goes with
 * it — AC5). No-op when `source` carries no channel. Consumers that rebuild their
 * target object fresh (syncStateFrontmatter builds derivedFm via buildStateFrontmatter
 * and copies keys with Object.keys, which skips the Symbol) MUST call this before
 * reconstructFrontmatter, or the channel parseGuardedYamlRegion attached to the extracted
 * source is lost.
 */
function propagateCommentChannel(source: Frontmatter, target: Frontmatter): void {
  const channel = (source as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] as FullLineCommentChannel | undefined;
  if (!channel) return;
  // #3742: two changes, both about a target that is a PARTIAL rebuild.
  //
  // (a) Root-segment membership: a comment keyed by a nested path
  //     (`["progress","total_plans"]`) survives while its root section survives —
  //     requiring the full path to resolve inside `target` would drop every
  //     nested comment the moment the rebuild reconstructed the section
  //     object (a fresh object with the same leaf keys still matches at
  //     EMIT time; membership is about the section existing at all).
  // (b) Merge, not clobber: `target` may already carry its own channel
  //     (extracted from content that kept some comments). Target entries win
  //     for the same key; source entries fill the gaps; trailing lists
  //     concatenate (source first, mirroring document order when the source
  //     is the earlier snapshot).
  const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  // The root is the path's first segment (`commentPathKey`), never text before a `.` — a
  // top-level key named `a.b` is its own root (found while implementing #5105).
  const rootAlive = (k: string): boolean => {
    const root = (JSON.parse(k) as string[])[0];
    return hasOwn(target, root);
  };
  // Null-prototype `leading` (post-#3881-review, finding 3) — same rationale as
  // `extractCommentChannel`. `target` may be a plain `{}` built by a caller outside this
  // module (e.g. `buildStateFrontmatter`), so membership is checked via
  // `hasOwnProperty`, not the `in` operator: `in` walks target's OWN prototype chain too,
  // and a target key named `constructor`/`toString`/etc. would otherwise read as "present"
  // even when it was never actually set.
  const existingChannel = (target as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] as FullLineCommentChannel | undefined;
  // Trailing: when the target already carries a channel, its trailing list is
  // the SAME comments re-parsed from content this lineage already emitted —
  // concatenating would duplicate them on every write (unbounded growth,
  // #3742 review). Take the target's list; only a channel-less target
  // (a fresh rebuild, e.g. buildStateFrontmatter output) inherits the
  // source's trailing comments.
  const merged: FullLineCommentChannel = {
    leading: Object.create(null) as Record<string, string[]>,
    trailing: existingChannel ? existingChannel.trailing : channel.trailing,
  };
  for (const [key, comments] of Object.entries(existingChannel?.leading ?? {})) {
    merged.leading[key] = comments;
  }
  for (const [key, comments] of Object.entries(channel.leading)) {
    if (!hasOwn(merged.leading, key) && rootAlive(key)) merged.leading[key] = comments;
  }
  if (merged.trailing.length || Object.keys(merged.leading).length) {
    (target as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] = merged;
  }
}

/**
 * One top-level key's raw text inside a frontmatter block. `raw` is every line from the
 * column-0 key line up to the next column-0 key line. It splits into `body` (the key line
 * and every line of the value, including column-0 continuation lines) and `tail`: the
 * trailing blank lines and column-0 full-line comments that are not part of the value
 * (typically the comments leading the NEXT key — see `segmentTailStart`). `valueStart` is
 * the offset in the key line where the value text
 * begins (just past the key's `:`).
 */
type FrontmatterSegment = { key: string; valueStart: number; raw: string; body: string[]; tail: string[] };

/** Column-0 quoted key: `"…":` (JSON-style escapes) or `'…':` (`''` escapes a quote). */
const QUOTED_SEGMENT_KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')[ \t]*:/;

/**
 * First character of a plain (unquoted) top-level key. A comment, an indented line, a
 * quote and a YAML indicator (`-`/`?`/`:` followed by whitespace or end of line, or any
 * of `,[]{}&*!|>%@` and backtick) never start one — those lines are never a key line, so
 * a key the parser reads from them (an explicit `? k` key, a flow mapping) has no segment
 * and `spliceFrontmatter` refuses rather than duplicating it.
 */
const PLAIN_KEY_START_RE = /^(?:[^\s#,[\]{}&*!|>'"%@`\-?:]|[-?:](?=[^\s]))/;

/**
 * Where the key of a column-0 line ends, agreeing with the YAML parser: the key is
 * everything before the FIRST `:` followed by whitespace or end of line (so `a:b: 1` is
 * key `a:b` and `http://x: 1` is key `http://x`, exactly as js-yaml reads them). Only when
 * no such colon exists does the no-space `key:value` spelling (`updated:2026-01-01`) fall
 * back to the bare-ASCII key before the first `:`. Returns null for a line that is not a
 * top-level key line.
 *
 * `indent` is the caller's indentation of `line` (0 for the genuinely column-0 callers —
 * `sliceFrontmatterLayout` — which never see a nonzero value since a real indented line
 * already fails `PLAIN_KEY_START_RE` there). `channelKeyLine` (#5105 follow-up) calls this
 * on an INDENT-STRIPPED nested line instead, to read nested keys like `total_phases: 5` —
 * but the no-space bare-ASCII fallback exists only for the top-level `key:value` shorthand a
 * document author actually writes; on a nested continuation line (a URL, a path, or any
 * other value line of a multi-line scalar that happens to contain an ASCII word immediately
 * followed by `:`, e.g. `https://x`) it misreads the line as opening a key. Restricting the
 * fallback to `indent === 0` keeps the top-level shorthand working while a nested line only
 * ever opens a key when the colon is unambiguously followed by whitespace or end of line.
 */
function segmentKeyOf(line: string, indent = 0): { key: string; valueStart: number } | null {
  const q = QUOTED_SEGMENT_KEY_RE.exec(line);
  if (q) {
    const valueStart = q[0].length;
    if (q[1] !== undefined) {
      try { return { key: JSON.parse(`"${q[1]}"`) as string, valueStart }; } catch { return { key: q[1], valueStart }; }
    }
    return { key: q[2].replace(/''/g, "'"), valueStart };
  }
  if (!PLAIN_KEY_START_RE.test(line)) return null;
  const spaced = /:(?:[ \t]|$)/.exec(line);
  if (spaced) return { key: line.slice(0, spaced.index).trimEnd(), valueStart: spaced.index + 1 };
  if (indent > 0) return null;
  const bare = /^([A-Za-z0-9_-]+):/.exec(line);
  return bare ? { key: bare[1], valueStart: bare[0].length } : null;
}


/**
 * A line that can sit after a key's value without belonging to it (see `FrontmatterSegment`):
 * a blank line or a column-0 full-line comment, and nothing else. Every other line after a
 * key line — an indented line, a `- item`, and a column-0 continuation of a multi-line
 * quoted scalar or of a flow collection split across lines (`tags: [a,` / `b]`) — is part of
 * the key's own value and is replaced with it (found while implementing #5105).
 */
function isSegmentTailLine(line: string): boolean {
  return line.trim() === '' || line.startsWith('#');
}

/** Parse one key's lines on their own, or null when they do not parse as YAML. */
function loadSegmentValue(lines: string[]): { value: unknown } | null {
  try {
    return { value: yamlLoad(escapeNullBytesForParse(lines.join('\n')), YAML_LOAD_OPTS) };
  } catch {
    return null;
  }
}

/**
 * Where a key's trailing tail starts. The candidate tail is the trailing run of blank and
 * column-0 `#` lines, but such a line can still be value text: a `#` line inside a
 * multi-line quoted scalar, or a blank line a block scalar keeps. The parser decides — a
 * tail line is only a tail line when the key's lines parse to the same value without it.
 * When the key's lines do not parse on their own, the lexical candidate stands; the
 * read-back check in `spliceFrontmatter` still refuses any block that would misread.
 */
function segmentTailStart(lines: string[]): number {
  let cut = lines.length;
  while (cut > 1 && isSegmentTailLine(lines[cut - 1])) cut--;
  if (cut === lines.length) return cut;
  const whole = loadSegmentValue(lines);
  if (!whole) return cut;
  while (cut < lines.length) {
    const body = loadSegmentValue(lines.slice(0, cut));
    if (body && frontmatterDeepEqual(body.value, whole.value)) return cut;
    cut++;
  }
  return cut;
}

/**
 * Slice a frontmatter YAML body into its `preamble` (lines before the first top-level key,
 * e.g. a leading comment) and per-top-level-key raw text segments. Each segment runs from a
 * column-0 key line through the line before the next column-0 key (or the end), capturing
 * all nested indented content. Used by `spliceFrontmatter` for per-key identity
 * preservation (#1572): a structurally-unchanged key keeps its original raw text, so the
 * lossy `reconstructFrontmatter` never touches object-lists the caller did not modify (e.g.
 * must_haves.artifacts / .prohibitions). Every input line lands in exactly one of
 * `preamble`, a segment `body` or a segment `tail` — nothing is discarded here.
 */
function sliceFrontmatterLayout(yaml: string): { preamble: string[]; segments: FrontmatterSegment[] } {
  const preamble: string[] = [];
  const segments: FrontmatterSegment[] = [];
  let current: { key: string; valueStart: number; lines: string[] } | null = null;
  const close = (seg: { key: string; valueStart: number; lines: string[] }): void => {
    const cut = segmentTailStart(seg.lines);
    segments.push({
      key: seg.key,
      valueStart: seg.valueStart,
      raw: seg.lines.join('\n'),
      body: seg.lines.slice(0, cut),
      tail: seg.lines.slice(cut),
    });
  };
  for (const line of splitLines(yaml)) {
    const key = segmentKeyOf(line);
    if (key) {
      if (current) close(current);
      current = { key: key.key, valueStart: key.valueStart, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) close(current);
  return { preamble, segments };
}

/**
 * Regenerate one frontmatter key's serialization, fail-closed if the lossy
 * `reconstructFrontmatter` cannot represent the value (#1572 codex review). Object-list
 * items (e.g. must_haves.artifacts `{path, provides}` maps) serialize as the literal
 * string "[object Object]"; rather than silently emit that and destroy the data, refuse
 * so the caller (cmdFrontmatterSet/Merge) errors out WITHOUT writing — directing the
 * user to edit the file directly. The reported #1572 case (mutating an UNRELATED field)
 * is unaffected: unchanged keys preserve their original raw text and never reach here.
 */
function regenerateFrontmatterKey(key: string, value: FrontmatterValue, comments?: FullLineCommentChannel): string {
  // Computed key: a key named `__proto__` is an own data property here, never the prototype.
  const single: Frontmatter = { [key]: value };
  // `comments` are the comments written inside this key's own value lines, keyed by exact
  // key path (`segmentComments`), so `reconstructFrontmatter` re-emits each beside the key it
  // belongs to. The key's own leading comment and the block's trailing comments are not part
  // of the value: they sit in the splice's preamble or a neighbour's tail, which is re-emitted
  // verbatim.
  if (comments) (single as Record<symbol, unknown>)[FULL_LINE_COMMENTS as unknown as symbol] = comments;
  const rendered = reconstructFrontmatter(single);
  if (/\[object Object\]/.test(rendered)) {
    throw new Error(
      `frontmatter: cannot faithfully serialize key "${key}" — it contains a nested object-list ` +
        `(e.g. must_haves.artifacts) the frontmatter writer cannot represent, and serializing it would ` +
        `emit "[object Object]". Edit the file directly instead of using frontmatter set/merge.`,
    );
  }
  // `reconstructFrontmatter` emits keys bare. A key the parser would not read back as
  // itself when bare (`a:b`, `a: b`, `#x`, `- k`, a trailing space) is emitted double-quoted
  // instead, so a regenerated or appended key never re-parses as a different key.
  if (rendered.startsWith(`${key}:`) && !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(key)) {
    return `"${escapeDoubleQuotedScalar(key)}"` + rendered.slice(key.length);
  }
  return rendered;
}

/**
 * Why `spliceFrontmatter` refused to write. `FRONTMATTER_UNPARSEABLE`: the existing block
 * is not parseable YAML (or not a mapping), so a regenerated block would either discard
 * the author's unparsed keys or leave them in a block no reader can see (#4802). The same
 * decision every write-path caller surfaces — there is one owner of it, here.
 * `FRONTMATTER_KEYS_UNRECONCILABLE`: the block parses, but its top-level key lines cannot
 * be matched one-to-one to the parsed keys (a duplicate key, an explicit `? k` key, a
 * flow-mapping block, a quoted key with a YAML-only escape), so a per-key splice could
 * duplicate or drop a key. `FRONTMATTER_SPLICE_VERIFY_FAILED`: the block the writer built
 * does not read back as the intended object (a value or nested key the serializer cannot
 * represent), so writing it would store something other than what the caller asked for.
 * `FRONTMATTER_COMMENT_WOULD_BE_LOST`: a changed key's value holds a comment — full-line or
 * inline — the regenerated value cannot carry (the key it belongs to was removed or is no
 * longer a key, the comment sits on or between list items or trails the value), so writing
 * would silently drop text the author wrote (#3257/#3742 treat those comments as preserved
 * data).
 */
type FrontmatterWriteRefusalCode =
  | 'FRONTMATTER_UNPARSEABLE'
  | 'FRONTMATTER_KEYS_UNRECONCILABLE'
  | 'FRONTMATTER_SPLICE_VERIFY_FAILED'
  | 'FRONTMATTER_COMMENT_WOULD_BE_LOST';

class FrontmatterWriteRefusedError extends Error {
  readonly code: FrontmatterWriteRefusalCode;
  constructor(code: FrontmatterWriteRefusalCode, message: string) {
    super(message);
    this.name = 'FrontmatterWriteRefusedError';
    this.code = code;
  }
}

function isFrontmatterWriteRefusal(err: unknown): err is FrontmatterWriteRefusedError {
  return err instanceof FrontmatterWriteRefusedError;
}

/** Does a closed frontmatter block's parse mean "unparseable" for a writer? */
function frontmatterBlockUnparseable(parsed: Frontmatter, innerYaml: string): boolean {
  if ((parsed as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true) return true;
  if (Object.keys(parsed).length > 0) return false;
  // `{}` from a block that still carries content: a bare scalar (`status:complete`) or a
  // sequence at the top level. Only blank lines and comments make a genuinely empty block.
  return splitLines(innerYaml).some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/**
 * What `extractFrontmatter` reads back for `value` once the writer has written it: every
 * scalar is a string under `FAILSAFE_SCHEMA` (`2` → `'2'`, `true` → `'true'`), a
 * null/undefined mapping entry is not written at all (`undefined` here), and a
 * null/undefined list item reads back as `''`. The intended object a write must read back as.
 */
function readBackProjection(value: unknown, inArray = false): unknown {
  if (value === null || value === undefined) return inArray ? '' : undefined;
  if (Array.isArray(value)) return value.map((item) => readBackProjection(item, true));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const projected = readBackProjection(v);
      // `defineProperty`, never `out[k] =`: a key named `__proto__` stays an own data property.
      if (projected !== undefined) Object.defineProperty(out, k, { value: projected, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

/**
 * The write post-condition every splice path ends with: the document about to be returned
 * must carry a frontmatter block that parses — through `extractFrontmatter` itself, the same
 * reader every consumer uses — to exactly the intended object. Anything the serializer cannot
 * represent faithfully (a nested key with `: ` in it, a value that re-types) is refused here,
 * so no caller can write a block that does not read back as intended (found while
 * implementing #5105).
 */
function verifyReadsBackAs(out: string, newObj: Frontmatter): string {
  const reread = extractFrontmatter(out);
  if (
    (reread as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true ||
    !frontmatterDeepEqual(reread, readBackProjection(newObj))
  ) {
    throw new FrontmatterWriteRefusedError(
      'FRONTMATTER_SPLICE_VERIFY_FAILED',
      'frontmatter: refusing to write — the rewritten frontmatter block would not read back as the ' +
        'requested values (a value or nested key the frontmatter writer cannot represent faithfully), so ' +
        'writing it would store something other than what was asked. Edit the file directly.',
    );
  }
  return out;
}

/**
 * Is `lines[i]` a full-line comment the parser ignores — do the key's lines parse to the
 * same value without it? A `#` line inside a block scalar or a multi-line quoted scalar is
 * value text, not a comment. When the lines do not parse on their own (`whole` null) every
 * `#` line counts, so the comment post-condition fails closed.
 */
function isSegmentComment(lines: string[], i: number, whole: { value: unknown } | null): boolean {
  if (!/^\s*#/.test(lines[i])) return false;
  if (!whole) return true;
  const without = loadSegmentValue([...lines.slice(0, i), ...lines.slice(i + 1)]);
  return without !== null && frontmatterDeepEqual(without.value, whole.value);
}

/**
 * Where the inline comment on `lines[i]` starts (the whitespace before its `#`), or -1. A
 * ` #` is a comment only when the key's lines parse to the same value with the line cut
 * there, so a `#` inside a quoted scalar or a block scalar never counts. When the lines do
 * not parse on their own (`whole` null) the first ` #` counts.
 */
function inlineCommentStart(lines: string[], i: number, whole: { value: unknown } | null): number {
  const line = lines[i];
  const hashes = /[ \t]#/g;
  for (let m = hashes.exec(line); m !== null; m = hashes.exec(line)) {
    let start = m.index;
    while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--;
    if (!whole) return start;
    const cut = loadSegmentValue([...lines.slice(0, i), line.slice(0, start), ...lines.slice(i + 1)]);
    if (cut !== null && frontmatterDeepEqual(cut.value, whole.value)) return start;
  }
  return -1;
}

/**
 * The comments inside one top-level key's value lines (`lines`, key line first), by the key
 * path they belong to — the same attachment `extractCommentChannel` uses: a full-line
 * comment leads the key line that follows it at the same indentation, and an inline comment
 * belongs to the key on its own line. `channel` is what `reconstructFrontmatter` re-emits
 * when this key is regenerated; `unattached` is every comment with no key to belong to (on
 * or between list items, misindented, after the last line of the value), trimmed.
 */
type SegmentComments = { channel: FullLineCommentChannel & { inline: Record<string, string> }; unattached: string[] };

function segmentComments(key: string, lines: string[]): SegmentComments {
  const whole = loadSegmentValue(lines);
  const leading = Object.create(null) as Record<string, string[]>;
  const inline = Object.create(null) as Record<string, string>;
  const unattached: string[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let pending: Array<{ indent: number; line: string }> = [];
  const loosen = (comments: Array<{ line: string }>): void => { for (const c of comments) unattached.push(c.line.trim()); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && line.trim() === '') continue;
    if (i > 0 && isSegmentComment(lines, i, whole)) {
      pending.push({ indent: /^\s*/.exec(line)?.[0].length ?? 0, line });
      continue;
    }
    const at = inlineCommentStart(lines, i, whole);
    let owner: string[] | null = i === 0 ? [key] : null;
    if (i > 0) {
      const k = channelKeyLine(at === -1 ? line : line.slice(0, at));
      if (k && k.indent > 0 && k.key.length > 0) {
        while (stack.length > 0 && stack[stack.length - 1].indent >= k.indent) stack.pop();
        owner = [key, ...stack.map((e) => e.key), k.key];
        const same = pending.filter((c) => c.indent === k.indent);
        if (same.length > 0) leading[commentPathKey(owner)] = same.map((c) => c.line);
        loosen(pending.filter((c) => c.indent !== k.indent));
        stack.push({ indent: k.indent, key: k.key });
      } else {
        loosen(pending);
      }
      pending = [];
    }
    if (at !== -1) {
      // A ` #` on lines that do not parse on their own may be value text: never re-emit it.
      if (owner && whole) inline[commentPathKey(owner)] = line.slice(at);
      else unattached.push(line.slice(at).trim());
    }
  }
  loosen(pending);
  return { channel: { leading, trailing: [], inline }, unattached };
}

/**
 * The comment post-condition of regenerating a changed key: every comment its original value
 * lines held — full-line or inline — appears in the regenerated text beside the SAME key path
 * (compared trimmed — `reconstructFrontmatter` re-indents a nested comment to its key's
 * depth). Compared per exact path, never as a global count, so a comment dropped in one place
 * can never be balanced by an identical one elsewhere. A comment that could not be re-attached
 * is refused, never silently dropped (found while implementing #5105).
 */
function assertCommentsKept(key: string, original: SegmentComments, regenerated: string): void {
  const placed = (c: SegmentComments): Map<string, number> => {
    const counts = new Map<string, number>();
    const add = (entry: string): void => { counts.set(entry, (counts.get(entry) ?? 0) + 1); };
    for (const [path, lines] of Object.entries(c.channel.leading)) for (const l of lines) add(JSON.stringify(['above', path, l.trim()]));
    for (const [path, text] of Object.entries(c.channel.inline)) add(JSON.stringify(['beside', path, text.trim()]));
    for (const text of c.unattached) add(JSON.stringify(['loose', '', text]));
    return counts;
  };
  const before = placed(original);
  const after = placed(segmentComments(key, splitLines(regenerated)));
  const differs = (entry: string): boolean => (before.get(entry) ?? 0) !== (after.get(entry) ?? 0);
  const lost = [...before.keys()].filter(differs);
  if (lost.length === 0 && ![...after.keys()].some(differs)) return;
  const describe = (entry: string): string => {
    const [where, path, text] = JSON.parse(entry) as [string, string, string];
    const keyPath = path === '' ? '' : (JSON.parse(path) as string[]).map((s) => JSON.stringify(s)).join(' › ');
    return where === 'loose' ? `${JSON.stringify(text)} (not beside any key)` : `${JSON.stringify(text)} ${where} ${keyPath}`;
  };
  throw new FrontmatterWriteRefusedError(
    'FRONTMATTER_COMMENT_WOULD_BE_LOST',
    `frontmatter: refusing to write — the new value of "${key}" cannot keep the comment(s) written ` +
      `inside it (${(lost.length > 0 ? lost : [...after.keys()].filter(differs)).map(describe).join(', ')}): a ` +
      'comment above or beside a key the new value removes or no longer holds as a key, on or between list ' +
      'items, or after the last line of the value has nowhere to go. Edit the file directly.',
  );
}

function spliceFrontmatter(content: string, newObj: Frontmatter): string {
  // The block is located through `frontmatterBlock` (composing `frontmatterRegion`), so the
  // writer and every reader agree on where it is: BOM (#2977), CRLF, an empty block.
  const located = frontmatterBlock(content);
  if (located) {
    const { bom, block: fmBlock, rest } = located;
    const fmLines = splitLines(fmBlock);
    const inner = fmLines.slice(1, -1).join('\n'); // drop the opening `---` and closing `---`
    let originalParsed: Frontmatter;
    try { originalParsed = extractFrontmatter(fmBlock); } catch { originalParsed = unparseableResult(); }

    // Fail closed on an unparseable block BEFORE anything else — never regenerate over it.
    if (frontmatterBlockUnparseable(originalParsed, inner)) {
      throw new FrontmatterWriteRefusedError(
        'FRONTMATTER_UNPARSEABLE',
        'frontmatter: refusing to write — the existing frontmatter block is not parseable YAML, so ' +
          'rewriting it would discard or hide the fields the author wrote. Fix the YAML syntax error in ' +
          'the frontmatter block first, then re-run.',
      );
    }

    // Whole-document no-op guard: a true no-op returns content verbatim (byte-exact,
    // including any formatting the lossy serializer would normalize). Compared on what the
    // new values read back as, so `wave: 2` (a number) over `wave: 2` (text) is a no-op.
    if (frontmatterDeepEqual(originalParsed, readBackProjection(newObj))) {
      return content;
    }

    // Per-key identity preservation (#1572). `reconstructFrontmatter` is a deliberately
    // lossy serializer — it cannot faithfully re-emit nested object-list items (e.g.
    // must_haves.artifacts / .prohibitions, whose items are `{ path, provides }` /
    // `{ statement, status }` maps; `extractFrontmatter` flattens those to scalar
    // strings, so a round-trip drops `provides:` and collapses the list to a malformed
    // inline array). For any top-level key whose value is STRUCTURALLY UNCHANGED between
    // the original parse and `newObj`, preserve that key's ORIGINAL raw text verbatim;
    // regenerate only keys that actually changed. This generalizes the whole-document
    // no-op guard above to per-key fidelity, so mutating `wave` no longer destroys an
    // unrelated `must_haves` block. Keys absent from the original (genuinely new) are
    // regenerated and appended; keys absent from `newObj` are preserved (never silently
    // deleted by a set/merge).
    //
    // A write never silently drops a line it did not parse: the preamble (e.g. a comment
    // above the first key) and every segment's tail (blank lines, full-line comments) are
    // re-emitted in place whatever happens to the key they sit next to.
    const { preamble, segments } = sliceFrontmatterLayout(inner);
    const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

    // Every parsed key must own exactly one key line, and every key line must be a parsed
    // key — otherwise a per-key splice could emit a key twice or lose one. Refuse instead.
    const parsedKeys = Object.keys(originalParsed);
    const segmentKeys = segments.map((s) => s.key);
    if (
      new Set(segmentKeys).size !== segmentKeys.length ||
      segmentKeys.length !== parsedKeys.length ||
      !segmentKeys.every((k) => hasOwn(originalParsed, k))
    ) {
      throw new FrontmatterWriteRefusedError(
        'FRONTMATTER_KEYS_UNRECONCILABLE',
        'frontmatter: refusing to write — the frontmatter block\'s top-level key lines cannot be matched ' +
          'one-to-one to its parsed keys (a duplicate key, an explicit "? key", a flow mapping, or a quoted ' +
          'key using a YAML-only escape), so rewriting it could duplicate or drop a key. Edit the file directly.',
      );
    }

    const emitted: string[] = [...preamble];
    const seen: Set<string> = new Set();

    for (const seg of segments) {
      seen.add(seg.key);
      if (hasOwn(newObj, seg.key)) {
        // Key is in newObj: preserve original raw text if structurally unchanged,
        // otherwise regenerate. The key SET is defined by newObj — keys that were in
        // the original but are absent from newObj are intentionally dropped (the real
        // cmdSet/cmdMerge flow always passes the full merged object, so this only
        // matters for direct unit callers and matches spliceFrontmatter's contract:
        // the result frontmatter IS newObj).
        if (frontmatterDeepEqual(readBackProjection(newObj[seg.key]), originalParsed[seg.key])) {
          emitted.push(seg.raw); // unchanged → preserve original raw text verbatim
        } else {
          // changed → regenerate (fail-closed on object-lists), keeping the tail. A value
          // that is not written at all (null) regenerates to '' — no line, only the tail:
          // the key is deleted, and the comments inside its value go with it (#3257 AC5).
          // Otherwise every comment inside the value — full-line or inline — is re-emitted
          // beside the key it belongs to or the write is refused.
          const comments = segmentComments(seg.key, seg.body);
          const regenerated = regenerateFrontmatterKey(seg.key, newObj[seg.key], comments.channel);
          if (regenerated !== '') assertCommentsKept(seg.key, comments, regenerated);
          emitted.push(...(regenerated === '' ? [] : [regenerated]), ...seg.tail);
        }
      } else {
        // Parsed key absent from newObj → drop its body; its tail is not its value.
        emitted.push(...seg.tail);
      }
    }
    // Append genuinely-new keys not present in the original frontmatter.
    for (const k of Object.keys(newObj)) {
      if (!seen.has(k)) {
        const regenerated = regenerateFrontmatterKey(k, newObj[k]);
        if (regenerated !== '') emitted.push(regenerated);
      }
    }

    // Re-emit the whole block with the document's own line ending (taken from the opening
    // fence), so a CRLF document never gains LF-only lines.
    const eol = fmBlock.startsWith('---\r\n') ? '\r\n' : '\n';
    const block = ['---', ...emitted, '---'].join('\n').split('\n').join(eol);
    return bom + verifyReadsBackAs(block + rest, newObj);
  }
  // No existing frontmatter — generate from scratch, fail-closed on unrepresentable values.
  if (/\[object Object\]/.test(reconstructFrontmatter(newObj))) {
    throw new Error(
      'frontmatter: cannot faithfully serialize the requested frontmatter — it contains a nested ' +
        'object-list (e.g. must_haves.artifacts) the writer cannot represent. Edit the file directly.',
    );
  }
  // Key by key through `regenerateFrontmatterKey`, so a key the parser would misread bare
  // (`a: b`, `#x`, one holding a line break) is quoted exactly as on the existing-block path.
  const keyLines = Object.keys(newObj)
    .map((k) => regenerateFrontmatterKey(k, newObj[k]))
    .filter((line) => line !== '');
  // #2977: a leading BOM stays the document's first character, ahead of the new fence.
  const bom = content.charCodeAt(0) === 0xFEFF ? content.slice(0, 1) : '';
  return bom + verifyReadsBackAs(`---\n${keyLines.join('\n')}\n---\n\n` + content.slice(bom.length), newObj);
}

/**
 * Structural deep-equality for two parsed frontmatter objects. Order-sensitive for arrays
 * (YAML lists are ordered), key-order-insensitive for objects. Used only by `spliceFrontmatter`
 * to recognize a no-op write-back; intentionally narrow (handles the string / string[] /
 * nested-object shapes `extractFrontmatter` produces).
 */
function frontmatterDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => frontmatterDeepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao: Record<string, unknown> = a as Record<string, unknown>;
    const bo: Record<string, unknown> = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(bo, k) && frontmatterDeepEqual(ao[k], bo[k]),
    );
  }
  return false;
}

/**
 * ADR-3473 §8.1 (#3881): the legacy `- key: value` same-line-with-dash capture never trimmed
 * or number-coerced its value (`current[kvMatch[1]] = kvMatch[2]` verbatim), while every
 * CONTINUATION line (a further-indented sibling key under the same list item) both trimmed
 * (`kvMatch[2].trim()` — #1905/#1154, a quoted `"backstop "` must not silently stop matching
 * the literal `backstop` marker) and number-coerced (`/^\d+$/.test(val) ? parseInt(val, 10) :
 * val`). That distinction was purely a byproduct of the hand-rolled line scanner's own
 * position tracking — real YAML has no such notion; `path: x` on the dash's own line and
 * `count: 1` one line below it are the same kind of mapping entry. `tests/frontmatter.test.cjs`
 * ("trims a continuation-KV value…") pins the trimming behavior, so it is reproduced here by
 * treating an object item's FIRST own key (source order, matching the dash line) as untouched
 * and every subsequent key as "continuation": trimmed, and coerced to a number when (after
 * trimming) it is all-digits — the exact `/^\d+$/` shape the legacy scanner recognized, never a
 * broader YAML-native numeric resolution (which would also promote floats/octal/booleans the
 * legacy scanner left as strings).
 */
function coerceMustHavesValue(value: unknown, isContinuation: boolean): unknown {
  if (typeof value !== 'string') return value; // arrays/nested maps pass through untouched
  if (!isContinuation) return value;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : trimmed;
}

/** Normalize one must_haves list item to the legacy contract: a plain scalar item stays a
 * string; an object item gets `coerceMustHavesValue`'s same-line/continuation treatment
 * (see that function's docblock).
 */
function normalizeMustHavesItem(item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
  const out: Record<string, unknown> = {};
  Object.entries(item as Record<string, unknown>).forEach(([k, v], idx) => {
    out[k] = coerceMustHavesValue(v, idx > 0);
  });
  return out;
}

/**
 * Extract a specific block from `must_haves` in frontmatter YAML (e.g. `must_haves.truths`,
 * `must_haves.artifacts`, `must_haves.key_links`) — via the same vendored js-yaml parser the
 * rest of this module uses (ADR-3473 §8.1 / #3881), rather than the hand-rolled indentation
 * scanner this replaces.
 *
 * Deliberately NOT routed through `parseGuardedYamlRegion`: that function flattens an
 * object-shaped list ITEM to a single canonical string (consequence 3), which is the correct
 * contract for the top-level Frontmatter value shape but would collapse `must_haves.artifacts`'s
 * `{path, provides, ...}` items into unusable strings. This parses the region independently,
 * under the same `FAILSAFE_SCHEMA` + `json: true` options (every scalar a string, duplicate
 * keys last-wins) and the same anchor/alias/merge-key refusal (`refuseAnchorsAndAliases`) —
 * `.planning/` must_haves blocks are untrusted input exactly like the rest of frontmatter.
 */
function parseMustHavesBlock(content: string, blockName: string): unknown[] {
  // Located through the one fence owner, so a BOM document's must_haves are read like an
  // LF or CRLF one's (found while implementing #5105).
  const found = frontmatterRegion(content);
  if (!found || !found.terminated) return [];
  const yaml = found.region;

  let parsed: unknown;
  try {
    refuseAnchorsAndAliases(yaml);
    parsed = yamlLoad(yaml, YAML_LOAD_OPTS);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const mustHaves = (parsed as Record<string, unknown>).must_haves;
  if (!mustHaves || typeof mustHaves !== 'object' || Array.isArray(mustHaves)) return [];

  const block = (mustHaves as Record<string, unknown>)[blockName];
  if (!Array.isArray(block)) {
    // Warn when the block exists but isn't a usable list — likely a YAML formatting issue.
    // This is a critical diagnostic: empty must_haves causes verification to silently degrade
    // to Option C (LLM-derived truths) instead of checking documented contracts.
    if (block !== undefined && block !== null) {
      process.stderr.write(
        `[gsd-tools] WARNING: must_haves.${blockName} block has content but parsed 0 items. ` +
        `Possible YAML formatting issue — verification will fall back to LLM-derived truths.\n`
      );
    }
    return [];
  }

  return block.map(normalizeMustHavesItem);
}

// ─── Frontmatter CRUD commands ────────────────────────────────────────────────

// Shared base for 'plan' and 'plan-gap-closure' below — a plain array reference (not
// FRONTMATTER_SCHEMAS.plan.required) because the object literal that defines
// FRONTMATTER_SCHEMAS cannot refer to itself mid-initialization (TDZ).
const PLAN_REQUIRED_FIELDS = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];

// `requiredValues` is optional per schema: when a field name is a key here, the
// field must be PRESENT AND strictly equal (===) to the given value to satisfy
// the schema — presence alone is not enough. Every other required field (no
// entry in requiredValues) keeps the original presence-only contract.
const FRONTMATTER_SCHEMAS: Record<string, { required: string[]; requiredValues?: Record<string, FrontmatterValue> }> = {
  plan: { required: PLAN_REQUIRED_FIELDS },
  // #2847: gap-closure plans carry every 'plan' field PLUS gap_closure — the flag
  // execute-phase --gaps-only filters on. A separate schema (not a change to
  // 'plan') so standard/reviews-mode plans stay unaffected: they validate against
  // 'plan' and are never required to declare or be checked for gap_closure.
  // Derived from PLAN_REQUIRED_FIELDS (never hand-duplicated) so the two can't drift.
  //
  // requiredValues.gap_closure = true (not just presence): --gaps-only filters
  // strictly on gap_closure === true (execute-phase.md, partial-wave.md), so a
  // plan carrying `gap_closure: false` would pass a presence-only check and
  // still be silently skipped at execute time — the exact symptom #2847
  // reports, one value away. Presence-only was flagged in review as a live
  // reproduction of the bug this schema exists to close.
  'plan-gap-closure': {
    required: [...PLAN_REQUIRED_FIELDS, 'gap_closure'],
    // extractFrontmatter parses every scalar as a string (FrontmatterValue has
    // no boolean member — `gap_closure: true` in YAML becomes the JS string
    // "true", not the boolean true), so the required value is the string here.
    requiredValues: { gap_closure: 'true' },
  },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

/**
 * Strip frontmatter blocks from the start of `content`.
 *
 * Handles CRLF line endings and, by default, multiple stacked blocks
 * (corruption recovery): greedily strips consecutive `---...---` blocks
 * separated by optional whitespace, so a doubled/tripled frontmatter header
 * (e.g. from a botched merge) is fully removed, not just the first block.
 *
 * Pass `{ once: true }` to stop after the first block. Callers whose input is
 * an arbitrary user-authored document — rather than a GSD artefact with a
 * known doubling failure mode — need this: a body that opens with a
 * thematic-break-delimited section is lexically indistinguishable from a
 * second frontmatter block, and the greedy loop deletes it silently (#2703).
 *
 * Canonical home for this primitive (#2143 audit dedup): previously
 * duplicated byte-identically in both `state.cts` and `state-transition.cts`.
 *
 * Each block is the one `locateFrontmatterFence` finds — the same block every reader and
 * writer sees — and the whitespace after its closing fence goes with it. Found while
 * implementing #5105: the previous regex needed a line ending before the closing `---` that
 * the opening fence's own line ending could not supply, so it could not see an adjacent empty
 * block (`---\n---\n`) and stripped through the first `---` in the BODY instead; it also
 * closed on any line merely starting with `---` and skipped whitespace before the opening
 * fence, neither of which any reader of the block agreed with.
 */
function stripFrontmatter(content: string, opts: { once?: boolean } = {}): string {
  let result = content;
  for (;;) {
    const fence = locateFrontmatterFence(result);
    if (!fence || !fence.closed) break;
    result = result.slice(fence.closingFenceEnd).replace(/^\s*/, '');
    if (opts.once) break;
  }
  return result;
}

function cmdFrontmatterGet(cwd: string, filePath: string, field: string | undefined, raw: boolean): void {
  if (!filePath) { error('file path required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  // #4806: an unparseable frontmatter block is a distinct outcome — the file
  // HAS a frontmatter block but its YAML failed to parse. Reporting
  // "Field not found" tells the caller the key is absent, which is
  // indistinguishable from a file that genuinely lacks it.
  if ((fm as unknown as Record<symbol, unknown>)[FRONTMATTER_UNPARSEABLE] === true) {
    output({ error: 'Frontmatter is not parseable YAML — fix the syntax error in the frontmatter block', path: filePath }, raw, undefined);
    return;
  }
  if (field) {
    const value = fm[field];
    if (value === undefined) { output({ error: 'Field not found', field }, raw, undefined); return; }
    output({ [field]: value }, raw, JSON.stringify(value));
  } else {
    output(fm, raw, undefined);
  }
}

/**
 * A field name is one line of a YAML key: a line break, NUL or other control character in it
 * is never an intended key name. The one check `frontmatter set` and `frontmatter merge`
 * share (found while implementing #5105).
 */
function rejectControlCharacterFieldName(field: string): void {
  if (/[\u0000-\u001f\u007f]/.test(field)) {
    error('field name contains a control character (a line break, tab, NUL or other C0/DEL character) — use a plain key name');
  }
}

/**
 * Write one field as an own data property. `fm[field] =` and `Object.assign` treat a field
 * named `__proto__` as the prototype setter, so the key was never written while the command
 * reported success (found while implementing #5105).
 */
function setOwnField(fm: Frontmatter, field: string, value: FrontmatterValue): void {
  Object.defineProperty(fm, field, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * `spliceFrontmatter` for the set/merge commands: a write refusal (`FrontmatterWriteRefusedError`
 * — unparseable block, unreconcilable keys, a block that would not read back, a comment that
 * would be lost) is reported as `{ error, code, path }` and nothing is written — the same
 * shape `cmdFrontmatterGet` uses for an unparseable block. Returns null when refused; any
 * other error propagates as before.
 */
function spliceOrReportRefusal(content: string, fm: Frontmatter, filePath: string, raw: boolean): string | null {
  try {
    return spliceFrontmatter(content, fm);
  } catch (err) {
    if (!isFrontmatterWriteRefusal(err)) throw err;
    output({ error: err.message, code: err.code, path: filePath }, raw, undefined);
    return null;
  }
}

function cmdFrontmatterSet(cwd: string, filePath: string, field: string | undefined, value: string | undefined, raw: boolean): void {
  if (!filePath || !field || value === undefined) { error('file, field, and value required'); }
  // Path traversal guard: reject null bytes
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  rejectControlCharacterFieldName(field as string);
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(value as string); } catch { parsedValue = value; }
  // #1660 (broadened): a lossy object-list field being genuinely CHANGED must fail closed
  // before it is regenerated, not just when the regenerated result happens to be byte-identical
  // to the original (see objectListFieldWouldLoseData's docblock).
  const lossyErr = objectListFieldWouldLoseData(content, field as string, parsedValue);
  if (lossyErr) {
    output({ error: lossyErr, field }, raw, undefined);
    return;
  }
  setOwnField(fm, field as string, parsedValue as FrontmatterValue);
  const newContent = spliceOrReportRefusal(content, fm, filePath, raw);
  if (newContent === null) return;
  // #1660: a no-op set (newContent unchanged) with a dict-valued field means the lossy
  // frontmatter parser made the new value's projection equal the original's — the change
  // did not apply (bites object-list fields like must_haves). Detection lives in the pure
  // exported helper noOpObjectListSetError so the mutation gate (property/unit set) covers
  // it — the cmd path itself is not in that set.
  const noOpErr = noOpObjectListSetError(content, newContent, parsedValue);
  if (noOpErr) {
    output({ error: noOpErr, field }, raw, undefined);
    return;
  }
  platformWriteSync(fullPath, newContent);
  output({ updated: true, field, value: parsedValue }, raw, 'true');
}

/**
 * #1660: detect a frontmatter `set` that would be a silent no-op on a dict-valued field.
 * Returns an error message when the splice produced no content change but the new value
 * is a dict (object-list fields like must_haves, whose `{path, provides}` items flatten to
 * scalar strings under extractFrontmatter so a replacement can deep-equal the original's
 * projection), else null. Scalars and scalar arrays round-trip faithfully, so idempotent
 * sets of those are intentionally NOT flagged. Pure and unit-tested directly (the cmd path
 * is not in Stryker's property/unit set, so the detection must be testable in isolation).
 */
function noOpObjectListSetError(originalContent: string, newContent: string, parsedValue: unknown): string | null {
  if (newContent !== originalContent) return null;
  if (parsedValue === null || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) return null;
  return 'frontmatter set had no effect — the supplied value is equivalent to the existing field under the frontmatter parser, which cannot faithfully round-trip object-list fields like must_haves. Edit the file directly.';
}

/**
 * #1660 (broadened, ADR-3473 §8.1 / #3881): `noOpObjectListSetError` only catches the
 * BYTE-IDENTICAL no-op case. Under the js-yaml migration, `flattenObjectListItem` correctly
 * joins EVERY sub-key of an object-list item (`path: X, provides: Y`) instead of the legacy
 * hand-rolled scanner's accidental behavior of silently discarding every field but the one on
 * the dash line itself. That fixes a real data-loss bug on READ, but it also means a `set` that
 * replaces such a field with a plainly-flattened string (e.g. `{artifacts: ["path: X"]}`,
 * omitting `provides`) is no longer byte-identical to the original — so it no longer trips the
 * no-op guard, sails through `regenerateFrontmatterKey` (which only refuses when the NEW value
 * itself contains a live JS object), and silently writes a version with `provides` gone.
 *
 * A field is lossy exactly when the parse a caller sees FLATTENED it: its verbatim YAML value
 * (`rawFrontmatterField`) holds a list item that is itself a mapping or a list, which
 * `extractFrontmatter` hands back as one display string, so any replacement a caller builds
 * from that view silently drops the item's structure. When that is true AND the caller is
 * genuinely changing the field (not merely re-supplying an equal value), the set is refused —
 * matching `regenerateFrontmatterKey`'s own fail-closed philosophy for the mirror-image case
 * (new value carries a nested object outright).
 *
 * Found while implementing #5105: this used to compare the field's regenerated text against
 * its source text, which refused every field merely written in another style — a quoted
 * scalar (`title: 'x'`), a trailing comment, a block list, a multi-line value — although the
 * parse had lost nothing. What the caller replaces is its own business; only data the caller
 * could not see is protected here, and whether the NEW value reads back is `spliceFrontmatter`'s
 * read-back check.
 */
function holdsFlattenedListItem(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => (item !== null && typeof item === 'object') || holdsFlattenedListItem(item));
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(holdsFlattenedListItem);
  return false;
}

/** See `holdsFlattenedListItem`: the #1660 lossy object-list refusal for one changed field. */
function objectListFieldWouldLoseData(content: string, field: string, newValue: unknown): string | null {
  // A NEW value that itself carries a live nested object (rather than an already-flattened
  // string) is the mirror-image case `regenerateFrontmatterKey` already refuses on its own
  // (the "[object Object]" guard, via spliceFrontmatter) — leave that path's existing throw
  // behavior alone rather than intercepting it here with a different (non-throwing) contract.
  try { regenerateFrontmatterKey(field, newValue as FrontmatterValue); } catch { return null; }

  let originalParsed: Frontmatter;
  try { originalParsed = extractFrontmatter(content); } catch { return null; }
  if (!Object.prototype.hasOwnProperty.call(originalParsed, field)) return null;
  if (frontmatterDeepEqual(readBackProjection(newValue), originalParsed[field])) return null;

  // The verbatim value is read through the one fence owner (`frontmatterRegion`), so a BOM
  // document is refused exactly like an LF or CRLF one, and any key spelling (bare, quoted,
  // Unicode) is found by its parsed key (found while implementing #5105).
  const original = rawFrontmatterField(content, field);
  if (!original || !holdsFlattenedListItem(original.value)) return null;

  return `frontmatter set refused — the existing "${field}" field cannot be faithfully round-tripped by ` +
    `the frontmatter writer (its structure would be flattened and data, such as a nested object-list ` +
    `field, silently dropped). Edit the file directly instead of using frontmatter set/merge.`;
}

function cmdFrontmatterMerge(cwd: string, filePath: string, data: string | undefined, raw: boolean): void {
  if (!filePath || !data) { error('file and data required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  let mergeData: Record<string, FrontmatterValue>;
  try { mergeData = JSON.parse(data as string) as Record<string, FrontmatterValue>; } catch { error('Invalid JSON for --data'); return; }
  // Only a JSON object names fields: an array or a string would spread into index-named
  // keys (`0: q`) and `null` crashed (found while implementing #5105).
  if (mergeData === null || typeof mergeData !== 'object' || Array.isArray(mergeData)) {
    error('--data must be a JSON object of field names to values');
    return;
  }
  for (const key of Object.keys(mergeData)) rejectControlCharacterFieldName(key);
  // #1660 parity with `cmdFrontmatterSet`: a merged key that would flatten a lossy object-list
  // field is refused before anything is written, reported in set's `{ error, field }` shape
  // (found while implementing #5105).
  for (const [key, value] of Object.entries(mergeData)) {
    const lossyErr = objectListFieldWouldLoseData(content, key, value);
    if (lossyErr) {
      output({ error: lossyErr, field: key }, raw, undefined);
      return;
    }
  }
  for (const [key, value] of Object.entries(mergeData)) setOwnField(fm, key, value);
  const newContent = spliceOrReportRefusal(content, fm, filePath, raw);
  if (newContent === null) return;
  platformWriteSync(fullPath, newContent);
  output({ merged: true, fields: Object.keys(mergeData) }, raw, 'true');
}

function cmdFrontmatterValidate(cwd: string, filePath: string, schemaName: string | undefined, raw: boolean): void {
  if (!filePath || !schemaName) { error('file and schema required'); }
  if (filePath.includes('\0')) { error('file path contains null bytes'); }
  // Guard against prototype-chain keys (__proto__, constructor, toString, hasOwnProperty,
  // valueOf, ...): a bare FRONTMATTER_SCHEMAS[schemaName] lookup resolves those to
  // Object.prototype members instead of undefined, so a `!schema` check on the raw
  // lookup never fires and the code crashes later on `schema.required.filter` with an
  // uncaught TypeError instead of the intended "Unknown schema" message. Confirmed live
  // with --schema __proto__. Now that --schema is agent-bound (agents/gsd-planner.md's
  // $SCHEMA), this is reachable from prompt state, not just an unreachable literal.
  // Checked and rejected BEFORE the lookup (rather than `?? undefined`-ing the lookup
  // itself) so `schema`'s inferred type stays non-optional and needs no assertion below.
  if (!Object.prototype.hasOwnProperty.call(FRONTMATTER_SCHEMAS, schemaName as string)) {
    error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`);
  }
  const schema = FRONTMATTER_SCHEMAS[schemaName as string];
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw, undefined); return; }
  // #2701: fail loud on NUL/binary corruption before schema checks. A structurally
  // intact-but-NUL-corrupted file otherwise passes as valid:true and is then silently
  // skipped by recursive/binary-skipping searchers, reading downstream as "absent."
  const encErr = textEncodingError(content, filePath);
  if (encErr) { output({ valid: false, errors: [encErr], schema: schemaName }, raw, 'invalid'); return; }
  // Pass the resolved path so a truncated file is named in the diagnostic and deduplicated
  // per file rather than per content digest (#1882, ADR-1411 wiring clause).
  const fm = extractFrontmatter(content, fullPath);
  const requiredValues = schema.requiredValues || {};
  // A field satisfies the schema when it is present AND — for fields with a
  // requiredValues entry — strictly equal to that value. Absent and
  // wrong-value both surface as `missing` (existing `missing`/`present`
  // partition of `required` is unchanged — no consumer reads `present` to
  // mean "physically exists regardless of value," confirmed by searching
  // every caller before choosing this). But #2847 review: folding silently
  // made "missing" misleading for a WRONG-valued field the plan author can
  // plainly see in the file (e.g. `gap_closure: True`) — nothing told them
  // the field is present but the VALUE is wrong, so they could loop trying
  // to add a field that is already there. `invalidValue` names exactly that
  // subset (present, but not the required value) so the message stays
  // actionable without changing what `missing`/`present` mean.
  const wrongValue = (f: string): boolean =>
    fm[f] !== undefined && Object.prototype.hasOwnProperty.call(requiredValues, f) && fm[f] !== requiredValues[f];
  const satisfies = (f: string): boolean => fm[f] !== undefined && !wrongValue(f);
  const missing = schema.required.filter(f => !satisfies(f));
  const present = schema.required.filter(f => satisfies(f));
  const invalidValue = schema.required.filter(wrongValue);
  output({ valid: missing.length === 0, missing, present, invalidValue, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

export = {
  // #3706: shared with the agent-frontmatter writers so a config-supplied
  // `model:`/`variant:` value cannot break out of its scalar. Previously private
  // here while those writers interpolated raw — one escaper, three call sites.
  escapeDoubleQuotedScalar,
  agentScalarNeedsDoubleQuoting,
  extractFrontmatter,
  UNTERMINATED_KEY_THRESHOLD,
  // ADR-3473 §8.1 (#3881, consequence 2): the unparseable-vs-empty marker Symbol. Exported so
  // the 8 `hasFrontmatter` call sites named in the design can consult it in a follow-up change.
  FRONTMATTER_UNPARSEABLE,
  // Additive alias (#644 prohibition-probe schema contract): the probe round-trip seam reads a
  // frontmatter object via `parseFrontmatter` (the name the contract test pins). It is the SAME
  // function as `extractFrontmatter` — a bare-object parse with no behavior change — exposed under
  // the alias so the prohibition schema round-trip and any future caller can use the canonical name.
  parseFrontmatter: extractFrontmatter,
  reconstructFrontmatter,
  spliceFrontmatter,
  // The one owner of "may a writer splice this frontmatter block?" — callers catch
  // `isFrontmatterWriteRefusal(err)` and surface `err.message`/`err.code`.
  FrontmatterWriteRefusedError,
  isFrontmatterWriteRefusal,
  stripFrontmatter,
  noOpObjectListSetError,
  parseMustHavesBlock,
  // #3850: an array key's entries as parsed OBJECTS, for a caller that must
  // branch on an entry's `status:`/`resolution:` rather than print it. Off the
  // same parse path as `extractFrontmatter`, minus only the display flattening.
  frontmatterListEntries,
  // #3850: the display rendering itself, so a caller deriving a name from those
  // objects produces the byte-identical string `extractFrontmatter` would have.
  flattenObjectListItem,
  FRONTMATTER_SCHEMAS,
  cmdFrontmatterGet,
  cmdFrontmatterSet,
  cmdFrontmatterMerge,
  cmdFrontmatterValidate,
  propagateCommentChannel,
  // #4917 / ADR-4910 Decision 1: additive-only export so `planning-document.cts`
  // can COMPOSE this seam's fence-detection grammar (byte-0 rule, BOM strip,
  // CR handling) instead of reimplementing it. No behavior change — same
  // function `extractFrontmatter`/`frontmatterListEntries` already call.
  frontmatterRegion,
  // The closed block for a writer (`bom + block + rest === content`), composing
  // `frontmatterRegion` — `uat.cts` locates its `updated:` edits through it.
  frontmatterBlock,
};
