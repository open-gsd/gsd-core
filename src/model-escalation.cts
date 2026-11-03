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
import crypto from 'node:crypto';
import { realClock, type Clock } from './clock.cjs';
import { retryRenameSync } from './shell-command-projection.cjs';
import { findProjectRoot } from './project-root.cjs';
import { CLAUDE_AGENT_ALIASES } from './model-catalog.cjs';
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeSafetyMod = require('./worktree-safety.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ledgerMod = require('./capability-ledger.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelResolverMod = require('./model-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
import { resolveActiveRuntime } from './runtime-slash.cjs';

export const ESCALATION_WINDOW_MS = 10 * 60 * 1000;
/** Tolerated clock skew for a record stamped slightly in the future. */
export const ESCALATION_SKEW_MS = 5000;
/** A record is a few hundred bytes; anything bigger is not ours. */
export const MAX_READ_BYTES = 64 * 1024;
/**
 * The model-id character-class body (#3714): gsd-tools.cjs derives its pin accept regex and sanitizer from it, and
 * hooks/lib/agent-model-check.js its echo sanitizer. Plain characters and `x-y` ranges only: it is interpolated raw
 * into both `[BODY]` and `[^BODY]`.
 */
export const MODEL_ID_CHARSET_BODY = 'A-Za-z0-9._:/@-';

/** The agent types the guard checks; also the only ones an escalation record is written for. */
export const GUARDED_AGENT_TYPES: ReadonlySet<string> = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

export interface EscalationRecord {
  model: string;
  written_at: number;
  session?: string;
}

export const escalationFile = (root: string, agentType: string): string =>
  path.join(root, '.gsd', `model-escalation-${agentType}.json`);

/** The root a record for `cwd` lives at: the root hooks/lib/isolation-sentinel.js resolveSentinelRoot gives the hook, raw `cwd` on a resolution error included (a test pins the two equal). */
export function escalationRoot(cwd: string): string {
  try {
    return fs.existsSync(path.join(cwd, '.planning')) ? cwd : findProjectRoot(worktreeSafetyMod.resolveWorktreeRoot(cwd).root);
  } catch {
    return cwd;
  }
}

/**
 * `hooks.agent_model_guard` from the root `.planning/config.json` only, as strict JSON capped at MAX_READ_BYTES, like the other
 * hooks.* keys; `skip` when absent, unreadable, oversized or unparseable. The hook and resolve-execution both read it here.
 */
export function readGuardMode(root: string): { mode?: unknown; skip?: true } {
  try {
    const text = ledgerMod.readSmallRegularFile(path.join(root, '.planning', 'config.json'), MAX_READ_BYTES);
    return text === null ? { skip: true } : { mode: ((JSON.parse(text) as { hooks?: Record<string, unknown> }).hooks || {})['agent_model_guard'] };
  } catch {
    return { skip: true };
  }
}

/**
 * Does the Agent model guard apply at `root` under the current GSD_WORKSTREAM: it is on (readGuardMode), and the runtime of the
 * config the expected model resolves through (GSD_RUNTIME > config.runtime > marker) resolves native tier aliases. The hook
 * (per candidate workstream) and the `init --ws` warning both ask it here.
 */
export function guardApplies(root: string): boolean {
  const { mode, skip } = readGuardMode(root);
  return !skip && mode !== false &&
    modelResolverMod.hasNativeModelAliases(resolveActiveRuntime(configLoaderMod.loadConfig(root, { persist: false })));
}

/** The root a CLI run at `cwd` writes a guard record at; throws when --project-dir/--cwd point away from the session's working directory, whose root the hook reads. */
export function sessionRoot(cwd: string): string {
  const root = escalationRoot(cwd);
  const session = escalationRoot(process.cwd());
  if (root !== session) throw new Error(`the project resolves to ${root}, but the Agent model guard reads at ${session}`);
  return root;
}

/** Compare at tier-alias level: `claude-sonnet-4-6` and `sonnet` are the same. Tier names are the catalog's CLAUDE_AGENT_ALIASES. */
const FAMILY_RE = new RegExp(`(?:^|[^a-z0-9])(${[...CLAUDE_AGENT_ALIASES].map(escapeRegex).join('|')})(?:$|[^a-z])`);
export function modelFamily(model: unknown): string {
  const s = String(model).toLowerCase();
  return FAMILY_RE.exec(s)?.[1] ?? s;
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
 * Throws when the record cannot be written: a symlinked or redirected `.gsd`, or a symlinked `.gsd/.gitignore`. Under
 * hooks.agent_model_guard:'deny' a missing record blocks the escalated model, so the caller (recordModelEscalation)
 * reports it. `.gsd/.gitignore` follows the dispatch-sentinel writer's policy (gsd-core/bin/gsd-tools.cjs,
 * writeDispatchIsolationSentinel; a parity test pins the two): create `*`; else keep a file with a bare `*` or this
 * writer's marker, else append marker and rules by tmp + rename; any other read or write failure keeps the rules.
 */
export function writeEscalation(
  root: string, agentType: string, model: string, session?: string, clock: Pick<Clock, 'now'> = realClock,
): void {
  if (!GUARDED_AGENT_TYPES.has(agentType)) return; // also keeps agentType, a file name, from traversing
  const dir = path.join(root, '.gsd');
  fs.mkdirSync(dir, { recursive: true });
  // Catches a planted .gsd symlink and an ancestor redirect; racing a swap after this needs repo write access already.
  if (fs.lstatSync(dir).isSymbolicLink() || path.relative(fs.realpathSync(root), fs.realpathSync(dir)) !== '.gsd') {
    throw new Error(`${dir} is a symlink or resolves outside the project`);
  }
  const ignore = path.join(dir, '.gitignore');
  try {
    fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // O_NONBLOCK beyond the sentinel's open: a FIFO here must not hang resolve-execution.
      const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
      let fd: number | undefined;
      let tmp: string | undefined;
      try {
        if (fs.lstatSync(ignore).isSymbolicLink()) throw new Error(`${ignore} is a symlink`);
        fd = fs.openSync(ignore, O_RDONLY | (O_NOFOLLOW || 0) | (O_NONBLOCK || 0));
        if (!fs.fstatSync(fd).isFile()) throw new Error(`${ignore} is not a regular file`);
        const cur = fs.readFileSync(fd, 'utf8');
        fs.closeSync(fd);
        fd = undefined;
        if (!cur.includes('# gsd-core model guard') && !/^\*\r?$/m.test(cur)) {
          tmp = `${ignore}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
          fs.writeFileSync(tmp, `${cur}${cur.endsWith('\n') ? '' : '\n'}# gsd-core model guard\n/model-escalation-*\n/.gitignore.tmp-*\n`, { flag: 'wx' });
          if (fs.lstatSync(ignore).isSymbolicLink()) throw new Error(`${ignore} is a symlink`);
          retryRenameSync(tmp, ignore);
          tmp = undefined;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP' || (err as Error).message === `${ignore} is a symlink`) {
          throw new Error(`${ignore} is a symlink`);
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (tmp) fs.rmSync(tmp, { force: true });
      }
    }
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
