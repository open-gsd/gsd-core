"use strict";
/**
 * Capability consent store — issue #1459 (capability trust model bypassable).
 *
 * A USER-OWNED store, living OUTSIDE any repository at `${GSD_HOME||homedir()}/.gsd/consent.json`,
 * that binds each PROJECT-scope third-party capability activation to a decision the user made on
 * THIS machine. Before #1459 a project's in-repo ledger entry was treated as the consent signal —
 * but a project ledger is repo-plantable, so cloning/forging a repo activated executable surfaces
 * and command dispatch with no user decision (the trust model was bypassable). The consent store
 * moves the authoritative signal off the repo tree: a project overlay is INACTIVE until a matching
 * consent record exists in this user-owned store.
 *
 * CONTENT BINDING (the security crux — #1459 round 2, findings CB-1/CB-2/TRUST2-5). The consent
 * record is bound to a RECOMPUTED full-bundle content hash (`bundleContentHash`), NOT to the ledger
 * `integrity` (which is `''` for path/git/dir installs and taken verbatim from the repo-plantable
 * project ledger — `'' === ''` is no binding) NOR to the `disclosureSignature` alone (which covers
 * only executable surfaces, so a declarative-only cap has a constant signature and a repo-write
 * attacker could swap `capability.json` for a malicious gate/contribution while consent still
 * matched). `bundleContentHash` is recomputed by the loader at load over the bundle (manifest AND
 * artifacts AND identity), excluding only derived Python bytecode/cache noise (#3631 — see
 * `bundleContentHash`'s own doc comment), so any tamper — declarative-only swap, hook-script edit,
 * empty-integrity local install — changes the hash and leaves the cap inactive. `integrity` and
 * `disclosureSignature` remain on the record for the human disclosure + re-consent-on-executable-
 * change UX (TRUST-2); they are NO LONGER the security binding.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, node:os, node:crypto, and the shared bounded
 * fd reader (readSmallRegularFile) from ./capability-ledger.cjs.
 *
 * Schema: `{ version: "1", records: { "<JSON({r,i})>": ConsentRecord } }`. The store is UNRELEASED
 * (no migration/back-compat shims needed); the only version is "1".
 *
 * Exports:
 *   consentStorePath(gsdHome?)            — resolve the store path (GSD_HOME||homedir() rule).
 *   bundleContentHash(capDir)            — recomputed sha512 over the whole bundle (the binding).
 *   readConsentStore(gsdHome?)            — bounded, NON-THROWING read; bad input → { records: {} }.
 *   hasProjectConsent({...})             — true iff a record matches the recomputed contentHash.
 *   recordProjectConsent({...})          — atomic+durable+LOCKED write of a project-scope record.
 *   revokeProjectConsent({...})          — atomic+LOCKED delete of a project-scope record (no-op if absent).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = __importDefault(require("node:crypto"));
/* eslint-disable @typescript-eslint/no-require-imports */
const ledgerMod = require('./capability-ledger.cjs');
// #1459 finding 4: the SHARED hardened lock primitive (single source of truth for lifecycle + consent).
// Before this, the consent lock used a naive mtime-only 60s steal that would STEAL A LIVE WRITER (a
// slow/paused holder past 60s is reclaimed → original writer resumes and overwrites = lost update). The
// shared primitive never stale-steals a verified-live same-host holder (pid + start-time identity) and
// only reclaims a provably-dead/unverifiable holder (dead-pid fast path or the hard deadman).
const lockMod = require('./capability-lock.cjs');
/**
 * The consent store has GENUINELY-CONTENDED writers (two different projects installing concurrently
 * both write the ONE global consent.json), so it must SERIALIZE under brief contention rather than fail
 * — a larger steal/retry budget than the lifecycle's small sub-second default. Combined with #1459
 * finding 3 (throw on a NULL handle), this throws only when contention truly outlasts the budget.
 */
const CONSENT_LOCK_MAX_ATTEMPTS = 50;
/* eslint-enable @typescript-eslint/no-require-imports */
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONSENT_SCHEMA_VERSION = '1';
const CONSENT_DIRNAME = '.gsd';
const CONSENT_FILE_NAME = 'consent.json';
/**
 * GENEROUS DoS backstop on the store FILE — NOT a product limit. The consent store is untrusted
 * on-disk content; the bounded reader must not read+parse an unbounded file. A few hundred bytes
 * per record × MAX_RECORDS is far below this; 8 MiB is wildly more than any real store.
 */
const CONSENT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * GENEROUS cap on the record COUNT so a hostile store with millions of keys cannot weaponize
 * Object.keys iteration. 4096 project×capability consents is far more than any user accumulates.
 * Enforced on BOTH read (refuse a hostile store wholesale) AND write (recordProjectConsent refuses
 * to grow the store past it — CONSENT-MAXRECORDS-WRITE-1).
 */
const MAX_RECORDS = 4096;
/**
 * CB-1/CB-2 content-hash bound: the maximum total bytes summed over every regular file in a bundle
 * `bundleContentHash` will hash. A legitimate capability bundle is a handful of small declarative
 * files plus a few scripts; 16 MiB is far more than any real bundle. A bundle exceeding this (a
 * hostile or runaway tree) fails closed: bundleContentHash throws rather than hashing unbounded
 * content, so the loader leaves the cap inactive.
 */
const BUNDLE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Per-file size cap inside a bundle (each file is read via the shared bounded fd reader). */
const BUNDLE_MAX_FILE_BYTES = BUNDLE_MAX_TOTAL_BYTES;
/**
 * Bound the bundle ENTRY count so a pathological tree of millions of empty files (or a very deep tree)
 * cannot DoS the walk. #1459 finding 2 (round 6): the cap is enforced on the CUMULATIVE entry count as
 * the walk STREAMS each directory (fs.opendirSync + readSync) — it throws the MOMENT the running count
 * exceeds this, BEFORE collecting/sorting a whole directory's entries — so a huge single directory (or a
 * deep tree) cannot force unbounded memory/CPU before the fail-closed cap. Backed by a mutable variable
 * with a test seam (`_setBundleMaxFilesForTest`) so a test can drive the bound deterministically without
 * planting 100k files; production code never mutates it.
 */
