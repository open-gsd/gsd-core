"use strict";
/**
 * external-job.cts — scheduler-adapter producer module for the async
 * external-job contract (#1164 / #1105).
 *
 * The CORE loop CONSUMES manifests at `.planning/async-jobs/<job>.json`
 * (#1165 — external_job_waiting half-state); this module is the Capability
 * half that PRODUCES them. SLURM is the first backend; the design stays
 * scheduler-pluggable via the `backend` field (planning-artifacts.md).
 *
 * Pure helpers (state map, build, validate, parsers) take no I/O; the writer
 * takes injected `fs` and `clock` seams so tests drive it without touching disk
 * or wall-clock time (CLAUDE.md clock-seam + injectable-deps conventions).
 *
 * Build: `src/*.cts` -> `gsd-core/bin/lib/*.cjs` (ADR-457 build-at-publish).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
// ─── Closed status enum (stability contract — Hyrum's Law) ────────────────────
const MANIFEST_VERSION = '1.0';
const MANIFEST_STATUS = [
    'submitted',
    'running',
    'completed-unverified',
    'failed',
    'cancelled',
    'timeout',
];
const NON_TERMINAL_STATUSES = ['submitted', 'running'];
const TERMINAL_FAILURE_STATUSES = ['failed', 'cancelled', 'timeout'];
// ─── SLURM state -> manifest status ───────────────────────────────────────────
//
// Source: SLURM job state codes (squeue/sacct State column). Producers for
// other backends map their own states onto the closed enum above; this table
// is SLURM-specific and lives behind the `backend: 'slurm'` field.
const SLURM_STATE_MAP = {
    PENDING: 'submitted',
    CONFIGURING: 'submitted',
    RUNNING: 'running',
    COMPLETING: 'running',
    COMPLETED: 'completed-unverified',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    OUT_OF_MEMORY: 'failed',
    BOOT_FAIL: 'failed',
    NODE_FAIL: 'failed',
    PREEMPTED: 'failed',
};
/**
 * Map a raw SLURM state string to the closed, scheduler-agnostic manifest
 * status. Case-insensitive; trims whitespace; strips a trailing by-part
 * ("CANCELLED by 1001" -> "CANCELLED"). Returns `null` for any unknown
 * state so the caller can decide whether to surface or fail — never guesses
 * (CLAUDE.md anti-guessing).
 */
function mapSlurmState(raw) {
    if (typeof raw !== 'string')
        return null;
    const key = raw.trim().toUpperCase();
    const head = key.split(/\s+/)[0];
    if (head && Object.prototype.hasOwnProperty.call(SLURM_STATE_MAP, head)) {
        return SLURM_STATE_MAP[head];
    }
    return null;
}
const REQUIRED_FIELDS = [
    'plan_id',
    'phase',
    'job_id',
    'backend',
    'submit_command',
    'status',
    'expected_artifacts',
    'verification_command',
    'resume_command',
];
function assertString(v, key) {
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`buildManifest: field "${key}" must be a non-empty string`);
    }
}
const STATUS_LIST = MANIFEST_STATUS;
/**
 * Build a versioned, frozen manifest. Stamps `version` and `submitted_at`
 * (via the injected clock seam) and normalises `terminal_details`:
 * `null` unless the status is a terminal failure AND details were supplied.
 * Throws on missing required fields or an out-of-enum status.
 */
function buildManifest(input, opts = {}) {
    const inputRecord = input;
    for (const key of REQUIRED_FIELDS) {
        const v = inputRecord[key];
        if (key === 'expected_artifacts') {
            if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
                throw new Error('buildManifest: field "expected_artifacts" must be a non-empty string[]');
            }
            continue;
        }
        assertString(v, key);
    }
    if (!STATUS_LIST.includes(input.status)) {
        throw new Error(`buildManifest: field "status" must be one of ${MANIFEST_STATUS.join(', ')}`);
    }
    const clock = opts.clock ?? { nowIso: () => new Date().toISOString() };
    const isTerminalFailure = TERMINAL_FAILURE_STATUSES.includes(input.status);
    const terminal_details = isTerminalFailure && input.terminal_details ? input.terminal_details : null;
    return Object.freeze({
        version: MANIFEST_VERSION,
        job_id: input.job_id,
        plan_id: input.plan_id,
        phase: input.phase,
        backend: input.backend,
        submit_command: input.submit_command,
        status: input.status,
        expected_artifacts: [...input.expected_artifacts],
        verification_command: input.verification_command,
        resume_command: input.resume_command,
        submitted_at: clock.nowIso(),
        terminal_details,
    });
}
/**
 * Producer-side schema validator — the mirror of the consumer trust boundary
 * (planning-artifacts.md). Producers MUST emit a manifest this accepts; the
 * core loop re-validates defensively on read.
 */
