/**
 * YAML Anchor Guard — the one owner of ADR-3473 §8.1's anchor/alias refusal.
 *
 * `FAILSAFE_SCHEMA` restricts tag resolution only. Anchor/alias node-graph
 * expansion is a document-level `load` mechanic orthogonal to schema, so no
 * schema choice disables it: a hostile 7-line frontmatter block fanned out
 * through nested aliases expands to tens of megabytes in a few milliseconds.
 *
 * js-yaml's `load` accepts a `listener` invoked once per parse event with the
 * parser's internal `State`. `state.anchor` is non-null on every event
 * belonging to an anchored node, in every spelling — bareword key, quoted key
 * (`"a": &x 1`), flow mapping (`{b: &x 1, c: *x}`), flow sequence
 * (`[&x "q", *x]`) — and a `<<: *base` merge key trips it too, because the
 * alias it references can only point at a previously anchored node. Detecting
 * that with a line regex is re-implementing a YAML parser in order to guard a
 * YAML parser, and the regex form was bypassable by all three non-bareword
 * spellings above.
 *
 * The signal is thrown FROM INSIDE the listener rather than recorded and
 * checked after `load` returns: js-yaml keeps parsing — and, for an alias,
 * keeps EXPANDING — past a listener that only sets a flag, which reintroduces
 * the exact resource-exhaustion window this guard exists to close. Throwing
 * here aborts the parse before any expansion, so the billion-laughs fixture
 * refuses in ~1-2ms instead of building the ~35MB tree and discarding it.
 *
 * This lives in its own module because both YAML entry points need it and
 * neither can import the other: `frontmatter.cts` already imports
 * `shell-command-projection.cts` for platform file I/O, so the reverse edge
 * would be circular. A second copy of a security-critical listener is how the
 * two silently diverge when one is later hardened against a new bypass.
 */

/**
 * Thrown from inside {@link refuseAnchorsListener}. Callers catch it to
 * distinguish "the parser refused an anchor" from "the YAML was malformed".
 */
export class AnchorDetectedSignal extends Error {}

/**
 * js-yaml `listener` that aborts the parse the instant an anchored node is
 * seen. Pass as `load(yaml, { ...opts, listener: refuseAnchorsListener })`.
 */
export function refuseAnchorsListener(
  _event: string,
  state: { anchor?: string | null },
): void {
  if (state.anchor !== null && state.anchor !== undefined) throw new AnchorDetectedSignal();
}
