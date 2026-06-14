#!/usr/bin/env node
/**
 * Copy GSD hooks to dist for installation.
 * Validates JavaScript syntax before copying to prevent shipping broken hooks.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const DIST_DIR = path.join(HOOKS_DIR, 'dist');
const STAGE_DIR = path.join(HOOKS_DIR, `.dist-staging-${process.pid}`);

// Hooks to copy (pure Node.js, no bundling needed)
const HOOKS_TO_COPY = [
  'gsd-check-update-worker.js',
  'gsd-check-update.js',
  'gsd-ensure-canonical-path.js',
  'managed-hooks-registry.cjs',
  'gsd-context-monitor.js',
  'gsd-cursor-session-start.js',
  'gsd-cursor-post-tool.js',
  'gsd-config-reload.js',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-statusline.js',
  'gsd-update-banner.js',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js'
];

const HOOKS_SUBDIRS_TO_COPY = ['lib'];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameAtomicWithRetry(stagedDest, dest, hook) {
  if (process.platform !== 'win32') {
    fs.renameSync(stagedDest, dest);
    return;
  }
  const BACKOFFS_MS = [10, 30, 90, 270];
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      fs.renameSync(stagedDest, dest);
      return;
    } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY');
      if (!transient) throw e;
      if (attempt < BACKOFFS_MS.length) {
        sleepSync(BACKOFFS_MS[attempt]);
        continue;
      }
      try {
        fs.copyFileSync(stagedDest, dest);
        try { fs.unlinkSync(stagedDest); } catch (_) { /* tolerate */ }
        console.warn(`\x1b[33m! ${hook}: rename failed (${e.code}) after ${BACKOFFS_MS.length} retries; used copy-fallback\x1b[0m`);
        return;
      } catch (fallbackErr) {
        try { fs.unlinkSync(stagedDest); } catch (_) { /* tolerate */ }
        console.warn(`\x1b[33m! ${hook}: rename + copy fallback both failed (${e.code} → ${fallbackErr.code || fallbackErr.message}); leaving prior dest in place\x1b[0m`);
        return;
      }
    }
  }
}

function validateSyntax(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    new vm.Script(content, { filename: path.basename(filePath) });
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) {
      return e.message;
    }
    throw e;
  }
}

function build() {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
  if (!fs.existsSync(STAGE_DIR)) {
    fs.mkdirSync(STAGE_DIR, { recursive: true });
  }

  let hasErrors = false;

  // Copy JS hooks
  for (const hook of HOOKS_TO_COPY) {
    const src = path.join(HOOKS_DIR, hook);
    const dest = path.join(DIST_DIR, hook);

    if (!fs.existsSync(src)) {
      console.warn(`Warning: ${hook} not found, skipping`);
      continue;
    }

    const syntaxError = validateSyntax(src);
    if (syntaxError) {
      console.error(`\x1b[31m✗ ${hook}: SyntaxError — ${syntaxError}\x1b[0m`);
      hasErrors = true;
      continue;
    }

    console.log(`\x1b[32m✓\x1b[0m Copying ${hook}...`);
    const stagedDest = path.join(STAGE_DIR, `${hook}.${Date.now()}`);
    fs.copyFileSync(src, stagedDest);
    renameAtomicWithRetry(stagedDest, dest, hook);
  }
  
  // Copy all shell hooks automatically
  const hooksDirEntries = fs.readdirSync(HOOKS_DIR, { withFileTypes: true });
  for (const ent of hooksDirEntries) {
    if (!ent.isFile() || !ent.name.endsWith('.sh')) continue;
    const src = path.join(HOOKS_DIR, ent.name);
    const dest = path.join(DIST_DIR, ent.name);
    
    console.log(`\x1b[32m✓\x1b[0m Copying ${ent.name}...`);
    const stagedDest = path.join(STAGE_DIR, `${ent.name}.${Date.now()}`);
    fs.copyFileSync(src, stagedDest);
    try { fs.chmodSync(stagedDest, 0o755); } catch (e) { /* Windows */ }
    renameAtomicWithRetry(stagedDest, dest, ent.name);
  }

  // Copy whitelisted hook subdirectories (e.g. hooks/lib/)
  for (const subdir of HOOKS_SUBDIRS_TO_COPY) {
    const srcDir = path.join(HOOKS_DIR, subdir);
    if (!fs.existsSync(srcDir)) continue;
    const destDir = path.join(DIST_DIR, subdir);
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const srcFile = path.join(srcDir, ent.name);
      const destFile = path.join(destDir, ent.name);
      if (ent.name.endsWith('.js')) {
        const syntaxError = validateSyntax(srcFile);
        if (syntaxError) {
          console.error(`\x1b[31m✗ ${subdir}/${ent.name}: SyntaxError — ${syntaxError}\x1b[0m`);
          hasErrors = true;
          continue;
        }
      }
      console.log(`\x1b[32m✓\x1b[0m Copying ${subdir}/${ent.name}...`);
      const stagedDest = path.join(STAGE_DIR, `${subdir}__${ent.name}.${Date.now()}`);
      fs.copyFileSync(srcFile, stagedDest);
      if (ent.name.endsWith('.sh')) {
        try { fs.chmodSync(stagedDest, 0o755); } catch (e) { /* Windows */ }
      }
      renameAtomicWithRetry(stagedDest, destFile, `${subdir}/${ent.name}`);
    }
  }

  try {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  } catch (e) { }

  if (hasErrors) {
    console.error('\n\x1b[31mBuild failed: fix syntax errors above before publishing.\x1b[0m');
    process.exit(1);
  }

  console.log('\nBuild complete.');
}

if (require.main === module) {
  build();
}

module.exports = { HOOKS_TO_COPY, HOOKS_SUBDIRS_TO_COPY };