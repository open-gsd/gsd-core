// gsd-hook-version: {{GSD_VERSION}}
// Read a path's entry out of the commit HEAD names, straight from `.git`.
//
// `headTreeEntry(startDir, relPath, limits?)` answers "what mode and object id
// does the tree of HEAD hold at this path?" without spawning git and without a
// timer: the verdict depends only on the repository's bytes, never on machine
// load or the wall clock (#4432).
//
// What it reads, in order:
//   1. the git dir: walk up from startDir to the nearest `.git`; a `.git` FILE
//      (linked worktree, submodule) holds `gitdir: <path>`; a `commondir` file
//      points at the directory that holds the shared objects and refs.
//   2. HEAD: a `ref:` chain through loose refs, then `packed-refs`, ending at a
//      40-hex object id (a detached HEAD holds the id directly).
//   3. objects: a loose object (`objects/xx/yyyy…`, zlib) or an object in a
//      pack (`objects/pack/*.idx` version 2 + `.pack`, including OFS_DELTA and
//      REF_DELTA chains).
//   4. the commit's `tree`, then each path segment through nested trees.
//
// Fail closed: ANY problem — no repository, no commits, a SHA-256 repository,
// a missing object (shallow/partial clone, objects only in alternates), an
// unknown index version, corruption, a structural limit — returns null. This
// module never throws and never answers from a guess. It is a pure reader: it
// spawns nothing and sets no timer, so every bound below is structural (a
// count or a byte size), not a duration.
//
// Standalone on purpose (node built-ins `fs`, `path`, `zlib` only): hooks are
// installed as loose files and cannot require `src/`.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LIMITS = Object.freeze({
  maxRefHops: 8,
  maxParentDirs: 64,
  maxObjectBytes: 1024 * 1024,
  maxDeltaDepth: 50,
  maxRefsFileBytes: 4 * 1024 * 1024,
  maxPackFiles: 64,
});

const HEX40 = /^[0-9a-f]{40}$/;

// Internal bail-out: caught once at the entry point and turned into null.
class Unreadable extends Error {}

function fail(why) {
  throw new Unreadable(why);
}