const BUNDLE_MAX_FILES_DEFAULT = 100_000;
let BUNDLE_MAX_FILES = BUNDLE_MAX_FILES_DEFAULT;
/** Valid capability id (kebab-case, lowercase, leading letter). */
const VALID_ID_RE = /^[a-z][a-z0-9-]*$/;
// ---------------------------------------------------------------------------
// Safety helpers (prototype-pollution-safe; CodeQL inline-literal barrier)
// ---------------------------------------------------------------------------
/**
 * Returns true when `id` must never be used as an object key / record id — either because it would
 * cause prototype pollution or because it fails the kebab-case constraint. Uses INLINE LITERAL key
 * comparisons (no Set / computed lookup) per the CodeQL prototype-pollution barrier.
 */
function isUnsafeCapabilityId(id) {
    if (typeof id !== 'string')
        return true;
    if (id === '__proto__')
        return true;
    if (id === 'constructor')
        return true;
    if (id === 'prototype')
        return true;
    if (!VALID_ID_RE.test(id))
        return true;
    return false;
}
/** The canonical IN-MEMORY lookup key for a (projectRoot, id) pair (NUL-joined). */
function consentKey(realRoot, id) {
    return realRoot + String.fromCharCode(0) + id;
}
/**
 * The ON-DISK key (WIN-3): an unambiguous JSON-object string `{"r":<realpath>,"i":<id>}`. The prior
 * space-joined `<realpath> <id>` form was ambiguous when a path contained a space (Windows
 * `C:\Users\John Smith\...`): two distinct (root,id) pairs could collide. A JSON-stringified object
 * key encodes both components unambiguously, so distinct pairs never collide on disk.
 */
function diskKey(realRoot, id) {
    return JSON.stringify({ r: realRoot, i: id });
}
/**
 * Best-effort realpath of a project root. A non-existent path cannot be realpath'd; fall back to
 * path.resolve so a record can still be written/looked-up consistently (both record and lookup use
 * this same function, so they agree).
 */
function realpathProject(projectRoot) {
    try {
        return node_fs_1.default.realpathSync(projectRoot);
    }
    catch {
        return node_path_1.default.resolve(projectRoot);
    }
}
// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the consent store path. Uses the SAME `gsdHome || GSD_HOME || homedir()` rule the loader
 * and CLI use, so a consent record written by the CLI is found by the loader. The store NEVER lives
 * under a repository — it is user-owned, machine-local config.
 */
function consentStorePath(gsdHome) {
    const home = gsdHome || process.env['GSD_HOME'] || node_os_1.default.homedir();
    return node_path_1.default.join(home, CONSENT_DIRNAME, CONSENT_FILE_NAME);
}
/** The path-separator BYTE used to join raw-byte path segments — `/` (0x2f) on every platform we hash on. */
const SEP_BYTE = Buffer.from('/');
/** On Windows the OS separator is `\\` (0x5c); normalize it to `/` at the BYTE level for cross-platform determinism. */
const WIN_SEP_BYTE = 0x5c;
/** Join a parent raw-byte path and a raw-byte segment with the `/` separator byte. An empty parent → the segment alone. */
function joinBytes(parent, segment) {
    if (parent.length === 0)
        return Buffer.from(segment);
    return Buffer.concat([parent, SEP_BYTE, segment]);
}
/** Normalize Windows `\\` separator bytes to `/` in a raw-byte relpath (no-op on POSIX paths). */
function normalizeSepBytes(rel) {
    if (process.platform !== 'win32')
        return rel;
    const out = Buffer.from(rel);
    for (let i = 0; i < out.length; i++)
        if (out[i] === WIN_SEP_BYTE)
            out[i] = 0x2f;
    return out;
}
/**
 * Recursively collect every REGULAR file AND every DIRECTORY under `absDir` as RAW-BYTE POSIX-relative
 * paths (`rel`, relative to the bundle root), refusing to follow symlinks out of the bundle. Two
 * NARROW, RECURSION-PRESERVING exclusions apply (#3631, amended after two orthogonal reviews found the
 * original wholesale-skip UNSAFE — see the doc comment on `bundleContentHash` for the full rationale
 * and the accepted residual risk):
 *
 *   1. A DIRECTORY whose basename is exactly `__pycache__` or `.pytest_cache`: its own TAG_DIR marker
 *      is SUPPRESSED (not pushed), but it is STILL RECURSED INTO — every child that is not itself
 *      excluded is still hashed. Suppressing only the marker is what keeps an empty/all-excluded such
 *      directory from moving the digest; recursing is what closes the original hole (H1): skipping
 *      recursion made an excluded directory an unbounded, permanently-unhashed region a manifest could
 *      point a hook `script` at (`__pycache__/run.js`) to install benign, then rewrite freely post-consent.
 *   2. A FILE whose name ends `.pyc` or `.pyo` is excluded ONLY when its PARENT directory's basename is
 *      exactly `__pycache__` (checked byte-exact, never `.pytest_cache`) — a `.pyc`/`.pyo` anywhere else
 *      (bundle root, `scripts/`, a directory literally named `cache.pyc`, etc.) is hashed normally,
 *      because a sourceless legacy `.pyc` there IS importable and executable (H2).
 *
 * A regular FILE literally named `__pycache__` or `.pytest_cache` is NOT excluded (only a DIRECTORY of
 * that basename gets marker-suppression) — it is hashed like any other file. A DIRECTORY literally
 * named `x.pyc` is NOT excluded either — the suffix rule only ever applies to files. All exclusion
 * checks run strictly AFTER the lstat-backed symlink/non-regular rejections below, so a symlink or
 * device masquerading under an excluded name is still fail-closed rejected rather than silently
 * skipped. Bounded: throws if the entry count or total byte size exceeds the caps (fail closed — a
 * hostile/runaway tree never hashes unbounded content); an excluded entry still counts toward BOTH
 * caps (the caps guard the walk itself, not the digest). A non-regular entry encountered IN the tree
 * (FIFO/device) is a fail-closed throw — a bundle must be plain files and directories.
 *
 * #1459 finding 2 (MED/HIGH, ROUND 6): the enumeration ITSELF is bounded. Instead of
 * `fs.readdirSync` (which loads + sorts a WHOLE directory before the count cap — so a malicious bundle
 * with a huge single directory, or a very deep tree, forces unbounded memory/CPU before fail-closing),
 * we STREAM each level via fs.opendirSync + dir.readSync() and increment a CUMULATIVE entry counter
 * (`count.n`) across the recursive walk, throwing the MOMENT it exceeds BUNDLE_MAX_FILES — BEFORE
 * collecting (let alone sorting) the rest of the level. Determinism is preserved: the BOUNDED set of a
 * level is still sorted (by raw-byte name) before lstat/recursion, and the FINAL digest sorts over all
 * rel byte strings. The cap is cumulative, so a deep tree spread across many nested dirs cannot blow it.
 *
 * #1459 finding 2 (LOW): directories (including EMPTY ones) are emitted as typed DIR markers so that
 * adding/removing an empty directory CHANGES the canonical hash. Capability code can branch on a
 * directory's existence, so a bare-dir add must be observable to the binding.
 *
 * #1459 finding 4 (LOW): dir entries are read as raw-byte Buffer names (`encoding: 'buffer'`) and the
 * abs/rel paths are concatenated at the BYTE level, so an invalid-UTF-8 filename is never lossily
 * decoded — two filenames that differ only in invalid bytes produce distinct rel byte strings.
 *
 * @param absDir       the absolute directory to scan, as RAW BYTES (Buffer).
 * @param relDir       the relpath of `absDir` from the bundle root, as RAW BYTES (Buffer; empty at the root).
 * @param dirBasename  the basename of `absDir` itself, as RAW BYTES (Buffer) — the PARENT basename every
 *                      entry collected at this level shares. Threaded down so a `.pyc`/`.pyo` FILE can be
 *                      excluded only when ITS parent is exactly `__pycache__` (empty at the bundle root).
 * @param count        the CUMULATIVE entry counter shared across the whole recursive walk (fail-closed at the cap).
 */
