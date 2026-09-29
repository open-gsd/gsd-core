/**
 * frontmatter-splice.cts — the frontmatter WRITER (#5105): `spliceFrontmatter` and the
 * machinery only it uses — per-key layout slicing, comment and tail-line classification, the
 * parse budget, key quoting for a regenerated key, the read-back post-condition and the
 * write-refusal vocabulary (`FrontmatterWriteRefusedError` / `isFrontmatterWriteRefusal`).
 *
 * Split out of `frontmatter.cts` by module ownership (#5105): the reader — fence region,
 * guarded parse, comment channel, `reconstructFrontmatter` — stays there; the decision whether
 * and how a changed frontmatter block may be written lives here. `frontmatter.cts` re-exports
 * this module's public names, so every caller's `require('./frontmatter.cjs')` is unchanged.
 * Behavior is unchanged: every function below moved verbatim.
 *
 * Import direction: this module requires `frontmatter.cjs` at load time (the parser it builds
 * on, through `frontmatter.spliceSeam`); `frontmatter.cjs` requires this module LAZILY — from
 * its re-export getters and its set/merge commands, never while it is itself loading — so
 * whichever of the two a caller loads first, the other is complete before it is read.
 *
 * Source in src/frontmatter-splice.cts, compiled to gsd-core/bin/lib/frontmatter-splice.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
import { splitLines } from './text-lines.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';
import { load as yamlLoad } from './vendor/js-yaml.cjs';

const { extractFrontmatter, reconstructFrontmatter, escapeDoubleQuotedScalar, frontmatterBlock, FRONTMATTER_UNPARSEABLE, spliceSeam } = frontmatterMod;
const {
  FULL_LINE_COMMENTS,
  YAML_LOAD_OPTS,
  commentPathKey,
  channelKeyLine,
  segmentKeyOf,
  escapeNullBytesForParse,
  unparseableResult,
  frontmatterDeepEqual,
} = spliceSeam;

// The reader's value shapes (`frontmatter.cts`), restated structurally so the writer's types do
// not depend on the reader's export object — which re-exports this module's own names.
type FrontmatterValue = string | string[] | Record<string, unknown>;
type Frontmatter = Record<string, FrontmatterValue>;
type FullLineCommentChannel = { leading: Record<string, string[]>; trailing: string[]; inline?: Record<string, string> };

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

/**
 * The most YAML text, in characters (each parse also counts one for its own line break), one
 * `spliceFrontmatter` call may parse while classifying lines — `segmentTailStart`,
 * `isSegmentComment` and `inlineCommentStart` each decide a line by re-parsing the key's lines
 * without it, so the work grows with (lines × `#`/tail lines × line length). A real planning
 * document stays far below it (across every tracked `.md` file, splicing any key to a changed
 * value parses at most ~60,000 characters — 0.3% of it, in the adversarial `huge-bounded.md`
 * fixture); a pathological block — thousands of blank lines after a `|+` key,
 * or hundreds of lines each holding many ` #` — is refused instead of stalling the writer
 * (found while implementing #5105).
 */
const SPLICE_PARSE_BUDGET_CHARS = 20_000_000;

/**
 * One `spliceFrontmatter` call's parse allowance: `limit` is the whole allowance
 * (`SPLICE_PARSE_BUDGET_CHARS` unless the caller passes `parseBudgetChars`), `remaining` what
 * is left of it.
 */
type SpliceParseBudget = { remaining: number; limit: number };

/**
 * `spliceFrontmatter`'s options. `parseBudgetChars` replaces `SPLICE_PARSE_BUDGET_CHARS` for
 * one call, so a test can reach the refusal boundary with a small document instead of a
 * 20-million-character one; a non-negative safe integer, or the call throws a TypeError.
 */
type SpliceFrontmatterOptions = { parseBudgetChars?: number };

/**
 * Parse one key's lines on their own, or null when they do not parse as YAML. Charges the
 * text to `budget`, refusing with `FRONTMATTER_TOO_COMPLEX` once it is spent.
 */
