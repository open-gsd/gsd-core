'use strict';
// hooks/lib/filename-classification.js — hand-written, NOT generated. One
// tiny, deliberately-named filename slicer.
//
// WHY this exists: issue #4580 was caused by comparing "everything after the
// `.env.` prefix" — a multi-segment token like `local.example` — against a
// set whose members are FINAL EXTENSIONS (`example`). `.env.local.example`
// was classified by its full `local.example` tail, which is not in a set
// built from bare extensions, so the comparison silently failed. This module
// deliberately exposes ONLY the final-extension answer so the wrong token
// can't be picked by accident at a call site. The "everything after the
// first dot" form is intentionally NOT exported: no caller needs it, and an
// unused export is dead code.

/**
 * The segment after the LAST dot in `name`. A string with no dot IS its own
 * final extension. Inert on non-strings/empty input: never throws, returns
 * ''.
 *
 * @param {*} name
 * @returns {string}
 */
function finalExtension(name) {
  if (typeof name !== 'string' || name === '') return '';
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * Strips ALL trailing dots and spaces from `name`, repeatedly, from the end
 * of the basename.
 *
 * WHY: Win32 strips trailing dots and trailing spaces from each path
 * component when resolving a filesystem path — `.env.`, `.env..`, `.env `,
 * and `.env. ` all resolve to the same on-disk file as `.env` on Windows.
 * These are therefore ALIASES for the protected name, not distinct names,
 * and a guard that classifies the literal string without normalizing first
 * can be bypassed by any of them. This is not cosmetic tidying — it closes
 * that Windows path-alias bypass.
 *
 * This runs UNCONDITIONALLY on every host platform (macOS, Linux, Windows),
 * not only when actually running on Windows: the guard must behave
 * identically everywhere, and a name is judged by what Win32 would resolve
 * it to, regardless of what OS the hook happens to run on.
 *
 * @param {*} name
 * @returns {string}
 */
function normalizeWindowsBasename(name) {
  if (typeof name !== 'string' || name === '') return '';
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end--;
  return name.slice(0, end);
}

// Last `/`- or `\`-separated segment, ignoring trailing separators. A string
// with no separator IS its own last segment.
function lastSegment(tok) {
  const s = tok.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

module.exports = { finalExtension, normalizeWindowsBasename, lastSegment };
