/**
 * Session Store — per-session pause handoffs and records (#6796; ADR-4962).
 *
 * Single owner of the handoff filename grammar (`HANDOFF.json`,
 * `HANDOFF.latest.<role_id>.json`, `HANDOFF.<session_id>.json`,
 * `HANDOFF.claimed.<role_id>.<session_id>.json`; `latest`, `claimed`, `json`
 * are reserved first segments), session identity (`--session` or a runtime key,
 * never a terminal token), ownership by filename, and bounded non-following
 * reads. Best-effort like milestone-lock.cts: failures are data, never thrown.
 * The hook-side followers (Phase 2) are held to it by
 * `tests/fixtures/session-handoff-cases.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { excludeFromGit } from './git-info-exclude.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6796: core-utils.cjs is an export= CommonJS module
import coreUtils = require('./core-utils.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6796: capability-ledger.cjs is an export= CommonJS module
import capabilityLedger = require('./capability-ledger.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6796: active-workstream-store.cjs is an export= CommonJS module
import activeWorkstreamStore = require('./active-workstream-store.cjs');

const { readSmallRegularFile } = capabilityLedger;

/** Largest handoff or session record any reader will read. Real ones are a few KB. */
export const HANDOFF_MAX_BYTES = 256 * 1024;
export const SESSION_ID_MAX = 160;
export const ROLE_ID_MAX = 80;

/**
 * Terminal-identity keys: they name a pane or a terminal, survive `/clear`, and so
 * never identify a session (ADR-4962 Decision 4).
 */
const TERMINAL_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_SSE_PORT',
  'TERM_SESSION_ID',
  'WT_SESSION',
  'TMUX_PANE',
  'ZELLIJ_SESSION_NAME',
]);

/**
 * Runtime-issued session-id keys, in the workstream store's own precedence order:
 * `WORKSTREAM_SESSION_ENV_KEYS` minus the terminal-identity keys. Derived, not
 * copied, so the two lists cannot drift and one session never gets two ids.
 */
export const SESSION_ENV_KEYS: readonly string[] = Object.freeze(
  activeWorkstreamStore.WORKSTREAM_SESSION_ENV_KEYS.filter((key) => !TERMINAL_IDENTITY_KEYS.has(key)),
);

const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set(['latest', 'claimed', 'json']);
const ROLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDOFF_PREFIX = 'HANDOFF.';
const HANDOFF_SUFFIX = '.json';
const LEGACY_HANDOFF = 'HANDOFF.json';
const LEGACY_CONTINUE_HERE = '.continue-here.md';
const SESSIONS_DIR = 'sessions';

export type HandoffKind = 'legacy' | 'latest' | 'session' | 'claimed';

export interface HandoffName {
  kind: HandoffKind;
  role_id: string | null;
  session_id: string | null;
}

export interface Identity {
  session_id: string | null;
  role_id: string | null;
}

export interface HandoffEntry extends HandoffName {
  file: string;
  body: Record<string, unknown>;
}

export interface SessionRecord {
  session_id: string;
  role: string | null;
  role_id: string | null;
  stopped_at: string | null;
  last_session: string | null;
  resume_file: string | null;
}

export interface SkippedEntry {
  file: string;
  reason: string;
}

// ─── Sanitizers ───────────────────────────────────────────────────────────────

/**
 * The role slug a `--role-id` / `--role` pair names: the explicit slug wins, else the
 * slug of the free text. The one place that rule lives; null when neither slugs to anything.
 */
export function roleIdFromFlags(roleId: unknown, role: unknown): string | null {
  return sanitizeRoleId(roleId) ?? sanitizeRoleId(role);
}

/**
 * A session id safe to use inside a filename: `[A-Za-z0-9._-]`, starting with
 * an alphanumeric, at most SESSION_ID_MAX characters. A first dot-segment that
 * the grammar reserves is escaped with an `s_` prefix so a session can never
 * parse as a role slot. Null when nothing usable remains.
 */
export function sanitizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let id = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  if (id === '') return null;
  if (RESERVED_FIRST_SEGMENTS.has(id.split('.')[0])) id = `s_${id}`;
  id = id.slice(0, SESSION_ID_MAX).replace(/[._-]+$/, '');
  return id === '' ? null : id;
}

/**
 * An ASCII role slug (`a-z0-9` and single hyphens, at most ROLE_ID_MAX), via the
 * repo's canonical slug owner. Null when the text slugs to nothing.
 */
export function sanitizeRoleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = coreUtils.generateSlugInternal(value, ROLE_ID_MAX);
  return slug ? slug : null;
}

/**
 * The calling session's id: a non-blank `--session` that sanitizes to
 * something, else the first runtime key (SESSION_ENV_KEYS order) that does.
 * Never a terminal token. Null when neither yields an id.
 */
