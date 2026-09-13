#!/usr/bin/env node
/**
 * lint-compiled-artifact-sync — fail when a *tracked*, direct-tsc artifact
 * under gsd-core/bin/lib/ has drifted from its src/*.cts source.
 *
 * ADR-457 compiles src/*.cts to gsd-core/bin/lib/*.cjs at build time and expects
 * those artifacts to be gitignored. Most are (see .gitignore). A handful are
 * still tracked because the migration that moved the module into src/ did not
 * also add the emitted .cjs to .gitignore. While a compiled artifact remains
 * tracked, the committed bytes are what ships to anyone who reads the repo
 * without building — so they must match the source.
 *
 * #2653: gsd-core/bin/lib/api-coverage.cjs sat four days behind its .cts after
 * PR #2551 changed the source without regenerating the artifact, shipping a
 * module that silently lacked the entire #2366 fix while CI stayed green.
 *
 * This check is deliberately regime-agnostic: it asserts a property of whatever
 * is tracked right now, except outputs explicitly owned by another canonical
 * producer and checked by that producer's own sync gate. If the remaining
 * direct-tsc artifacts are later untracked and gitignored (the ADR-457 end
 * state), the checked set becomes empty and this script passes trivially.
 *
 * Usage: node scripts/lint-compiled-artifact-sync.cjs [--check]
 * Exit 0 when every tracked artifact matches a fresh compile; 1 otherwise.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getBundleArtifactManifest } = require('./build-opencode-v2-bundles.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join('gsd-core', 'bin', 'lib');
const SRC_DIR = 'src';

/** Frozen reason codes so tests assert on structure, not prose. */
const REASON = Object.freeze({
  OK: 'ok_artifacts_in_sync',
  DRIFTED: 'fail_artifact_drifted',
  BUILD_FAILED: 'fail_build_failed',
  MISSING_EMIT: 'fail_missing_emit',
});

function git(args) {
  // -c safe.directory=REPO_ROOT: containerized CI checkouts are frequently
  // owned by a different uid than the one running the test process, and git
  // refuses to operate at all on such a repo ("detected dubious ownership")
  // unless explicitly trusted. Scoped per-invocation (not written to any
  // config file) so this never widens trust beyond this one call.
  return execFileSync('git', ['-c', `safe.directory=${REPO_ROOT}`, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * Tracked .cjs files under gsd-core/bin/lib/ that have a matching src/*.cts.
 * Uses `git ls-files` so the set is derived from what git actually tracks
 * rather than a hand-maintained list that could itself drift.
 */
function producerOwnedOutputs(manifests) {
  const owners = new Map();
  const producers = new Set();
  for (const [index, manifest] of manifests.entries()) {
    if (!manifest || typeof manifest !== 'object') throw new Error(`producer manifest ${index} must be an object`);
    const { producer, outputs } = manifest;
    if (typeof producer !== 'string' || producer.length === 0) throw new Error(`producer manifest ${index} has no producer`);
    if (producers.has(producer)) throw new Error(`duplicate producer manifest: ${producer}`);
    producers.add(producer);
    if (!Array.isArray(outputs)) throw new Error(`producer manifest ${producer} outputs must be an array`);
    for (const output of outputs) {
      if (typeof output !== 'string' || output.length === 0 || path.isAbsolute(output) || output.includes('\\')) {
        throw new Error(`producer manifest ${producer} has invalid output: ${String(output)}`);
      }
      const normalized = path.posix.normalize(output);
      if (normalized !== output || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`producer manifest ${producer} output escapes the repository: ${output}`);
      }
      if (owners.has(output)) {
        throw new Error(`ambiguous producer ownership for ${output}: ${owners.get(output)} and ${producer}`);
      }
      owners.set(output, producer);
    }
  }
  return owners;
}

function classifyTrackedCompiledArtifacts({ tracked, sourceExists, producerManifests }) {
  const owners = producerOwnedOutputs(producerManifests);
  const out = [];
  const producerOwned = [];
  for (const rel of tracked) {
    if (!rel.endsWith('.cjs')) continue;
    const stem = path.basename(rel, '.cjs');
    const subdir = path.dirname(path.relative(LIB_DIR, rel));
    const srcRel = path.join(SRC_DIR, subdir === '.' ? '' : subdir, `${stem}.cts`);
    if (!sourceExists(srcRel)) continue;
    if (owners.has(srcRel)) throw new Error(`producer source/output collision: ${srcRel}`);
    if (owners.has(rel)) {
      producerOwned.push({ artifact: rel, source: srcRel, producer: owners.get(rel) });
    } else {
      out.push({ artifact: rel, source: srcRel });
    }
  }
  const byArtifact = (a, b) => (a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0);
  return { pairs: out.sort(byArtifact), producerOwned: producerOwned.sort(byArtifact) };
}

function trackedCompiledArtifactClassification() {
  const tracked = git(['ls-files', LIB_DIR]).split('\n').filter(Boolean);
  return classifyTrackedCompiledArtifacts({
    tracked,
    sourceExists: (source) => fs.existsSync(path.join(REPO_ROOT, source)),
    producerManifests: [getBundleArtifactManifest()],
  });
}

function trackedCompiledArtifacts() {
  return trackedCompiledArtifactClassification().pairs;
}

/** Compile the whole project to a throwaway outDir so the work tree is untouched. */
function compileToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-artifact-sync-'));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p', path.join(REPO_ROOT, 'tsconfig.build.json'),
        '--outDir', tmp,
        // A throwaway outDir must not reuse the in-tree incremental state, or
        // tsc skips emit for files it believes are already current.
        '--incremental', 'false',
        '--tsBuildInfoFile', 'null',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return { ok: true, dir: tmp };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, detail };
  }
}