// #3631 (amended — see bundleContentHash's doc comment for the H1/H2 rationale and accepted residual
// risk): basename rules for what is excluded FROM THE DIGEST. They are NOT excluded from the walk's
// resource caps — see the count.n / total.bytes accounting below, which still sees every excluded
// entry.
//
// Exact byte comparison, case-sensitive, deliberately: CPython always writes a lowercase
// `__pycache__` directory, so byte-exact matching keeps the digest identical across case-insensitive
// filesystems (e.g. default macOS/Windows) instead of varying with how a name happens to be spelled
// on disk.
//
// DELIBERATELY NOT on this list: node_modules, dist, build, or similar. Those hold code that is
// actually required/executed at runtime, so excluding them from the digest would stop consent from
// binding executable content — turning a usability bug (noisy re-consent prompts) into a
// supply-chain hole (a swapped dependency that never re-triggers consent).
/** Directory basenames whose TAG_DIR marker is suppressed — but the directory is STILL RECURSED INTO. */
const PYCACHE_DIR_BASENAMES = [
    Buffer.from('__pycache__'),
    Buffer.from('.pytest_cache'),
];
/** FILE-name suffixes excluded ONLY when the file's parent directory basename is `__pycache__` (see below). */
const PYCACHE_FILE_SUFFIXES = [
    Buffer.from('.pyc'),
    Buffer.from('.pyo'),
];
/** The one parent directory basename that gates the `.pyc`/`.pyo` FILE-suffix exclusion — never `.pytest_cache`. */
const PYCACHE_PARENT_BASENAME = Buffer.from('__pycache__');
/**
 * True when `name` (a raw-byte dirent basename) is a DIRECTORY whose TAG_DIR marker must be
 * suppressed — `__pycache__` or `.pytest_cache`, exact byte match. The caller still recurses into it;
 * this predicate answers ONLY "skip the marker", never "skip the subtree".
 */
function isPycacheDirBasename(name) {
    for (const exact of PYCACHE_DIR_BASENAMES) {
        if (Buffer.compare(name, exact) === 0)
            return true;
    }
    return false;
}
/** True when raw-byte basename `name` ends in `.pyc` or `.pyo` (byte-suffix match, never utf8-decoded). */
function hasPycacheFileSuffix(name) {
    for (const suffix of PYCACHE_FILE_SUFFIXES) {
        if (name.length >= suffix.length && Buffer.compare(name.subarray(name.length - suffix.length), suffix) === 0) {
            return true;
        }
    }
    return false;
}
/**
 * True when a FILE with basename `name`, inside a directory whose OWN basename is `dirBasename`, must
 * be excluded from the digest: a `.pyc`/`.pyo` suffix whose parent directory basename is exactly
 * `__pycache__` (byte-exact — never `.pytest_cache`, so a `.pyc` sitting directly inside a
 * `.pytest_cache` dir is still hashed). A `.pyc`/`.pyo` file anywhere else — bundle root, `scripts/`,
 * a directory literally named `cache.pyc`, etc. — is NOT excluded (H2): a sourceless legacy `.pyc`
 * there is importable and executable, so it must stay bound to consent.
 */
