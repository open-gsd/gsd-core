/**
 * Lane evidence — the one owner of the #5019 persisted external-reviewer evidence (write, read, clear).
 *
 * `code-review` persists the evidence block at dispatch (`lane-evidence-persist`); `code-review-fix`
 * re-surfaces it per re-review (`lane-evidence-read`); both workflows remove it (`lane-evidence-clear`).
 * State lives in `${TMPDIR}/gsd-review-lane-evidence-<key>`, keyed to the review file, never in the
 * project or its git metadata. Content: `<suffix>\n<auto|once>\n<block>`, where `<suffix>` is the 6-char
 * mktemp suffix of the lane scratch dir `${TMPDIR}/gsd-review-lanes-<suffix>` and `auto` keeps both for the
 * `--fix --auto` loop. STATE_RE is the only parser of the file; persist checks each argument against the same two patterns, anchored.
 *
 * The suffix is data read back from disk, never a path: only a 6-char alphanumeric value names a
 * directory, and a symlinked or foreign-owned entry is skipped, so no value reaches outside TMPDIR.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryRenameSync } from './shell-command-projection.cjs';

const STATE_RE = /^([A-Za-z0-9]{6})\n(auto|once)\n([\s\S]*)$/;
const SUFFIX_RE = /^[A-Za-z0-9]{6}$/; // the same grammar as STATE_RE's line 1 and 2, anchored for a lone argument
const MODE_RE = /^(auto|once)$/;
const MAX_AGE_MS = 360 * 60000; // a state idle for 6h is a crashed earlier run's leftover
const LANES = 'gsd-review-lanes-';

const defaultTmp = (): string => process.env.TMPDIR || (process.platform === 'win32' ? os.tmpdir() : '/tmp');

export function laneStatePath(reviewPath: string, tmpDir: string = defaultTmp()): string {
  const key = crypto.createHash('sha256').update(path.resolve(reviewPath)).digest('hex').slice(0, 16);
  return path.join(tmpDir, `gsd-review-lane-evidence-${key}`);
}

const ownedByCurrentUser = (st: fs.Stats): boolean => process.platform === 'win32' || st.uid === process.getuid!();

/** Remove the lane dir `suffix` names when it is a real directory we own. */
function removeLaneDir(tmpDir: string, suffix: string): void {
  try {
    const dir = path.join(tmpDir, LANES + suffix);
    const st = fs.lstatSync(dir);
    if (st.isDirectory() && ownedByCurrentUser(st)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* missing: nothing to remove */ }
}

/** The parsed state, or null when absent or not a regular file we own (a present one that is not ours is `rejected`). */
function loadState(file: string): { suffix: string; mode: string; block: string; mtimeMs: number } | 'rejected' | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || !ownedByCurrentUser(st)) return 'rejected';
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 'rejected'; } // a race or EACCES fails soft, like clear
  const m = STATE_RE.exec(text);
  return m ? { suffix: m[1], mode: m[2], block: m[3], mtimeMs: st.mtimeMs } : 'rejected';
}

export function persistLaneEvidence(reviewPath: string, suffix: string, mode: string, block: string, tmpDir: string = defaultTmp()): void {
  if (!SUFFIX_RE.test(suffix) || !MODE_RE.test(mode)) throw new Error('Usage: lane-evidence-persist <review-path> <suffix: 6 alphanumeric chars> <auto|once>, block on stdin');
  if (block === '') { removeLaneDir(tmpDir, suffix); return; } // no evidence cites the dir, so nothing may keep it
  const file = laneStatePath(reviewPath, tmpDir);
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${suffix}\n${mode}\n${block}`, { mode: 0o600, flag: 'wx' });
    retryRenameSync(tmp, file);
  } catch {
    process.stderr.write(`Warning: could not persist lane evidence to ${file}; removing the lane dir.\n`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    removeLaneDir(tmpDir, suffix);
  }
}

/** The block plus a blank line, or '' when there is no usable state. */
export function readLaneEvidence(reviewPath: string, tmpDir: string = defaultTmp()): string {
  const file = laneStatePath(reviewPath, tmpDir);
  const s = loadState(file);
  if (s === null) return '';
  if (s !== 'rejected' && s.mode === 'auto' && Date.now() - s.mtimeMs < MAX_AGE_MS) {
    try {
      const st = fs.lstatSync(path.join(tmpDir, LANES + s.suffix));
      if (st.isDirectory() && ownedByCurrentUser(st)) {
        try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* freshness refresh is best effort */ }
        return `${s.block}\n\n`;
      }
    } catch { /* lane dir missing */ }
  }
  process.stderr.write(`Warning: lane evidence ${file} rejected (idle for 6h, not an --auto state, not a regular file we own, malformed, or lane dir missing, a symlink or foreign); re-reviewing without it.\n`);
  return '';
}

export function clearLaneEvidence(reviewPath: string, opts: { keepAuto?: boolean; tmpDir?: string } = {}): void {
  const tmpDir = opts.tmpDir ?? defaultTmp();
  const file = laneStatePath(reviewPath, tmpDir);
  try {
    const s = loadState(file);
    if (s === null) return;
    // a state we do not own is another user's: leave it (and what it names) alone
    if (s !== 'rejected') {
      if (opts.keepAuto && s.mode === 'auto') return;
      removeLaneDir(tmpDir, s.suffix);
    } else if (!ownedByCurrentUser(fs.lstatSync(file))) return;
    fs.rmSync(file, { force: true });
  } catch { /* best effort: the fences ran with no `set -e` */ }
}

/** CLI arm for `gsd-tools lane-evidence-persist <review-path> <suffix> <auto|once>` (block on stdin). */
export function cmdLaneEvidencePersist(args: string[], error: (msg: string) => void): void {
  const [reviewPath, suffix, mode] = args;
  if (!reviewPath || !suffix || !mode) { error('Usage: lane-evidence-persist <review-path> <suffix> <auto|once>'); return; }
  let block: string;
  try { block = fs.readFileSync(0, 'utf8'); } catch (e) {
    // The reviewer may still cite the lane dir, so keep it now; a `once` state (read ignores it) lets the
    // clear in commit_review find and remove it later. Recorded before `error`, which may exit.
    try { persistLaneEvidence(reviewPath, suffix, 'once', 'unreadable'); } catch { /* bad suffix: nothing to record */ }
    error(`lane-evidence-persist: could not read the block from stdin: ${(e as Error).message}`);
    return;
  }
  try { persistLaneEvidence(reviewPath, suffix, mode, block); } catch (e) { error((e as Error).message); }
}

/** CLI arm for `gsd-tools lane-evidence-read <review-path>`. */
export function cmdLaneEvidenceRead(reviewPath: string | undefined, error: (msg: string) => void): void {
  if (!reviewPath) { error('Usage: lane-evidence-read <review-path>'); return; }
  process.stdout.write(readLaneEvidence(reviewPath));
}

/** CLI arm for `gsd-tools lane-evidence-clear <review-path> [--keep-auto]`. */
export function cmdLaneEvidenceClear(args: string[], error: (msg: string) => void): void {
  const [reviewPath, flag] = args;
  if (!reviewPath) { error('Usage: lane-evidence-clear <review-path> [--keep-auto]'); return; }
  clearLaneEvidence(reviewPath, { keepAuto: flag === '--keep-auto' });
}
