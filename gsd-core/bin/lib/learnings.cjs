"use strict";
/**
 * Learnings — Global knowledge store with CRUD operations
 *
 * Provides a cross-project learnings store at ~/.gsd/knowledge/.
 * Each learning is stored as an individual JSON file with content-hash
 * deduplication. Supports write, read, list, query, delete, copy-from-project,
 * and prune operations.
 *
 * Storage format: { id, source_project, date, context, learning, tags, content_hash }
 * File naming: {id}.json
 * Deduplication: SHA-256 of learning text + source_project
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/learnings.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseLocator = require("./phase-locator.cjs");
const node_os_1 = __importDefault(require("node:os"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { output, error: coreError } = ioMod;
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_STORE_DIR = node_path_1.default.join(node_os_1.default.homedir(), '.gsd', 'knowledge');
// ─── Helpers ─────────────────────────────────────────────────────────────────
function getStoreDir(opts) {
    return (opts && opts.storeDir) || DEFAULT_STORE_DIR;
}
function ensureStoreDir(dir) {
    if (!node_fs_1.default.existsSync(dir)) {
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    }
}
function contentHash(learning, sourceProject) {
    return node_crypto_1.default.createHash('sha256')
        .update(learning + '\n' + sourceProject)
        .digest('hex');
}
function generateId() {
    const ts = Date.now().toString(36);
    const rand = node_crypto_1.default.randomBytes(4).toString('hex');
    return `${ts}-${rand}`;
}
function readLearningFile(filePath) {
    try {
        const content = node_fs_1.default.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (err) {
        process.stderr.write(`Warning: skipping malformed file ${filePath}: ${err.message}\n`);
        return null;
    }
}
// ─── CRUD Operations ─────────────────────────────────────────────────────────
function learningsWrite(entry, opts) {
    const dir = getStoreDir(opts);
    ensureStoreDir(dir);
    const hash = contentHash(entry.learning, entry.source_project);
    // #306: In bulk-import paths, callers may supply a pre-built dedupeIndex
    // (Map<content_hash, id>) to avoid the per-write O(N) store scan.
    if (opts && opts.dedupeIndex) {
        const dedupeIndex = opts.dedupeIndex;
        if (dedupeIndex.has(hash)) {
            return { id: dedupeIndex.get(hash), created: false, content_hash: hash };
        }
        const id = generateId();
        const record = {
            id,
            source_project: entry.source_project,
            date: new Date().toISOString(),
            context: entry.context || '',
            learning: entry.learning,
            tags: entry.tags || [],
            content_hash: hash,
        };
        (0, shell_command_projection_cjs_1.platformWriteSync)(node_path_1.default.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
        dedupeIndex.set(hash, id);
        return { id, created: true, content_hash: hash };
    }
    // Check for duplicate by scanning existing files (single-write path, unchanged)
    const files = node_fs_1.default.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const existing = readLearningFile(node_path_1.default.join(dir, file));
        if (existing && existing.content_hash === hash) {
            return { id: existing.id, created: false, content_hash: hash };
        }
    }
    const id = generateId();
    const record = {
        id,
        source_project: entry.source_project,
        date: new Date().toISOString(),
        context: entry.context || '',
        learning: entry.learning,
        tags: entry.tags || [],
        content_hash: hash,
    };
    (0, shell_command_projection_cjs_1.platformWriteSync)(node_path_1.default.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
    return { id, created: true, content_hash: hash };
}
function learningsRead(id, opts) {
    if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id))
        return null;
    const dir = getStoreDir(opts);
    const filePath = node_path_1.default.join(dir, `${id}.json`);
    if (!node_fs_1.default.existsSync(filePath))
        return null;
    return readLearningFile(filePath);
}
function learningsList(opts) {
    const dir = getStoreDir(opts);
    if (!node_fs_1.default.existsSync(dir))
        return [];
    const files = node_fs_1.default.readdirSync(dir).filter(f => f.endsWith('.json'));
    const results = [];
    for (const file of files) {
        const record = readLearningFile(node_path_1.default.join(dir, file));
        if (record)
            results.push(record);
    }
    // Sort by date descending (newest first)
    results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return results;
}
function learningsQuery(query, opts) {
    const all = learningsList(opts);
    if (query && query.tag) {
        return all.filter(r => r.tags && r.tags.includes(query.tag));
    }
    return all;
}
function learningsDelete(id, opts) {
    if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id))
        return false;
    const dir = getStoreDir(opts);
    const filePath = node_path_1.default.join(dir, `${id}.json`);
    if (!node_fs_1.default.existsSync(filePath))
        return false;
    node_fs_1.default.unlinkSync(filePath);
    return true;
}
/**
 * #3683 — resolve which learnings artifact a copy reads. The extractor writes
 * phase-scoped `{PHASE_DIR}/{PADDED}-LEARNINGS.md`; the legacy shape is a
 * project-root `LEARNINGS.md`. The MOST RECENT phase-scoped artifact wins (a
 * gated completion copies the phase it just wrote); the project-root file is
 * the fallback when no phase artifact exists. Returns null when neither shape
 * is present.
 */
