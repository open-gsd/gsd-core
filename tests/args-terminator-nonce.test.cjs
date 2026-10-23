'use strict';

/**
 * #5637: the heredoc that captures the typed text ends at a fixed `GSD_ARGS_END` line. The harness
 * splices the typed text in before the shell parses it, so typed text containing that line closes
 * the heredoc early and the lines after it run as shell. Every install now stamps its own random
 * terminator into the workflows it writes; text that does not know the nonce cannot close the heredoc.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall, RUNTIME_META } = require('./helpers/install-shared.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const {
  ARGS_TERMINATOR,
  ARGS_TERMINATORS,
  ARGS_NONCE_RE,
  generateArgsNonce,
  stampArgsTerminator,
  stampInstalledContent,
  readInstalledNonce,
} = require('../gsd-core/bin/lib/args-terminator.cjs');

const REPO = path.join(__dirname, '..');
const RUNTIME_NAMES = Object.keys(RUNTIME_META);
const NONCE = '0123456789abcdef0123456789abcdef';
const CAPTURE = [
  "IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true",
  '$ARGUMENTS',
  'GSD_ARGS_END',
  "GSD_ARGS=${GSD_ARGS%$'\\n'}",
];
const FENCE = ['```bash', ...CAPTURE, 'printf "%s" "$GSD_ARGS"', '```'].join('\n');
const SHELLS = ['bash', 'zsh'].filter((sh) => {
  try {
    execFileSync(sh, ['--version'], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (_err) {
    return false;
  }
});

/** The shell lines of the first fence in `text`. */
function fenceBody(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('```bash');
  const end = lines.indexOf('```', start + 1);
  return lines.slice(start + 1, end);
}