function compareCompiledArtifacts(pairs, buildDir, repoRoot = REPO_ROOT) {
  const drifted = [];
  const missing = [];
  for (const { artifact, source } of pairs) {
    const fresh = path.join(buildDir, path.relative(LIB_DIR, artifact));
    if (!fs.existsSync(fresh)) { missing.push({ artifact, source }); continue; }
    const committed = fs.readFileSync(path.join(repoRoot, artifact));
    const expected = fs.readFileSync(fresh);
    if (!committed.equals(expected)) {
      drifted.push({ artifact, source, committed: committed.length, expected: expected.length });
    }
  }
  return { drifted, missing };
}

function main() {
  let pairs;
  try {
    ({ pairs } = trackedCompiledArtifactClassification());
  } catch (err) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.BUILD_FAILED}`);
    console.error(err.message);
    return 1;
  }
  if (pairs.length === 0) {
    console.log('ok compiled-artifact-sync: no tracked compiled artifacts (ADR-457 end state)');
    return 0;
  }

  const build = compileToTemp();
  if (!build.ok) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.BUILD_FAILED}`);
    console.error(build.detail);
    return 1;
  }

  let comparison;
  try {
    comparison = compareCompiledArtifacts(pairs, build.dir);
  } finally {
    fs.rmSync(build.dir, { recursive: true, force: true });
  }
  const { drifted, missing } = comparison;

  if (missing.length > 0) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.MISSING_EMIT}`);
    for (const m of missing) console.error(`  ${m.artifact} — no emit produced from ${m.source}`);
    return 1;
  }

  if (drifted.length > 0) {
    console.error(`FAIL compiled-artifact-sync: ${REASON.DRIFTED}`);
    for (const d of drifted) {
      console.error(`  ${d.artifact} (${d.committed} bytes) != compile of ${d.source} (${d.expected} bytes)`);
    }
    console.error('');
    console.error('The committed artifact is what ships to anyone reading the repo without');
    console.error('building, so it must match its source. Fix with:');
    console.error('  npm run build:lib && git add ' + drifted.map((d) => d.artifact).join(' '));
    console.error('');
    console.error('Alternatively, per ADR-457 these artifacts are meant to be gitignored —');
    console.error('untracking them (git rm --cached + .gitignore) also resolves this.');
    return 1;
  }

  console.log(`ok compiled-artifact-sync: ${pairs.length} tracked artifact(s) match their source`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  REASON,
  classifyTrackedCompiledArtifacts,
  compareCompiledArtifacts,
  producerOwnedOutputs,
  trackedCompiledArtifactClassification,
  trackedCompiledArtifacts,
};