function isExcludedFileBasename(name, dirBasename) {
    return hasPycacheFileSuffix(name) && Buffer.compare(dirBasename, PYCACHE_PARENT_BASENAME) === 0;
}
function collectBundleEntries(absDir, relDir, dirBasename, acc, total, count) {
    let dir;
    try {
        // RAW-BYTE streaming open: dirent names are Buffers (encoding: 'buffer'), so an invalid-UTF-8
        // filename is preserved verbatim. opendirSync + readSync iterates one entry at a time, so the cap
        // can fail closed BEFORE the whole directory is materialized/sorted.
        dir = node_fs_1.default.opendirSync(absDir, { encoding: 'buffer' });
    }
    catch (err) {
        throw new Error(`bundleContentHash: cannot read directory "${absDir.toString('utf8')}": ${err.message}`);
    }
    // Collect ONLY the BOUNDED set of this level's dirents — the cumulative counter throws the moment it
    // crosses the cap, so the array can never grow past it. We still sort this bounded set (by raw-byte
    // name) so the byte/count accounting walk is reproducible across platforms.
    const levelEntries = [];
    try {
        for (;;) {
            let ent;
            try {
                ent = dir.readSync();
            }
            catch (err) {
                throw new Error(`bundleContentHash: cannot read directory "${absDir.toString('utf8')}": ${err.message}`);
            }
            if (ent === null)
                break;
            // BOUND THE ENUMERATION ITSELF: increment the cumulative counter and fail closed BEFORE this entry
            // is retained/sorted, so a huge directory (or deep tree) cannot be loaded/sorted in full first.
            count.n++;
            if (count.n > BUNDLE_MAX_FILES) {
                throw new Error(`bundleContentHash: bundle entry count exceeds ${BUNDLE_MAX_FILES} (refusing)`);
            }
            levelEntries.push(ent);
        }
    }
    finally {
        try {
            dir.closeSync();
        }
        catch { /* best-effort */ }
    }
    levelEntries.sort((a, b) => Buffer.compare(a.name, b.name));
    for (const ent of levelEntries) {
        const name = ent.name; // Buffer
        const abs = joinBytes(absDir, name);
        const rel = normalizeSepBytes(joinBytes(relDir, name));
        // lstat the entry (Buffer path): a symlink must NOT be followed (it could escape the bundle to
        // /etc/passwd or to an infinite device). Re-lstat to be certain across platforms.
        let st;
        try {
            st = node_fs_1.default.lstatSync(abs);
        }
        catch (err) {
            throw new Error(`bundleContentHash: cannot lstat "${abs.toString('utf8')}": ${err.message}`);
        }
        if (st.isSymbolicLink()) {
            // A symlink in the bundle is suspicious and unhashable safely (it would either escape the
            // bundle or follow to a non-regular target). Fail closed.
            throw new Error(`bundleContentHash: refusing to hash a symlink in the bundle: "${abs.toString('utf8')}"`);
        }
        if (st.isDirectory()) {
            // #3631 (amended, H1): exclusion is checked HERE — after the symlink fail-closed throw above —
            // so a symlink named e.g. "__pycache__" or "x.pyc" is never silently skipped; only a REAL
            // (lstat-confirmed) dir/file can be excluded. An excluded directory's own dirent was already
            // counted toward count.n above (the cap guards the walk itself). Only the TAG_DIR MARKER is
            // suppressed for `__pycache__`/`.pytest_cache` — the directory is ALWAYS recursed into so every
            // non-excluded child underneath is still hashed (closing H1: no unbounded unhashed region).
            if (isPycacheDirBasename(name)) {
                collectBundleEntries(abs, rel, name, acc, total, count);
                continue;
            }
            // Emit a typed DIR marker for THIS directory (so an empty dir is bound), then recurse into it.
            acc.push({ abs, rel, kind: 'dir' });
            collectBundleEntries(abs, rel, name, acc, total, count);
            continue;
        }
        if (!st.isFile()) {
            throw new Error(`bundleContentHash: refusing to hash a non-regular file in the bundle: "${abs.toString('utf8')}"`);
        }
        // #3631: an excluded FILE (a __pycache__/*.pyc or *.pyo) still counts its bytes toward the
        // total-size cap below — exclusion answers "does this bind the digest?", not "is this safe to
        // read unbounded?" — so it must never become a way to smuggle unbounded bytes past
        // BUNDLE_MAX_TOTAL_BYTES.
        total.bytes += st.size;
        if (total.bytes > BUNDLE_MAX_TOTAL_BYTES) {
            throw new Error(`bundleContentHash: bundle size exceeds ${BUNDLE_MAX_TOTAL_BYTES} bytes (refusing)`);
        }
        if (isExcludedFileBasename(name, dirBasename))
            continue;
        acc.push({ abs, rel, kind: 'file' });
    }
}
/** Encode an unsigned 32-bit length as 4 big-endian bytes (the path-length frame). */
function uint32be(n) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}
/**
 * Encode an unsigned 64-bit length as 8 big-endian bytes (the content-length frame). A bundle file is
 * size-capped well below 2^53 so writeBigUInt64BE of a BigInt is exact and never overflows.
 */
