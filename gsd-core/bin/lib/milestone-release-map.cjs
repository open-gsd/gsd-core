"use strict";
/**
 * Milestone Release Map — validation, rendering and archive read-back for the
 * per-repository release record `milestone complete --release-map` persists
 * (#5706, phase 2 of epic #3628, docs/adr/3628-milestone-release-mapping.md).
 *
 * A release map is the caller-supplied record of what each repository shipped
 * for a milestone. It is data: this module never resolves a repository to a
 * directory, never consults `planning.sub_repos`, and never creates a tag. The
 * map is archived by recorded value, so a repository that later leaves
 * `planning.sub_repos` does not change an already-archived map.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELEASE_MAP_TAG_STATES = exports.RELEASE_MAP_STATUSES = exports.MAX_RELEASE_MAP_FILE_BYTES = exports.MAX_RELEASE_MAP_FIELD_LENGTH = exports.MAX_RELEASE_MAP_ENTRIES = void 0;
exports.validateReleaseMap = validateReleaseMap;
exports.renderReleaseMapMarkdown = renderReleaseMapMarkdown;
exports.releaseMapArchivePath = releaseMapArchivePath;
exports.serializeReleaseMapArchive = serializeReleaseMapArchive;
exports.loadReleaseMapFile = loadReleaseMapFile;
exports.readArchivedReleaseMap = readArchivedReleaseMap;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const security_cjs_1 = require("./security.cjs");
/** Maximum number of entries a single release map may carry. */
exports.MAX_RELEASE_MAP_ENTRIES = 256;
/** Maximum length (UTF-16 code units) of any single string field in an entry. */
exports.MAX_RELEASE_MAP_FIELD_LENGTH = 200;
/** Maximum size in bytes of a `--release-map` input file. */
exports.MAX_RELEASE_MAP_FILE_BYTES = 1048576;
/** Allowed values of an entry's `status`. */
exports.RELEASE_MAP_STATUSES = Object.freeze(['released', 'deployed', 'unreleased']);
/** Allowed values of an entry's `tag`. */
exports.RELEASE_MAP_TAG_STATES = Object.freeze(['created', 'already_tagged', 'skipped', 'none']);
const OPTIONAL_STRING_FIELDS = ['release', 'reference', 'environment'];
const ENTRY_FIELDS = Object.freeze(['repo', ...OPTIONAL_STRING_FIELDS, 'status', 'tag']);
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function describeType(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
/**
 * Validate a release map (an array of entries) and return the normalized
 * entries. Every problem is reported in one pass so a caller fixes the file
 * once. Strict on shape: unknown fields are an error, not silently dropped.
 */
function validateReleaseMap(input) {
    if (!Array.isArray(input)) {
        return { ok: false, errors: [`release map must be an array of entries (got ${describeType(input)})`] };
    }
    const errors = [];
    if (input.length > exports.MAX_RELEASE_MAP_ENTRIES) {
        errors.push(`release map has ${input.length} entries; the maximum is ${exports.MAX_RELEASE_MAP_ENTRIES}`);
    }
    const map = [];
    const seenRepos = new Set();
    const limit = Math.min(input.length, exports.MAX_RELEASE_MAP_ENTRIES);
    for (let i = 0; i < limit; i++) {
        const raw = input[i];
        const label = `entries[${i}]`;
        if (!isPlainObject(raw)) {
            errors.push(`${label} must be an object (got ${describeType(raw)})`);
            continue;
        }
        let entryOk = true;
        for (const key of Object.keys(raw)) {
            if (!ENTRY_FIELDS.includes(key)) {
                errors.push(`${label} has unknown field "${key.slice(0, exports.MAX_RELEASE_MAP_FIELD_LENGTH)}"`);
                entryOk = false;
            }
        }
        const repo = raw['repo'];
        if (typeof repo !== 'string' || repo.trim() === '') {
            errors.push(`${label}.repo must be a non-blank string`);
            entryOk = false;
        }
        else if (repo.length > exports.MAX_RELEASE_MAP_FIELD_LENGTH) {
            errors.push(`${label}.repo exceeds ${exports.MAX_RELEASE_MAP_FIELD_LENGTH} characters`);
            entryOk = false;
        }
        else if (seenRepos.has(repo)) {
            errors.push(`${label}.repo is a duplicate of an earlier entry`);
            entryOk = false;
        }
        else {
            seenRepos.add(repo);
        }
        const optional = {};
        for (const field of OPTIONAL_STRING_FIELDS) {
            const value = raw[field];
            if (value === undefined || value === null) {
                optional[field] = null;
            }
            else if (typeof value !== 'string') {
                errors.push(`${label}.${field} must be a string or null (got ${describeType(value)})`);
                entryOk = false;
            }
            else if (value.length > exports.MAX_RELEASE_MAP_FIELD_LENGTH) {
                errors.push(`${label}.${field} exceeds ${exports.MAX_RELEASE_MAP_FIELD_LENGTH} characters`);
                entryOk = false;
            }
            else {
                optional[field] = value;
            }
        }
        const status = raw['status'];
        if (typeof status !== 'string' || !exports.RELEASE_MAP_STATUSES.includes(status)) {
            errors.push(`${label}.status must be one of: ${exports.RELEASE_MAP_STATUSES.join(', ')}`);
            entryOk = false;
        }
        const tag = raw['tag'];
        if (typeof tag !== 'string' || !exports.RELEASE_MAP_TAG_STATES.includes(tag)) {
            errors.push(`${label}.tag must be one of: ${exports.RELEASE_MAP_TAG_STATES.join(', ')}`);
            entryOk = false;
        }
        if (entryOk) {
            map.push({
                repo: repo,
                release: optional['release'] ?? null,
                reference: optional['reference'] ?? null,
                environment: optional['environment'] ?? null,
                status: status,
                tag: tag,
            });
        }
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return { ok: true, map };
}
/**
 * Escape one value for a GFM table cell: a pipe, newline, backtick, angle
 * bracket or other markdown control character in recorded data can neither
 * end the cell, start a new row, nor inject structure (headings, HTML).
 */
function escapeCell(value) {
    if (value === null)
        return '-';
    const flattened = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    if (flattened === '')
        return '-';
    const escaped = flattened.replace(/[\\|`*_[\]<>&~#!]/g, (ch) => {
        if (ch === '<')
            return '&lt;';
        if (ch === '>')
            return '&gt;';
        if (ch === '&')
            return '&amp;';
        return `\\${ch}`;
    });
    return escaped;
}
/**
 * Render a validated release map as the `**Release mapping:**` markdown block
 * appended to a MILESTONES.md entry. One table row per entry, always six cells.
 */
function renderReleaseMapMarkdown(map) {
    const lines = [
        '**Release mapping:**',
        '',
        '| Repository | Release | Reference | Environment | Status | Tag |',
        '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const entry of map) {
        lines.push(`| ${escapeCell(entry.repo)} | ${escapeCell(entry.release)} | ${escapeCell(entry.reference)} | ${escapeCell(entry.environment)} | ${escapeCell(entry.status)} | ${escapeCell(entry.tag)} |`);
    }
    return `${lines.join('\n')}\n`;
}
/** Path of the archived release map for a milestone version. */
function releaseMapArchivePath(milestonesDir, version) {
    return node_path_1.default.join(milestonesDir, `${version}-RELEASE-MAP.json`);
}
/** Serialize the archive document `{ version, entries }`. */
function serializeReleaseMapArchive(version, map) {
    return `${JSON.stringify({ version, entries: map }, null, 2)}\n`;
}
/**
 * Read and validate a caller-supplied `--release-map` file. Refuses anything
 * that is not a regular file (directory, FIFO, device), anything over 1 MiB and
 * anything unreadable or unparseable, without ever opening a non-regular file.
 */
function loadReleaseMapFile(filePath) {
    let stat;
    try {
        stat = node_fs_1.default.statSync(filePath);
    }
    catch (err) {
        const code = err.code ?? 'unknown';
        return { ok: false, errors: [`release map file cannot be read (${code}): ${node_path_1.default.basename(filePath)}`] };
    }
    if (!stat.isFile()) {
        return { ok: false, errors: [`release map path is not a regular file: ${node_path_1.default.basename(filePath)}`] };
    }
    if (stat.size > exports.MAX_RELEASE_MAP_FILE_BYTES) {
        return { ok: false, errors: [`release map file is ${stat.size} bytes; the maximum is ${exports.MAX_RELEASE_MAP_FILE_BYTES}`] };
    }
    let text;
    try {
        text = node_fs_1.default.readFileSync(filePath, 'utf-8');
    }
    catch (err) {
        const code = err.code ?? 'unknown';
        return { ok: false, errors: [`release map file cannot be read (${code}): ${node_path_1.default.basename(filePath)}`] };
    }
    const parsed = (0, security_cjs_1.safeJsonParse)(text, { maxLength: exports.MAX_RELEASE_MAP_FILE_BYTES, label: 'release map' });
    if (!parsed.ok) {
        return { ok: false, errors: [parsed.error ?? 'release map: invalid JSON'] };
    }
    return validateReleaseMap(parsed.value);
}
/**
 * Read a milestone's archived release map back by recorded value. A milestone
 * archived without a map yields `{ ok: true, map: null }` ("no map"), never an
 * error; a present-but-corrupt archive is reported, not guessed at.
 */
function readArchivedReleaseMap(milestonesDir, version) {
    const file = releaseMapArchivePath(milestonesDir, version);
    let text;
    try {
        text = node_fs_1.default.readFileSync(file, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return { ok: true, map: null };
        return { ok: false, error: `release map archive cannot be read: ${node_path_1.default.basename(file)}` };
    }
    const parsed = (0, security_cjs_1.safeJsonParse)(text, { maxLength: exports.MAX_RELEASE_MAP_FILE_BYTES, label: 'release map archive' });
    if (!parsed.ok)
        return { ok: false, error: parsed.error ?? 'release map archive: invalid JSON' };
    const doc = parsed.value;
    if (!isPlainObject(doc))
        return { ok: false, error: 'release map archive: expected an object' };
    const validated = validateReleaseMap(doc['entries']);
    if (!validated.ok)
        return { ok: false, error: validated.errors.join('; ') };
    return { ok: true, map: validated.map };
}
