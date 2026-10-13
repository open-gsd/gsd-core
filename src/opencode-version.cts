/**
 * OpenCode generation detection (ADR-5331 D2, D5; epic #5331, Phase 1 #5337).
 *
 * OpenCode 1.x and 2.x share one command name (`opencode`), one set of config
 * locations and cannot be installed side by side, so GSD's `opencode` runtime
 * cannot tell them apart from the descriptor alone. This module answers one
 * question — "which generation is installed?" — and adapts the two spawn-time
 * argument shapes that differ between generations.
 *
 * Evidence (ADR-5331 evidence register; reproduced against the real binaries):
 *   E2  `opencode --version` prints `1.19.0` on 1.x and `opencode v2.0.27` on 2.x.
 *   E3  2.x `opencode run` has no `--dir` and no `--variant`; both exit 1 with usage.
 *       Effort travels as a `#variant` suffix on `--model provider/model#variant`.
 *
 * What this module deliberately does NOT do:
 *   - It does not infer 1.x from config. 2.x reads GSD's 1.x-shaped keys in place
 *     (E7), so a 1.x-shaped config proves nothing about the binary. Only 2.x-shaped
 *     keys (or `cli.json`) are evidence, and only for generation 2.
 *   - It does not guess. An unresolvable generation is `null`, and callers keep
 *     today's behavior.
 *   - It does not apply to Kilo. Kilo is a fork on the OpenCode 1.x line with its
 *     own binary (ADR-5331 D7); callers gate on the `opencode` runtime / lane slug.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { configString } from './review-lane-invocation.cjs';
import { envGet } from './shell-command-projection.cjs';

/** Environment variable that forces a generation (`1` or `2`), bypassing the probe. */
export const OPENCODE_GENERATION_ENV = 'GSD_OPENCODE_GENERATION';

/** Generations GSD distinguishes. A future major is treated as `2` until verified (ADR-5331 D2). */
export type OpencodeGeneration = 1 | 2;

export interface ParsedOpencodeVersion {
  /** Bare semver, e.g. `2.0.27` (any `opencode ` prefix and leading `v` removed). */
  version: string;
  major: number;
}

// One whole line: optional `opencode` word, optional `v`, semver with optional
// pre-release/build. Both observed outputs (`1.19.0`, `opencode v2.0.27`) match;
// log noise, banners and multi-token lines do not.
const VERSION_LINE = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)((?:[-+][0-9A-Za-z.+-]+)?)$/i;

/**
 * Parse the stdout of `opencode --version`.
 *
 * Only the first non-empty line is considered, and it must be a version and
 * nothing else. Returns `null` for anything unparseable rather than guessing.
 */
export function parseOpencodeVersion(raw: unknown): ParsedOpencodeVersion | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (first === undefined) return null;
  const m = VERSION_LINE.exec(first);
  if (!m) return null;
  const major = Number(m[1]);
  if (!Number.isSafeInteger(major)) return null;
  return { version: `${m[1]}.${m[2]}.${m[3]}${m[4]}`, major };
}

/** Map a parsed major to a generation. Major 0 is not a shipped OpenCode line → `null`. */
export function generationForMajor(major: number): OpencodeGeneration | null {
  if (!Number.isInteger(major) || major < 1) return null;
  return major === 1 ? 1 : 2;
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export type ProbeFailureReason = 'missing' | 'timeout' | 'nonzero' | 'unparseable' | 'error';

export type OpencodeProbe =
  | { ok: true; version: string; major: number; raw: string }
  | { ok: false; reason: ProbeFailureReason; detail: string };

/** The slice of `child_process.spawnSync`'s result this module reads. */
export interface SpawnResultLike {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: (Error & { code?: string }) | undefined;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    shell: false;
    windowsHide: true;
    maxBuffer: number;
    stdio: ['ignore', 'pipe', 'pipe'];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  },
) => SpawnResultLike;