function uint64be(n) {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64BE(BigInt(n), 0);
    return b;
}
/** Typed entry tags so a FILE and a DIR at the same relpath can never produce the same digest input. */
const TAG_FILE = Buffer.from([0x01]);
const TAG_DIR = Buffer.from([0x02]);
/**
 * The recomputed full-bundle content hash (#1459 CB-1/CB-2/TRUST2-5) — the SECURITY BINDING. A
 * `sha512-<base64>` over a DETERMINISTIC, INJECTIVE, LOSSLESS serialization of every regular file
 * AND directory under `capDir` (recursively), with two NARROW exclusions (#3631, amended after two
 * orthogonal reviews found the original wholesale directory-skip UNSAFE):
 *   - A `__pycache__` or `.pytest_cache` DIRECTORY's own TAG_DIR marker is suppressed, but it is
 *     ALWAYS recursed into — every non-excluded child underneath is still hashed.
 *   - A `.pyc`/`.pyo` FILE is excluded ONLY when its immediate parent directory's basename is exactly
 *     `__pycache__`; a `.pyc`/`.pyo` anywhere else (bundle root, `scripts/`, etc.) is hashed normally,
 *     since a sourceless legacy `.pyc` there is importable and executable.
 * `node_modules`, `dist`, `build`, and similar are deliberately NOT excluded: their contents are
 * executed/required at runtime, so dropping them from the digest would stop consent from binding
 * executable content.
 *
 * ACCEPTED RESIDUAL RISK (documented, not a defect to re-litigate): CPython's default `.pyc`
 * invalidation (timestamp-based) validates a cached bytecode file against its SOURCE's mtime and size
 * only — NOT against the source's content — and both mtime and size are attacker-settable by whoever
 * can already write to the bundle. So a forged `__pycache__/mod.cpython-3XX.pyc` whose header mtime/size
 * were copied from an unmodified, still-hashed `mod.py` will execute without moving this digest. Before
 * this exclusion existed that write was detected (any file under `__pycache__` moved the hash); after
 * it, it is not, for files matching the narrow `__pycache__/*.pyc` shape above. This is accepted
 * deliberately — the alternative (H1's original wholesale skip, or hashing every regenerated bytecode
 * file) either reopens an unbounded unhashed region or makes consent fire on routine bytecode caching —
 * and is bounded by: (1) the attacker must already have POST-CONSENT write access to the bundle; (2)
 * everything outside `__pycache__/*.pyc` — including sourceless legacy `.pyc`/`.pyo` files anywhere
 * else — remains hashed. NOT a bound, despite `isSafeHookScriptPath` (capability-lifecycle.cts /
 * capability-validator.cjs) rejecting a manifest-declared hook `script` that names a
 * `__pycache__`/`.pytest_cache` segment or ends `.pyc`/`.pyo`: the excluded region is still reachable
 * by ONE HOP of indirection from any hashed, consent-covered script — a `require`/`import` of a
 * `__pycache__/*.pyc` module path is not itself a declared script and the validator never sees it —
 * so a hashed `hooks/run.js` can load a `__pycache__/mod.pyc` whose bytes are then free to change
 * post-consent with the digest unmoved. The validator guard raises the bar for DECLARED surfaces; it
 * does not contain the risk. KNOWN LIMITATION: `.pytest_cache`'s CONTENTS still change the digest as
 * normal files — only its directory marker is suppressed, so this residual risk does NOT extend to
 * `.pytest_cache`.
 *
 * Canonicalization (#1459 findings 1 + 4 — the prior `relpath + NUL + content + NUL` over utf8-decoded
 * STRINGS was non-injective, lossy in CONTENT, AND lossy in the PATH component):
 *   - LENGTH-FRAMED, no ambiguous delimiters. A leading fixed-width entry COUNT, then per entry
 *     (sorted by raw-byte relpath): a 1-byte TYPE tag, uint32 path-byte-length + the raw path bytes,
 *     and (for a FILE) uint64 content-byte-length + the raw content bytes. Because every component is
 *     length-prefixed, a NUL (or any byte) inside a path or file content can never be mistaken for a
 *     boundary — two different (path, content) splits cannot collide.
 *   - RAW BYTES end to end, never utf8-decoded — for BOTH content AND the path. File bytes are read via
 *     the ledger's RAW-BYTES bounded reader (readSmallRegularFileBuffer); the PATH bytes come straight
 *     from a raw-byte (`encoding: 'buffer'`) dir walk (#1459 finding 4), so two binary artifacts that
 *     differ only in invalid-UTF-8 bytes — whether in their CONTENT or in their FILENAME (both of which
 *     a utf8 decode would collapse to U+FFFD) — produce DIFFERENT digests.
 *   - DETERMINISTIC across platforms: entries sorted by the raw-byte relpath whose separators are
 *     normalized to the `/` byte, so an on-disk reorder and a Windows-vs-POSIX separator difference do
 *     not matter.
 *
 * Throws (fail closed) on an unreadable dir, a non-regular/symlinked bundle entry, or a bundle that
 * exceeds the size/count caps — the loader treats a throw as "no matching consent" (inactive).
 *
 * Each file's bytes are read via the SHARED bounded fd reader (open → fstat → require regular file →
 * size cap → read exactly size), so a file swapped for a FIFO/device between the walk and the read
 * cannot block or read unbounded.
 */
function bundleContentHash(capDir) {
    // Resolve to an absolute path, then carry it as RAW BYTES so the walk never lossily decodes a name.
    const rootBytes = Buffer.from(node_path_1.default.resolve(capDir));
    // The root's own basename is threaded as the initial `dirBasename` so the parent-basename check for
    // a `.pyc`/`.pyo` FILE applies even to a file placed DIRECTLY at the bundle root (root literally
    // named `__pycache__` is the only case this matters for, and it is a correct, if exotic, match).
    const rootBasename = Buffer.from(node_path_1.default.basename(node_path_1.default.resolve(capDir)));
    const entries = [];
    collectBundleEntries(rootBytes, Buffer.alloc(0), rootBasename, entries, { bytes: 0 }, { n: 0 });
    // Sort by the raw-byte (separator-normalized) relpath so the digest is identical on Windows and POSIX,
    // and is independent of the on-disk creation/readdir order. Tie-break on kind so a (degenerate, never
    // produced on a real fs) file-and-dir same-relpath pair still has a stable order.
    entries.sort((a, b) => {
        const c = Buffer.compare(a.rel, b.rel);
        if (c !== 0)
            return c;
        return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
    const hash = node_crypto_1.default.createHash('sha512');
    // Header: a fixed-width entry COUNT frames the whole stream (so a truncated/extended entry list
    // cannot be confused with a different bundle).
    hash.update(uint64be(entries.length));
    for (const ent of entries) {
        const pathBytes = ent.rel; // RAW path bytes (finding 4) — never utf8-decoded.
        if (ent.kind === 'dir') {
            // Typed DIR marker: tag + length-framed path. No content — binds the directory's mere existence.
            hash.update(TAG_DIR);
            hash.update(uint32be(pathBytes.length));
            hash.update(pathBytes);
            continue;
        }
        // FILE: tag + length-framed path + length-framed RAW content bytes (no utf8 decode).
        const content = ledgerMod.readSmallRegularFileBuffer(ent.abs, BUNDLE_MAX_FILE_BYTES);
        // null here would mean the file vanished between walk and read — fail closed.
        if (content === null) {
            throw new Error(`bundleContentHash: file vanished during hash: "${ent.abs.toString('utf8')}"`);
        }
        hash.update(TAG_FILE);
        hash.update(uint32be(pathBytes.length));
        hash.update(pathBytes);
        hash.update(uint64be(content.length));
        hash.update(content);
    }
    return `sha512-${hash.digest('base64')}`;
}
// ---------------------------------------------------------------------------
// Read (bounded, non-throwing)
// ---------------------------------------------------------------------------
/**
 * Validate a single record object. Rejects anything not matching the schema — a malformed/tampered
 * record is dropped (fail closed: it cannot grant consent). Returns true only for a structurally-
 * complete project-scope record carrying a contentHash binding.
 */
function isValidConsentRecord(rec) {
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec))
        return false;
    const r = rec;
    if (typeof r['projectRoot'] !== 'string' || !r['projectRoot'])
        return false;
    if (typeof r['id'] !== 'string' || isUnsafeCapabilityId(r['id']))
        return false;
    if (r['scope'] !== 'project')
        return false;
    if (typeof r['integrity'] !== 'string')
        return false;
    if (typeof r['disclosureSignature'] !== 'string')
        return false;
    // The security binding MUST be present and non-empty — a record without a contentHash can never
    // match a recomputed hash and is treated as invalid (fail closed).
    if (typeof r['contentHash'] !== 'string' || !r['contentHash'])
        return false;
    if (typeof r['consentedAt'] !== 'string' || !r['consentedAt'])
        return false;
    // Optional (see ConsentRecord.reviewerHost): absent is valid and is the common case. Present but
    // non-string is a corrupt record — reject rather than silently comparing against a non-host.
    if (r['reviewerHost'] !== undefined && typeof r['reviewerHost'] !== 'string')
        return false;
    return true;
}
/**
 * Read the consent store. NON-THROWING and BOUNDED: a missing, corrupt, oversized, non-regular
 * (FIFO/device), or wrong-shape store yields an empty `{ records: {} }`. Invalid individual records
 * are dropped. A store whose record count exceeds MAX_RECORDS is refused wholesale (hostile DoS).
 */