/** Run the capture fence in `shell` with `typed` spliced in as the harness does; report the canary and stdout. */
function runStamped(shell, fenceText, typed) {
  const dir = createTempDir('gsd-5637-');
  try {
    const script = fenceBody(fenceText).map((l) => (l === '$ARGUMENTS' ? typed : l)).join('\n');
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', script] : ['-f', '-c', script];
    let stdout = '';
    try {
      stdout = execFileSync(shell, args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
    } catch (err) {
      stdout = String(err.stdout || '');
    }
    return { stdout, canary: fs.existsSync(path.join(dir, 'CANARY')) };
  } finally {
    cleanup(dir);
  }
}

describe('#5637 the terminator stamp', () => {
  test('exports the canonical token and a 32-hex nonce shape', () => {
    assert.equal(ARGS_TERMINATOR, 'GSD_ARGS_END');
    assert.ok(ARGS_NONCE_RE.test(NONCE));
    assert.equal(ARGS_NONCE_RE.test(NONCE.slice(1)), false, 'limit-1');
    assert.equal(ARGS_NONCE_RE.test(`${NONCE}0`), false, 'limit+1');
    assert.equal(ARGS_NONCE_RE.test(NONCE.toUpperCase()), false);
  });

  test('stamps the opener tag and the closing line, and nothing else', () => {
    const out = stampArgsTerminator(FENCE, NONCE);
    const body = fenceBody(out);
    assert.equal(body[0], `IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END_${NONCE}' || true`);
    assert.equal(body[1], '$ARGUMENTS');
    assert.equal(body[2], `GSD_ARGS_END_${NONCE}`);
    assert.equal(body[3], CAPTURE[3]);
  });

  test('stamps the quick-batch terminator the same way', () => {
    const fence = ["gsd_run quick-batch parse-args --raw --stdin <<'GSD_QUICK_BATCH_ARGS_END'", 'text', 'GSD_QUICK_BATCH_ARGS_END'].join('\n');
    assert.deepEqual(ARGS_TERMINATORS, ['GSD_ARGS_END', 'GSD_QUICK_BATCH_ARGS_END']);
    assert.equal(
      stampArgsTerminator(fence, NONCE),
      fence.replace(/GSD_QUICK_BATCH_ARGS_END/g, `GSD_QUICK_BATCH_ARGS_END_${NONCE}`),
    );
  });

  test('a process that is not an installer leaves content canonical', () => {
    assert.equal(stampInstalledContent(FENCE), FENCE);
  });

  test('leaves prose that names the token mid-line alone', () => {
    const prose = 'The capture ends at `GSD_ARGS_END` on its own line.\n';
    assert.equal(stampArgsTerminator(prose, NONCE), prose);
  });

  test('handles CRLF line endings', () => {
    const out = stampArgsTerminator(FENCE.replace(/\n/g, '\r\n'), NONCE);
    assert.ok(out.includes(`\nGSD_ARGS_END_${NONCE}\r\n`));
    assert.equal(/\nGSD_ARGS_END\r?\n/.test(out), false);
  });

  test('is a no-op on text with no capture block, and does not restamp a stamped block', () => {
    assert.equal(stampArgsTerminator('# nothing here\n', NONCE), '# nothing here\n');
    const once = stampArgsTerminator(FENCE, NONCE);
    assert.equal(stampArgsTerminator(once, 'f'.repeat(32)), once);
  });

  test('refuses a nonce that is not 32 lowercase hex characters', () => {
    for (const bad of ['', 'abc', NONCE.slice(1), `${NONCE}0`, NONCE.toUpperCase(), 'g'.repeat(32), `${NONCE.slice(1)}\n`]) {
      assert.throws(() => stampArgsTerminator(FENCE, bad), /nonce/i, JSON.stringify(bad));
    }
  });

  test('generateArgsNonce returns a fresh valid nonce each call', () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const n = generateArgsNonce();
      assert.ok(ARGS_NONCE_RE.test(n), n);
      seen.add(n);
    }
    assert.equal(seen.size, 20);
  });

  test('the nonce is 16 random bytes from the injected source', () => {
    const asked = [];
    const nonce = generateArgsNonce((size) => {
      asked.push(size);
      return Buffer.alloc(size, 0xab);
    });
    assert.deepEqual(asked, [16]);
    assert.equal(nonce, 'ab'.repeat(16));
  });

  test('property: only exact terminator lines and quoted openers change, whatever surrounds them', () => {
    const line = fc.oneof(
      fc.constantFrom(
        'GSD_ARGS_END', 'GSD_QUICK_BATCH_ARGS_END',
        "cmd <<'GSD_ARGS_END' || true", "cmd <<'GSD_QUICK_BATCH_ARGS_END'",
        ' GSD_ARGS_END', 'GSD_ARGS_END ', '\tGSD_ARGS_END', 'GSD_ARGS_END_ffffffffffffffffffffffffffffffff',
        'the `GSD_ARGS_END` line ends it', 'NOT_GSD_ARGS_END', 'GSD_ARGS_ENDX', "<<-'GSD_ARGS_END'", '<<GSD_ARGS_END',
      ),
      fc.string({ maxLength: 20 }).filter((s) => !s.includes('\n') && !s.includes('\r')),
    );
    const eol = fc.constantFrom('\n', '\r\n');
    fc.assert(
      fc.property(fc.array(fc.tuple(line, eol), { maxLength: 12 }), fc.stringMatching(/^[0-9a-f]{32}$/), (rows, nonce) => {
        const text = rows.map(([l, e]) => l + e).join('');
        const out = stampArgsTerminator(text, nonce);
        const outRows = out.split(/(?<=\n)/);
        const inRows = text.split(/(?<=\n)/);
        assert.equal(outRows.length, inRows.length);
        inRows.forEach((row, i) => {
          const body = row.replace(/\r?\n$/, '');
          const tail = row.slice(body.length);
          const isCloser = body === 'GSD_ARGS_END' || body === 'GSD_QUICK_BATCH_ARGS_END';
          const expected = isCloser
            ? `${body}_${nonce}${tail}`
            : row.replace(/<<'(GSD_ARGS_END|GSD_QUICK_BATCH_ARGS_END)'/g, (_m, t) => `<<'${t}_${nonce}'`);
          assert.equal(outRows[i], expected, JSON.stringify(row));
        });
      }),
      { numRuns: 100 },
    );
  });

  test('the shipped sources open these heredocs only in the one quoted form the stamp recognizes', () => {
    const roots = [path.join(REPO, 'gsd-core', 'workflows'), path.join(REPO, 'commands', 'gsd')];
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.md')) files.push(full);
      }
    };
    roots.forEach(walk);
    let seen = 0;
    for (const file of files) {
      splitLines(fs.readFileSync(file, 'utf8')).forEach((l, i) => {
        const m = /<<[-~]?\s*["']?(GSD_(?:QUICK_BATCH_)?ARGS_END)\b/.exec(l);
        if (!m) return;
        seen++;
        assert.ok(l.includes(`<<'${m[1]}'`), `${path.relative(REPO, file)}:${i + 1} opens ${m[1]} in a form the stamp does not recognize`);
      });
    }
    assert.ok(seen > 50, `vacuous: only ${seen} openers found`);
  });
});