function resolveLimits(limits) {
  const out = { ...LIMITS };
  if (limits !== null && typeof limits === 'object') {
    for (const key of Object.keys(LIMITS)) {
      const v = limits[key];
      if (Number.isInteger(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}

// ─── bounded file reads ─────────────────────────────────────────────────────

function readExactAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  if (n !== len) fail('short read');
  return buf;
}

function readFileBounded(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) fail('not a regular file');
    if (st.size > maxBytes) fail('file too large');
    return st.size === 0 ? Buffer.alloc(0) : readExactAt(fd, 0, st.size);
  } finally {
    fs.closeSync(fd);
  }
}

function readTextOrNull(file, maxBytes) {
  try {
    return readFileBounded(file, maxBytes).toString('utf8');
  } catch (err) {
    if (err instanceof Unreadable) throw err;
    return null; // missing or not a file: the caller decides what that means
  }
}

// ─── locating the repository ────────────────────────────────────────────────

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// A `.git` file is followed only when it is the one `git worktree add` wrote:
// its gitdir is <commondir>/worktrees/<name> and that directory's `gitdir`
// back-pointer names this very `.git` file. A planted file fails one of the two.
function linkedWorktree(dir, dotGit, gitDir) {
  const common = readTextOrNull(path.join(gitDir, 'commondir'), 4096);
  if (common === null || common.trim() === '') fail('worktree git dir has no commondir');
  const commonDir = path.resolve(gitDir, common.trim());
  if (!sameRealPath(path.dirname(gitDir), path.join(commonDir, 'worktrees'))) fail('git dir is not a linked worktree');
  const back = readTextOrNull(path.join(gitDir, 'gitdir'), 4096);
  if (back === null || back.trim() === '') fail('worktree git dir has no back-pointer');
  if (!sameRealPath(path.resolve(gitDir, back.trim()), dotGit)) fail('worktree back-pointer names another .git file');
  return { top: dir, gitDir, commonDir };
}

function locateGit(startDir, limits) {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= limits.maxParentDirs; i++) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st !== null) {
      const gitDir = dotGit;
      if (st.isFile()) {
        const text = readTextOrNull(dotGit, 4096);
        const m = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
        if (m === null) fail('unreadable .git file');
        return linkedWorktree(dir, dotGit, path.resolve(dir, m[1]));
      } else if (!st.isDirectory()) {
        fail('unexpected .git entry');
      }
      let commonDir = gitDir;
      const common = readTextOrNull(path.join(gitDir, 'commondir'), 4096);
      if (common !== null && common.trim() !== '') commonDir = path.resolve(gitDir, common.trim());
      return { top: dir, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fail('no repository');
}

function assertSha1Repository(commonDir, limits) {
  const config = readTextOrNull(path.join(commonDir, 'config'), limits.maxRefsFileBytes);
  if (config !== null && /^\s*objectformat\s*=\s*sha256\s*$/im.test(config)) fail('sha256 repository');
}

// ─── refs ───────────────────────────────────────────────────────────────────

function isSafeRefName(name) {
  return name !== '' && !name.startsWith('/') && !name.includes('\0') && !name.includes('\\') &&
    !name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

// packed-refs is read at most once per repository per call, however many ref hops follow.
function readPackedRefs(base, repo, limits) {
  if (repo.packedRefsCache === undefined) repo.packedRefsCache = new Map();
  if (!repo.packedRefsCache.has(base)) {
    repo.packedRefsCache.set(base, readTextOrNull(path.join(base, 'packed-refs'), limits.maxRefsFileBytes));
  }
  return repo.packedRefsCache.get(base);
}

function lookupRef(name, repo, limits) {
  if (!isSafeRefName(name)) fail('bad ref name');
  for (const base of repo.gitDir === repo.commonDir ? [repo.gitDir] : [repo.gitDir, repo.commonDir]) {
    const loose = readTextOrNull(path.join(base, ...name.split('/')), 4096);
    if (loose !== null && loose.trim() !== '') return loose.trim();
  }
  for (const base of repo.gitDir === repo.commonDir ? [repo.gitDir] : [repo.commonDir, repo.gitDir]) {
    const packed = readPackedRefs(base, repo, limits);
    if (packed === null) continue;
    for (const line of packed.split('\n')) {
      if (line === '' || line[0] === '#' || line[0] === '^') continue;
      const space = line.indexOf(' ');
      if (space === 40 && line.slice(space + 1).trim() === name) return line.slice(0, 40);
    }
  }
  return fail('ref not found');
}

function resolveHead(repo, limits) {
  const head = readTextOrNull(path.join(repo.gitDir, 'HEAD'), 4096);
  if (head === null) fail('no HEAD');
  let content = head.trim();
  let hops = 0;
  while (content.startsWith('ref:')) {
    hops++;
    if (hops > limits.maxRefHops) fail('too many ref hops');
    content = lookupRef(content.slice(4).trim(), repo, limits);
  }
  if (!HEX40.test(content)) fail('HEAD does not name a SHA-1 object');
  return content;
}

// ─── objects ────────────────────────────────────────────────────────────────

const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// Worst-case deflate expansion is 5 bytes per 64 KiB block plus a few bytes of
// framing; this bound is only a memory cap on how much compressed input to read.
function compressedCap(inflatedBytes) {
  return inflatedBytes + (inflatedBytes >> 8) + 64;
}

function readLoose(oid, repo, limits) {
  const file = path.join(repo.commonDir, 'objects', oid.slice(0, 2), oid.slice(2));
  let raw;
  try {
    raw = readFileBounded(file, compressedCap(limits.maxObjectBytes));
  } catch (err) {
    if (err instanceof Unreadable) throw err;
    if (err && err.code === 'ENOENT') return null;
    return fail('unreadable loose object');
  }
  const inflated = zlib.inflateSync(raw, { maxOutputLength: limits.maxObjectBytes });
  const nul = inflated.indexOf(0);
  if (nul === -1) fail('loose object has no header');
  const m = /^(commit|tree|blob|tag) (\d+)$/.exec(inflated.toString('latin1', 0, nul));
  if (m === null) fail('bad loose object header');
  const data = inflated.subarray(nul + 1);
  if (data.length !== Number(m[2])) fail('loose object size mismatch');
  return { type: m[1], data, depth: 0 };
}

function applyDelta(base, delta, limits) {
  let pos = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) fail('truncated delta');
      const b = delta[pos++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) return value;
      if (shift > 56) fail('delta size overflow');
    }
  };
  const srcSize = varint();
  const dstSize = varint();
  if (srcSize !== base.length) fail('delta base size mismatch');
  if (dstSize > limits.maxObjectBytes) fail('delta result too large');
  const out = Buffer.alloc(dstSize);
  let outPos = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if ((cmd & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if ((cmd & (1 << i)) !== 0) {
          if (pos >= delta.length) fail('truncated delta copy');
          offset += delta[pos++] * 2 ** (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((cmd & (0x10 << i)) !== 0) {
          if (pos >= delta.length) fail('truncated delta copy');
          size += delta[pos++] * 2 ** (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || outPos + size > dstSize) fail('delta copy out of range');
      base.copy(out, outPos, offset, offset + size);
      outPos += size;
    } else if (cmd !== 0) {
      if (pos + cmd > delta.length || outPos + cmd > dstSize) fail('delta insert out of range');
      delta.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      fail('reserved delta opcode');
    }
  }
  if (outPos !== dstSize) fail('delta result size mismatch');
  return out;
}

function packEntry(packFd, packSize, offset, level, repo, limits) {
  if (level > limits.maxDeltaDepth) fail('delta chain too deep');
  if (offset < 12 || offset >= packSize) fail('pack offset out of range');
  const header = readExactAt(packFd, offset, Math.min(32, packSize - offset));
  let pos = 0;
  let byte = header[pos++];
  const typeCode = (byte >> 4) & 7;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (pos >= header.length || shift > 56) fail('bad pack entry header');
    byte = header[pos++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (size > limits.maxObjectBytes) fail('pack object too large');

  let baseOffset = -1;
  let baseOid = null;
  if (typeCode === 6) {
    if (pos >= header.length) fail('bad ofs-delta header');
    byte = header[pos++];
    let rel = byte & 0x7f;
    while ((byte & 0x80) !== 0) {
      if (pos >= header.length) fail('bad ofs-delta header');
      byte = header[pos++];
      rel = (rel + 1) * 128 + (byte & 0x7f);
    }
    baseOffset = offset - rel;
  } else if (typeCode === 7) {
    if (pos + 20 > header.length) fail('bad ref-delta header');
    baseOid = header.toString('hex', pos, pos + 20);
    pos += 20;
  } else if (TYPE_NAMES[typeCode] === undefined) {
    fail('unknown pack object type');
  }

  const start = offset + pos;
  const want = Math.min(compressedCap(size), packSize - start);
  if (want <= 0) fail('pack entry has no data');
  const inflated = zlib.inflateSync(readExactAt(packFd, start, want), { maxOutputLength: Math.max(size, 1) });
  if (inflated.length !== size) fail('pack entry size mismatch');

  if (typeCode !== 6 && typeCode !== 7) return { type: TYPE_NAMES[typeCode], data: inflated, depth: 0 };

  let base;
  if (typeCode === 6) {
    if (baseOffset < 12) fail('bad ofs-delta base');
    base = packEntry(packFd, packSize, baseOffset, level + 1, repo, limits);
  } else {
    base = readObject(baseOid, repo, limits, level + 1);
  }
  return { type: base.type, data: applyDelta(base.data, inflated, limits), depth: base.depth + 1 };
}

function idxLookup(idxFd, idxSize, oid) {
  const head = readExactAt(idxFd, 0, 8 + 1024);
  if (head.readUInt32BE(0) !== 0xff744f63 || head.readUInt32BE(4) !== 2) fail('unsupported pack index');
  const fan = (i) => head.readUInt32BE(8 + 4 * i);
  const count = fan(255);
  if (idxSize < 8 + 1024 + count * 28 + 40) fail('truncated pack index');
  const want = Buffer.from(oid, 'hex');
  let lo = want[0] === 0 ? 0 : fan(want[0] - 1);
  let hi = fan(want[0]);
  if (lo > hi || hi > count) fail('corrupt pack index fanout');
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = Buffer.compare(readExactAt(idxFd, 1032 + mid * 20, 20), want);
    if (cmp === 0) {
      const off32 = readExactAt(idxFd, 1032 + count * 24 + mid * 4, 4).readUInt32BE(0);
      if ((off32 & 0x80000000) === 0) return off32;
      const slot = off32 & 0x7fffffff;
      if (idxSize < 1032 + count * 28 + slot * 8 + 8 + 40) fail('truncated pack index');
      const big = readExactAt(idxFd, 1032 + count * 28 + slot * 8, 8).readBigUInt64BE(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('pack offset too large');
      return Number(big);
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function readPacked(oid, repo, limits, level) {
  const packDir = path.join(repo.commonDir, 'objects', 'pack');
  let names;
  try {
    names = fs.readdirSync(packDir).filter((n) => n.endsWith('.idx')).sort();
  } catch {
    return null;
  }
  if (names.length > limits.maxPackFiles) fail('too many pack files');
  for (const name of names) {
    const idxFd = fs.openSync(path.join(packDir, name), 'r');
    try {
      const offset = idxLookup(idxFd, fs.fstatSync(idxFd).size, oid);
      if (offset === -1) continue;
      const packFd = fs.openSync(path.join(packDir, `${name.slice(0, -4)}.pack`), 'r');
      try {
        return packEntry(packFd, fs.fstatSync(packFd).size, offset, level, repo, limits);
      } finally {
        fs.closeSync(packFd);
      }
    } finally {
      fs.closeSync(idxFd);
    }
  }
  return null;
}

function readObject(oid, repo, limits, level) {
  if (!HEX40.test(oid)) fail('bad object id');
  if (level > limits.maxDeltaDepth) fail('delta chain too deep');
  const loose = readLoose(oid, repo, limits);
  if (loose !== null) return loose;
  const packed = readPacked(oid, repo, limits, level);
  if (packed !== null) return packed;
  return fail('object not found');
}

// ─── trees ──────────────────────────────────────────────────────────────────

function findInTree(data, name) {
  const want = Buffer.from(name, 'utf8');
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = space === -1 ? -1 : data.indexOf(0, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > data.length) fail('corrupt tree');
    if (data.subarray(space + 1, nul).equals(want)) {
      return { mode: data.toString('latin1', pos, space), oid: data.toString('hex', nul + 1, nul + 21) };
    }
    pos = nul + 21;
  }
  return null;
}

function lookup(startDir, relPath, limits) {
  if (typeof startDir !== 'string' || startDir === '' || typeof relPath !== 'string' || relPath === '') return null;
  if (startDir.includes('\0') || relPath.includes('\0')) return null;
  const repo = locateGit(startDir, limits);
  const rel = path.relative(repo.top, path.resolve(startDir, relPath));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null; // allow-handrolled-containment: an installed hook cannot require src/security.cts
  const segments = rel.split(path.sep);
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;

  assertSha1Repository(repo.commonDir, limits);
  const commit = readObject(resolveHead(repo, limits), repo, limits, 0);
  if (commit.type !== 'commit') fail('HEAD is not a commit');
  const m = /^tree ([0-9a-f]{40})\n/.exec(commit.data.toString('latin1', 0, Math.min(commit.data.length, 64)));
  if (m === null) fail('commit has no tree');

  let treeOid = m[1];
  for (let i = 0; i < segments.length; i++) {
    const tree = readObject(treeOid, repo, limits, 0);
    if (tree.type !== 'tree') fail('not a tree');
    const entry = findInTree(tree.data, segments[i]);
    if (entry === null) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/**
 * @param {string} startDir directory the walk up to `.git` starts from
 * @param {string} relPath  path relative to startDir (a path below the repo top)
 * @param {Partial<typeof LIMITS>} [limits] structural bounds, for tests
 * @returns {{mode: string, oid: string} | null} the tree entry HEAD holds at the
 *   path, or null when it is absent or the repository cannot be read with confidence
 */
function headTreeEntry(startDir, relPath, limits) {
  try {
    return lookup(startDir, relPath, resolveLimits(limits));
  } catch {
    return null;
  }
}

// Exposed so tests can drive the parsers with hand-built buffers; not a public API.
const _internal = { applyDelta, idxLookup, packEntry, lookupRef, locateGit, resolveLimits };

module.exports = { headTreeEntry, LIMITS, _internal };