function resolveLearningsSource(planningDir) {
    let best = null;
    const phasesDir = node_path_1.default.join(planningDir, 'phases');
    // Phase enumeration routes through the sanctioned seam (the #3185 drift
    // guard rejects ad-hoc re-derivations): no cwd → every phase dir in the
    // tree, sentinel dirs excluded, unreadable phases dir already degraded to
    // an empty list by the locator itself.
    const { value: phaseDirNames } = phaseLocator.listMilestonePhaseDirs(phasesDir);
    for (const entry of phaseDirNames) {
        const phaseDir = node_path_1.default.join(phasesDir, entry);
        let files;
        try {
            files = node_fs_1.default.readdirSync(phaseDir);
        }
        catch {
            // An unreadable phase dir (ACL, removal race) must not crash the copy —
            // skip it and keep scanning.
            continue;
        }
        for (const f of files) {
            if (!/-LEARNINGS\.md$/i.test(f))
                continue;
            const p = node_path_1.default.join(phaseDir, f);
            try {
                const m = node_fs_1.default.statSync(p).mtimeMs;
                if (best === null || m > best.m)
                    best = { p, m };
            }
            catch {
                continue;
            }
        }
    }
    if (best !== null)
        return best.p;
    const rootPath = node_path_1.default.join(planningDir, 'LEARNINGS.md');
    return node_fs_1.default.existsSync(rootPath) ? rootPath : null;
}
function learningsCopyFromProject(planningDir, opts) {
    const learningsPath = resolveLearningsSource(planningDir);
    if (learningsPath === null) {
        return { total: 0, created: 0, skipped: 0 };
    }
    const content = node_fs_1.default.readFileSync(learningsPath, 'utf-8');
    const sourceProject = (opts && opts.sourceProject) || node_path_1.default.basename(node_path_1.default.resolve(planningDir, '..'));
    // #306: Build the content_hash -> id dedupe index once before the loop so
    // that learningsWrite does not re-scan the entire store on every call —
    // O(K*N) -> O(N+K).
    const dir = getStoreDir(opts);
    ensureStoreDir(dir);
    const dedupeIndex = new Map();
    for (const file of node_fs_1.default.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const existing = readLearningFile(node_path_1.default.join(dir, file));
        // First-seen-wins, matching the legacy scan path's first-match return so the
        // dedupe-hit `id` is identical on both paths even if the store already holds
        // duplicate content_hashes. (#306)
        if (existing && existing.content_hash && !dedupeIndex.has(existing.content_hash)) {
            dedupeIndex.set(existing.content_hash, existing.id);
        }
    }
    // Parse markdown: split on ## category headings.
    // #3683: the real producer (extract-learnings.md write_learnings) writes ##
    // categories containing ### item headings — each item is ONE learning (the
    // store's relevance contract caps injection by count, so category-sized
    // blobs defeat it). A bare ## section with no ### items keeps the legacy
    // single-learning shape.
    const sections = content.split(/^## /m).slice(1); // skip preamble before first ##
    let created = 0;
    let skipped = 0;
    const writeOne = (title, body, extraTags) => {
        const tags = Array.from(new Set([
            ...extraTags,
            ...title.toLowerCase().split(/\s+/).filter(w => w.length > 2),
        ]));
        const result = learningsWrite({
            source_project: sourceProject,
            learning: body,
            context: title,
            tags,
        }, { ...opts, dedupeIndex });
        if (result.created)
            created++;
        else
            skipped++;
    };
    for (const section of sections) {
        const lines = section.trim().split('\n');
        const category = lines[0].trim();
        const body = lines.slice(1).join('\n').trim();
        if (!body)
            continue;
        const categoryTag = category.toLowerCase().split(/\s+/)[0] || '';
        // Split into ### items when present; otherwise one learning per section.
        const items = body.split(/^### /m).map(s => s.trim()).filter(s => s.length > 0);
        const hasItemHeadings = /^### /m.test(body);
        if (!hasItemHeadings) {
            writeOne(category, body, categoryTag ? [categoryTag] : []);
            continue;
        }
        for (const item of items) {
            const itemLines = item.split('\n');
            const title = itemLines[0].trim();
            const itemBody = itemLines.slice(1).join('\n').trim();
            if (!itemBody && !title)
                continue;
            writeOne(title, itemBody || title, categoryTag ? [categoryTag] : []);
        }
    }
    return { total: created + skipped, created, skipped };
}
function learningsPrune(olderThan, opts) {
    const match = /^(\d+)d$/.exec(olderThan);
    if (!match) {
        throw new Error(`Invalid duration format: "${olderThan}" — expected format like "90d"`);
    }
    const days = parseInt(match[1], 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const dir = getStoreDir(opts);
    if (!node_fs_1.default.existsSync(dir))
        return { removed: 0, kept: 0 };
    const files = node_fs_1.default.readdirSync(dir).filter(f => f.endsWith('.json'));
    let removed = 0;
    let kept = 0;
    for (const file of files) {
        const filePath = node_path_1.default.join(dir, file);
        const record = readLearningFile(filePath);
        if (!record)
            continue;
        const recordDate = new Date(record.date);
        if (recordDate < cutoff) {
            node_fs_1.default.unlinkSync(filePath);
            removed++;
        }
        else {
            kept++;
        }
    }
    return { removed, kept };
}
// ─── CLI Command Handlers ────────────────────────────────────────────────────
function cmdLearningsList(raw) {
    const results = learningsList();
    output({ learnings: results, count: results.length }, raw, undefined);
}
function cmdLearningsQuery(tag, raw) {
    const results = learningsQuery({ tag });
    output({ learnings: results, count: results.length, tag }, raw, undefined);
}
function cmdLearningsCopy(cwd, raw) {
    const planDir = node_path_1.default.join(cwd, '.planning');
    const result = learningsCopyFromProject(planDir);
    output(result, raw, undefined);
}
function cmdLearningsPrune(olderThan, raw) {
    try {
        const result = learningsPrune(olderThan);
        output(result, raw, undefined);
    }
    catch (err) {
        coreError(err.message);
    }
}
function cmdLearningsDelete(id, raw) {
    if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id)) {
        coreError(`Invalid learning ID: "${id}"`);
    }
    const deleted = learningsDelete(id);
    output({ id, deleted }, raw, undefined);
}
module.exports = {
    learningsWrite,
    learningsRead,
    learningsList,
    learningsQuery,
    learningsDelete,
    learningsCopyFromProject,
    learningsPrune,
    cmdLearningsList,
    cmdLearningsQuery,
    cmdLearningsCopy,
    cmdLearningsPrune,
    cmdLearningsDelete,
    DEFAULT_STORE_DIR,
};