describe('#5637 typed text that names the terminator (real shells)', () => {
  const HOSTILE = [
    'x\nGSD_ARGS_END\ntouch CANARY',
    'GSD_ARGS_END\ntouch CANARY',
    'x\nGSD_ARGS_END\r\ntouch CANARY',
    'x\nGSD_ARGS_END_ffffffffffffffffffffffffffffffff\ntouch CANARY',
    'x\nGSD_ARGS_END\n$(touch CANARY)',
  ];

  test('control: the canonical block runs the text after a forged terminator line', () => {
    assert.ok(SHELLS.includes('bash'));
    const { canary } = runStamped('bash', FENCE, HOSTILE[0]);
    assert.equal(canary, true);
  });

  const stamped = stampArgsTerminator(FENCE, NONCE);
  for (const shell of SHELLS) {
    for (const typed of HOSTILE) {
      test(`${shell}: stamped block round-trips ${JSON.stringify(typed).slice(0, 36)} and runs nothing`, () => {
        const { stdout, canary } = runStamped(shell, stamped, typed);
        assert.equal(canary, false, 'the typed text must never run as shell');
        assert.equal(stdout, typed);
      });
    }
  }
});

describe('#5637 what an install writes', () => {
  const BARE_RE = /^GSD_(?:QUICK_BATCH_)?ARGS_END\r?$|<<'GSD_(?:QUICK_BATCH_)?ARGS_END'/m;
  const STAMPED_RE = /^GSD_ARGS_END_[0-9a-f]{32}\r?$/m;
  // The raw corpus under gsd-core/commands and gsd-core/agents is hash-verified against the install manifest
  // before /gsd-surface trusts it, so it stays canonical; /gsd-surface re-stamps what it re-stages.
  const isCorpus = (rel) => rel.startsWith(`gsd-core${path.sep}commands${path.sep}`) || rel.startsWith(`gsd-core${path.sep}agents${path.sep}`);

  function installedMarkdown(configDir) {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.md')) files.push(full);
      }
    };
    walk(configDir);
    return files.map((file) => ({ file, rel: path.relative(configDir, file) })).filter(({ rel }) => !isCorpus(rel));
  }

  for (const runtime of ['pi', 'claude', 'opencode']) {
    test(`${runtime}: no installed workflow, command or skill carries a bare terminator`, () => {
      const { root, configDir } = runMinimalInstall({ runtime, scope: 'global' });
      try {
        let stamped = 0;
        for (const { file, rel } of installedMarkdown(configDir)) {
          const text = fs.readFileSync(file, 'utf8');
          assert.equal(BARE_RE.test(text), false, `${rel} still has a bare terminator`);
          if (STAMPED_RE.test(text)) stamped++;
        }
        assert.ok(stamped > 50, `expected the capture block in many workflows, found ${stamped}`);
      } finally {
        cleanup(root);
      }
    });
  }

  test('opencode local scope: the project-local install is stamped too', () => {
    const { root, configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'local' });
    try {
      let stamped = 0;
      for (const { file, rel } of installedMarkdown(configDir)) {
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(BARE_RE.test(text), false, `${rel} still has a bare terminator`);
        if (STAMPED_RE.test(text)) stamped++;
      }
      assert.ok(stamped > 0, 'nothing was stamped');
    } finally {
      cleanup(root);
    }
  });

  test('/gsd-surface re-stages commands and skills without dropping the nonce', () => {
    const { root, configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    try {
      const lib = path.join(configDir, 'gsd-core', 'bin', 'lib');
      const script = `
        const s = require(${JSON.stringify(path.join(lib, 'surface.cjs'))});
        const L = require(${JSON.stringify(path.join(lib, 'runtime-artifact-layout.cjs'))});
        const P = require(${JSON.stringify(path.join(lib, 'install-profiles.cjs'))});
        const C = require(${JSON.stringify(path.join(lib, 'clusters.cjs'))});
        const layout = L.resolveRuntimeArtifactLayout('opencode', ${JSON.stringify(configDir)}, 'global');
        const manifest = P.loadSkillsManifest(${JSON.stringify(path.join(configDir, 'gsd-core', 'commands', 'gsd'))});
        s.applySurface(${JSON.stringify(configDir)}, layout, manifest, C.CLUSTERS);
      `;
      execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, GSD_HOME: root },
        stdio: 'pipe',
        timeout: PROBE_TIMEOUT_MS * 4,
      });
      const surfaces = installedMarkdown(configDir).filter(({ rel }) => /(?:^|[\\/])(?:commands|skills)[\\/].*quick-batch/.test(rel));
      assert.ok(surfaces.length > 0);
      for (const { file, rel } of surfaces) {
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(BARE_RE.test(text), false, `${rel} lost its nonce`);
        assert.match(text, /GSD_QUICK_BATCH_ARGS_END_[0-9a-f]{32}/, rel);
      }
    } finally {
      cleanup(root);
    }
  });

  test('reinstalling into the same config dir keeps its nonce and changes no byte', () => {
    const first = runMinimalInstall({ runtime: 'pi', scope: 'global' });
    try {
      const read = () => installedMarkdown(first.configDir).map(({ file, rel }) => `${rel}\n${fs.readFileSync(file, 'utf8')}`).join('\n\0');
      const before = read();
      runMinimalInstall({ runtime: 'pi', scope: 'global', root: first.root });
      assert.ok(before.length > 0);
      assert.equal(read() === before, true, 'a reinstall rewrote installed files');
      assert.equal(readInstalledNonce(first.configDir), /GSD_ARGS_END_([0-9a-f]{32})/.exec(before)[1]);
    } finally {
      cleanup(first.root);
    }
  });

  test('readInstalledNonce skips a directory, a symlink and an oversized file, and still finds the nonce after them', () => {
    const dir = createTempDir('gsd-5637-');
    try {
      const wf = path.join(dir, 'gsd-core', 'workflows');
      fs.mkdirSync(path.join(wf, '0.md'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'outside.md'), `GSD_ARGS_END_${'e'.repeat(32)}\n`);
      try {
        fs.symlinkSync(path.join(dir, 'outside.md'), path.join(wf, '1-link.md'));
      } catch (err) {
        // A runner without symlink rights still proves the directory and size cases.
        if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      }
      fs.writeFileSync(path.join(wf, '2-big.md'), `${'x'.repeat(2 * 1024 * 1024 + 1)}\nGSD_ARGS_END_${'d'.repeat(32)}\n`);
      assert.equal(readInstalledNonce(dir), null, 'nothing valid yet');
      fs.writeFileSync(path.join(wf, '3-ok.md'), `GSD_ARGS_END_${NONCE}\n`);
      assert.equal(readInstalledNonce(dir), NONCE);
    } finally {
      cleanup(dir);
    }
  });

  test('readInstalledNonce reads nothing from a directory with no install, a non-hex nonce or a short one', () => {
    const dir = createTempDir('gsd-5637-');
    try {
      assert.equal(readInstalledNonce(dir), null);
      const wf = path.join(dir, 'gsd-core', 'workflows');
      fs.mkdirSync(wf, { recursive: true });
      for (const bad of ['GSD_ARGS_END_' + 'g'.repeat(32), 'GSD_ARGS_END_' + NONCE.slice(1), 'GSD_ARGS_END_' + NONCE + '0']) {
        fs.writeFileSync(path.join(wf, 'a.md'), `${bad}\n`);
        assert.equal(readInstalledNonce(dir), null, bad);
      }
      fs.writeFileSync(path.join(wf, 'a.md'), `GSD_ARGS_END_${NONCE}\n`);
      assert.equal(readInstalledNonce(dir), NONCE);
    } finally {
      cleanup(dir);
    }
  });

  test('two installs carry different nonces yet emit identical normalized manifests', () => {
    const { buildParityManifest } = require('./helpers/install-shared.cjs');
    const manifests = [];
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const { root, configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
      try {
        nonces.push(readInstalledNonce(configDir));
        manifests.push(JSON.stringify(buildParityManifest(configDir, root)));
      } finally {
        cleanup(root);
      }
    }
    assert.ok(nonces[0] !== null && nonces[1] !== null, 'both installs must be stamped');
    assert.notEqual(nonces[0], nonces[1]);
    assert.equal(manifests[0], manifests[1]);
  });

  test('a project-local install does not adopt a nonce planted in the project', () => {
    const root = createTempDir('gsd-5637-local-');
    try {
      const planted = path.join(root, '.opencode', 'gsd-core', 'workflows');
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(path.join(planted, '000-planted.md'), `GSD_ARGS_END_${NONCE}\n`);
      const { configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'local', root });
      const nonce = readInstalledNonce(configDir);
      assert.ok(nonce !== null);
      assert.notEqual(nonce, NONCE);
    } finally {
      cleanup(root);
    }
  });

  for (const runtime of RUNTIME_NAMES) {
    test(`${runtime}: a global install stamps its workflows, commands and skills and leaves none bare`, () => {
      const { root, configDir } = runMinimalInstall({ runtime, scope: 'global' });
      try {
        let stamped = 0;
        for (const { file, rel } of installedMarkdown(configDir)) {
          const text = fs.readFileSync(file, 'utf8');
          assert.equal(BARE_RE.test(text), false, `${rel} still has a bare terminator`);
          if (STAMPED_RE.test(text)) stamped++;
        }
        assert.ok(stamped > 0, `${runtime}: nothing was stamped`);
      } finally {
        cleanup(root);
      }
    });
  }

  test('the quick-batch command surface is stamped with its own terminator', () => {
    const { root, configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'global' });
    try {
      const surfaces = installedMarkdown(configDir).filter(({ rel }) => /(?:^|[\\/])(?:commands|skills)[\\/].*quick-batch/.test(rel));
      assert.ok(surfaces.length > 0, 'no quick-batch command or skill was installed');
      for (const { file, rel } of surfaces) {
        assert.match(fs.readFileSync(file, 'utf8'), /^GSD_QUICK_BATCH_ARGS_END_[0-9a-f]{32}\r?$/m, rel);
      }
    } finally {
      cleanup(root);
    }
  });

  test('generated Pi package skills stay canonical: a build-time nonce would be a constant shared by every user', () => {
    const text = fs.readFileSync(path.join(REPO, 'pi', 'package-skills', 'gsd-quick-batch', 'SKILL.md'), 'utf8');
    assert.ok(/^GSD_QUICK_BATCH_ARGS_END\r?$/m.test(text));
    assert.equal(/ARGS_END_[0-9a-f]{32}/.test(text), false);
  });

  test('one install uses one nonce across its workflows, and two installs use different ones', () => {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const { root, configDir } = runMinimalInstall({ runtime: 'pi', scope: 'global' });
      try {
        const dir = path.join(configDir, 'gsd-core', 'workflows');
        const found = new Set();
        for (const name of ['debug.md', 'quick.md', 'plan-phase.md']) {
          const m = /^GSD_ARGS_END_([0-9a-f]{32})\r?$/m.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
          assert.ok(m, `${name} has no stamped terminator`);
          found.add(m[1]);
        }
        assert.equal(found.size, 1, 'one install, one nonce');
        nonces.push([...found][0]);
      } finally {
        cleanup(root);
      }
    }
    assert.notEqual(nonces[0], nonces[1]);
  });

  test('the shipped source keeps the canonical token (the stamp happens at install, not in the repo)', () => {
    const text = fs.readFileSync(path.join(REPO, 'gsd-core', 'workflows', 'debug.md'), 'utf8');
    assert.ok(/^GSD_ARGS_END$/m.test(text));
  });
});