function loadSegmentValue(lines: string[], budget: SpliceParseBudget): { value: unknown } | null {
  const text = lines.join('\n');
  budget.remaining -= text.length + 1;
  if (budget.remaining < 0) {
    throw new FrontmatterWriteRefusedError(
      'FRONTMATTER_TOO_COMPLEX',
      'frontmatter: refusing to write — telling this frontmatter block\'s comments and trailing blank ' +
        `lines apart from its values would take more than ${budget.limit} characters of YAML ` +
        'parsing (a very large block with many `#` or trailing blank lines), so the writer stops rather ' +
        'than stall. Edit the file directly.',
    );
  }
  try {
    return { value: yamlLoad(escapeNullBytesForParse(text), YAML_LOAD_OPTS) };
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
function segmentTailStart(lines: string[], budget: SpliceParseBudget): number {
  let cut = lines.length;
  while (cut > 1 && isSegmentTailLine(lines[cut - 1])) cut--;
  if (cut === lines.length) return cut;
  const whole = loadSegmentValue(lines, budget);
  if (!whole) return cut;
  while (cut < lines.length) {
    const body = loadSegmentValue(lines.slice(0, cut), budget);
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
function sliceFrontmatterLayout(yaml: string, budget: SpliceParseBudget): { preamble: string[]; segments: FrontmatterSegment[] } {
  const preamble: string[] = [];
  const segments: FrontmatterSegment[] = [];
  let current: { key: string; valueStart: number; lines: string[] } | null = null;
  const close = (seg: { key: string; valueStart: number; lines: string[] }): void => {
    const cut = segmentTailStart(seg.lines, budget);
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
  if (comments) (single as Record<symbol, unknown>)[FULL_LINE_COMMENTS] = comments;
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
 * data). `FRONTMATTER_TOO_COMPLEX`: telling the block's comments and trailing lines apart from
 * its values would parse more YAML than `SPLICE_PARSE_BUDGET_CHARS` (or the call's
 * `parseBudgetChars`) allows, so the writer stops
 * rather than stall on a pathological block.
 */
type FrontmatterWriteRefusalCode =
  | 'FRONTMATTER_UNPARSEABLE'
  | 'FRONTMATTER_KEYS_UNRECONCILABLE'
  | 'FRONTMATTER_SPLICE_VERIFY_FAILED'
  | 'FRONTMATTER_COMMENT_WOULD_BE_LOST'
  | 'FRONTMATTER_TOO_COMPLEX';

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
function isSegmentComment(lines: string[], i: number, whole: { value: unknown } | null, budget: SpliceParseBudget): boolean {
  if (!/^\s*#/.test(lines[i])) return false;
  if (!whole) return true;
  const without = loadSegmentValue([...lines.slice(0, i), ...lines.slice(i + 1)], budget);
  return without !== null && frontmatterDeepEqual(without.value, whole.value);
}

/**
 * Where the inline comment on `lines[i]` starts (the whitespace before its `#`), or -1. A
 * ` #` is a comment only when the key's lines parse to the same value with the line cut
 * there, so a `#` inside a quoted scalar or a block scalar never counts. When the lines do
 * not parse on their own (`whole` null) the first ` #` counts.
 */
function inlineCommentStart(lines: string[], i: number, whole: { value: unknown } | null, budget: SpliceParseBudget): number {
  const line = lines[i];
  const hashes = /[ \t]#/g;
  for (let m = hashes.exec(line); m !== null; m = hashes.exec(line)) {
    let start = m.index;
    while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--;
    if (!whole) return start;
    const cut = loadSegmentValue([...lines.slice(0, i), line.slice(0, start), ...lines.slice(i + 1)], budget);
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

function segmentComments(key: string, lines: string[], budget: SpliceParseBudget): SegmentComments {
  const whole = loadSegmentValue(lines, budget);
  const leading = Object.create(null) as Record<string, string[]>;
  const inline = Object.create(null) as Record<string, string>;
  const unattached: string[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let pending: Array<{ indent: number; line: string }> = [];
  const loosen = (comments: Array<{ line: string }>): void => { for (const c of comments) unattached.push(c.line.trim()); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && line.trim() === '') continue;
    if (i > 0 && isSegmentComment(lines, i, whole, budget)) {
      pending.push({ indent: /^\s*/.exec(line)?.[0].length ?? 0, line });
      continue;
    }
    const at = inlineCommentStart(lines, i, whole, budget);
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
function assertCommentsKept(key: string, original: SegmentComments, regenerated: string, budget: SpliceParseBudget): void {
  const placed = (c: SegmentComments): Map<string, number> => {
    const counts = new Map<string, number>();
    const add = (entry: string): void => { counts.set(entry, (counts.get(entry) ?? 0) + 1); };
    for (const [path, lines] of Object.entries(c.channel.leading)) for (const l of lines) add(JSON.stringify(['above', path, l.trim()]));
    for (const [path, text] of Object.entries(c.channel.inline)) add(JSON.stringify(['beside', path, text.trim()]));
    for (const text of c.unattached) add(JSON.stringify(['loose', '', text]));
    return counts;
  };
  const before = placed(original);
  const after = placed(segmentComments(key, splitLines(regenerated), budget));
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

function spliceFrontmatter(
  content: string,
  newObj: Frontmatter,
  { parseBudgetChars = SPLICE_PARSE_BUDGET_CHARS }: SpliceFrontmatterOptions = {},
): string {
  if (!Number.isSafeInteger(parseBudgetChars) || parseBudgetChars < 0) {
    throw new TypeError(`spliceFrontmatter: parseBudgetChars must be a non-negative safe integer, got ${String(parseBudgetChars)}`);
  }
  // The block is located through `frontmatterBlock` (the one fence owner's block), so the
  // writer and every reader agree on where it is: BOM (#2977), CRLF, an empty block.
  const located = frontmatterBlock(content);
  if (located) {
    const { bom, block: fmBlock, rest } = located;
    const fmLines = splitLines(fmBlock);
    const innerLines = fmLines.slice(1, -1); // drop the opening `---` and closing `---`
    const inner = innerLines.join('\n');
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
    // An adjacent empty block (`---\n---`) has NO lines between its fences, while a block
    // holding one blank line has one empty line: both join to ''. Laying out '' yields that one
    // blank line, so the empty block would gain a blank line above its first key (found while
    // implementing #5105).
    // One parse allowance for the whole call: every line classification below draws on it.
    const budget: SpliceParseBudget = { remaining: parseBudgetChars, limit: parseBudgetChars };
    const { preamble, segments } = innerLines.length === 0
      ? { preamble: [] as string[], segments: [] as ReturnType<typeof sliceFrontmatterLayout>['segments'] }
      : sliceFrontmatterLayout(inner, budget);
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
          const comments = segmentComments(seg.key, seg.body, budget);
          const regenerated = regenerateFrontmatterKey(seg.key, newObj[seg.key], comments.channel);
          if (regenerated !== '') assertCommentsKept(seg.key, comments, regenerated, budget);
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

    // Re-emit the whole block with the document's own line ending (the opening fence's, as
    // the one fence owner reads it), so a CRLF document never gains LF-only lines.
    const eol = locateFrontmatterFence(content)?.eol ?? '\n';
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

export = {
  spliceFrontmatter,
  // The one owner of "may a writer splice this frontmatter block?" — callers catch
  // `isFrontmatterWriteRefusal(err)` and surface `err.message`/`err.code`.
  FrontmatterWriteRefusedError,
  isFrontmatterWriteRefusal,
  // The parse allowance past which `spliceFrontmatter` refuses with FRONTMATTER_TOO_COMPLEX —
  // exported so its boundary can be exercised exactly.
  SPLICE_PARSE_BUDGET_CHARS,
  // `frontmatter.cts`'s set/merge #1660 lossy-field check (`objectListFieldWouldLoseData`)
  // asks the writer what a key regenerates to and what a value reads back as.
  regenerateFrontmatterKey,
  readBackProjection,
};
