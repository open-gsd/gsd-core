'use strict';

/**
 * #6048 — an optional flag and its value passed as ONE conditional expansion.
 *
 * `${X:+--flag "$X"}` relies on bash splitting the unquoted expansion into two words. zsh does not
 * split an unquoted parameter expansion, so `--flag value` arrives as a single argument, the CLI does
 * not recognise it, and the option is silently dropped (the code-review `--since`, the codebase-map
 * `--files`, the reviewer-instance `--agent`, the cross-runtime `--executor-runtime`). The portable
 * spelling is two conditional expansions: `${X:+--flag} ${X:+"$X"}` (two words when X is non-empty,
 * none when it is unset or empty, in both shells; the value stays ONE argument even with spaces).
 *
 * Covered here:
 *   1. a repo-wide scan of the shipped markdown surfaces for the joined shape (no new site can appear)
 *   2. the detector's own precision (what is and is not the hazardous shape)
 *   3. each fixed site, its shipped expansion executed under bash and zsh: argv is asserted, not prose
 *   4. a control showing the hazard is real (the joined shape is one word under zsh, two under bash)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

const ROOT = path.join(__dirname, '..');
const SHIPPED_DIRS = ['gsd-core', 'agents', 'commands', 'skills', 'pi'];

// A flag and its value inside one `${NAME:+...}` alternative: the flag, whitespace, then the value
// (quoted or `$`-led). `${GSD_WS:+--ws=${GSD_WS##* }}` is one token by design and `${X:+ or $X}` is
// prose, so neither matches.
const JOINED_FLAG_EXPANSION_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*:[+-]-{1,2}[A-Za-z][A-Za-z0-9-]*[ \t]+[^ \t}]/;
const CONDITIONAL_FLAG_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*:\+--[A-Za-z]/;

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const SHIPPED_MARKDOWN = SHIPPED_DIRS.flatMap((d) => {
  const dir = path.join(ROOT, d);
  return fs.existsSync(dir) ? markdownFiles(dir) : [];
});

// ─── 1. the scan ──────────────────────────────────────────────────────────────

describe('no shipped markdown passes a flag and its value as one conditional expansion (#6048)', () => {
  test('the scan finds no joined `${X:+--flag "$X"}` shape', () => {
    const offenders = [];
    let conditionalFlags = 0;
    for (const file of SHIPPED_MARKDOWN) {
      const lines = splitLines(fs.readFileSync(file, 'utf8'));
      lines.forEach((line, i) => {
        if (CONDITIONAL_FLAG_RE.test(line)) conditionalFlags += 1;
        if (JOINED_FLAG_EXPANSION_RE.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    // Non-vacuity: the scan must be reading the corpus, and the corpus has many conditional flags.
    assert.ok(SHIPPED_MARKDOWN.length >= 300, `expected >=300 shipped markdown files, scanned ${SHIPPED_MARKDOWN.length}`);
    assert.ok(conditionalFlags >= 20, `expected >=20 conditional flag expansions, found ${conditionalFlags}`);
    assert.deepEqual(
      offenders,
      [],
      `these lines pass a flag and its value as one expansion; zsh passes them as a single argument, so the option is ` +
        `silently dropped. Write \`\${X:+--flag} \${X:+"$X"}\` instead (#6048):\n  ${offenders.join('\n  ')}`,
    );
  });
});

// ─── 2. the detector ──────────────────────────────────────────────────────────

describe('the joined-expansion detector is precise (#6048)', () => {
  test('it matches the hazardous shape', () => {
    for (const bad of [
      'gsd_run x ${LAST:+--since "$LAST"}',
      'gsd_run x ${DOCS:+--files "$DOCS"} --raw',
      'gsd_run x ${A_1:+--executor-runtime $A_1}',
      'cmd ${X:+--flag\t"$X"}',
      'cmd ${X:+-f "$X"}',
      "cmd ${X:+--flag '$X'}",
      'cmd ${X:+--flag value}',
      'cmd ${X:--flag $X}',
    ]) {
      assert.ok(JOINED_FLAG_EXPANSION_RE.test(bad), bad);
    }
  });

  test('it does not match the portable split form, a one-token flag, prose, or a bare flag (limit-1, limit, limit+1)', () => {
    for (const ok of [
      'gsd_run x ${LAST:+--since} ${LAST:+"$LAST"}',
      'gsd_run x ${GSD_WS:+--ws=${GSD_WS##* }}',
      'echo "set${X:+ or $X}"',
      'gsd_run x ${FLAG:+--verbose} --raw',
      'gsd_run x ${X:+--flag="$X"}',
    ]) {
      assert.equal(JOINED_FLAG_EXPANSION_RE.test(ok), false, ok);
    }
  });
});

// ─── 3 + 4. behavior under bash and zsh ───────────────────────────────────────

// zsh is the macOS default shell; each case must behave the same there. A shell that is not installed is
// left out (the precedent in tests/command-arguments-block.test.cjs): bash always runs.
const SHELLS = ['bash', 'zsh'].filter((sh) => {
  const r = runHook('--version', [], { interpreter: sh, timeoutMs: PROBE_TIMEOUT_MS });
  return r.outcome === OUTCOME.EXITED && r.exitCode === 0;
});

function runInShell(shell, script) {
  const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
  const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS });
  assert.equal(r.outcome, OUTCOME.EXITED, `${shell} did not complete: ${r.summary}`);
  assert.equal(r.exitCode, 0, `${shell} exited ${r.exitCode}: ${r.stderr}`);
  return r.stdout;
}

/** Each fixed site: the file, the variable and the flag its shipped expansion carries. */
const SITES = [
  { file: 'gsd-core/workflows/code-review.md', name: 'LAST_REVIEW_COMMIT', flag: '--since' },
  { file: 'gsd-core/workflows/map-codebase.md', name: 'UPDATED_DOCS', flag: '--files' },
  { file: 'gsd-core/references/reviewer-instances.md', name: 'INSTANCE_AGENT', flag: '--agent' },
  { file: 'gsd-core/workflows/execute-phase/steps/cross-runtime-executor-dispatch.md', name: 'EXECUTOR_RUNTIME', flag: '--executor-runtime' },
];

