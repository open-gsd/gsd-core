"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.capCodeUnits = capCodeUnits;
/**
 * Cut `text` to at most `max` UTF-16 code units, keeping the head or the tail,
 * without leaving half a surrogate pair: the head cut drops a trailing high
 * surrogate and the tail cut drops a leading low surrogate, whether the cut
 * split a pair or the edge already held a lone half. Text that fits is returned
 * whole; a non-positive `max` keeps nothing.
 */
function capCodeUnits(text, max, keep) {
    if (text.length <= max)
        return text;
    if (max <= 0)
        return '';
    return keep === 'tail'
        ? text.slice(-max).replace(/^[\uDC00-\uDFFF]/, '')
        : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}
