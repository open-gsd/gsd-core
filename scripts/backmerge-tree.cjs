#!/usr/bin/env node
'use strict';

// backmerge-tree.cjs — #4990, single source for the back-merge CONTENT
// construction/verification shared by two workflows (CLAUDE.md "Generative
// Fix Divergence": a fact re-derived in two independent hand-kept copies is
// free to drift silently — this closes exactly that risk).
//
// .github/workflows/auto-backmerge.yml calls `stage --main origin/main`
// (right after `git checkout -B <branch> origin/next`) to build the REAL
// back-merge commit's tree, then commits and pushes it itself — this script
// owns none of that surrounding branch/commit/push machinery, only the tree
// construction.
//
// .github/workflows/backmerge-merge-when-green.yml calls
// `verify --next <sha> --main <sha> --merge-commit <sha> --head <sha>` to
// INDEPENDENTLY REPRODUCE that construction from the merge commit's own
// recorded parents and prove the PR's actual head contains nothing beyond
// it (or, at most, one commit that changes ONLY the `version` field of a
// file in VERSION_STAMP_MANIFESTS — auto-backmerge.yml's optional
// best-effort version-sync commit) — without ever committing anything
// itself.
//
// TRUST BOUNDARY (review fix, CRITICAL, code#3): `verify` is always invoked
// with `--cwd <scratch-worktree>` pointed at a `git worktree add` SCRATCH
// checkout — never the trusted default-branch checkout the calling workflow
// also reads scripts/ci-required-checks-verdict.cjs and
// .github/rulesets/main-protection.json from. Every git call in this module
// honors `--cwd` (including `fileExistsAtRef`, fixed here — review fix,
// code#9: it used to silently ignore `cwd` and run against the process's
// own working directory instead of the caller's `opts`), so `verify` never
// touches the trusted tree's checkout/index/HEAD.
//
// No `timeout` option was set on any git subprocess call as of the first
// version of this module — that gap is now closed: `GIT_TIMEOUT_MS` bounds
// every call (see its own comment below for the confirmation this required).

const { execFileSync } = require('node:child_process');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  VERSIONED_MANIFESTS,
  VERSIONED_MANIFEST_PATHS,
  getByPath,
  CAPABILITY_MANIFEST_PATH_RE,
} = require('./sync-manifest-versions.cjs');
const { isReleaseVersion } = require('./sync-next-version.cjs');

// Review fix (sec MEDIUM): the tolerated version-sync shape is now derived
// from the SAME single source `npm version` itself uses
// (scripts/sync-manifest-versions.cjs's `VERSIONED_MANIFESTS` — which
// already covers `.claude-plugin/plugin.json` (`version`),
// `.claude-plugin/marketplace.json` (`plugins.0.version`), and
// `vscode/package.json` (`version`)), rather than a second, independently
// hand-kept list that could silently drift from what a real `npm version`
// bump actually touches. `package.json` and `package-lock.json` are NOT
// part of that registry (npm's own version bump writes them directly, not
// via the sync script) and are named explicitly here; the generated
// capability registry (`CAPABILITY_REGISTRY_PATH`) is a third, distinct
// shape (line-based, not a single JSON field) handled separately below.
const CAPABILITY_REGISTRY_PATH = 'gsd-core/bin/lib/capability-registry.cjs';

const VERSION_STAMP_MANIFESTS = Object.freeze([
  'package.json',
  'package-lock.json',
  ...VERSIONED_MANIFEST_PATHS,
  CAPABILITY_REGISTRY_PATH,
]);

/**
 * The dotted field path(s) (per scripts/sync-manifest-versions.cjs's
 * `getByPath`/`setByPath` contract) that a real version sync writes in
 * `filePath`, or `null` if `filePath` is not a JSON-field-shaped manifest
 * (i.e. it is `CAPABILITY_REGISTRY_PATH`, handled by its own line-based
 * checker, or not a registered manifest at all).
 *
 * `package-lock.json`'s second path, `'packages..version'`, splits (on `.`)
 * to `['packages', '', 'version']` — exactly `packages[""].version`, npm's
 * own "this package" entry in the v2/v3 lockfile format, the SAME two-path
 * shape the original file-level check named explicitly.
 */
// Round-4 review fix (LOW, code#8): named explicitly, not an accidental
// artifact of splitting 'packages..version' on '.'. A v2/v3 npm lockfile's
// top-level "packages" object keys every entry by its install path RELATIVE
// TO THE LOCKFILE ROOT; the root package's own entry (i.e. "this package",
// the one npm's own `version` lifecycle bumps) is keyed by the EMPTY STRING
// — `packages[""].version`. Splitting `'packages..version'` on `.` yields
// `['packages', '', 'version']`, which resolves exactly that path via the
// same plain-key traversal getByPath/stripFieldPaths already use (no special
// casing needed — a JS object accepts `''` as an ordinary key). Stated as its
// own named constant, with this comment, so the shape reads as a deliberate
// design decision rather than something a future edit could "simplify away"
// as a stray double-dot typo.
const PACKAGE_LOCK_FIELD_PATHS = Object.freeze(['version', 'packages..version']);

