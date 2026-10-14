/**
 * Per-session continuity records + handoff discovery for concurrent sessions
 * that share one `.planning/` (e.g. a coordinator, an implementer and a
 * reviewer all working the same repo at once).
 *
 * Why this exists:
 *   `STATE.md`'s `## Session` block (`Stopped at` / `Last session` /
 *   `Resume file`) and its frontmatter `status:` are project-wide,
 *   last-writer-wins values. With several sessions active, one session's
 *   pause used to flip everyone's statusline to `paused`, and there was no
 *   GSD path back out of it. Pause is therefore modelled PER SESSION:
 *
 *   - "this session is paused" == "a handoff file that belongs to this
 *     session exists under `.planning/`". No `status: paused` is written.
 *   - each session additionally keeps its own continuity record at
 *     `.planning/sessions/<session_id>.json` (written alongside — not
 *     instead of — the legacy `## Session` block, which many callers and
 *     tests still pin).
 *
 * Handoff filename forms (see workflows/pause-work.md `detect` step):
 *   HANDOFF.json                             legacy, unkeyed
 *   HANDOFF.<session_id>.json                session-id keyed (no role)
 *   HANDOFF.latest.<role_id>.json            role keyed, unclaimed
 *   HANDOFF.claimed.<role_id>.<session_id>.json  role keyed, claimed by a
 *                                            resuming session (renamed by
 *                                            resume-project.md before read)
 *
 * Session identity is resolved from `--session` or a runtime env key only.
 * There is deliberately NO controlling-TTY / tmux fallback (unlike
 * `getWorkstreamSessionKey`): two panes of one terminal are two sessions
 * here, and a wrong guess would delete another session's handoff.
 *
 * Modelled on src/milestone-lock.cts: every read is best-effort (corrupt JSON
 * → null, missing dir → empty), nothing here may throw into a state command.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realClock } from './clock.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- active-workstream-store.cjs is an export= CommonJS module
import activeWorkstreamStore = require('./active-workstream-store.cjs');

export const SESSIONS_DIR_NAME = 'sessions';
export const SESSION_RECORD_VERSION = 1;

/**
 * Runtime session-id env keys, most canonical first. A strict subset of
 * WORKSTREAM_SESSION_ENV_KEYS — terminal-identity keys (WT_SESSION,
 * TMUX_PANE, …) are intentionally absent: they survive `/clear` and would make
 * two consecutive sessions in one pane look like the same session.
 */
export const SESSION_ID_ENV_KEYS: readonly string[] = [
  'GSD_SESSION_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'GEMINI_SESSION_ID',
  'CURSOR_SESSION_ID',
  'WINDSURF_SESSION_ID',
];

export const HANDOFF_FILENAME_RE = /^HANDOFF(?:\.(.+))?\.json$/;

export interface SessionRecord {
  version: number;
  session_id: string;
  role: string | null;
  role_id: string | null;
  last_session: string | null;
  stopped_at: string | null;
  resume_file: string | null;
  updated_at: string;
}

export type SessionRecordPatch = Partial<Omit<SessionRecord, 'version' | 'session_id' | 'updated_at'>>;

export type HandoffKind = 'legacy' | 'session' | 'role' | 'claimed';

export interface HandoffEntry {
  path: string;
  file: string;
  kind: HandoffKind;
  /** Session id from the filename (session/claimed) or the JSON body (legacy). */
  session_id: string | null;
  /** Role slug from the filename (role/claimed) or the JSON body. */
  role_id: string | null;
  /** Verbatim role from the JSON body, when present. */
  role: string | null;
  timestamp: string | null;
}

export interface SessionView {
  session_id: string | null;
  role: string | null;
  role_id: string | null;
  paused: boolean;
  stopped_at: string | null;
  last_session: string | null;
  updated_at: string | null;
  handoff_path: string | null;
  handoff_kind: HandoffKind | null;
  continue_here_path: string | null;
  record_path: string | null;
  is_self: boolean;
  legacy: boolean;
}