function readConsentStore(gsdHome) {
    const empty = { records: {} };
    const filePath = consentStorePath(gsdHome);
    let raw;
    try {
        raw = ledgerMod.readSmallRegularFile(filePath, CONSENT_MAX_BYTES);
    }
    catch {
        // Non-regular (FIFO/device/dir), oversized, or IO error → fail closed to empty.
        return empty;
    }
    if (raw === null || raw === '')
        return empty; // genuinely missing / empty.
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return empty; // corrupt JSON.
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return empty;
    const p = parsed;
    const recordsVal = p['records'];
    if (typeof recordsVal !== 'object' || recordsVal === null || Array.isArray(recordsVal))
        return empty;
    const records = recordsVal;
    const keys = Object.keys(records);
    if (keys.length > MAX_RECORDS)
        return empty; // hostile record count — refuse the whole store.
    // Re-key by the canonical NUL key so lookups never depend on the disk-key's serialization.
    const out = { records: {} };
    for (const key of keys) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype')
            continue; // proto-safe.
        const rec = records[key];
        if (!isValidConsentRecord(rec))
            continue;
        out.records[consentKey(rec.projectRoot, rec.id)] = rec;
    }
    return out;
}
// ---------------------------------------------------------------------------
// Has (the security match is the recomputed contentHash)
// ---------------------------------------------------------------------------
/**
 * True iff a consent record exists for `(realpath(projectRoot), id)` whose `contentHash` equals the
 * supplied (recomputed-by-the-loader) value. The contentHash is THE security binding (#1459
 * CB-1/CB-2): it covers the whole bundle (manifest AND artifacts AND identity), so a swapped
 * declarative manifest, a tampered hook script, or an empty-integrity local install all fail to
 * match. An unsafe id is rejected (→ false) before any lookup. Prototype-pollution-safe (NUL keys +
 * hasOwnProperty).
 */
function hasProjectConsent(args) {
    const { gsdHome, projectRoot, id, contentHash } = args;
    if (isUnsafeCapabilityId(id))
        return false;
    if (typeof contentHash !== 'string' || !contentHash)
        return false;
    const store = readConsentStore(gsdHome);
    const key = consentKey(realpathProject(projectRoot), id);
    if (!Object.prototype.hasOwnProperty.call(store.records, key))
        return false;
    const rec = store.records[key];
    return rec.contentHash === contentHash;
}
/** The consent-store lock path — keyed on the consent store DIRECTORY (one lock per machine store). */
function consentLockPath(gsdHome) {
    return node_path_1.default.join(node_path_1.default.dirname(consentStorePath(gsdHome)), '.consent.lock');
}
/**
 * CONSENT-CONCURRENCY-1 (HIGH): record/revoke do a read-modify-write of the ONE global consent.json.
 * Two DIFFERENT projects writing the same store concurrently would lose-update without a lock (project B
 * reads, project A writes, project B overwrites with its stale snapshot, dropping A's record). The lock
 * is keyed on the consent store DIRECTORY so all consent writers on this machine serialize.
 *
 * #1459 finding 4 (MEDIUM): this now uses the SHARED hardened lock primitive (capability-lock) — the
 * SAME steal protocol as the lifecycle lock. The old self-contained consent lock stole any holder past
 * a 60s mtime regardless of liveness, so a slow/paused LIVE writer would be stolen and its store
 * overwritten (lost update). The shared primitive NEVER stale-steals a verified-live same-host holder
 * (pid + process-start-time identity) and reclaims only a provably-dead/unverifiable holder (dead-pid
 * fast path or the hard deadman) — so a live writer is never stolen and a crashed writer never deadlocks.
 */
function acquireConsentLock(dir) {
    // waitForFresh: a contended fresh/live holder is WAITED FOR (back off + retry), not failed-fast, so
    // two genuinely-racing consent writers serialize; null only when contention outlasts the budget.
    return lockMod.acquireLock(node_path_1.default.join(dir, '.consent.lock'), { maxAttempts: CONSENT_LOCK_MAX_ATTEMPTS, waitForFresh: true });
}
/** Release the consent lock (shared primitive — token + inode owner-safe; never deletes a successor's). */
function releaseConsentLock(handle) {
    lockMod.releaseLock(handle);
}
// ---------------------------------------------------------------------------
// Atomic + durable write (mirrors capability-ledger.writeLedger)
// ---------------------------------------------------------------------------
/**
 * Errnos from a directory fsync that are tolerated (platforms/filesystems disallowing dir fsync).
 * WIN-4 (#1459 round 2): ENOENT is tolerated too — the containing dir can vanish between rename and
 * fsync on an aggressively-swept tmp tree (Windows/CI), and a missing dir cannot be fsync'd.
 */