function fieldPathsForFile(filePath) {
  if (filePath === 'package.json') return ['version'];
  if (filePath === 'package-lock.json') return PACKAGE_LOCK_FIELD_PATHS;
  const entry = VERSIONED_MANIFESTS.find((e) => e.path === filePath);
  return entry ? [entry.versionKey] : null;
}

// Review fix (MAJOR, code#8): every git subprocess in this module is now
// bounded. Confirmed explicitly by the human, in-turn, per CLAUDE.md
// "Unbounded Subprocesses" (git/npm subprocesses require timeouts, 5-30s for
// git): a `git` plumbing call in this module's own class caps at 30s.
const GIT_TIMEOUT_MS = 30000;

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...opts });
}

/**
 * Review fix (code#9): this used to be called WITHOUT `opts`, silently
 * running `git cat-file` against the calling process's own cwd instead of
 * the `--cwd` a caller (e.g. `verify`, operating in a scratch worktree) had
 * requested — a trust-boundary leak in a function whose entire job is to
 * stay inside the caller's chosen tree.
 *
 * Review fix (MINOR, code#5): a TIMED-OUT `git cat-file` is rethrown, never
 * swallowed into `false`. Before this fix, a timeout here looked identical
 * to "the file genuinely doesn't exist" — inside `stageBackmergeTree`, that
 * silently SKIPS the CHANGELOG.md overlay instead of failing loudly, which
 * would ship a real back-merge commit missing content it should have
 * carried. "Inconclusive" must never resolve to a specific, confident
 * answer.
 */
function fileExistsAtRef(ref, file, opts = {}) {
  try {
    git(['cat-file', '-e', `${ref}:${file}`], opts);
    return true;
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    return false;
  }
}

/**
 * True iff `err` is the shape `execFileSync` throws when its `timeout`
 * option fires: Node sets `err.killed === true` and, on this platform,
 * `err.signal` (commonly `SIGTERM`) plus (per Node's documented behavior
 * for the child_process timeout option) `err.code === 'ETIMEDOUT'` is NOT
 * guaranteed to be set for every OS/Node version, so `killed` is the
 * primary, reliable signal — `code === 'ETIMEDOUT'` is checked too,
 * defensively, in case a future Node version sets it consistently.
 */
function isGitTimeoutError(err) {
  return !!(err && (err.killed === true || err.code === 'ETIMEDOUT'));
}

/**
 * `git show <ref>:<file>` contents, or `null` if the path does not exist at
 * that ref. Review fix (MINOR, code#5): rethrows on a timed-out git call —
 * see fileExistsAtRef's comment for why "inconclusive" must never collapse
 * into the same `null` a genuine missing-path read returns.
 */
function showFileAtRefOrNull(ref, file, opts = {}) {
  try {
    return git(['show', `${ref}:${file}`], opts);
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    return null;
  }
}

/**
 * True iff `commit` is `ref` itself or an ancestor of it. Fails CLOSED:
 * `git merge-base --is-ancestor` exits non-zero both on a definite "no" and
 * on a real error (unknown ref, etc.) — both cases are treated the same way
 * here (not confirmed ancestor), since a caller deciding whether to trust a
 * commit's ancestry must never default to "yes" on an inconclusive read.
 */
