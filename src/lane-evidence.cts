/**
 * Lane-evidence removal — the one owner of the #5019 removal fence.
 *
 * `code-review` persists its external-reviewer evidence beside REVIEW.md as
 * `<review>-lane-evidence.md` (line 1: the 6-char suffix of the lane scratch dir
 * `$TMPDIR/gsd-review-lanes-<suffix>`). `code-review` removes both at `check_empty_scope` and in
 * `commit_review` (unless `--auto` keeps them); `code-review-fix` at every exit after `REVIEW_PATH` is computed.
 * The loop's read in code-review-fix.md repeats SUFFIX_RE's guard in bash: keep them in step. That was six byte-identical inline bash fences; this
 * verb replaces them (`gsd_run lane-evidence-clear "$REVIEW_PATH"`) so the guard lives once.
 *
 * Line 1 is data read back from disk, never a path: only a 6-char alphanumeric value names
 * a directory, and a symlinked directory is skipped, so no value can reach outside TMPDIR.
 * Total: never throws (the inline fences ran with no `set -e`).
 */

import fs from 'node:fs';
import { splitLines } from './text-lines.cjs';

const SUFFIX_RE = /^[A-Za-z0-9]{6}$/;

export function clearLaneEvidence(reviewPath: string, tmpDir: string = process.env.TMPDIR || '/tmp'): void {
  const file = `${reviewPath.replace(/\.md$/, '')}-lane-evidence.md`;
  try {
    if (!fs.statSync(file).isFile()) return;
    const suffix = splitLines(fs.readFileSync(file, 'utf8'))[0] ?? '';
    if (SUFFIX_RE.test(suffix)) {
      const dir = `${tmpDir}/gsd-review-lanes-${suffix}`;
      if (fs.lstatSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // missing file or lane dir: nothing to remove
  }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/** CLI arm for `gsd-tools lane-evidence-clear <review-path>`. */
export function cmdLaneEvidenceClear(reviewPath: string | undefined, error: (msg: string) => void): void {
  if (!reviewPath) { error('Usage: lane-evidence-clear <review-path>'); return; }
  clearLaneEvidence(reviewPath);
}