const DIR_FSYNC_TOLERATED_ERRNOS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EBADF', 'ENOENT']);
/** fsync the directory containing `dest` so a rename is durable across a power loss (best-effort). */
function fsyncContainingDir(dest) {
    let dirFd = null;
    try {
        dirFd = node_fs_1.default.openSync(node_path_1.default.dirname(dest), 'r');
        node_fs_1.default.fsyncSync(dirFd);
    }
    catch (err) {
        const code = err.code;
        if (code !== undefined && !DIR_FSYNC_TOLERATED_ERRNOS.has(code)) {
            throw new Error(`Directory fsync of "${node_path_1.default.dirname(dest)}" failed (${code}); durability of the consent ` +
                `store rename could NOT be confirmed: ${err.message}`);
        }
        /* tolerated errno (or no code) — best-effort */
    }
    finally {
        if (dirFd !== null) {
            try {
                node_fs_1.default.closeSync(dirFd);
            }
            catch { /* best-effort */ }
        }
    }
}
/** WIN-1: rename errnos that are transient on Windows (AV scanner / indexer holding a brief lock). */
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;
let _renameSleepBuf = null;
function renameBackoff() {
    if (_renameSleepBuf === null)
        _renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(_renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}
/**
 * Serialize the store to disk atomically + durably (tmp with O_EXCL → write-all → fsync → close →
 * rename → dir fsync; temp cleaned up on any failure). Mirrors the capability-ledger writeLedger
 * durability idiom so a crash/power-loss mid-write can never produce a truncated consent store.
 *
 * WIN-1 / CONSENT-ATOMIC-WRITE parity (#1459 round 2): the renameSync is retried with backoff on the
 * transient Windows AV/indexer errnos (EPERM/EBUSY/EACCES), matching writeLedger.
 *
 * The on-disk JSON uses the unambiguous JSON-object disk key (WIN-3); the in-memory store is keyed by
 * the canonical NUL key, so we re-key here.
 */
function writeConsentStore(gsdHome, store) {
    const filePath = consentStorePath(gsdHome);
    const dir = node_path_1.default.dirname(filePath);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const onDisk = {
        version: CONSENT_SCHEMA_VERSION,
        records: {},
    };
    for (const key of Object.keys(store.records)) {
        const rec = store.records[key];
        onDisk.records[diskKey(rec.projectRoot, rec.id)] = rec;
    }
    const content = JSON.stringify(onDisk, null, 2) + '\n';
    const nonce = node_crypto_1.default.randomBytes(4).toString('hex');
    const tmpPath = `${filePath}.tmp.${process.pid}-${nonce}`;
    const fd = node_fs_1.default.openSync(tmpPath, 'wx'); // exclusive create — defeats a pre-planted symlink.
    let primaryErr = null;
    try {
        node_fs_1.default.writeFileSync(fd, content); // write-all loop — no short writes.
        node_fs_1.default.fsyncSync(fd); // flush bytes to stable storage BEFORE the rename.
    }
    catch (err) {
        primaryErr = err instanceof Error ? err : new Error(String(err));
    }
    finally {
        let closeErr = null;
        try {
            node_fs_1.default.closeSync(fd);
        }
        catch (err) {
            closeErr = err instanceof Error ? err : new Error(String(err));
        }
        if (primaryErr !== null) {
            try {
                node_fs_1.default.unlinkSync(tmpPath);
            }
            catch { /* best-effort — no orphan */ }
            throw primaryErr;
        }
        if (closeErr !== null) {
            try {
                node_fs_1.default.unlinkSync(tmpPath);
            }
            catch { /* best-effort — no orphan */ }
            throw closeErr;
        }
    }
    // WIN-1: retry the rename on transient Windows AV/indexer locks before giving up (writeLedger parity).
    let renameErr = null;
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            node_fs_1.default.renameSync(tmpPath, filePath);
            renameErr = null;
            break;
        }
        catch (err) {
            renameErr = err instanceof Error ? err : new Error(String(err));
            const code = err.code ?? '';
            if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
                renameBackoff();
                continue;
            }
            break;
        }
    }
    if (renameErr !== null) {
        try {
            node_fs_1.default.unlinkSync(tmpPath);
        }
        catch { /* best-effort */ }
        throw renameErr;
    }
    fsyncContainingDir(filePath);
}
/**
 * Record a PROJECT-scope consent: that the user, on THIS machine, accepted capability `id` at the
 * given `projectRoot`, bound to the recomputed bundle `contentHash` (the security binding) plus the
 * `integrity` + `disclosureSignature` (kept for the disclosure/re-consent UX). Rejects an unsafe id
 * (throws, writing nothing). Idempotent: re-recording the same (projectRoot, id) overwrites in place;
 * other records are preserved.
 *
 * CONSENT-CONCURRENCY-1: the whole read-modify-write runs UNDER the consent-store lock so two
 * different projects writing concurrently cannot lose each other's record.
 * CONSENT-MAXRECORDS-WRITE-1: refuses to grow the store past MAX_RECORDS BEFORE writing (a clear
 * 'consent store full' throw), leaving the on-disk store intact.
 *
 * #1459 finding 3 (MEDIUM): if the consent-store lock CANNOT be acquired, this THROWS rather than
 * proceeding UNLOCKED — an unlocked read-modify-write is exactly the lost-update vector the lock exists
 * to prevent. The lifecycle treats a consent-write failure as NON-FATAL + warns (round-2 IC-05), so
 * throwing here is safe: an install still succeeds; the cap simply stays inactive until consent can be
 * written. (The OLD code returned a null handle and proceeded unlocked — that is the bug.)
 */
