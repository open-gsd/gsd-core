'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SCOPED_EDIT_DISTANCE = void 0;
exports.matchLines = matchLines;
exports.writeScope = writeScope;
/**
 * Line alignment for scoped Markdown normalization (#5165).
 *
 * `platformWriteSync` re-spaces a `.md` document on every write. Given the
 * document the write replaces, only the line junctions the write itself made
 * need that treatment; everything else is published byte-for-byte. This module
 * is the pure half of that: it aligns the new lines against the prior lines and
 * says which junctions the write left alone. It performs no I/O.
 */
/**
 * Largest line-edit distance `matchLines` will search for. A write that changed
 * more than this many lines is a rewrite, not an edit: it falls back to
 * whole-document normalization (the pre-#5165 behavior), which also bounds the
 * diff's time and memory.
 */
exports.MAX_SCOPED_EDIT_DISTANCE = 400;
/**
 * Align the lines of the document being written (`next`) against the document
 * it replaces (`prev`). Returns, per `next` line, the index of its counterpart
 * in `prev` (a longest-common-subsequence match, Myers' O(ND) greedy diff after
 * trimming the common prefix and suffix), or -1 for a line the write added or
 * changed. Null when the documents differ by more than MAX_SCOPED_EDIT_DISTANCE
 * edits.
 */
function matchLines(prev, next) {
    const match = new Int32Array(next.length).fill(-1);
    const common = Math.min(prev.length, next.length);
    let lo = 0;
    while (lo < common && prev[lo] === next[lo]) {
        match[lo] = lo;
        lo++;
    }
    let prevEnd = prev.length;
    let nextEnd = next.length;
    while (prevEnd > lo && nextEnd > lo && prev[prevEnd - 1] === next[nextEnd - 1]) {
        prevEnd--;
        nextEnd--;
        match[nextEnd] = prevEnd;
    }
    const a = prev.slice(lo, prevEnd);
    const b = next.slice(lo, nextEnd);
    const n = a.length;
    const m = b.length;
    if (n === 0 || m === 0)
        return match;
    const max = Math.min(n + m, exports.MAX_SCOPED_EDIT_DISTANCE);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
        trace.push(v.slice()); // the furthest-reaching points after d-1 edits
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }
    }
    if (found < 0)
        return null;
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
        const before = trace[d];
        const k = x - y;
        const prevK = (k === -d || (k !== d && before[off + k - 1] < before[off + k + 1])) ? k + 1 : k - 1;
        const prevX = before[off + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            x--;
            y--;
            match[lo + y] = lo + x;
        }
        x = prevX;
        y = prevY;
    }
    while (x > 0 && y > 0) {
        x--;
        y--;
        match[lo + y] = lo + x;
    }
    return match;
}
/**
 * Derive a {@link WriteScope} from a line alignment. A junction is the write's
 * own — and so is normalized — when it is wholly inside text the write added,
 * or when a deletion between two kept lines made them newly adjacent. The
 * boundary of an edit that replaced lines inherits the surrounding spacing:
 * replacing a line in place must not add blank lines around it.
 */
function writeScope(match, prevLength) {
    // For each unmatched line: how many prior lines its run of changed lines replaced.
    const replaced = new Int32Array(match.length);
    const priorIndex = new Int32Array(match.length).fill(-1);
    for (let i = 0; i < match.length;) {
        if (match[i] >= 0) {
            i++;
            continue;
        }
        let end = i;
        while (end + 1 < match.length && match[end + 1] < 0)
            end++;
        const before = i > 0 ? match[i - 1] : -1;
        const after = end + 1 < match.length ? match[end + 1] : prevLength;
        const dropped = after - before - 1;
        for (let j = i; j <= end; j++) {
            replaced[j] = dropped;
            if (j - i < dropped)
                priorIndex[j] = before + 1 + (j - i);
        }
        i = end + 1;
    }
    return {
        junctionKept(i) {
            const left = match[i] >= 0;
            const right = match[i + 1] >= 0;
            // Two kept lines are one junction only if nothing sat between them in the
            // prior document; a deletion made them adjacent, so the write owns it.
            if (left && right)
                return match[i + 1] - match[i] === 1;
            if (left)
                return replaced[i + 1] >= 1;
            if (right)
                return replaced[i] >= 1;
            return false;
        },
        lineWritten(i) {
            return match[i] < 0;
        },
        replacedPriorIndex(i) {
            return priorIndex[i] ?? -1;
        },
    };
}
