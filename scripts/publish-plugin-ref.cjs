#!/usr/bin/env node
'use strict';

/**
 * Publish the moving `plugin` branch that `.claude-plugin/marketplace.json`
 * points at (#5796).
 *
 * The plugin marketplace materializes a git tree, and the compiled runtime
 * library `gsd-core/bin/lib/**\/*.cjs` is a gitignored build artifact
 * (ADR-457), so a tree taken straight from `next`/`main` has no runtime
 * library and the self-heal cannot build one without `typescript`. This
 * script builds ONE commit, parented on the named release ref (--source), which
 * must be the checked-out HEAD, whose tree is that ref's tree plus every
 * untracked compiled `.cjs` under `gsd-core/bin/lib`, then force-updates
 * `refs/heads/<branch>` on the remote to it. It runs from release.yml
 * `finalize` after `npm run build:lib`; next/main never receive the compiled
 * files.
 *
 * The commit is assembled in a temporary index (GIT_INDEX_FILE), so the
 * caller's HEAD, index and working tree are left exactly as they were.
 *
 * Push credentials: when GSD_PLUGIN_REF_PUSH_TOKEN is set (release.yml passes
 * GSD_BOT_PR_TOKEN), the push authenticates with it instead of the checkout's
 * persisted GITHUB_TOKEN, which GitHub may refuse for pushes that touch workflow
 * files. The token reaches git only through env config for that one push and is
 * scrubbed from every error string.
 *
 * No git call here carries a wall-clock timeout. Each hang source is removed
 * instead: stdin is closed (or carries the exact input), git may not prompt for
 * credentials, the index is private so nothing waits on a lock, and the one
 * network call (the push) uses git's stall detection, which aborts only when
 * the transfer stops making progress.
 *
 * Usage: node scripts/publish-plugin-ref.cjs --remote <remote> --source <ref> [--branch plugin]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_REF_BRANCH = 'plugin';
const LIB_DIR = 'gsd-core/bin/lib';
const SENTINEL = `${LIB_DIR}/cli-exit.cjs`;
const PUSH_TOKEN_ENV = 'GSD_PLUGIN_REF_PUSH_TOKEN';
const EXTRAHEADER_KEY = 'http.https://github.com/.extraheader';
const BRANCH_MAX_LENGTH = 100;
// One path component: no `/`, no leading `-` (option injection) or `.`.
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// git-config http.lowSpeedLimit / http.lowSpeedTime: the push is aborted when
// it moves fewer than this many bytes per second for this many seconds.
const PUSH_STALL_MIN_BYTES_PER_SEC = 1000;
const PUSH_STALL_WINDOW_SECONDS = 60;
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
};

function basicAuthHeaderValue(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

// Git env-config entries that replace the checkout's persisted auth header for
// one push. actions/checkout persists the header in git config (v6: in a
// credentials file pulled in by includeIf.gitdir) under the multi-valued key
// http.https://github.com/.extraheader. Command-scope env config is read last,
// so an empty value resets that key and the value after it is the only one
// sent. The entries are appended after any GIT_CONFIG_COUNT already in baseEnv.
// The token goes through env, never argv: argv is visible in the process table.
function pushAuthEnv(token, baseEnv = process.env) {
  if (token === undefined || token === null || token === '') return {};
  if (typeof token !== 'string' || /[\r\n\0]/.test(token)) return { error: 'invalid push token' };
  const existing = baseEnv.GIT_CONFIG_COUNT;
  const n = typeof existing === 'string' && /^\d+$/.test(existing) ? Number(existing) : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: EXTRAHEADER_KEY,
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: EXTRAHEADER_KEY,
    [`GIT_CONFIG_VALUE_${n + 1}`]: basicAuthHeaderValue(token),
  };
}

function scrubToken(text, token) {
  if (!token) return text;
  const header = basicAuthHeaderValue(token);
  const b64 = header.slice(header.lastIndexOf(' ') + 1);
  return String(text).split(header).join('***').split(b64).join('***').split(token).join('***');
}

function isValidBranchName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= BRANCH_MAX_LENGTH
    && BRANCH_RE.test(name);
}

// Non-interactive git. Never throws: a spawn error or a non-zero exit comes
// back as { ok: false, error }.
function runGit(root, args, options = {}) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...(options.env || process.env), GIT_TERMINAL_PROMPT: '0' },
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const label = options.label || args[0];
  if (r.error) return { ok: false, error: `git ${label}: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, error: `git ${label} exited ${r.status}: ${String(r.stderr || '').trim()}` };
  }
  return { ok: true, stdout: r.stdout };
}

// commit-tree needs an identity; a CI checkout or a bench container may have
// none configured. A configured identity or explicit GIT_* env wins.
function withIdentity(root, env) {
  const configured = runGit(root, ['config', 'user.email']);
  if (configured.ok && configured.stdout.trim()) return env;
  return { ...FALLBACK_IDENTITY, ...env };
}

// Every untracked file under the lib dir, whether or not a .gitignore line
// names it; only the compiled .cjs files are kept.
function listCompiledLib(root) {
  const listed = runGit(root, ['ls-files', '-z', '--others', '--', LIB_DIR]);
  if (!listed.ok) return listed;
  return { ok: true, files: listed.stdout.split('\0').filter((p) => p.endsWith('.cjs')) };
}

function isValidSource(source) {
  return typeof source === 'string' && source.length > 0 && !source.startsWith('-');
}

function buildPluginRefCommit({ root, source: sourceRef }) {
  if (!isValidSource(sourceRef)) {
    return { ok: false, error: `invalid source: ${JSON.stringify(sourceRef)}` };
  }
  if (!fs.existsSync(path.join(root, SENTINEL))) {
    return { ok: false, error: `runtime library is not built: ${SENTINEL} is missing (run npm run build:lib first)` };
  }
  const resolved = runGit(root, ['rev-parse', '--verify', '--end-of-options', `${sourceRef}^{commit}`]);
  if (!resolved.ok) return resolved;
  const source = resolved.stdout.trim();
  const head = runGit(root, ['rev-parse', 'HEAD']);
  if (!head.ok) return head;
  const headSha = head.stdout.trim();
  if (headSha !== source) {
    return {
      ok: false,
      error: `HEAD ${headSha} is not the source ${source} (${sourceRef}); the compiled lib in the checkout was built from HEAD, so publish from a checkout of the source`,
    };
  }
  const compiled = listCompiledLib(root);
  if (!compiled.ok) return compiled;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plugin-ref-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmpDir, 'index') };
  try {
    const read = runGit(root, ['read-tree', source], { env });
    if (!read.ok) return read;
    if (compiled.files.length > 0) {
      // Paths go over stdin, never argv (Windows argv limit).
      const added = runGit(root, ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env,
        input: compiled.files.join('\0'),
      });
      if (!added.ok) return added;
    }
    const tree = runGit(root, ['write-tree'], { env });
    if (!tree.ok) return tree;
    // Parented on the source commit, not an orphan: an orphan makes every path
    // new, including .github/workflows/*, and GitHub refuses a GITHUB_TOKEN push
    // that creates or updates workflow files. Parented on the already-pushed
    // release commit, the pushed delta only adds the compiled lib.
    const commit = runGit(root, ['commit-tree', tree.stdout.trim(), '-p', source, '-m', `plugin: prebuilt tree of ${source}`], {
      env: withIdentity(root, env),
    });
    if (!commit.ok) return commit;
    return { ok: true, commit: commit.stdout.trim(), source, compiled: compiled.files.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function publishPluginRef({
  root, remote, branch = PLUGIN_REF_BRANCH, source, pushToken = process.env[PUSH_TOKEN_ENV],
}) {
  if (!isValidBranchName(branch)) return { ok: false, code: 'usage', error: `invalid branch name: ${JSON.stringify(branch)}` };
  if (typeof remote !== 'string' || remote.length === 0 || remote.startsWith('-')) {
    return { ok: false, code: 'usage', error: `invalid remote: ${JSON.stringify(remote)}` };
  }
  if (!isValidSource(source)) {
    return { ok: false, code: 'usage', error: `invalid source: ${JSON.stringify(source)}` };
  }
  const auth = pushAuthEnv(pushToken, process.env);
  if (auth.error) return { ok: false, code: 'usage', error: 'invalid push token' };
  const built = buildPluginRefCommit({ root, source });
  if (!built.ok) return built;
  const pushed = runGit(root, [
    '-c', 'credential.interactive=false',
    '-c', `http.lowSpeedLimit=${PUSH_STALL_MIN_BYTES_PER_SEC}`,
    '-c', `http.lowSpeedTime=${PUSH_STALL_WINDOW_SECONDS}`,
    'push', '--force', remote, `${built.commit}:refs/heads/${branch}`,
  ], { label: 'push', env: { ...process.env, ...auth } });
  if (!pushed.ok) return { ok: false, error: scrubToken(pushed.error, pushToken) };
  return { ...built, branch, remote };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--remote' || flag === '--branch' || flag === '--source') {
      if (i + 1 >= argv.length) return { error: `${flag} needs a value` };
      opts[flag.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      return { error: `unknown argument: ${flag}` };
    }
  }
  return { opts };
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`publish-plugin-ref: ${parsed.error}\n`);
    return 2;
  }
  const { remote, source } = parsed.opts;
  const branch = parsed.opts.branch === undefined ? PLUGIN_REF_BRANCH : parsed.opts.branch;
  if (!remote) {
    process.stderr.write('publish-plugin-ref: --remote is required\n');
    return 2;
  }
  if (!source) {
    process.stderr.write('publish-plugin-ref: --source is required\n');
    return 2;
  }
  const res = publishPluginRef({ root: process.cwd(), remote, branch, source });
  if (!res.ok) {
    process.stderr.write(`publish-plugin-ref: ${res.error}\n`);
    return res.code === 'usage' ? 2 : 1;
  }
  process.stdout.write(`${JSON.stringify(res)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  PLUGIN_REF_BRANCH,
  PUSH_TOKEN_ENV,
  pushAuthEnv,
  scrubToken,
  isValidBranchName,
  buildPluginRefCommit,
  publishPluginRef,
};