export interface ProbeOptions {
  /** Executable to run. Defaults to `opencode` (resolved through PATH by the OS). */
  binary?: string;
  /** Hard bound on the child; `--version` returns immediately on both generations (E2). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injected for tests. Defaults to `child_process.spawnSync`. */
  spawn?: SpawnLike;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const PROBE_OUTPUT_LIMIT = 1 << 16;

function text(v: string | Buffer | null | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : v.toString('utf8');
}

/** Single-line, length-bounded excerpt for diagnostics; never echoes control characters. */
function excerpt(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
}

/**
 * Run `<binary> --version` and parse the result.
 *
 * Argv only, never a shell: the binary name is the sole variable and is not
 * interpolated into a command string. Never throws.
 */
export function probeOpencodeVersion(opts: ProbeOptions = {}): OpencodeProbe {
  const binary = typeof opts.binary === 'string' && opts.binary.length > 0 ? opts.binary : 'opencode';
  const timeout =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;
  const spawn: SpawnLike = opts.spawn ?? nodeSpawnSync;

  let result: SpawnResultLike;
  try {
    result = spawn(binary, ['--version'], {
      encoding: 'utf8',
      timeout,
      shell: false,
      windowsHide: true,
      maxBuffer: PROBE_OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch (e) {
    return { ok: false, reason: 'error', detail: excerpt(e instanceof Error ? e.message : String(e)) };
  }

  if (result.error) {
    const code = result.error.code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return { ok: false, reason: 'missing', detail: `${binary}: ${code}` };
    }
    if (code === 'ETIMEDOUT') {
      return { ok: false, reason: 'timeout', detail: `${binary} --version exceeded ${timeout}ms` };
    }
    return { ok: false, reason: 'error', detail: excerpt(result.error.message) };
  }
  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
    return { ok: false, reason: 'timeout', detail: `${binary} --version exceeded ${timeout}ms` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'nonzero', detail: `${binary} --version exited ${String(result.status)}` };
  }

  const raw = text(result.stdout);
  const parsed = parseOpencodeVersion(raw);
  if (!parsed) {
    return { ok: false, reason: 'unparseable', detail: `unrecognized output: ${excerpt(raw)}` };
  }
  return { ok: true, version: parsed.version, major: parsed.major, raw: raw.trim() };
}

// ─── Config signals (generation 2 only) ──────────────────────────────────────

export interface SignalsFs {
  exists(p: string): boolean;
}

export interface SignalsOptions {
  fs?: SignalsFs;
  /** The OpenCode config directory (`~/.config/opencode`, `./.opencode`, …). */
  configDir: string;
  /**
   * Parsed `opencode.json(c)` from `configDir`, or `null`/`undefined` when absent or unparseable.
   * Parsing stays with the caller (the installer owns the JSONC reader).
   */
  config?: unknown;
}

export interface GenerationSignals {
  /** `2` when at least one 2.x-only signal is present; otherwise `null` (absence proves nothing). */
  generation: 2 | null;
  evidence: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Look for evidence that a 2.x binary has been (or is being) used with this config.
 *
 * Positive evidence only: `cli.json` is created by 2.x on first start, and the
 * following keys exist only in the native 2.x shape ([migrate-v1] renames):
 * `plugins[]`, `agents{}`, `commands{}`, `permissions[]`, `skills[]`,
 * `providers{}`, `snapshots`, `media{}` and `mcp.servers{}`. 1.x-shaped keys are
 * deliberately not evidence of generation 1: 2.x reads them unchanged (E7).
 */
export function detectGenerationSignals(opts: SignalsOptions): GenerationSignals {
  const fs: SignalsFs = opts.fs ?? { exists: (p) => nodeFs.existsSync(p) };
  const evidence: string[] = [];

  if (typeof opts.configDir === 'string' && opts.configDir.length > 0) {
    try {
      if (fs.exists(path.join(opts.configDir, 'cli.json'))) evidence.push('cli.json');
    } catch {
      /* an unreadable directory is simply no evidence */
    }
  }

  const cfg = opts.config;
  if (isPlainObject(cfg)) {
    if (Array.isArray(cfg['plugins'])) evidence.push('plugins[]');
    if (isPlainObject(cfg['agents'])) evidence.push('agents{}');
    if (isPlainObject(cfg['commands'])) evidence.push('commands{}');
    if (Array.isArray(cfg['permissions'])) evidence.push('permissions[]');
    if (Array.isArray(cfg['skills'])) evidence.push('skills[]');
    if (isPlainObject(cfg['providers'])) evidence.push('providers{}');
    if (typeof cfg['snapshots'] === 'boolean') evidence.push('snapshots');
    if (isPlainObject(cfg['media'])) evidence.push('media{}');
    const mcp = cfg['mcp'];
    if (isPlainObject(mcp) && isPlainObject(mcp['servers'])) evidence.push('mcp.servers{}');
  }

  return { generation: evidence.length > 0 ? 2 : null, evidence };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export type GenerationSource = 'override' | 'probe' | 'signals' | 'unknown';

export interface ResolvedGeneration {
  generation: OpencodeGeneration | null;
  /** Bare version string when the probe succeeded. */
  version: string | null;
  source: GenerationSource;
  /** Human-readable reason, for logs and the installer notice. */
  detail: string | null;
}

/** Accepts `1`, `2`, `v1`, `v2`, `opencode2`… in any case; anything else is not an override. */
export function parseGenerationOverride(raw: unknown): OpencodeGeneration | null {
  if (typeof raw === 'number') return raw === 1 || raw === 2 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = /^\s*(?:opencode\s*)?v?([12])\s*$/i.exec(raw);
  return m ? (Number(m[1]) as OpencodeGeneration) : null;
}

export interface ResolveInputs {
  /** An explicit choice (CLI flag value or `GSD_OPENCODE_GENERATION`). Wins over everything. */
  override?: unknown;
  probe?: OpencodeProbe | null;
  signals?: GenerationSignals | null;
}

/**
 * Combine the evidence in precedence order: explicit override → probe → config
 * signals → unknown. Pure; the caller supplies already-gathered evidence.
 */
export function resolveOpencodeGeneration(inputs: ResolveInputs): ResolvedGeneration {
  const notes: string[] = [];

  if (inputs.override !== undefined && inputs.override !== null && inputs.override !== '') {
    const forced = parseGenerationOverride(inputs.override);
    if (forced !== null) {
      return { generation: forced, version: null, source: 'override', detail: `forced to ${forced}.x` };
    }
    notes.push(`ignored invalid generation override ${JSON.stringify(typeof inputs.override === 'string' ? inputs.override : typeof inputs.override).slice(0, 40)}`);
  }

  const probe = inputs.probe;
  if (probe) {
    if (probe.ok) {
      const gen = generationForMajor(probe.major);
      if (gen !== null) {
        return { generation: gen, version: probe.version, source: 'probe', detail: notes.join('; ') || null };
      }
      notes.push(`opencode --version reported unsupported major ${probe.major}`);
    } else {
      notes.push(`probe ${probe.reason}: ${probe.detail}`);
    }
  }

  const signals = inputs.signals;
  if (signals && signals.generation !== null) {
    notes.push(`2.x config signals: ${signals.evidence.join(', ')}`);
    return { generation: signals.generation, version: null, source: 'signals', detail: notes.join('; ') };
  }

  return {
    generation: null,
    version: null,
    source: 'unknown',
    detail: notes.length > 0 ? notes.join('; ') : 'no evidence gathered',
  };
}

// ─── Memoized detection for spawn-time callers ───────────────────────────────

let memo: { key: string; value: ResolvedGeneration } | null = null;

/** Test hook: forget the memoized detection. */
export function resetOpencodeGenerationMemo(): void {
  memo = null;
}

/**
 * Detect the installed generation once per process.
 *
 * For callers that build a `opencode run …` command line (worktree dispatch,
 * the reviewer lane): the override environment variable wins, then one
 * `--version` probe, memoized so a multi-lane review spawns it once.
 */
export function detectOpencodeGeneration(
  opts: ProbeOptions & { overrideEnv?: NodeJS.ProcessEnv } = {},
): ResolvedGeneration {
  const env = opts.overrideEnv ?? process.env;
  const override = env[OPENCODE_GENERATION_ENV];
  const key = `${opts.binary ?? 'opencode'}\u0000${String(override ?? '')}`;
  if (memo && memo.key === key) return memo.value;
  const value = resolveOpencodeGeneration({
    override,
    probe: parseGenerationOverride(override) !== null ? null : probeOpencodeVersion(opts),
  });
  memo = { key, value };
  return value;
}

// ─── Spawn-time adapters (generation 2) ──────────────────────────────────────

interface OrchestratorExecLike {
  cwdFlag?: string | null;
  [k: string]: unknown;
}

/**
 * 2.x `opencode run` has no `--dir` (E3), so a descriptor that binds the worktree
 * through `--dir` must bind it through the spawned process's own working directory
 * instead — the "process-cwd" shape `resolveOrchestratorExec` already supports
 * (`cwdFlag: null`, as for Kimi Code). Every other descriptor and generation is
 * returned untouched.
 */
export function adaptOrchestratorExecForGeneration<T extends OrchestratorExecLike>(
  orchestratorExec: T | undefined | null,
  generation: OpencodeGeneration | null,
): T | undefined | null {
  if (generation !== 2) return orchestratorExec;
  if (!orchestratorExec || typeof orchestratorExec !== 'object') return orchestratorExec;
  if (orchestratorExec.cwdFlag !== '--dir') return orchestratorExec;
  return { ...orchestratorExec, cwdFlag: null };
}

interface LaneInputLike {
  lane?: { slug?: unknown; modelConfigKey?: unknown } | null;
  configGet: (key: string) => unknown;
  effortArgs?: readonly string[];
  effortValue?: string | null;
  [k: string]: unknown;
}

export interface AdaptedLaneInput<T extends LaneInputLike> {
  input: T;
  /** Operator-facing notes (an effort level that cannot be expressed on 2.x). */
  warnings: string[];
}

/**
 * Adapt an OpenCode reviewer-lane resolution input for generation 2.
 *
 * 2.x rejects `--variant` (E3); a reasoning effort rides on the model reference
 * instead (`provider/model#variant`, [D8] / [D5]). So for the `opencode` lane:
 *   - the `--variant` argv is dropped;
 *   - when an effort level and a configured model both exist, the model is
 *     returned from `configGet` with `#<level>` appended (never doubled: a model
 *     that already carries a `#variant` is the operator's explicit choice);
 *   - when an effort level exists but no model is configured, nothing can carry
 *     it, so the level is dropped and a warning says so.
 * Any other lane, and generation 1 / unknown, is returned unchanged.
 */
export function adaptLaneInputForGeneration<T extends LaneInputLike>(
  input: T,
  generation: OpencodeGeneration | null,
): AdaptedLaneInput<T> {
  const warnings: string[] = [];
  if (generation !== 2) return { input, warnings };
  const lane = input.lane;
  if (!lane || lane.slug !== 'opencode') return { input, warnings };

  const modelKey = typeof lane.modelConfigKey === 'string' ? lane.modelConfigKey : null;
  const effort = typeof input.effortValue === 'string' && input.effortValue.length > 0 ? input.effortValue : null;
  const hadEffortArgs = Array.isArray(input.effortArgs) && input.effortArgs.length > 0;

  let configGet = input.configGet;
  if (effort !== null && modelKey !== null) {
    const configured = configString(input.configGet(modelKey));
    if (configured === null) {
      warnings.push(
        `reasoning effort '${effort}' not applied to the OpenCode reviewer: OpenCode 2.x has no --variant ` +
          `flag and no model is configured to carry a #variant. Set a model to apply it.`,
      );
    } else if (!configured.includes('#')) {
      const original = input.configGet;
      configGet = (key: string): unknown =>
        key === modelKey ? `${configured}#${effort}` : original(key);
    }
  } else if (effort !== null) {
    warnings.push(
      `reasoning effort '${effort}' not applied to the OpenCode reviewer: the lane declares no model key to carry a #variant.`,
    );
  }

  if (!hadEffortArgs && configGet === input.configGet && warnings.length === 0) {
    return { input, warnings };
  }
  return { input: { ...input, configGet, effortArgs: [] }, warnings };
}

interface LanePlanResultLike {
  ok?: unknown;
  plan?: { slug?: unknown; stdin?: unknown; argv?: unknown } | null;
  [k: string]: unknown;
}

/**
 * 2.x `opencode run` treats a trailing `-` as message text, not as a "read stdin" marker: the model
 * receives `-\n<prompt>` (verified on 2.0.27, E12). Piped stdin is read either way (E4), so for a
 * stdin-fed opencode plan on generation 2 the marker is dropped and the run is made `--standalone`.
 * Everything else is untouched.
 */
export function adaptLanePlanForGeneration<T extends LanePlanResultLike>(
  result: T,
  generation: OpencodeGeneration | null,
): T {
  if (generation !== 2 || !result || result.ok !== true || !result.plan) return result;
  const plan = result.plan;
  if (plan.slug !== 'opencode' || plan.stdin === null || plan.stdin === undefined) return result;
  const argv = plan.argv;
  if (!Array.isArray(argv)) return result;
  let next: unknown[] = argv;
  if (next[next.length - 1] === '-') next = next.slice(0, -1);
  // `--standalone` ("Run with a private server instead of the background service", `opencode run
  // --help` on 2.0.27): without it `run` attaches to a long-lived managed service on a fixed port
  // that outlives the review, serves whichever config it booted with, and fails when another
  // process holds the port. A review is one-shot, so it gets its own server.
  const runIdx = next.indexOf('run');
  if (runIdx !== -1 && !next.includes('--standalone')) {
    next = [...next.slice(0, runIdx + 1), '--standalone', ...next.slice(runIdx + 1)];
  }
  if (next === argv) return result;
  return { ...result, plan: { ...plan, argv: next } };
}

// ─── Data-directory rollback hazard (ADR-5331 D6, E8) ────────────────────────

/**
 * `v1`: 1.x tables only. `v2`: 2.x tables only (1.x cannot open it). `both`: 2.x added its tables beside an
 * existing 1.x database (1.x keeps working). `empty`: no database or no tables. `unknown`: unreadable/unrecognized.
 */
export type OpencodeDataKind = 'v1' | 'v2' | 'both' | 'empty' | 'unknown';

/** Reads the table names of an SQLite database, or `null` when it cannot be opened. */
export type TableReader = (dbPath: string) => string[] | null;

/**
 * Default reader: `node:sqlite`, read-only. Its schema lives in the write-ahead log until a checkpoint,
 * so reading the main file's bytes would see an empty database; SQLite itself merges both. The module
 * prints an ExperimentalWarning on some Node versions, which is swallowed for the duration of the read.
 * Any failure (module missing, file locked or corrupt) is `null`, never a throw.
 */
function readTableNames(dbPath: string): string[] | null {
  const emit = process.emitWarning.bind(process);
  try {
    process.emitWarning = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (p: string, o: { readOnly: boolean }) => {
        prepare(sql: string): { all(): Array<{ name: string }> };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Which generation(s) built an OpenCode database. 1.x keeps sessions in a `session` table; 2.x in
 * `session_v2`. A database 2.x created from scratch has no `session` table and 1.x cannot open it; a 1.x
 * database that 2.x later used gains the 2.x tables beside `session` and 1.x keeps working — both
 * reproduced on 1.18.29 and 2.0.27 (ADR-5331 E8, E18). GSD only reads the schema; it never writes to this
 * database.
 */
export function classifyOpencodeDatabase(
  dbPath: string,
  deps: { exists?: (p: string) => boolean; readTables?: TableReader } = {},
): OpencodeDataKind {
  const exists = deps.exists ?? ((p: string) => nodeFs.existsSync(p));
  if (!exists(dbPath)) return 'empty';
  const names = (deps.readTables ?? readTableNames)(dbPath);
  if (names === null) return 'unknown';
  const v1 = names.includes('session');
  const v2 = names.includes('session_v2');
  if (v1 && v2) return 'both';
  if (v2) return 'v2';
  if (v1) return 'v1';
  return names.length === 0 ? 'empty' : 'unknown';
}

/**
 * The directory holding `opencode.db`: the `data` entry of `opencode debug paths` (the binary's own
 * answer, identical on 1.x and 2.x), else the XDG default every OpenCode generation shares.
 */
export function resolveOpencodeDataDir(opts: ProbeOptions & { home?: string } = {}): string {
  const spawn: SpawnLike = opts.spawn ?? nodeSpawnSync;
  const binary = typeof opts.binary === 'string' && opts.binary.length > 0 ? opts.binary : 'opencode';
  try {
    const r = spawn(binary, ['debug', 'paths'], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      shell: false,
      windowsHide: true,
      maxBuffer: PROBE_OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env } : {}),
    });
    if (!r.error && r.status === 0) {
      const m = /^data[ \t]+(.+?)[ \t]*$/m.exec(text(r.stdout));
      if (m && m[1] && path.isAbsolute(m[1])) return m[1];
    }
  } catch {
    /* fall through to the XDG default */
  }
  const env = opts.env ?? process.env;
  const home = opts.home ?? envGet(env, 'HOME') ?? envGet(env, 'USERPROFILE') ?? '';
  const xdgData = envGet(env, 'XDG_DATA_HOME');
  const base = xdgData && path.isAbsolute(xdgData) ? xdgData : path.join(home, '.local', 'share');
  return path.join(base, 'opencode');
}

export interface DataDirNotice {
  /** `warn`: the installed binary cannot open the data directory. `info`: worth knowing, nothing is broken. */
  level: 'warn' | 'info';
  text: string;
}

/**
 * What to tell the operator about the data directory, given the installed generation and the schema
 * generation(s) found there; `null` when there is nothing to say.
 */
export function describeDataDirNotice(
  generation: OpencodeGeneration | null,
  kind: OpencodeDataKind,
  dataDir: string,
): DataDirNotice | null {
  if (generation === 1 && kind === 'v2') {
    return {
      level: 'warn',
      text:
        `OpenCode 1.x is installed but its data directory (${dataDir}) was created by OpenCode 2.x. ` +
        "1.x cannot open it (\"Database is not empty and has no session table\"). Reinstall 2.x, or restore a " +
        'backup of the data directory taken before 2.x first ran. GSD never modifies this database.',
    };
  }
  if (generation === 1 && kind === 'both') {
    return {
      level: 'info',
      text:
        `OpenCode 2.x has also used the data directory (${dataDir}); it keeps its sessions in its own tables ` +
        'beside the 1.x ones, and 1.x still opens it.',
    };
  }
  if (generation === 2 && kind === 'v1') {
    return {
      level: 'info',
      text:
        `OpenCode 2.x will add its own tables to the data directory (${dataDir}) beside the 1.x ones; ` +
        'OpenCode 1.x still opens it afterwards. A data directory that 2.x creates from scratch, by contrast, ' +
        'cannot be opened by 1.x.',
    };
  }
  return null;
}

/**
 * End of the OpenCode 1.x bug-fix-only window (ADR-5331 D7, epic #5331 Phase 3). A maintainer decision:
 * 1.x receives fixes until this date, after which Phase 4 removes the 1.x paths for the `opencode` runtime.
 * Kilo is a separate runtime on the 1.x line and is not affected.
 */
export const OPENCODE_V1_FREEZE_DATE = '2026-12-31';

/**
 * The deprecation notice shown when the installed `opencode` binary is OpenCode 1.x; `null` for 2.x and for an
 * undetected generation. The upgrade commands are the binary's own: `opencode upgrade --major` is a flag of
 * 1.19.0 (absent from 1.18.29) ("upgrade to OpenCode 2 and remove OpenCode 1"), and the V2 installer and package replace the 1.x binary
 * (https://opencode.ai/v2/docs/migrate-v1/).
 */
export function describeDeprecationNotice(generation: OpencodeGeneration | null): string | null {
  if (generation !== 1) return null;
  return (
    `OpenCode 1.x is deprecated for GSD: it receives bug fixes only until ${OPENCODE_V1_FREEZE_DATE}, after which ` +
    'GSD supports OpenCode 2.x only. Upgrade with `opencode upgrade --major` (OpenCode 1.19 and newer), or install ' +
    'OpenCode 2 (`curl -fsSL https://opencode.ai/v2/install | bash`, or `npm install -g @opencode/cli`) and re-run the GSD installer. ' +
    'Your configuration is read in place by 2.x. Kilo is not affected.'
  );
}