export interface SessionIdentity {
  session_id: string | null;
  role_id: string | null;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe session id, or null. Rejects anything that is not a plain
 * basename (traversal via `../x` or `a/b`) and tokens with no alphanumerics
 * (`...`, `_`), so `sessions/<id>.json` can never escape the directory.
 */
export function sanitizeSessionId(raw: unknown): string | null {
  const token = activeWorkstreamStore.sanitizeWorkstreamSessionToken(raw);
  if (!token) return null;
  if (!/[A-Za-z0-9]/.test(token)) return null;
  if (path.basename(token) !== token) return null;
  return token;
}

/**
 * Role slug as pause-work.md derives it (`[a-z0-9-]+`): an explicit slug is
 * kept as-is when already clean; otherwise the verbatim role is lowercased and
 * non-alphanumerics collapsed to `-`. Null when nothing usable remains (e.g. a
 * non-ASCII role with no explicit slug).
 */
export function sanitizeRoleId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw : `${raw as number | boolean}`;
  const slug = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || !/[a-z0-9]/.test(slug)) return null;
  return slug.slice(0, 80);
}

/** `--session` wins; then the runtime env keys in order; else null. */
export function resolveSessionId(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const own = sanitizeSessionId(explicit);
  if (own) return own;
  if (explicit !== undefined && explicit !== null && `${explicit}`.trim() !== '') {
    // An explicit-but-unusable id must not silently fall through to the env
    // (the caller named a session; guessing a different one is worse than none).
    return null;
  }
  for (const key of SESSION_ID_ENV_KEYS) {
    const token = sanitizeSessionId(env[key]);
    if (token) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// session records: .planning/sessions/<sid>.json
// ---------------------------------------------------------------------------

function planningRoot(cwd: string): string {
  return path.join(cwd, '.planning');
}

export function sessionsDir(cwd: string): string {
  return path.join(planningRoot(cwd), SESSIONS_DIR_NAME);
}

export function sessionRecordPath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

function parseSessionRecord(raw: string | null | undefined, fallbackSid: string | null): SessionRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRecord> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const sid = typeof parsed.session_id === 'string' && parsed.session_id.trim() ? parsed.session_id : fallbackSid;
    if (!sid) return null;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      version: typeof parsed.version === 'number' ? parsed.version : SESSION_RECORD_VERSION,
      session_id: sid,
      role: str(parsed.role),
      role_id: str(parsed.role_id) ?? sanitizeRoleId(parsed.role),
      last_session: str(parsed.last_session),
      stopped_at: str(parsed.stopped_at),
      resume_file: str(parsed.resume_file),
      updated_at: str(parsed.updated_at) ?? '',
    };
  } catch {
    // Corrupt body (partial write, hand edit) — treat as absent; the next
    // upsert rewrites it. Never crash a state command over a sidecar.
    return null;
  }
}

export function readSessionRecord(cwd: string, sessionId: string | null | undefined): SessionRecord | null {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return null;
  try {
    return parseSessionRecord(fs.readFileSync(sessionRecordPath(cwd, sid), 'utf-8'), sid);
  } catch {
    return null;
  }
}

/**
 * Merge `patch` into the session's record (creating it) and persist. Fields
 * absent from `patch` keep their stored value — in particular `role` /
 * `role_id` survive a later heartbeat that does not restate them.
 */
export function upsertSessionRecord(
  cwd: string,
  sessionId: string,
  patch: SessionRecordPatch,
  nowIso: string = realClock.nowIso(),
): SessionRecord {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) throw new Error(`invalid session id: ${String(sessionId)}`);
  const existing = readSessionRecord(cwd, sid);
  const merged: SessionRecord = {
    version: SESSION_RECORD_VERSION,
    session_id: sid,
    role: existing?.role ?? null,
    role_id: existing?.role_id ?? null,
    last_session: existing?.last_session ?? null,
    stopped_at: existing?.stopped_at ?? null,
    resume_file: existing?.resume_file ?? null,
    updated_at: nowIso,
  };
  for (const key of ['role', 'role_id', 'last_session', 'stopped_at', 'resume_file'] as const) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  if (patch.role !== undefined && patch.role_id === undefined) {
    // A restated role re-derives its slug unless the caller pinned one.
    merged.role_id = sanitizeRoleId(patch.role);
  }
  try {
    fs.mkdirSync(sessionsDir(cwd), { recursive: true });
  } catch {
    /* best-effort — writeFileSync below reports the real failure */
  }
  fs.writeFileSync(sessionRecordPath(cwd, sid), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export function listSessionRecords(cwd: string): SessionRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir(cwd));
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -'.json'.length);
    const record = readSessionRecord(cwd, sid);
    if (record) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// handoffs: .planning/HANDOFF*.json