/** The shipped expansion text for a site, taken from the file itself (the test fails if it is not there). */
function shippedExpansion({ file, name, flag }) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = new RegExp(`\\$\\{${escapeRegex(name)}:\\+${escapeRegex(flag)}\\} \\$\\{${escapeRegex(name)}:\\+"\\$${escapeRegex(name)}"\\}`);
  const m = re.exec(text);
  assert.ok(m, `${file} must carry the split expansion for ${name}`);
  return m[0];
}

const argvOf = (args) => args.map((a) => `<${a}>`).join('');

describe('each fixed site passes the flag and its value as two arguments under bash and zsh (#6048)', () => {
  test('bash is available (the zsh rows are skipped when zsh is not installed)', () => {
    assert.ok(SHELLS.includes('bash'));
  });

  for (const shell of SHELLS) {
    for (const site of SITES) {
      const expansion = () => shippedExpansion(site);
      const stub = 'show() { for a in "$@"; do printf "<%s>" "$a"; done; }';

      test(`${shell}: ${path.basename(site.file)} — set: the flag and the value are two arguments`, () => {
        const out = runInShell(shell, `${stub}\n${site.name}=value\nshow pre ${expansion()} post`);
        assert.equal(out, argvOf(['pre', site.flag, 'value', 'post']));
      });

      test(`${shell}: ${path.basename(site.file)} — unset or empty: neither is passed`, () => {
        assert.equal(runInShell(shell, `${stub}\nunset ${site.name}\nshow pre ${expansion()} post`), argvOf(['pre', 'post']));
        assert.equal(runInShell(shell, `${stub}\n${site.name}=''\nshow pre ${expansion()} post`), argvOf(['pre', 'post']));
      });

      test(`${shell}: ${path.basename(site.file)} — a value holding spaces stays ONE argument`, () => {
        const out = runInShell(shell, `${stub}\n${site.name}='one/a.md two/b.md'\nshow pre ${expansion()} post`);
        assert.equal(out, argvOf(['pre', site.flag, 'one/a.md two/b.md', 'post']));
      });
    }
  }

  test('property: any non-empty value reaches the command as exactly the flag then one value, in every shell', () => {
    const value = fc.stringMatching(/^[A-Za-z0-9 ._/-]{1,24}$/).filter((v) => v.trim().length > 0);
    fc.assert(
      fc.property(value, fc.integer({ min: 0, max: SITES.length - 1 }), (v, i) => {
        const site = SITES[i];
        for (const shell of SHELLS) {
          const script = `show() { for a in "$@"; do printf "<%s>" "$a"; done; }\n${site.name}='${v}'\nshow ${shippedExpansion(site)}`;
          assert.equal(runInShell(shell, script), argvOf([site.flag, v]), `${shell} ${site.name}=${JSON.stringify(v)}`);
        }
      }),
      { numRuns: 8 },
    );
  });

  test('control: the joined shape is the hazard — one word under zsh, two under bash', { skip: !SHELLS.includes('zsh') && 'zsh is not installed' }, () => {
    const joined = 'show() { for a in "$@"; do printf "<%s>" "$a"; done; }\nX=val\nshow ${X:+--since "$X"}';
    assert.equal(runInShell('bash', joined), argvOf(['--since', 'val']));
    assert.equal(runInShell('zsh', joined), argvOf(['--since val']), 'zsh does not split the unquoted expansion');
  });
});

