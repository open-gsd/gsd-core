/**
 * Model escalation record (#5328) — the one owner of the file
 * `resolve-execution --attempt N` writes and hooks/lib/agent-model-check.js reads.
 *
 * Single slot per agent type: `.gsd/model-escalation-<agent>.json` holds the model
 * an escalation resolved, when, and (when known) the session that asked for it.
 * The guard honours it for ESCALATION_WINDOW_MS, only for a model of the same tier family and, when both
 * sides know a session id, only in that session. Unauthenticated by design: a guard against drift, not a
 * security boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock, type Clock } from './clock.cjs';
import { retryRenameSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityLedgerMod = require('./capability-ledger.cjs');

const { readSmallRegularFile } = capabilityLedgerMod;

export const ESCALATION_WINDOW_MS = 10 * 60 * 1000;
/** Tolerated clock skew for a record stamped slightly in the future. */
export const ESCALATION_SKEW_MS = 5000;
/** A record is a few hundred bytes; anything bigger is not ours. */
export const MAX_READ_BYTES = 64 * 1024;

/** The agent types the guard checks; also the only ones an escalation record is written for. */
export const GUARDED_AGENT_TYPES: ReadonlySet<string> = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

export interface EscalationRecord {
  model: string;
  written_at: number;
  session?: string;
}

export const escalationFile = (root: string, agentType: string): string =>
  path.join(root, '.gsd', `model-escalation-${agentType}.json`);

/** Compare at tier-alias level: `claude-sonnet-4-6` and `sonnet` are the same. */
export function modelFamily(model: unknown): string {
  const s = String(model).toLowerCase();
  return /(?:^|[^a-z0-9])(opus|sonnet|haiku|fable)(?:$|[^a-z])/.exec(s)?.[1] ?? s;
}

/**
 * tmp + rename: a reader never sees a half-written file, and rename replaces a symlink planted at
 * `file` instead of following it. 'wx': nor is one at `tmp` followed. Not platformWriteSync: its
 * tmp-failure fallback writes `file` directly, which follows exactly that planted link.
 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true }); // left by a crashed writer whose pid was reused
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    retryRenameSync(tmp, file); // Windows: a reader can hold `file` open briefly
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Throws when the record cannot be written, a symlinked `.gsd` included. Under hooks.agent_model_guard:'deny'
 * a missing record blocks the legitimate escalated model, so the caller (recordModelEscalation) must report it.
 * The .gitignore upkeep stays best-effort: a rule that fails to land never loses the record.
 */
export function writeEscalation(
  root: string, agentType: string, model: string, session?: string, clock: Pick<Clock, 'now'> = realClock,
): void {
  if (!GUARDED_AGENT_TYPES.has(agentType)) return; // also keeps agentType, a file name, from traversing
  const dir = path.join(root, '.gsd');
  fs.mkdirSync(dir, { recursive: true });
  // Catches a planted .gsd symlink; racing a swap after this needs repo write access already.
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink`);
  const ignore = path.join(dir, '.gitignore');
  try {
    fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
  } catch {
    // Pre-existing (e.g. the dispatch sentinel's rules only): a bare `*` already covers the record,
    // else add our own rule. Replace by rename so a link swapped in after the lstat is not written through.
    // Own try: an oversized or unreadable .gitignore must not abort before the record is written.
    try {
      if (!fs.lstatSync(ignore).isSymbolicLink()) {
        const cur = readSmallRegularFile(ignore, MAX_READ_BYTES) ?? '';
        if (!/^\*\r?$/m.test(cur) && !/^\/model-escalation-\*\r?$/m.test(cur)) {
          writeAtomic(ignore, `${cur}${cur === '' || cur.endsWith('\n') ? '' : '\n'}/model-escalation-*\n`);
        }
      }
    } catch { /* leave the rules as they are */ }
  }
  const rec: EscalationRecord = { model, written_at: clock.now(), ...(session ? { session } : {}) };
  writeAtomic(escalationFile(root, agentType), JSON.stringify(rec));
}

/** Parsed record, or null when absent, a symlink, non-regular, oversized or unparseable. */
export function readEscalation(root: string, agentType: string): EscalationRecord | null {
  // Own no-follow open, not the shared reader (it follows links; SKILL.md and others rely on that).
  // O_NOFOLLOW closes the lstat-then-open race; win32 lacks it (and O_NONBLOCK), so there the lstat
  // alone refuses a link, and a swap after it needs repo write access, which forges a record anyway.
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  let fd: number | undefined;
  try {
    const file = escalationFile(root, agentType);
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, O_RDONLY | (O_NONBLOCK || 0) | (O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return null; // FIFO, device
    const buf = Buffer.alloc(MAX_READ_BYTES + 1);
    let n = 0;
    for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
    return n > MAX_READ_BYTES ? null : JSON.parse(buf.toString('utf8', 0, n)) as EscalationRecord;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Does `rec` legitimise `passedModel` now, for the dispatching `session` (undefined = unknown)? */
export function escalationAllows(
  rec: EscalationRecord | null,
  passedModel: string,
  { now, session }: { now: number; session?: string },
): boolean {
  if (!rec || typeof rec.model !== 'string' || !Number.isFinite(rec.written_at)) return false;
  const age = now - rec.written_at;
  if (!(age > -ESCALATION_SKEW_MS && age < ESCALATION_WINDOW_MS)) return false;
  if (typeof rec.session === 'string' && session !== undefined && rec.session !== session) return false;
  return modelFamily(rec.model) === modelFamily(passedModel);
}