// ---------------------------------------------------------------------------

/** Filename pause-work.md writes for a role-less session (RAW id, not sanitized). */
export function handoffPathFor(cwd: string, sessionId: string): string {
  return path.join(planningRoot(cwd), `HANDOFF.${sessionId}.json`);
}

function classifyHandoffName(file: string): Pick<HandoffEntry, 'kind' | 'session_id' | 'role_id'> | null {
  const m = HANDOFF_FILENAME_RE.exec(file);
  if (!m) return null;
  const key = m[1];
  if (key === undefined) return { kind: 'legacy', session_id: null, role_id: null };
  let sub = /^latest\.(.+)$/.exec(key);
  if (sub) return { kind: 'role', session_id: null, role_id: sub[1] };
  sub = /^claimed\.([^.]+)\.(.+)$/.exec(key);
  if (sub) return { kind: 'claimed', session_id: sub[2], role_id: sub[1] };
  return { kind: 'session', session_id: key, role_id: null };
}

function readHandoffBody(filePath: string): { session_id: string | null; role: string | null; role_id: string | null; timestamp: string | null } {
  const empty = { session_id: null, role: null, role_id: null, timestamp: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    const sid = str(parsed['session_id']);
    return {
      session_id: sid && sid !== 'unknown' ? sid : null,
      role: str(parsed['role']),
      role_id: str(parsed['role_id']),
      timestamp: str(parsed['timestamp']),
    };
  } catch {
    return empty;
  }
}

export function listHandoffs(cwd: string): HandoffEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(planningRoot(cwd));
  } catch {
    return [];
  }
  const entries: HandoffEntry[] = [];
  for (const file of names.sort()) {
    const shape = classifyHandoffName(file);
    if (!shape) continue;
    const filePath = path.join(planningRoot(cwd), file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const body = readHandoffBody(filePath);
    entries.push({
      path: filePath,
      file,
      kind: shape.kind,
      session_id: shape.session_id ?? body.session_id,
      role_id: shape.role_id ?? body.role_id ?? sanitizeRoleId(body.role),
      role: body.role,
      timestamp: body.timestamp,
    });
  }
  return entries;
}

function sameSessionId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = sanitizeSessionId(a);
  const sb = sanitizeSessionId(b);
  return sa !== null && sa === sb;
}

/**
 * Does this handoff belong to `self`? A session-id match always counts; a
 * role match counts for role-keyed files (the role is the identity that
 * survives `/clear`). A legacy unkeyed file is only "ours" when its JSON body
 * says so — never by default.
 */
export function isOwnHandoff(entry: HandoffEntry, self: SessionIdentity): boolean {
  if (sameSessionId(entry.session_id, self.session_id)) return true;
  if (entry.kind === 'claimed') {
    // A claim names the session that took it; another session's claim is
    // theirs even when the role matches ours.
    return false;
  }
  if (self.role_id && entry.role_id && entry.role_id === self.role_id) return true;
  return false;
}

/** Resolve the caller's role slug: explicit → its own session record → null. */
export function resolveRoleId(cwd: string, sessionId: string | null, explicitRole?: string | null, explicitRoleId?: string | null): string | null {
  const pinned = sanitizeRoleId(explicitRoleId) ?? sanitizeRoleId(explicitRole);
  if (pinned) return pinned;
  const record = readSessionRecord(cwd, sessionId);
  return record?.role_id ?? null;
}

export function ownHandoffs(cwd: string, self: SessionIdentity): HandoffEntry[] {
  if (!self.session_id && !self.role_id) return [];
  return listHandoffs(cwd).filter((entry) => isOwnHandoff(entry, self));
}