function recordProjectConsent(args) {
    const { gsdHome, projectRoot, id, integrity, disclosureSignature, contentHash, reviewerHost } = args;
    if (isUnsafeCapabilityId(id)) {
        throw new Error(`Invalid capability id "${String(id)}": must match /^[a-z][a-z0-9-]*$/ (kebab-case, lowercase). ` +
            `Unsafe or non-kebab ids are rejected to keep the consent store prototype-pollution-safe.`);
    }
    if (typeof contentHash !== 'string' || !contentHash) {
        throw new Error(`recordProjectConsent: a non-empty contentHash is required (it is the security binding). ` +
            `Compute it via bundleContentHash(capDir) over the installed bundle.`);
    }
    const realRoot = realpathProject(projectRoot);
    const lockDir = node_path_1.default.dirname(consentStorePath(gsdHome));
    try {
        node_fs_1.default.mkdirSync(lockDir, { recursive: true });
    }
    catch { /* best-effort — write also mkdirs */ }
    // #1459 finding 3: never proceed UNLOCKED. A null handle (live holder / contention budget exhausted)
    // → throw rather than risk a lost update.
    const lock = acquireConsentLock(lockDir);
    if (lock === null) {
        throw new Error(`recordProjectConsent: could not acquire the consent-store lock at ${consentLockPath(gsdHome)} ` +
            `(another writer holds it). Refusing to write the consent store UNLOCKED (a lost-update risk). ` +
            `Retry; if a stale lock persists past the deadman it is reclaimed automatically.`);
    }
    try {
        const store = readConsentStore(gsdHome);
        const key = consentKey(realRoot, id);
        // CONSENT-MAXRECORDS-WRITE-1: enforce the cap BEFORE the write. A re-record of an EXISTING key
        // does not grow the store (allowed); only ADDING a new key when already at the cap is refused.
        if (!Object.prototype.hasOwnProperty.call(store.records, key) && Object.keys(store.records).length >= MAX_RECORDS) {
            throw new Error(`consent store full: already at the maximum of ${MAX_RECORDS} consent records. Revoke an ` +
                `unused consent (gsd capability trust revoke) before recording a new one.`);
        }
        store.records[key] = {
            projectRoot: realRoot,
            id,
            scope: 'project',
            integrity,
            disclosureSignature,
            contentHash,
            consentedAt: new Date().toISOString(),
            // Written only when the capability actually declares an egress destination, so a spawn lane
            // or a non-lane capability keeps a byte-identical record shape.
            ...(typeof reviewerHost === 'string' && reviewerHost ? { reviewerHost } : {}),
        };
        writeConsentStore(gsdHome, store);
    }
    finally {
        releaseConsentLock(lock);
    }
}
/**
 * Revoke a PROJECT-scope consent record. No-op (and never throws) when the record is absent or the
 * id is unsafe. Atomic, LOCKED write of the resulting store. Used on `capability remove` and
 * `trust revoke`.
 *
 * #1459 finding 3 (MEDIUM): if the consent-store lock CANNOT be acquired, this THROWS rather than
 * doing an unlocked read-modify-write (the lost-update vector). An ABSENT-record no-op still happens
 * UNDER the lock (so a concurrent record cannot interleave); only a genuine lock-acquire failure throws.
 */
function revokeProjectConsent(args) {
    const { gsdHome, projectRoot, id } = args;
    if (isUnsafeCapabilityId(id))
        return; // an unsafe id was never stored — nothing to revoke.
    const realRoot = realpathProject(projectRoot);
    const lockDir = node_path_1.default.dirname(consentStorePath(gsdHome));
    try {
        node_fs_1.default.mkdirSync(lockDir, { recursive: true });
    }
    catch { /* best-effort — write also mkdirs */ }
    // #1459 finding 3: never proceed UNLOCKED — a null handle throws rather than deleting unlocked.
    const lock = acquireConsentLock(lockDir);
    if (lock === null) {
        throw new Error(`revokeProjectConsent: could not acquire the consent-store lock at ${consentLockPath(gsdHome)} ` +
            `(another writer holds it). Refusing to modify the consent store UNLOCKED (a lost-update risk). ` +
            `Retry; if a stale lock persists past the deadman it is reclaimed automatically.`);
    }
    try {
        const store = readConsentStore(gsdHome);
        const key = consentKey(realRoot, id);
        if (!Object.prototype.hasOwnProperty.call(store.records, key))
            return; // absent — no-op.
        delete store.records[key];
        writeConsentStore(gsdHome, store);
    }
    finally {
        releaseConsentLock(lock);
    }
}
/**
 * The egress destination a capability's consent was granted against, or `undefined`.
 *
 * ADR-2782 D5 rule 4 (#2799) — read on the INVOCATION path, not only at install, because
 * `hostConfigKey` names a key in `.planning/config.json`: the one consent-bound value that lives
 * outside the SHA-pinned bundle and can be changed by an ordinary pull request with no re-install
 * and no integrity check.
 *
 * `undefined` means "nothing to compare", and the caller MUST treat that as allow, not deny. Two
 * legitimate ways to get it: the capability has no consent record at all (first-party lanes ship
 * inside the SHA-pinned distribution and are never consent-gated), or the record predates this
 * field. Denying on absence would break every existing local-model user on upgrade.
 *
 * Non-throwing: a missing, corrupt, or oversized store yields `undefined` like any other absence.
 */
function readConsentedReviewerHost(args) {
    const { gsdHome, projectRoot, id } = args;
    if (isUnsafeCapabilityId(id))
        return undefined;
    try {
        const store = readConsentStore(gsdHome);
        const key = consentKey(realpathProject(projectRoot), id);
        if (!Object.prototype.hasOwnProperty.call(store.records, key))
            return undefined;
        const host = store.records[key].reviewerHost;
        return typeof host === 'string' && host ? host : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * #1459 finding 2 (round 6): TEST-ONLY — override the cumulative bundle entry-count cap and return a
 * restore() that resets it to the production default. Lets a test prove the streaming walk fails closed
 * at the bound without planting 100k real files. Never called by production code.
 */
function _setBundleMaxFilesForTest(n) {
    const prev = BUNDLE_MAX_FILES;
    BUNDLE_MAX_FILES = n;
    return () => { BUNDLE_MAX_FILES = prev; };
}
module.exports = {
    consentStorePath,
    bundleContentHash,
    readConsentStore,
    readConsentedReviewerHost,
    hasProjectConsent,
    recordProjectConsent,
    revokeProjectConsent,
    // Exported for testing / introspection.
    MAX_RECORDS,
    CONSENT_FILE_NAME,
    // #1459 finding 3/4: the consent-store lock path + the shared lock primitive's test seams (so tests
    // can plant a lock and inject deterministic liveness probes to verify the never-steal-a-live-writer
    // and dead-holder-reclaim behavior). Not part of the CLI surface.
    consentLockPath,
    _setLockProbes: lockMod._setLockProbes,
    _resetLockProbes: lockMod._resetLockProbes,
    // #1459 finding 2 (round 6): a TEST-ONLY seam to drive the cumulative entry-count cap deterministically
    // (so a test can prove the streaming walk fails closed at the bound without planting 100k real files).
    // Returns a restore() that resets the cap to its production default. Not part of the CLI surface.
    _setBundleMaxFilesForTest,
};