// ─── 5. /gsd-code-review --files under zsh, bash and a BSD userland (#6152) ───────────────────────────────────
//
// The `--files` list was split with `read -a` (bash-only: zsh `bad option: -a`) in a different fence from the Tier 1 block
// that used it, containment used GNU `realpath -m` (BSD: `illegal option -- m`, so every relative path looked outside),
// and an override that resolved to nothing silently widened to the phase scope. The shipped Tier 1 fence and the
// reviewer-slug split are run here exactly as written, one child shell per case, with a `realpath` that rejects `-m`.

describe('/gsd-code-review --files resolves the listed files under bash and zsh, without GNU realpath (#6152)', () => {
  const { createTempDir, cleanup } = require('./helpers.cjs');
  const { runGit } = require('./helpers/process-seam.cjs');
  const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

  /** The first ```bash fence after the line starting with `heading`. */
  function fenceAfter(heading) {
    const lines = splitLines(fs.readFileSync(WORKFLOW, 'utf8'));
    const at = lines.findIndex((line) => line.startsWith(heading));
    assert.ok(at >= 0, `code-review.md must carry "${heading}"`);
    const open = lines.findIndex((line, i) => i > at && line === '```bash');
    const close = lines.findIndex((line, i) => i > open && line === '```');
    assert.ok(open > at && close > open, `"${heading}" must carry a bash fence`);
    return lines.slice(open + 1, close).join('\n');
  }

  /** A repository with src/a.ts and `dir with space/b.ts`, a sibling `outside/x`, and a symlink inside pointing at it. */
  function fixture(t) {
    const parent = createTempDir('gsd-6152-');
    t.after(() => cleanup(parent));
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'dir with space'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'dir with space', 'b.ts'), 'b\n');
    fs.writeFileSync(path.join(parent, 'outside', 'x'), 'x\n');
    if (process.platform !== 'win32') fs.symlinkSync(path.join(parent, 'outside', 'x'), path.join(repo, 'link-out'));
    assert.equal(runGit(['init', '-q'], { cwd: repo }).exitCode, 0);
    const stubBin = path.join(parent, 'bin');
    fs.mkdirSync(stubBin);
    // a BSD userland: `realpath -m` does not exist
    fs.writeFileSync(path.join(stubBin, 'realpath'), '#!/bin/sh\necho "realpath: illegal option -- m" >&2\nexit 1\n', { mode: 0o755 });
    return { repo, parent, env: { ...process.env, PATH: `${stubBin}${path.delimiter}${process.env.PATH}` } };
  }

  /** Run the shipped Tier 1 fence in a fresh shell with only FILES_OVERRIDE set; report what it left in REVIEW_FILES. */
  function tier1(shell, fx, filesOverride) {
    const quoted = `'${filesOverride.replace(/'/g, `'\\''`)}'`;
    const script = [`FILES_OVERRIDE=${quoted}`, fenceAfter('**Tier 1'), 'printf "COUNT=%s\\n" "${#REVIEW_FILES[@]}"',
      'for f in "${REVIEW_FILES[@]}"; do printf "FILE=%s\\n" "$f"; done'].join('\n');
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
    const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS, cwd: fx.repo, env: fx.env });
    assert.equal(r.outcome, OUTCOME.EXITED, `${shell} did not complete: ${r.summary}`);
    const lines = splitLines(r.stdout);
    return { status: r.exitCode, stdout: r.stdout, files: lines.filter((l) => l.startsWith('FILE=')).map((l) => l.slice(5)) };
  }

  for (const shell of SHELLS) {
    test(`${shell}: a relative path, an absolute path and a path with a space are accepted`, (t) => {
      const fx = fixture(t);
      assert.deepEqual(tier1(shell, fx, 'src/a.ts').files, ['src/a.ts']);
      const abs = path.join(fx.repo, 'src', 'a.ts');
      assert.deepEqual(tier1(shell, fx, abs).files, [abs]);
      const two = tier1(shell, fx, 'src/a.ts,dir with space/b.ts');
      assert.deepEqual(two.files, ['src/a.ts', 'dir with space/b.ts']);
      assert.match(two.stdout, /File scope: 2 files from --files override/);
      assert.equal(two.status, 0);
    });

    test(`${shell}: blanks around the commas are trimmed, so \`a, b\` lists the two files`, (t) => {
      const fx = fixture(t);
      const r = tier1(shell, fx, ' src/a.ts , dir with space/b.ts ');
      assert.deepEqual(r.files, ['src/a.ts', 'dir with space/b.ts']);
      assert.equal(r.status, 0);
    });

    test(`${shell}: a missing file is skipped with a warning and the valid one is reviewed`, (t) => {
      const fx = fixture(t);
      const r = tier1(shell, fx, 'src/missing.ts,src/a.ts');
      assert.deepEqual(r.files, ['src/a.ts']);
      assert.match(r.stdout, /Warning: File not found, skipping: src\/missing\.ts/);
    });

    test(`${shell}: a path outside the repository and a symlink pointing outside are rejected, and nothing widens to phase scope`, { skip: process.platform === 'win32' && 'symlinks need privilege on Windows' }, (t) => {
      const fx = fixture(t);
      const outside = tier1(shell, fx, '../outside/x');
      assert.match(outside.stdout, /Error: File path outside repository, skipping: \.\.\/outside\/x/);
      assert.notEqual(outside.status, 0, 'every entry invalid exits non-zero');
      assert.deepEqual(outside.files, []);
      assert.doesNotMatch(outside.stdout, /File scope:/, 'no scope is logged under the override label');
      const link = tier1(shell, fx, 'link-out');
      assert.match(link.stdout, /Error: File path outside repository, skipping: link-out/);
      assert.notEqual(link.status, 0);
      assert.deepEqual(link.files, []);
      const mixed = tier1(shell, fx, 'link-out,src/a.ts');
      assert.deepEqual(mixed.files, ['src/a.ts'], 'a valid entry beside a rejected one is still reviewed');
    });

    test(`${shell}: a missing file under a symlinked directory that points outside is rejected, not reported as missing`, { skip: process.platform === 'win32' && 'symlinks need privilege on Windows' }, (t) => {
      const fx = fixture(t);
      fs.symlinkSync(path.join(fx.parent, 'outside'), path.join(fx.repo, 'link-dir'), 'dir');
      const r = tier1(shell, fx, 'link-dir/missing.ts');
      assert.match(r.stdout, /Error: File path outside repository, skipping: link-dir\/missing\.ts/);
      assert.doesNotMatch(r.stdout, /Warning: File not found/);
      assert.deepEqual(r.files, []);
    });

    test(`${shell}: a list entry shaped like a node option is a path, never an option (it runs nothing)`, (t) => {
      const fx = fixture(t);
      const marker = path.join(fx.parent, 'pwned');
      fs.writeFileSync(path.join(fx.repo, 'planted.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
      for (const entry of ['--require=./planted.js', `--import=data:text/javascript,require('node:fs')`]) {
        const r = tier1(shell, fx, entry);
        assert.notEqual(r.status, 0, `${entry} resolves to no file`);
        assert.deepEqual(r.files, []);
      }
      assert.equal(fs.existsSync(marker), false, 'the planted script never ran');
    });

    test(`${shell}: an empty or all-missing list is an error, not a fall back to phase scope`, (t) => {
      const fx = fixture(t);
      for (const list of [',', 'src/nope.ts']) {
        const r = tier1(shell, fx, list);
        assert.notEqual(r.status, 0, `${JSON.stringify(list)} exits non-zero`);
        assert.match(r.stdout, /Error: --files override resolved to no reviewable file/);
        assert.deepEqual(r.files, []);
      }
    });

    test(`${shell}: the reviewer-lane slug list splits on commas`, () => {
      const text = fs.readFileSync(WORKFLOW, 'utf8');
      const from = text.indexOf('EXPLICIT_REVIEWER_SLUGS=()');
      assert.ok(from >= 0, 'the slug split must exist');
      const snippet = text.slice(from, text.indexOf('\nfi\n', from) + 4);
      const script = `EXPLICIT_JOINED='codex,gemini,opencode'\n${snippet}\nprintf "COUNT=%s\\n" "\${#EXPLICIT_REVIEWER_SLUGS[@]}"\nfor s in "\${EXPLICIT_REVIEWER_SLUGS[@]}"; do printf "<%s>" "$s"; done`;
      const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
      const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /COUNT=3\n<codex><gemini><opencode>$/);
    });
  }
});