export function ownHandoffExists(cwd: string, sessionId: string | null, roleId?: string | null): boolean {
  const self: SessionIdentity = {
    session_id: sessionId,
    role_id: roleId === undefined ? resolveRoleId(cwd, sessionId) : roleId,
  };
  return ownHandoffs(cwd, self).length > 0;
}

/**
 * The `.continue-here*.md` twin of a handoff — searched to the same depth as
 * resume-project.md's `find .planning -maxdepth 3`. Returns the first match
 * for the session id (`.continue-here.<sid>.md`) or role
 * (`.continue-here.latest.<role>.md` / `.continue-here.claimed.<role>.<sid>.md`).
 */
export function findContinueHere(cwd: string, self: SessionIdentity): string | null {
  const wanted = new Set<string>();
  if (self.session_id) wanted.add(`.continue-here.${self.session_id}.md`);
  if (self.role_id) wanted.add(`.continue-here.latest.${self.role_id}.md`);
  if (self.role_id && self.session_id) wanted.add(`.continue-here.claimed.${self.role_id}.${self.session_id}.md`);
  if (wanted.size === 0) return null;
  const root = planningRoot(cwd);
  const walk = (dir: string, depth: number): string | null => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of dirents) {
      if (d.isFile() && wanted.has(d.name)) return path.join(dir, d.name);
    }
    if (depth >= 3) return null;
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const hit = walk(path.join(dir, d.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 1);
}

// ---------------------------------------------------------------------------
// combined view
// ---------------------------------------------------------------------------

/**
 * Handoffs ∪ session records, joined by session id (or by role for role-keyed
 * handoffs whose owner has no record). `is_self` is computed against `self`
 * exactly like `isOwnHandoff`.
 */
export function listSessions(cwd: string, self: SessionIdentity): SessionView[] {
  const views: SessionView[] = [];
  const records = listSessionRecords(cwd);
  const recordBySid = new Map<string, SessionRecord>();
  for (const r of records) recordBySid.set(r.session_id, r);
  const consumed = new Set<string>();

  const recordFor = (entry: HandoffEntry): SessionRecord | null => {
    if (entry.session_id) {
      const direct = recordBySid.get(entry.session_id) ?? recordBySid.get(sanitizeSessionId(entry.session_id) ?? '');
      if (direct) return direct;
    }
    if (entry.role_id) {
      // Role-keyed handoff: the most recently updated record carrying that role.
      let best: SessionRecord | null = null;
      for (const r of records) {
        if (r.role_id !== entry.role_id) continue;
        if (!best || r.updated_at > best.updated_at) best = r;
      }
      return best;
    }
    return null;
  };

  for (const entry of listHandoffs(cwd)) {
    const record = recordFor(entry);
    if (record) consumed.add(record.session_id);
    const sid = entry.session_id ?? record?.session_id ?? null;
    const roleId = entry.role_id ?? record?.role_id ?? null;
    const isSelf = isOwnHandoff(entry, self);
    views.push({
      session_id: sid,
      role: entry.role ?? record?.role ?? null,
      role_id: roleId,
      paused: true,
      stopped_at: record?.stopped_at ?? null,
      last_session: record?.last_session ?? null,
      updated_at: record?.updated_at ?? entry.timestamp,
      handoff_path: entry.path,
      handoff_kind: entry.kind,
      continue_here_path: findContinueHere(cwd, { session_id: sid, role_id: roleId }),
      record_path: record ? sessionRecordPath(cwd, record.session_id) : null,
      is_self: isSelf,
      legacy: entry.kind === 'legacy',
    });
  }

  for (const record of records) {
    if (consumed.has(record.session_id)) continue;
    views.push({
      session_id: record.session_id,
      role: record.role,
      role_id: record.role_id,
      paused: false,
      stopped_at: record.stopped_at,
      last_session: record.last_session,
      updated_at: record.updated_at,
      handoff_path: null,
      handoff_kind: null,
      continue_here_path: null,
      record_path: sessionRecordPath(cwd, record.session_id),
      is_self: sameSessionId(record.session_id, self.session_id),
      legacy: false,
    });
  }
  return views;
}