export function resolveSessionId(opts: { session?: unknown; env?: Record<string, string | undefined> } = {}): string | null {
  const fromFlag = sanitizeSessionId(opts.session);
  if (fromFlag !== null) return fromFlag;
  const env = opts.env ?? process.env;
  for (const key of SESSION_ENV_KEYS) {
    const id = sanitizeSessionId(env[key]);
    if (id !== null) return id;
  }
  return null;
}

// ─── Filename grammar ─────────────────────────────────────────────────────────

export function latestHandoffName(roleId: string): string {
  return `${HANDOFF_PREFIX}latest.${roleId}${HANDOFF_SUFFIX}`;
}

export function sessionHandoffName(sessionId: string): string {
  return `${HANDOFF_PREFIX}${sessionId}${HANDOFF_SUFFIX}`;
}

export function claimedHandoffName(roleId: string, sessionId: string): string {
  return `${HANDOFF_PREFIX}claimed.${roleId}.${sessionId}${HANDOFF_SUFFIX}`;
}

/** The `.continue-here` companion of a role slot, or the legacy one for no role. */
export function continueHereName(roleId: string | null): string {
  return roleId ? `.continue-here.latest.${roleId}.md` : LEGACY_CONTINUE_HERE;
}

/**
 * Parse a directory entry name. Null for anything that is not exactly one of
 * the four forms; a partial or ambiguous match is never guessed at.
 */
export function classifyHandoffName(name: unknown): HandoffName | null {
  if (typeof name !== 'string') return null;
  if (name === LEGACY_HANDOFF) return { kind: 'legacy', role_id: null, session_id: null };
  if (!name.startsWith(HANDOFF_PREFIX) || !name.endsWith(HANDOFF_SUFFIX)) return null;
  const middle = name.slice(HANDOFF_PREFIX.length, name.length - HANDOFF_SUFFIX.length);
  if (middle === '') return null;
  const first = middle.split('.')[0];
  if (first === 'latest') {
    const role = middle.startsWith('latest.') ? middle.slice('latest.'.length) : '';
    if (!ROLE_ID_RE.test(role) || role.length > ROLE_ID_MAX) return null;
    return { kind: 'latest', role_id: role, session_id: null };
  }
  if (first === 'claimed') {
    const rest = middle.startsWith('claimed.') ? middle.slice('claimed.'.length) : '';
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    const role = rest.slice(0, dot);
    const sid = rest.slice(dot + 1);
    if (!ROLE_ID_RE.test(role) || role.length > ROLE_ID_MAX || sanitizeSessionId(sid) !== sid) return null;
    return { kind: 'claimed', role_id: role, session_id: sid };
  }
  if (sanitizeSessionId(middle) !== middle) return null;
  return { kind: 'session', role_id: null, session_id: middle };
}

// ─── Ownership ────────────────────────────────────────────────────────────────

/** The role a legacy handoff body names, as a slug, or null when it names none. */
function bodyRoleId(body: Record<string, unknown>): string | null {
  return sanitizeRoleId(body['role_id']) ?? sanitizeRoleId(body['role']);
}

/**
 * Whether `entry` belongs to the caller. Decided by the FILENAME for keyed
 * files; a legacy unkeyed file is the caller's when its body names no role or
 * names the caller's. A caller with no session id owns nothing.
 */
export function isOwnHandoff(entry: { kind: HandoffKind; role_id: string | null; session_id: string | null; body?: Record<string, unknown> }, identity: Identity): boolean {
  if (identity.session_id === null) return false;
  switch (entry.kind) {
    case 'latest':
      return identity.role_id !== null && entry.role_id === identity.role_id;
    case 'session':
    case 'claimed':
      return entry.session_id === identity.session_id;
    case 'legacy': {
      const named = bodyRoleId(entry.body ?? {});
      return named === null || named === identity.role_id;
    }
    default:
      return false;
  }
}

// ─── Bounded reads ────────────────────────────────────────────────────────────

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unreadable';
}