function validateManifest(value) {
    if (!value || typeof value !== 'object') {
        return { ok: false, errors: ['manifest must be an object'] };
    }
    const m = value;
    const errors = [];
    if (m.version !== MANIFEST_VERSION)
        errors.push(`version must be "${MANIFEST_VERSION}"`);
    for (const f of ['job_id', 'plan_id', 'phase', 'backend', 'submit_command', 'verification_command', 'resume_command', 'submitted_at']) {
        if (typeof m[f] !== 'string' || m[f].length === 0) {
            errors.push(`field "${f}" must be a non-empty string`);
        }
    }
    if (typeof m.status !== 'string' || !STATUS_LIST.includes(m.status)) {
        errors.push(`status must be one of ${MANIFEST_STATUS.join(', ')}`);
    }
    if (!Array.isArray(m.expected_artifacts) || !m.expected_artifacts.every((x) => typeof x === 'string')) {
        errors.push('expected_artifacts must be a string[]');
    }
    if (m.terminal_details !== null && typeof m.terminal_details !== 'object') {
        errors.push('terminal_details must be null or an object');
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
/**
 * Parse `sbatch --parsable` output. Accepts either a bare job id
 * (`"12345"`) or the `"12345;clustername"` form. Rejects prose like
 * `"Submitted batch job 12345"` (that is the non-parsable default format).
 */
function parseSbatchParsable(stdout) {
    if (typeof stdout !== 'string')
        return { ok: false, kind: 'non_string', raw: String(stdout) };
    const trimmed = stdout.trim();
    if (!trimmed)
        return { ok: false, kind: 'empty', raw: stdout };
    const head = trimmed.split(';')[0].split(/\s+/)[0];
    if (!/^\d+$/.test(head))
        return { ok: false, kind: 'not_numeric', raw: trimmed };
    return { ok: true, job_id: head };
}
/**
 * Parse a single `squeue` line of the form `"<jobid> <state>"`. Returns `null`
 * for a header or any row that does not have at least two tokens.
 */
function parseSqueueLine(line) {
    if (typeof line !== 'string')
        return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2)
        return null;
    const [job_id, state] = parts;
    if (!/^\d+$/.test(job_id))
        return null;
    return { job_id, state };
}
/**
 * Parse a `sacct -P` row given as pre-split columns where index 0 is the job
 * id and index 1 is the state. Returns `null` for malformed rows.
 */
function parseSacctRow(cols) {
    if (cols.length < 2)
        return null;
    const job_id = cols[0];
    const state = cols[1];
    if (typeof job_id !== 'string' || typeof state !== 'string')
        return null;
    if (!/^\d+$/.test(job_id))
        return null;
    return { job_id, state };
}
/**
 * Pure path projection: `.planning/async-jobs/<job_id>.json`.
 */
function manifestPath(planningDir, jobId) {
    return node_path_1.default.join(planningDir, 'async-jobs', `${jobId}.json`);
}
function _isNonTerminal(status) {
    return typeof status === 'string' && NON_TERMINAL_STATUSES.includes(status);
}
/**
 * Write a manifest to `.planning/async-jobs/<job_id>.json`.
 *
 * Fail-closed rules (mirror of the consumer contract, planning-artifacts.md):
 *  - If any existing manifest in the dir shares `plan_id` but has a different
 *    `job_id` AND is non-terminal -> refuse (`duplicate_plan_id`); dispatching
 *    again would duplicate the external job.
 *  - If the target file exists but is not valid JSON -> refuse
 *    (`malformed_existing`); never silently clobber.
 *  - Same `job_id` for the same `plan_id` -> allowed (status progression).
 *  - A prior job for the same `plan_id` that is already terminal -> allowed
 *    (the duplicate guard only protects against re-dispatching live work).
 */
function writeManifest(manifest, planningDir, opts = {}) {
    const fs = opts.fs ?? node_fs_1.default;
    const dir = node_path_1.default.join(planningDir, 'async-jobs');
    const target = manifestPath(planningDir, manifest.job_id);
    let names;
    try {
        fs.mkdirSync(dir, { recursive: true });
        names = fs.readdirSync(dir);
    }
    catch (e) {
        return { ok: false, kind: 'io_error', message: e.message };
    }
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        const p = node_path_1.default.join(dir, name);
        let raw;
        try {
            raw = String(fs.readFileSync(p));
        }
        catch {
            continue;
        }
        let existing;
        try {
            existing = JSON.parse(raw);
        }
        catch {
            if (p === target) {
                return { ok: false, kind: 'malformed_existing', message: `target manifest ${p} is not valid JSON` };
            }
            continue;
        }
        const samePlan = existing.plan_id === manifest.plan_id;
        const sameJob = existing.job_id === manifest.job_id;
        if (samePlan && !sameJob && _isNonTerminal(existing.status)) {
            return {
                ok: false,
                kind: 'duplicate_plan_id',
                message: `plan_id "${manifest.plan_id}" already has non-terminal job "${String(existing.job_id)}" at ${p}; dispatching again would duplicate the external job`,
            };
        }
    }
    try {
        fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
    }
    catch (e) {
        return { ok: false, kind: 'io_error', message: e.message };
    }
    return { ok: true, path: target };
}
module.exports = {
    MANIFEST_VERSION,
    MANIFEST_STATUS,
    NON_TERMINAL_STATUSES,
    TERMINAL_FAILURE_STATUSES,
    mapSlurmState,
    buildManifest,
    validateManifest,
    parseSbatchParsable,
    parseSqueueLine,
    parseSacctRow,
    writeManifest,
    manifestPath,
};
