'use strict';
/**
 * #6146 — the path shapes the `.planning/` confinement of the state tools must
 * refuse, shared by the MCP dispatch tests (tests/gsd-mcp-server.test.cjs) and
 * the adapter tests (tests/state-io.test.cjs) so both seams are pinned against
 * the SAME cases, independently of each other.
 *
 * Every fixture lives in one temp directory:
 *
 *   <dir>/proj/.planning/STATE.md      in-root state file (IN)
 *   <dir>/proj/.planning/sub/          in-root subdirectory
 *   <dir>/outside/secret.md            outside file (SECRET)
 *
 * Each shape returns the target path plus a `proof` callback that asserts the
 * negative: no outside (or in-root) file was read into the result, created or
 * modified. Shapes that need a symlink or a hardlink skip where the platform
 * refuses to create one (Windows without the privilege).
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createTempDir, cleanup } = require('../helpers.cjs');

const SECRET = 'SECRET-OUTSIDE-6146\n';
const IN = 'IN-ROOT-STATE-6146\n';
const PAYLOAD = 'PAYLOAD-6146\n';

/** Every refusal names the boundary, leaks no absolute path and no file content. */
function assertRefusalText(text, fx, reason) {
  assert.ok(!text.includes(SECRET.trim()) && !text.includes(IN.trim()), `no file content may be returned: ${text}`);
  assert.match(text, /refused: .+; state paths must resolve inside the project \.planning\/ root/, `refusal must name the boundary: ${text}`);
  assert.ok(!text.includes(fx.dir), `refusal must not echo an absolute path: ${text}`);
  if (reason) assert.match(text, new RegExp(`refused: ${reason}`), `refusal must give the specific reason: ${text}`);
}

function buildFixture(t) {
  const dir = fs.realpathSync(createTempDir());
  t.after(() => cleanup(dir));
  const proj = path.join(dir, 'proj');
  const planning = path.join(proj, '.planning');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(planning, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, SECRET);
  const state = path.join(planning, 'STATE.md');
  fs.writeFileSync(state, IN);
  return { dir, proj, planning, outside, secret, state };
}

/** Create a link, or skip the test where the platform refuses (EPERM on Windows). */
function link(t, kind, target, at) {
  try {
    if (kind === 'hard') fs.linkSync(target, at);
    else fs.symlinkSync(target, at, kind === 'dir' ? 'dir' : 'file');
    return true;
  } catch (e) {
    t.skip(`cannot create a ${kind} link here (${e.code})`);
    return false;
  }
}

function unchanged(fx) {
  assert.equal(fs.readFileSync(fx.secret, 'utf8'), SECRET, 'the outside file must be unchanged');
  assert.equal(fs.readFileSync(fx.state, 'utf8'), IN, 'the in-root state file must be unchanged');
  assert.deepEqual(fs.readdirSync(fx.outside).sort(), ['secret.md'], 'nothing may be created outside');
}

/**
 * Shapes: `ops` lists which operations to try. `setup` returns the target path
 * (or null when it skipped). Raw string joins keep `..` segments un-normalized.
 */
const SYMLINKED_ROOT_REASON = 'the \\.planning/ root is a symbolic link';