type JsonObjectRead = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/** A regular, non-symlink, size-capped JSON object file; otherwise the reason it was refused. */
function readJsonObject(file: string): JsonObjectRead {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
  let text: string | null;
  try {
    text = readSmallRegularFile(file, HANDOFF_MAX_BYTES);
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
  if (text === null) return { ok: false, reason: 'ENOENT' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not a JSON object' };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
}

function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Every file named like a handoff under `planningDir`, with unreadable ones reported, never thrown. */
export function listHandoffs(planningDir: string): { handoffs: HandoffEntry[]; skipped: SkippedEntry[] } {
  const handoffs: HandoffEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const file of readDirNames(planningDir)) {
    const parsed = classifyHandoffName(file);
    if (parsed === null) continue;
    const read = readJsonObject(path.join(planningDir, file));
    if (!read.ok) { skipped.push({ file, reason: read.reason }); continue; }
    handoffs.push({ file, ...parsed, body: read.value });
  }
  return { handoffs, skipped };
}

function sessionsDirIsUsable(planningDir: string): boolean {
  try {
    const st = fs.lstatSync(path.join(planningDir, SESSIONS_DIR));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every `sessions/*.json` record under `planningDir`. */
export function listRecords(planningDir: string): { records: Array<Record<string, unknown> & { session_id: string; file: string }>; skipped: SkippedEntry[] } {
  const records: Array<Record<string, unknown> & { session_id: string; file: string }> = [];
  const skipped: SkippedEntry[] = [];
  if (!sessionsDirIsUsable(planningDir)) return { records, skipped };
  const dir = path.join(planningDir, SESSIONS_DIR);
  for (const file of readDirNames(dir)) {
    if (!file.endsWith(HANDOFF_SUFFIX)) continue;
    const read = readJsonObject(path.join(dir, file));
    if (!read.ok) { skipped.push({ file, reason: read.reason }); continue; }
    const stem = file.slice(0, file.length - HANDOFF_SUFFIX.length);
    const recorded = typeof read.value['session_id'] === 'string' ? read.value['session_id'] : stem;
    records.push({ ...read.value, session_id: recorded, file });
  }
  return { records, skipped };
}

/** The caller's own record, or null. */
export function readRecord(planningDir: string, sessionId: string | null): Record<string, unknown> | null {
  if (sessionId === null || !sessionsDirIsUsable(planningDir)) return null;
  const read = readJsonObject(path.join(planningDir, SESSIONS_DIR, `${sessionId}${HANDOFF_SUFFIX}`));
  return read.ok ? read.value : null;
}

// ─── Identity ─────────────────────────────────────────────────────────────────

export interface IdentityInput {
  session?: unknown;
  role?: unknown;
  role_id?: unknown;
  env?: Record<string, string | undefined>;
}

/**
 * Who is calling: the session id (flag, else runtime key), and the role slug
 * from `--role-id`, else `--role`, else the caller's own recorded role.
 */
export function resolveIdentity(planningDir: string, input: IdentityInput = {}): Identity & { role: string | null } {
  const session_id = resolveSessionId({ session: input.session, env: input.env });
  const prior = readRecord(planningDir, session_id);
  const role = typeof input.role === 'string' && input.role !== '' ? input.role : null;
  const priorRoleId = prior && typeof prior['role_id'] === 'string' ? sanitizeRoleId(prior['role_id']) : null;
  const role_id = roleIdFromFlags(input.role_id, role) ?? priorRoleId;
  return { session_id, role_id, role };
}

// ─── Listing for `state sessions` ─────────────────────────────────────────────

export interface ListedHandoff {
  file: string;
  kind: HandoffKind;
  role_id: string | null;
  session_id: string | null;
  is_self: boolean;
  continue_here_path: string | null;
}

function isRegularFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The pause view for the caller: every handoff and record, who owns each, and whether the caller is paused. */
export function listSessions(planningDir: string, identity: Identity, displayDir = '.planning') {
  const { handoffs, skipped } = listHandoffs(planningDir);
  const records = listRecords(planningDir);
  const listed: ListedHandoff[] = handoffs.map((h) => {
    const companion = companionOf(h);
    return {
      file: h.file,
      kind: h.kind,
      role_id: h.role_id,
      session_id: h.session_id,
      is_self: isOwnHandoff(h, identity),
      continue_here_path: companion !== null && isRegularFile(path.join(planningDir, companion)) ? `${displayDir}/${companion}` : null,
    };
  });
  return {
    session_id: identity.session_id,
    role_id: identity.role_id,
    paused: listed.some((h) => h.is_self),
    handoffs: listed,
    records: records.records.map((r) => ({
      file: r.file,
      session_id: r.session_id,
      role_id: typeof r['role_id'] === 'string' ? r['role_id'] : null,
      is_self: identity.session_id !== null && r.session_id === identity.session_id,
    })),
    skipped: [...skipped, ...records.skipped.map((s) => ({ file: `${SESSIONS_DIR}/${s.file}`, reason: s.reason }))],
  };
}

// ─── Consuming handoffs for `state session-resume` ────────────────────────────

export interface ConsumeResult {
  removed: string[];
  failed: SkippedEntry[];
  refused?: string;
}

function removeFile(planningDir: string, file: string, result: ConsumeResult): void {
  const target = path.join(planningDir, file);
  if (!isRegularFile(target)) return;
  try {
    fs.unlinkSync(target);
    result.removed.push(file);
  } catch (err) {
    result.failed.push({ file, reason: reasonOf(err) });
  }
}

function companionOf(entry: HandoffName): string | null {
  if (entry.kind === 'latest') return continueHereName(entry.role_id);
  if (entry.kind === 'legacy') return LEGACY_CONTINUE_HERE;
  return null;
}

/**
 * Remove the caller's own handoff(s) and their `.continue-here` companions.
 * With `adopt`, remove that one named handoff instead (a name that is not a
 * plain handoff file name is refused). With `keep`, remove nothing. A caller
 * with no session id removes nothing. Never throws: a failed unlink is data.
 */
export function consumeHandoffs(
  planningDir: string,
  identity: Identity,
  opts: { adopt?: string | null; keep?: boolean } = {},
): ConsumeResult {
  const result: ConsumeResult = { removed: [], failed: [] };
  if (opts.keep === true || identity.session_id === null) return result;
  if (typeof opts.adopt === 'string' && opts.adopt !== '') {
    const parsed = /[\\/]/.test(opts.adopt) ? null : classifyHandoffName(opts.adopt);
    if (parsed === null) {
      result.refused = 'not a handoff file name';
      return result;
    }
    // Adopting another session's handoff is the point of --handoff (a role-less session after
    // /clear takes over the old session's file), but a `claimed` file held by a DIFFERENT session
    // is a resume in progress: removing it would pull the handoff out from under that session.
    if (parsed.kind === 'claimed' && parsed.session_id !== identity.session_id) {
      result.refused = 'claimed by another session';
      return result;
    }
    removeFile(planningDir, opts.adopt, result);
    const companion = companionOf(parsed);
    if (companion !== null && result.removed.length > 0) removeFile(planningDir, companion, result);
    return result;
  }
  for (const entry of listHandoffs(planningDir).handoffs) {
    if (!isOwnHandoff(entry, identity)) continue;
    removeFile(planningDir, entry.file, result);
    const companion = companionOf(entry);
    if (companion !== null && result.removed.includes(entry.file)) removeFile(planningDir, companion, result);
  }
  return result;
}

// ─── Per-session record ───────────────────────────────────────────────────────

export interface RecordWriteResult {
  written: boolean;
  path?: string;
  reason?: string;
}

/**
 * Write or merge `.planning/sessions/<session_id>.json`. A field the caller
 * does not supply keeps its prior value. Refuses a symlinked or non-directory
 * `sessions/`, and a record path that is not a regular file; never throws.
 */
export function writeRecord(
  planningDir: string,
  update: { session_id: string | null } & Partial<Omit<SessionRecord, 'session_id'>>,
  displayDir = '.planning',
): RecordWriteResult {
  const sessionId = sanitizeSessionId(update.session_id);
  if (sessionId === null) return { written: false, reason: 'no usable session id' };
  const dir = path.join(planningDir, SESSIONS_DIR);
  try {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dir); } catch { st = null; }
    if (st === null) fs.mkdirSync(dir, { recursive: true });
    else if (st.isSymbolicLink() || !st.isDirectory()) return { written: false, reason: 'sessions is not a plain directory' };
    const file = path.join(dir, `${sessionId}${HANDOFF_SUFFIX}`);
    let exists = false;
    try { fs.lstatSync(file); exists = true; } catch { exists = false; }
    if (exists && !isRegularFile(file)) return { written: false, reason: 'record path is not a regular file' };
    const prior = exists ? readJsonObject(file) : null;
    const before: Record<string, unknown> = prior && prior.ok ? prior.value : {};
    // A field the caller passed (even null) wins; one it left out keeps the prior record's value.
    const pick = (key: string, incoming: string | null | undefined): string | null => {
      if (incoming !== undefined) return incoming;
      const kept = before[key];
      return typeof kept === 'string' ? kept : null;
    };
    const record: SessionRecord = {
      session_id: sessionId,
      role: pick('role', update.role),
      role_id: pick('role_id', update.role_id),
      stopped_at: pick('stopped_at', update.stopped_at),
      last_session: pick('last_session', update.last_session),
      resume_file: pick('resume_file', update.resume_file),
    };
    platformWriteSync(file, `${JSON.stringify(record, null, 2)}\n`, { atomic: true });
    // The record is per-machine state, never project content (cf. milestone.lock, #5551).
    excludeFromGit(planningDir, SESSIONS_DIR);
    return { written: true, path: `${displayDir}/${SESSIONS_DIR}/${sessionId}${HANDOFF_SUFFIX}` };
  } catch (err) {
    return { written: false, reason: reasonOf(err) };
  }
}