// ─── 6. the executor path guard under zsh and bash (#6153) ────────────────────────────────────────────────────
//
// `_norm` split with bash-only `read -ra` and popped a 0-based array, and `_unquote` / `_resets_cwd` took characters
// with `${s:i:1}`, which zsh reads as the `:i` history modifier, so under zsh every command the guard tokenized
// errored and no violation was ever reported. The whole shipped guard block is run here from a real linked worktree,
// under each installed shell, and the verdicts and output must be the same.

describe('the executor path guard gives the same verdicts under zsh and bash (#6153)', () => {
  const { createTempDir, cleanup } = require('./helpers.cjs');
  const { runGit } = require('./helpers/process-seam.cjs');
  const GUARD = path.join(ROOT, 'gsd-core', 'references', 'worktree-path-safety.md');

  /** The bash fence that defines `_norm`, as written. */
  function guardBlock() {
    const lines = splitLines(fs.readFileSync(GUARD, 'utf8'));
    const at = lines.findIndex((line) => line.startsWith('_norm()'));
    assert.ok(at >= 0, 'the guard must define _norm');
    const open = lines.map((line, i) => [line, i]).filter(([line, i]) => line === '```bash' && i < at).pop()[1];
    const close = lines.findIndex((line, i) => i > at && line === '```');
    return lines.slice(open + 1, close).join('\n');
  }

  /** A repository with src/ and `has space/`, and a linked worktree of it; the guard runs from the worktree. */
  function linkedWorktree(t) {
    const parent = createTempDir('gsd-6153-');
    t.after(() => cleanup(parent));
    const main = path.join(parent, 'repo');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    fs.mkdirSync(path.join(main, 'has space'), { recursive: true });
    fs.writeFileSync(path.join(main, 'src', '.keep'), '');
    fs.writeFileSync(path.join(main, 'has space', '.keep'), '');
    const git = (args) => assert.equal(runGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: main }).exitCode, 0, args.join(' '));
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    const wt = path.join(parent, 'wt');
    git(['worktree', 'add', '-q', '-b', 'wt', wt]);
    return { main: fs.realpathSync(main), wt: fs.realpathSync(wt) };
  }

  function runGuard(shell, fx, cmd) {
    const script = `${guardBlock()}\necho PASSED`;
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
    const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS, cwd: fx.wt, env: { ...process.env, AUTOMATED_CMD: cmd } });
    assert.equal(r.outcome, OUTCOME.EXITED, `${shell} did not complete: ${r.summary}`);
    return { status: r.exitCode, out: `${r.stdout}${r.stderr}` };
  }

  // The guard targets POSIX shells (zsh, bash 3.2); a Windows lane's 8.3 temp paths are a separate path-form concern.
  const POSIX_ONLY = { skip: process.platform === 'win32' && 'the executor guard targets POSIX shells' };
  const PASSES = ['cd src && npm test', 'cd "has space"', 'npm --prefix ./src'];
  const HALTS = (fx) => [`cd ${fx.main}/src`, 'cd ../repo', 'cd src & cd ../..', 'cd ./src/../..', 'cd nope/../../repo'];

  for (const shell of SHELLS) {
    test(`${shell}: the commands that stay inside the worktree pass without a shell error`, POSIX_ONLY, (t) => {
      const fx = linkedWorktree(t);
      for (const cmd of PASSES) {
        const r = runGuard(shell, fx, cmd);
        assert.equal(r.status, 0, `${cmd}: ${r.out}`);
        assert.doesNotMatch(r.out, /unrecognized modifier|bad option|syntax error|bad substitution/i, cmd);
        assert.match(r.out, /PASSED/);
      }
    });

    test(`${shell}: the commands that leave the worktree halt with the FATAL message`, POSIX_ONLY, (t) => {
      const fx = linkedWorktree(t);
      for (const cmd of HALTS(fx)) {
        const r = runGuard(shell, fx, cmd);
        assert.equal(r.status, 1, `${cmd}: ${r.out}`);
        assert.match(r.out, /FATAL: <automated> command (relocates|names)/, cmd);
        assert.doesNotMatch(r.out, /unrecognized modifier|bad option|syntax error|bad substitution/i, cmd);
      }
    });

    test(`${shell}: _norm gives / for the root and for ..-only results, and drops empty and . segments`, () => {
      const norm = guardBlock().split('\n').filter((line, i, all) => {
        const start = all.findIndex((l) => l.startsWith('_norm()'));
        const end = all.findIndex((l, j) => j > start && l.startsWith('  done; printf'));
        return i >= start && i <= end;
      }).join('\n');
      const cases = [['/', '/'], ['/..', '/'], ['/a/../..', '/'], ['/a/b/../c', '/a/c'], ['//a///b/./c/', '/a/b/c']];
      const script = `${norm}\n${cases.map(([input]) => `printf '%s\\n' "$(_norm '${input}')"`).join('\n')}`;
      const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
      const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.deepEqual(splitLines(r.stdout).filter(Boolean), cases.map(([, expected]) => expected));
    });

    test(`${shell}: property: _norm equals the POSIX normalization of the path, with the root as /`, () => {
      const norm = guardBlock().split('\n').filter((line, i, all) => {
        const start = all.findIndex((l) => l.startsWith('_norm()'));
        const end = all.findIndex((l, j) => j > start && l.startsWith('  done; printf'));
        return i >= start && i <= end;
      }).join('\n');
      const segment = fc.constantFrom('a', 'b', '..', '.', '', 'c d', 'x*', '...', '-n');
      fc.assert(
        fc.property(fc.array(fc.array(segment, { minLength: 0, maxLength: 8 }), { minLength: 1, maxLength: 6 }), (paths) => {
          const inputs = paths.map((segments) => `/${segments.join('/')}`);
          const expected = inputs.map((input) => { const n = path.posix.normalize(input); return n.length > 1 ? n.replace(/\/$/, '') : n; });
          const script = `${norm}\n${inputs.map((input) => `printf '%s\\n' "$(_norm '${input}')"`).join('\n')}`;
          const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
          const r = runHook(args[0], args.slice(1), { interpreter: shell, timeoutMs: PROBE_TIMEOUT_MS });
          assert.equal(r.exitCode, 0, r.stderr);
          assert.deepEqual(splitLines(r.stdout).slice(0, inputs.length), expected, `${shell}: ${JSON.stringify(inputs)}`);
        }),
        { numRuns: 12 },
      );
    });
  }

  test('the verdict and the message are identical in every installed shell', { skip: (SHELLS.length < 2 && 'zsh is not installed, so there is nothing to compare bash with') || (process.platform === 'win32' && 'the executor guard targets POSIX shells') }, (t) => {
    const fx = linkedWorktree(t);
    const norm = (out) => out.split(fx.main).join('<MAIN>').split(fx.wt).join('<WT>');
    for (const cmd of [...PASSES, ...HALTS(fx)]) {
      const results = SHELLS.map((shell) => runGuard(shell, fx, cmd));
      for (const r of results.slice(1)) {
        assert.equal(r.status, results[0].status, `${cmd}: exit status`);
        assert.equal(norm(r.out), norm(results[0].out), `${cmd}: output`);
      }
    }
  });
});