function isAncestor(commit, ref, opts = {}) {
  try {
    git(['merge-base', '--is-ancestor', commit, ref], opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `git diff --name-status` output into `{status, file}` rows. Tab-
 * separated, one entry per line; a rename status (e.g. `R100`) is NOT
 * matched by the D/A/M handling in stageBackmergeTree — same as the bash
 * this replaces, which only ever branched on exactly `D`/`A`/`M`.
 */
function parseNameStatus(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    rows.push({ status: line.slice(0, tab), file: line.slice(tab + 1) });
  }
  return rows;
}

function splitNonEmptyLines(output) {
  return output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Round-6 review fix (BLOCKER, code#2 / sec LOW): discover native capability
 * manifests from `ref`'s OWN git tree (`git ls-tree -r --name-only <ref> --
 * capabilities/`), never from any checkout on disk. The prior version read
 * `--trusted`'s checkout via `listCapabilityManifests({root})` (an
 * fs.readdirSync-based glob) — a real capability introduced only on `next`
 * (never yet on `main`) is fully present in `mergeCommit`'s own tree (the
 * `-s ours` merge keeps next's tree wholesale), but a CHECKOUT of some
 * unrelated ref (or a stale/partial one) could disagree with what the
 * COMMIT BEING VERIFIED actually contains — the commit's own tree is the
 * only source that can never be stale or mismatched relative to itself.
 * This also removes the `--trusted` CLI flag's only real use (see below).
 *
 * Filtered with the SAME shape predicate
 * (`sync-manifest-versions.cjs`'s `CAPABILITY_MANIFEST_PATH_RE`) the real
 * glob-based sync uses — one shared regex, not two independently hand-kept
 * shape rules that could silently diverge.
 */
function listCapabilityManifestsFromTree(ref, opts) {
  let output;
  try {
    output = git(['ls-tree', '-r', '--name-only', ref, '--', 'capabilities/'], opts);
  } catch (err) {
    // Round-7 review fix (NIT, code#2): a TIMED-OUT `git ls-tree` is
    // rethrown, never swallowed into `[]` — same "inconclusive must never
    // resolve to a specific confident answer" rule fileExistsAtRef/
    // showFileAtRefOrNull already follow (round-4). Before this fix, a
    // timeout here looked identical to "no capabilities/ directory exists",
    // which would silently accept an extra/sync commit's capability-manifest
    // changes as out-of-scope-checked when the check never actually ran.
    if (isGitTimeoutError(err)) throw err;
    // No capabilities/ directory at this ref (or the ref itself is
    // unreadable for a non-timeout reason) — an empty capability-manifest
    // set, not a crash. The caller (verifyBackmergeContent) still fails
    // closed independently via its own out-of-scope check on anything
    // actually found in the diff.
    return [];
  }
  return splitNonEmptyLines(output).filter((rel) => CAPABILITY_MANIFEST_PATH_RE.test(rel));
}

/**
 * Recursive structural equality — order-independent on object keys (so a
 * JSON.stringify of the same logical document with keys re-serialized in a
 * different order still compares equal), used by isVersionOnlyChange below.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const k of aKeys) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Delete the field at each dotted path in `fieldPaths` from a deep clone of
 * `doc` and return the clone. Mirrors sync-manifest-versions.cjs's own
 * getByPath/setByPath traversal (numeric-string array indices, no special
 * casing) so this stays byte-for-byte consistent with what that module
 * considers "the version field" for a given path.
 */
function stripFieldPaths(doc, fieldPaths) {
  const clone = JSON.parse(JSON.stringify(doc));
  for (const fieldPath of fieldPaths) {
    const parts = String(fieldPath).split('.');
    let cur = clone;
    for (let i = 0; i < parts.length - 1 && cur != null && typeof cur === 'object'; i++) {
      cur = cur[parts[i]];
    }
    if (cur != null && typeof cur === 'object') {
      delete cur[parts[parts.length - 1]];
    }
  }
  return clone;
}

/**
 * Review fix (HIGH, code#7; sec MEDIUM shape fix): FIELD-level version-sync
 * tolerance for a JSON-shaped manifest, not file-level. A file appearing in
 * a diff is not enough to accept it as "the version sync": this
 *   1. resolves `filePath`'s field path(s) via `fieldPathsForFile` (`null`
 *      -> not a registered JSON manifest at all -> reject),
 *   2. parses both copies as JSON (unparseable on either side -> reject,
 *      fails CLOSED),
 *   3. requires the NEW value at EVERY field path to equal `targetVersion`
 *      exactly (review fix: the old version merely required "consistently
 *      changed", never validating WHAT it changed TO — a version bump to
 *      the wrong value, or to something that isn't even main's actual
 *      released version, is now rejected too), and
 *   4. strips those field paths and requires the REMAINDER to be
 *      structurally identical — a dependency bump, a `scripts` edit, or any
 *      other change riding along in the same file is rejected exactly like
 *      a change to an unrelated file would be.
 */
/**
 * Shared JSON-field-level checker: both isVersionOnlyChange (a registered
 * manifest, whose field path(s) come from fieldPathsForFile) and the native
 * capability-manifest check below (whose single field path is always
 * `'version'`, top-level — see syncCapabilityVersions in
 * sync-manifest-versions.cjs) delegate here rather than each re-implementing
 * "parse both sides as JSON, require the target field(s) to equal
 * targetVersion, require everything else to be byte-for-byte structurally
 * identical" a second time.
 */
function isJsonVersionOnlyChange({ oldText, newText, fieldPaths, targetVersion }) {
  let oldDoc;
  let newDoc;
  try {
    oldDoc = JSON.parse(oldText);
    newDoc = JSON.parse(newText);
  } catch {
    return false;
  }
  if (typeof oldDoc !== 'object' || oldDoc === null || typeof newDoc !== 'object' || newDoc === null) {
    return false;
  }

  for (const fieldPath of fieldPaths) {
    if (getByPath(newDoc, fieldPath) !== targetVersion) return false;
  }

  return deepEqual(stripFieldPaths(oldDoc, fieldPaths), stripFieldPaths(newDoc, fieldPaths));
}

function isVersionOnlyChange({ oldText, newText, filePath, targetVersion }) {
  const fieldPaths = fieldPathsForFile(filePath);
  if (!fieldPaths) return false;
  return isJsonVersionOnlyChange({ oldText, newText, fieldPaths, targetVersion });
}

/**
 * Review fix (sec MEDIUM): CAPABILITY_REGISTRY_PATH is a GENERATED file (by
 * `gen-capability-registry.cjs`, fired by the npm `version` lifecycle hook)
 * whose repeated `"version": "X.Y.Z"` lines are not one single JSON
 * document field — it is checked LINE-by-LINE instead: every line that
 * differs between old/new text must match the version-line shape on BOTH
 * sides, and the new value must equal `targetVersion`. Requires the two
 * texts to have the SAME LINE COUNT — a real version bump only ever
 * replaces existing values in place; it never inserts or removes lines, so
 * a line-count mismatch is itself evidence of an unmodeled change (rejected
 * rather than attempting a real diff/patience algorithm here).
 */
const CAPABILITY_REGISTRY_VERSION_LINE_RE = /^(\s*"version":\s*")([^"]*)("\s*,?\s*)$/;

/**
 * Round-4 review fix (LOW, code#9): a changed line is accepted ONLY when its
 * PRIOR value equals `preSyncVersion` (the package version BEFORE this
 * extra/sync commit — i.e. the value at the merge commit, next's own
 * pre-sync version) AND its new value equals `targetVersion` exactly.
 * Before this fix, any line matching the bare `"version": "X"` shape could
 * be changed to targetVersion regardless of what it previously held — which
 * would also accept an attacker selectively rewriting an unrelated
 * capability's already-different version metadata to the release version,
 * as long as it merely LOOKED like a version line. Requiring the prior value
 * to match the known pre-sync package version ties every accepted line back
 * to "this was genuinely still at next's old version," the same invariant a
 * real `npm version` bump satisfies for every line it touches.
 */
function isCapabilityRegistryVersionOnlyChange({ oldText, newText, targetVersion, preSyncVersion }) {
  if (typeof preSyncVersion !== 'string') return false;
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  if (oldLines.length !== newLines.length) return false;

  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i] === newLines[i]) continue;
    const oldMatch = CAPABILITY_REGISTRY_VERSION_LINE_RE.exec(oldLines[i]);
    const newMatch = CAPABILITY_REGISTRY_VERSION_LINE_RE.exec(newLines[i]);
    if (!oldMatch || !newMatch) return false;
    if (oldMatch[2] !== preSyncVersion) return false;
    if (newMatch[2] !== targetVersion) return false;
  }
  return true;
}

/**
 * Build the back-merge tree on top of the CURRENT HEAD (assumed to already
 * be at the "next" side — either the real `origin/next` tip, or a replayed
 * historical next-parent sha) by merging in `mainRef` with `-s ours`,
 * overlaying `mainRef`'s CHANGELOG.md, and replaying the `.changeset`
 * add/modify/delete diff between `merge-base(HEAD, mainRef)` and `mainRef`.
 * Leaves the result STAGED (never commits) and returns the resulting tree
 * hash (`git write-tree`).
 */
function stageBackmergeTree({ mainRef, cwd }) {
  const opts = cwd ? { cwd } : {};

  // -s ours never conflicts; the "next" side's tree is kept wholesale and
  // only explicitly overlaid below.
  git(['merge', '-s', 'ours', '--no-commit', '--no-ff', mainRef], opts);

  if (fileExistsAtRef(mainRef, 'CHANGELOG.md', opts)) {
    git(['checkout', mainRef, '--', 'CHANGELOG.md'], opts);
    git(['add', 'CHANGELOG.md'], opts);
  }

  // HEAD has not moved (merge --no-commit never advances it), so this is the
  // same merge-base a caller would get computing it before the merge above.
  const base = git(['merge-base', 'HEAD', mainRef], opts).trim();

  const diffOutput = git(['diff', '--name-status', base, mainRef, '--', '.changeset'], opts);
  for (const { status, file } of parseNameStatus(diffOutput)) {
    if (status === 'D') {
      git(['rm', '--quiet', '--ignore-unmatch', '--', file], opts);
    } else if (status === 'A' || status === 'M') {
      git(['checkout', mainRef, '--', file], opts);
      git(['add', '--', file], opts);
    }
  }

  return git(['write-tree'], opts).trim();
}

/**
 * Independently REPRODUCE the back-merge tree from a merge commit's own
 * recorded parents and prove `head` contains nothing beyond it (or, at
 * most, one commit whose changed manifests each pass isVersionOnlyChange).
 *
 * ALWAYS call this with `cwd` pointed at a SCRATCH `git worktree add`
 * checkout, never the trusted default-branch checkout — see the module
 * header's TRUST BOUNDARY note. This function checks out/resets `cwd`
 * freely; it must never be a tree anything else depends on being stable.
 *
 * Review fix (HIGH, code#2 / code#3): before trusting the merge commit's
 * recorded parents at all, `nextParent` is proven to be a REAL ancestor of
 * the trusted branch it claims to descend from (`merge-base --is-ancestor
 * nextParent origin/next`) — a forged merge commit naming an arbitrary sha
 * as its next-side parent fails here before any tree comparison even runs.
 *
 * Round-10 review fix (SEC LOW): `mainParent` must be EXACTLY
 * `origin/main`'s CURRENT tip — not merely an ancestor of it. A mere
 * ancestor check would accept a back-merge branch built from a STALE main
 * (main has since moved), which can silently RE-ADD `.changeset` fragments
 * (or other release-engineering content) a NEWER release already consumed —
 * the overlay in `stageBackmergeTree` is diffed against `mainParent`, not
 * against main's real current state, so a stale `mainParent` reintroduces
 * exactly what the newer release already removed. `nextParent` stays an
 * ancestor check (not exact-tip) because `next` legitimately keeps moving
 * with unrelated work between when a back-merge branch is built and when it
 * is verified — only `main`'s content is replayed into the tree, so only
 * `main` needs to be pinned to its current tip.
 *
 * Then every commit in `origin/next..head` is required to be EITHER
 * reachable from `origin/main` (i.e. legitimately pulled in via the -s ours
 * merge's own ancestry), OR the merge commit itself, OR the one allowed
 * extra (version-sync) commit on top — anything else is a foreign commit
 * smuggled into the branch and is rejected.
 *
 * Review fix (MAJOR, code#8): every git call this function makes is bounded
 * by GIT_TIMEOUT_MS. A timeout (or any other uncaught git failure) is caught
 * at the TOP LEVEL here and turned into `{ok:false, reason:'git-timeout'|
 * 'git-command-failed', ...}` — CLAUDE.md's fail-closed contract applied
 * literally: an inconclusive read (the git call never finished) must never
 * be mistaken for, or silently resolve to, "content verified, safe to
 * merge". Before this, an uncaught timeout would propagate as a raw thrown
 * exception all the way to the CLI entrypoint — still non-zero exit (never
 * a false "ok:true"), but as an unstructured crash instead of the same
 * typed JSON verdict shape every other rejection in this function returns.
 *
 * Round-4 review fix (BLOCKER, code#1), superseded in shape by round-6
 * (BLOCKER, code#2 / sec LOW): the set of manifests an extra/sync commit is
 * allowed to touch now ALSO includes every native capability manifest
 * (`capabilities/<id>/capability.json`) — discovered via
 * `listCapabilityManifestsFromTree(mergeCommit, opts)`, which reads
 * `mergeCommit`'s OWN git tree directly (`git ls-tree`), never any checkout
 * on disk. This also means a capability introduced only on `next` (not yet
 * on `main`) is correctly found (mergeCommit's tree IS next's tree,
 * wholesale, via the `-s ours` merge) — the checkout-based round-4 approach
 * (`--trusted <path>`) is gone entirely; nothing else in this module used
 * it. A real sync commit (`npm version` -> the `version` lifecycle hook ->
 * `sync-manifest-versions.cjs --stage`) stamps every one of these; the
 * static VERSION_STAMP_MANIFESTS list never covered them, so before the
 * round-4 fix EVERY real sync commit that touched a capability manifest was
 * unconditionally rejected as `extra-commit-out-of-scope`.
 *
 * @returns {{ok:true}|{ok:false, reason:string, [key:string]:*}}
 */
function verifyBackmergeContent({ nextParent, mainParent, mergeCommit, head, cwd }) {
  const opts = cwd ? { cwd } : {};

  try {
    if (!isAncestor(nextParent, 'origin/next', opts)) {
      return { ok: false, reason: 'next-parent-not-ancestor-of-origin-next', nextParent };
    }
    // Round-10 review fix (SEC LOW): exact-tip, not merely ancestor — see
    // the function's own doc comment above for why a stale mainParent is a
    // real content-smuggling hazard (a since-consumed .changeset fragment
    // could be silently re-added). `git rev-parse` itself can time out; that
    // is caught by this function's own top-level try/catch below, same as
    // every other git call here.
    const currentMainSha = git(['rev-parse', 'origin/main'], opts).trim();
    if (mainParent !== currentMainSha) {
      return { ok: false, reason: 'main-parent-not-current', mainParent, currentMainSha };
    }

    const rangeCommits = splitNonEmptyLines(git(['rev-list', `origin/next..${head}`], opts));
    for (const commit of rangeCommits) {
      if (commit === mergeCommit) continue;
      if (commit === head && head !== mergeCommit) continue; // the one allowed extra commit; file/field-scoped below
      if (isAncestor(commit, 'origin/main', opts)) continue; // legitimately pulled in via -s ours
      return { ok: false, reason: 'foreign-commit-in-range', commit };
    }

    git(['checkout', '-q', '--detach', nextParent], opts);
    let candidateTree;
    try {
      candidateTree = stageBackmergeTree({ mainRef: mainParent, cwd });
    } finally {
      try {
        git(['reset', '-q', '--hard', nextParent], opts);
      } catch {
        // Best-effort cleanup, mirroring the `|| true` this replaces — a
        // failed reset must never mask (or be mistaken for) the verification
        // result computed above.
      }
    }

    const mergeCommitTree = git(['rev-parse', `${mergeCommit}^{tree}`], opts).trim();
    if (candidateTree !== mergeCommitTree) {
      return { ok: false, reason: 'tree-mismatch', candidateTree, mergeCommitTree };
    }

    if (head === mergeCommit) {
      return { ok: true };
    }

    const extraFiles = splitNonEmptyLines(git(['diff', '--name-only', mergeCommit, head], opts));
    // Round-6 review fix (BLOCKER, code#2): discovered from mergeCommit's
    // OWN tree — never a checkout — so a capability that exists on `next`
    // but not yet on `main` is still correctly found.
    const capabilityManifestPaths = new Set(listCapabilityManifestsFromTree(mergeCommit, opts));
    const outOfScope = extraFiles.filter(
      (f) => !VERSION_STAMP_MANIFESTS.includes(f) && !capabilityManifestPaths.has(f),
    );
    if (outOfScope.length > 0) {
      return { ok: false, reason: 'extra-commit-out-of-scope', outOfScope };
    }

    // Review fix (sec MEDIUM): the tolerated new value must equal MAIN
    // PARENT's own package.json version — never just "some value the extra
    // commit happened to settle on" — and that version must itself pass the
    // repo's existing release-version predicate (scripts/sync-next-version.cjs's
    // `isReleaseVersion`: X.Y.Z, optionally -rc.N/-beta.N; rejects -dev and
    // anything else). If main's own package.json can't be read or isn't a
    // release version, nothing about "this is a legitimate version sync" can
    // be trusted, so every extra file is rejected outright.
    const mainPackageJsonText = showFileAtRefOrNull(mainParent, 'package.json', opts);
    let targetVersion = null;
    if (mainPackageJsonText !== null) {
      try {
        targetVersion = JSON.parse(mainPackageJsonText).version;
      } catch {
        targetVersion = null;
      }
    }
    if (typeof targetVersion !== 'string' || !isReleaseVersion(targetVersion)) {
      return { ok: false, reason: 'main-parent-version-not-a-release-version', targetVersion };
    }

    // Round-4 review fix (LOW, code#9): the capability-registry checker also
    // requires each changed line's PRIOR value to equal next's own pre-sync
    // package version — read from mergeCommit's package.json (the state
    // immediately before this extra/sync commit).
    const mergeCommitPackageJsonText = showFileAtRefOrNull(mergeCommit, 'package.json', opts);
    let preSyncVersion = null;
    if (mergeCommitPackageJsonText !== null) {
      try {
        preSyncVersion = JSON.parse(mergeCommitPackageJsonText).version;
      } catch {
        preSyncVersion = null;
      }
    }

    const fieldMismatches = [];
    for (const file of extraFiles) {
      // A file that did not exist at mergeCommit at all (added, not modified,
      // by the extra commit) is a mismatch, not a crash — `git show` throws on
      // a missing path, so both reads are defensively caught rather than
      // letting an uncaught exception escape verifyBackmergeContent. Found by
      // this module's own test suite (a fixture that introduced a manifest
      // for the first time in the extra commit) — fixed here, not worked
      // around in the test.
      const oldText = showFileAtRefOrNull(mergeCommit, file, opts);
      const newText = showFileAtRefOrNull(head, file, opts);
      if (oldText === null || newText === null) {
        fieldMismatches.push(file);
        continue;
      }
      const isOk = file === CAPABILITY_REGISTRY_PATH
        ? isCapabilityRegistryVersionOnlyChange({ oldText, newText, targetVersion, preSyncVersion })
        : capabilityManifestPaths.has(file)
          ? isJsonVersionOnlyChange({ oldText, newText, fieldPaths: ['version'], targetVersion })
          : isVersionOnlyChange({ oldText, newText, filePath: file, targetVersion });
      if (!isOk) {
        fieldMismatches.push(file);
      }
    }
    if (fieldMismatches.length > 0) {
      return { ok: false, reason: 'version-sync-field-mismatch', fieldMismatches };
    }

    return { ok: true };
  } catch (err) {
    if (isGitTimeoutError(err)) {
      return { ok: false, reason: 'git-timeout', message: err.message };
    }
    return { ok: false, reason: 'git-command-failed', message: err.message };
  }
}

/**
 * Identify the back-merge merge commit reachable from `head` BY ANCESTRY,
 * never by parent COUNT alone.
 *
 * Round-9 review fix (correcting a round-8 regression): a round-8 "fix" here
 * rejected any 2-parent commit whose own parent was ITSELF a merge commit —
 * that is WRONG and rejects GENUINE back-merges: `main`'s tip is routinely a
 * merge commit (release.yml merges release -> main with `gh pr merge
 * --merge`), and `next`'s tip can be one too (a prior back-merge). Parent
 * COUNT was never the right signal; ANCESTRY is. A commit `M` is the
 * genuine back-merge merge commit if and only if:
 *   - `M` has exactly two parents, `M^1` and `M^2`;
 *   - `M^1` is `origin/next` or an ancestor of it (the "next" side);
 *   - `M^2` is `origin/main` or an ancestor of it (the "main" side).
 * `head` matches the expected shape iff:
 *   - `head` itself is such an `M` (no extra commit on top), or
 *   - `head` has exactly one parent, and that parent is such an `M` (the
 *     one allowed extra/version-sync commit on top).
 *
 * This correctly REFUSES a `gh pr update-branch`-style merge-of-a-merge `U`
 * laid on top of a genuine `M`: `U`'s first parent is `M` itself (or a
 * descendant of it), which is NOT an ancestor of `origin/next` (only `M`'s
 * OWN first parent is), so `U` fails the ancestry test as a candidate `M`;
 * and `U` is not a single-parent commit sitting on top of a genuine `M`
 * either (it has two parents) — `head` therefore matches neither shape and
 * is refused as `unrecognized-shape`.
 *
 * Requires `origin/next` and `origin/main` to already be present as
 * remote-tracking refs in `cwd` (both call sites fetch them before invoking
 * this: backmerge-merge-when-green.yml's "Fetch main and next into the
 * trusted checkout" step, and auto-backmerge.yml's push job's own
 * `git fetch --no-tags origin main next` in its verify step — worktrees
 * share their parent repository's refs, so a scratch `git worktree add`
 * checkout sees them too without fetching again).
 *
 * @returns {{ok:true, mergeCommit:string, nextParent:string, mainParent:string, extraCommit:string|null}|{ok:false, reason:string}}
 */
function identifyMergeCommit({ head, cwd }) {
  const opts = cwd ? { cwd } : {};

  function parentsOf(commit) {
    const line = git(['rev-list', '--parents', '--max-count=1', commit], opts).trim();
    const parts = line.split(/\s+/).filter(Boolean);
    return parts.slice(1); // drop the commit itself (first field)
  }

  /**
   * True iff `commit` matches the genuine back-merge merge-commit shape:
   * exactly two parents, first an ancestor-or-self of origin/next, second
   * an ancestor-or-self of origin/main. `isAncestor` (`git merge-base
   * --is-ancestor`) already treats a commit as its own ancestor, so this
   * also accepts `commit` itself being exactly the tip of either branch.
   */
  function matchesMergeCommitShape(commit) {
    const parents = parentsOf(commit);
    if (parents.length !== 2) return null;
    const [p1, p2] = parents;
    if (!isAncestor(p1, 'origin/next', opts)) return null;
    if (!isAncestor(p2, 'origin/main', opts)) return null;
    return { mergeCommit: commit, nextParent: p1, mainParent: p2 };
  }

  // Review fix (MAJOR, code#8): a bounded git call can still time out; that
  // must resolve to the same {ok:false} shape every other rejection in this
  // function uses, never an uncaught crash. `isAncestor` itself already
  // fails closed (swallows to `false`, per its own doc comment) rather than
  // throwing, so only the `rev-list`/`parentsOf` calls need this guard here.
  try {
    const direct = matchesMergeCommitShape(head);
    if (direct) {
      return { ok: true, mergeCommit: direct.mergeCommit, nextParent: direct.nextParent, mainParent: direct.mainParent, extraCommit: null };
    }

    const headParents = parentsOf(head);
    if (headParents.length === 1) {
      const viaParent = matchesMergeCommitShape(headParents[0]);
      if (viaParent) {
        return {
          ok: true,
          mergeCommit: viaParent.mergeCommit,
          nextParent: viaParent.nextParent,
          mainParent: viaParent.mainParent,
          extraCommit: head,
        };
      }
    }
  } catch (err) {
    return isGitTimeoutError(err)
      ? { ok: false, reason: 'git-timeout', message: err.message }
      : { ok: false, reason: 'git-command-failed', message: err.message };
  }
  return { ok: false, reason: 'unrecognized-shape' };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/backmerge-tree.cjs stage --main <ref> [--cwd <path>]',
    '  node scripts/backmerge-tree.cjs identify --head <sha> --cwd <path>',
    '  node scripts/backmerge-tree.cjs verify --next <sha> --main <sha>',
    '    --merge-commit <sha> --head <sha> --cwd <scratch-worktree-path>',
    '',
    'stage: stages the back-merge tree (git merge -s ours + CHANGELOG.md',
    '  overlay + .changeset replay) on top of the current HEAD against',
    '  --main <ref>, and prints the resulting `git write-tree` hash. Never',
    '  commits.',
    '',
    'identify: locates the back-merge merge commit reachable from --head by',
    '  its expected two-parent shape (never by searching history for "the',
    '  most recent merge commit"). Prints JSON {ok, mergeCommit, nextParent,',
    '  mainParent, extraCommit} and exits 0, or {ok:false, reason} and exits 1.',
    '',
    'verify: independently reproduces that same tree from a merge commit\'s',
    '  own recorded parents (after proving they are real ancestors of',
    '  origin/next and origin/main) and proves --head contains nothing',
    '  beyond it (or at most one commit whose changed manifests are each',
    '  version-field-only changes). ALWAYS pass --cwd pointed at a scratch',
    '  `git worktree add` checkout — never the trusted default-branch tree,',
    '  which this subcommand checks out/resets freely. Prints a JSON verdict',
    '  and exits 0 (ok) or 1 (not ok).',
  ].join('\n');
}

function parseArgs(argv) {
  const sub = argv[0];
  if (sub === '--help' || sub === '-h') {
    process.stdout.write(`${usage()}\n`);
    throw new ExitError(0);
  }
  if (sub !== 'stage' && sub !== 'verify' && sub !== 'identify') {
    throw new Error(`unknown subcommand: ${sub || '(none)'} — expected "stage", "identify", or "verify"`);
  }

  const out = {
    sub,
    mainRef: undefined,
    cwd: undefined,
    nextParent: undefined,
    mergeCommit: undefined,
    head: undefined,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--main') {
      out.mainRef = argv[++i];
    } else if (arg === '--cwd') {
      out.cwd = argv[++i];
    } else if (arg === '--next') {
      out.nextParent = argv[++i];
    } else if (arg === '--merge-commit') {
      out.mergeCommit = argv[++i];
    } else if (arg === '--head') {
      out.head = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (sub === 'stage' && !out.mainRef) throw new Error('--main <ref> is required');
  if (sub === 'identify') {
    if (!out.head) throw new Error('--head <sha> is required for identify');
    if (!out.cwd) throw new Error('--cwd <path> is required for identify');
  }
  if (sub === 'verify') {
    if (!out.mainRef) throw new Error('--main <ref> is required');
    if (!out.nextParent) throw new Error('--next <sha> is required for verify');
    if (!out.mergeCommit) throw new Error('--merge-commit <sha> is required for verify');
    if (!out.head) throw new Error('--head <sha> is required for verify');
    if (!out.cwd) throw new Error('--cwd <scratch-worktree-path> is required for verify (never the trusted tree)');
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.sub === 'stage') {
    const tree = stageBackmergeTree({ mainRef: args.mainRef, cwd: args.cwd });
    process.stdout.write(`${tree}\n`);
    return 0;
  }

  if (args.sub === 'identify') {
    const result = identifyMergeCommit({ head: args.head, cwd: args.cwd });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }

  const result = verifyBackmergeContent({
    nextParent: args.nextParent,
    mainParent: args.mainRef,
    mergeCommit: args.mergeCommit,
    head: args.head,
    cwd: args.cwd,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  runMain(main);
}

module.exports = {
  VERSION_STAMP_MANIFESTS,
  CAPABILITY_REGISTRY_PATH,
  GIT_TIMEOUT_MS,
  git,
  isGitTimeoutError,
  fileExistsAtRef,
  showFileAtRefOrNull,
  isAncestor,
  parseNameStatus,
  splitNonEmptyLines,
  deepEqual,
  fieldPathsForFile,
  stripFieldPaths,
  isJsonVersionOnlyChange,
  isVersionOnlyChange,
  isCapabilityRegistryVersionOnlyChange,
  listCapabilityManifestsFromTree,
  stageBackmergeTree,
  identifyMergeCommit,
  verifyBackmergeContent,
  parseArgs,
  main,
};
