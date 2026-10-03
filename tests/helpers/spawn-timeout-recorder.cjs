'use strict';

/**
 * Preload fixture for #5180 — record the `timeout` option every `git` child
 * process spawn in the SPAWNED hook receives, so a test can bind a guard to
 * its probe-budget constant by BEHAVIOR (what the guard actually passed to
 * spawnSync) instead of by reading the guard's source or trusting a constant it
 * may have stopped using.
 *
 * Loaded with `node --require <this file> <hook.js>` (the same one-shot
 * `--require` seam tests/helpers/context-monitor-fixed-now-preload.cjs uses; no
 * restoration needed in a one-shot subprocess). Inert unless
 * `GSD_SPAWN_RECORD_FILE` names a file. Each `git` spawn appends one JSON line
 * `{ "args": [...], "timeout": <number|null> }` — a synchronous append, so the
 * record survives the guard's immediate `process.exit()` on allow/deny — and
 * then calls through to the real function unchanged.
 *
 * Wraps spawnSync, execFileSync, spawn and execFile on the `child_process`
 * module object. Hooks destructure these at require time, which runs AFTER this
 * preload, so they bind to the wrappers. Node's own execFileSync/execFile reach
 * the internal spawn binding rather than the wrapped exports, so one logical
 * spawn is never counted twice.
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const recordFile = process.env.GSD_SPAWN_RECORD_FILE;

if (recordFile) {
  const isGit = (file) => typeof file === 'string' && /^git(?:\.exe)?$/i.test(path.basename(file));

  const record = (rest) => {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
    const timeout = options && typeof options === 'object' && typeof options.timeout === 'number'
      ? options.timeout
      : null;
    fs.appendFileSync(recordFile, `${JSON.stringify({ args, timeout })}\n`);
  };

  for (const name of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
    const original = cp[name];
    cp[name] = function recordedSpawn(file, ...rest) {
      if (isGit(file)) record(rest);
      return original.apply(this, [file, ...rest]);
    };
  }
}