const REFUSAL_SHAPES = [
  { name: 'absolute path to an existing outside file', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => fx.secret },
  { name: 'absolute path to a new outside file', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => path.join(fx.outside, 'new.md') },
  { name: '".." escape from the root', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => [fx.planning, '..', '..', 'outside', 'secret.md'].join(path.sep) },
  { name: '".." escape through an in-root subdirectory', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => [fx.planning, 'sub', '..', '..', '..', 'outside', 'new.md'].join(path.sep) },
  {
    name: 'sibling directory sharing the root name prefix (.planning-x)', reason: 'the path is outside the root', ops: ['read', 'write'],
    setup: (fx) => {
      const sib = path.join(fx.proj, '.planning-x');
      fs.mkdirSync(sib);
      fs.writeFileSync(path.join(sib, 'STATE.md'), SECRET);
      return path.join(sib, 'STATE.md');
    },
    proof: (fx) => assert.equal(fs.readFileSync(path.join(fx.proj, '.planning-x', 'STATE.md'), 'utf8'), SECRET),
  },
  { name: 'the bare parent directory', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => fx.proj },
  { name: 'a file in the bare parent directory', reason: 'the path is outside the root', ops: ['read', 'write'], setup: (fx) => path.join(fx.proj, 'STATE.md'), proof: (fx) => assert.equal(fs.existsSync(path.join(fx.proj, 'STATE.md')), false) },
  { name: 'the root directory itself', reason: 'the path names the root directory itself', ops: ['read', 'write'], setup: (fx) => fx.planning },
  { name: 'a trailing separator', reason: 'the path names a directory', ops: ['read', 'write'], setup: (fx) => fx.state + path.sep },
  { name: 'a NUL byte', reason: 'the path must be a non-empty string with no NUL byte', ops: ['read', 'write'], setup: (fx) => `${fx.state}\0.md` },
  {
    // A regression that resolves relative paths against process.cwd() would
    // land this INSIDE the temp root, never in the repository.
    name: 'a relative path (resolved against the process cwd it would point into the root)', reason: 'the path must be absolute', ops: ['read', 'write'],
    setup: (fx, t) => {
      const rel = path.relative(process.cwd(), fx.state);
      if (path.isAbsolute(rel)) { t.skip('temp dir is on another drive than the process cwd'); return null; }
      return rel;
    },
  },
  {
    // A regression that rewrites relative paths into the root would create
    // <root>/sub/rel.md; resolved against process.cwd() its parent is absent.
    name: 'a relative path (rewritten into the root it would name a new file)', reason: 'the path must be absolute', ops: ['write'],
    setup: () => path.join('sub', 'rel-6146.md'),
    proof: (fx) => assert.equal(fs.existsSync(path.join(fx.planning, 'sub', 'rel-6146.md')), false, 'never rewritten into the root'),
  },
  {
    name: 'symlinked file inside the root pointing outside', reason: 'the path resolves outside the root', ops: ['read', 'write'],
    setup: (fx, t) => (link(t, 'file', fx.secret, path.join(fx.planning, 'link.md')) ? path.join(fx.planning, 'link.md') : null),
  },
  {
    name: 'symlinked directory inside the root pointing outside (existing file)', reason: 'the path resolves outside the root', ops: ['read', 'write'],
    setup: (fx, t) => (link(t, 'dir', fx.outside, path.join(fx.planning, 'linkdir')) ? path.join(fx.planning, 'linkdir', 'secret.md') : null),
  },
  {
    name: 'symlinked directory inside the root pointing outside (new file)', reason: 'the path resolves outside the root', ops: ['write'],
    setup: (fx, t) => (link(t, 'dir', fx.outside, path.join(fx.planning, 'linkdir')) ? path.join(fx.planning, 'linkdir', 'new.md') : null),
  },
  {
    name: 'dangling symlink inside the root pointing outside', reason: 'the path goes through a dangling symbolic link', ops: ['read', 'write'],
    setup: (fx, t) => (link(t, 'file', path.join(fx.outside, 'nope.md'), path.join(fx.planning, 'dangle.md')) ? path.join(fx.planning, 'dangle.md') : null),
  },
  {
    name: 'dangling directory symlink inside the root pointing outside', reason: 'the path goes through a dangling symbolic link', ops: ['write'],
    setup: (fx, t) => (link(t, 'dir', path.join(fx.outside, 'nodir'), path.join(fx.planning, 'dangledir')) ? path.join(fx.planning, 'dangledir', 'new.md') : null),
  },
  {
    name: 'symlink chain inside the root ending outside', reason: 'the path resolves outside the root', ops: ['read', 'write'],
    setup: (fx, t) => {
      if (!link(t, 'file', fx.secret, path.join(fx.planning, 'b.md'))) return null;
      return link(t, 'file', path.join(fx.planning, 'b.md'), path.join(fx.planning, 'a.md')) ? path.join(fx.planning, 'a.md') : null;
    },
  },
  {
    name: 'hard link inside the root to an outside file', reason: 'the file has more than one hard link', ops: ['read', 'write'],
    setup: (fx, t) => (link(t, 'hard', fx.secret, path.join(fx.planning, 'hard.md')) ? path.join(fx.planning, 'hard.md') : null),
  },
  {
    // Lexically outside, real path inside: only the lexical check refuses it.
    name: 'outside alias that symlinks into the root', reason: 'the path is outside the root', ops: ['read', 'write'],
    setup: (fx, t) => (link(t, 'dir', fx.planning, path.join(fx.proj, 'alias')) ? path.join(fx.proj, 'alias', 'STATE.md') : null),
  },
  { name: 'an in-root directory', reason: 'the path is not a regular file', ops: ['read', 'write'], setup: (fx) => path.join(fx.planning, 'sub') },
  {
    name: 'missing parent directory inside the root', reason: 'the parent directory does not exist', ops: ['write'],
    setup: (fx) => path.join(fx.planning, 'no-such-dir', 'new.md'),
    proof: (fx) => assert.equal(fs.existsSync(path.join(fx.planning, 'no-such-dir')), false),
  },
];

/**
 * The symlinked-root shape replaces `.planning` itself, so it has its own
 * fixture: `<dir>/proj2/.planning -> <dir>/outside`.
 */
function symlinkedRootFixture(t, fx) {
  const proj2 = path.join(fx.dir, 'proj2');
  fs.mkdirSync(proj2);
  if (!link(t, 'dir', fx.outside, path.join(proj2, '.planning'))) return null;
  return { proj: proj2, planning: path.join(proj2, '.planning') };
}

module.exports = { SECRET, IN, PAYLOAD, REFUSAL_SHAPES, SYMLINKED_ROOT_REASON, buildFixture, symlinkedRootFixture, assertRefusalText, unchanged, link };
