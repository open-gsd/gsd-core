/**
 * code-unit-cap.cts — surrogate-safe UTF-16 length cap (#5639).
 *
 * Source in src/code-unit-cap.cts, compiled to gsd-core/bin/lib/code-unit-cap.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * A "genuine leaf" module (CONTEXT.md's term): zero I/O, zero imports from other
 * `src/*.cts` modules, one pure string function. Owner of the cut shared by
 * `prefixedCap` (gate-predicate-evaluator), the Pi description cap
 * (runtime-artifact-conversion) and the raw-status token cut (verification).
 */

/**
 * Cut `text` to at most `max` UTF-16 code units, keeping the head or the tail,
 * without leaving half a surrogate pair: when the cut orphans a high surrogate
 * (head) or a low surrogate (tail), that half is dropped too. Text that fits is
 * returned whole; a non-positive `max` keeps nothing.
 */
export function capCodeUnits(text: string, max: number, keep: 'head' | 'tail'): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  return keep === 'tail'
    ? text.slice(-max).replace(/^[\uDC00-\uDFFF]/, '')
    : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}
