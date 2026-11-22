/**
 * #6158 — the Codex emit writes exactly one `.toml` per role, from the canonical source.
 *
 * `installCodexConfig` used to enumerate every `gsd-*.md`, including the `*.compact.md`
 * alternate renderings, which share their canonical sibling's frontmatter `name:`. Each
 * such role was therefore written twice to one destination, the survivor decided by the
 * directory's enumeration order, and the returned role count was overstated.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { listAgentFiles, AGENTS_DIR } = require('./helpers/agent-roster.cjs');
const { installCodexConfig, codexAgentSourceFiles } = require('../bin/install.js');

function agentSource(name, body) {
  return ['---', `name: ${name}`, `description: ${name} role`, 'tools: Read', '---', '', `<role>${body}</role>`, ''].join('\n');
}

function makeDirs(label) {
  return {
    src: fs.mkdtempSync(path.join(os.tmpdir(), `gsd-6158-${label}-src-`)),
    dest: fs.mkdtempSync(path.join(os.tmpdir(), `gsd-6158-${label}-dest-`)),
  };
}

function tomlFiles(dest) {
  const dir = path.join(dest, 'agents');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.toml')).sort() : [];
}

// The emitted payload embeds the install directory in its @-include paths, so two installs
// into different directories are compared with that directory replaced by a placeholder.
function snapshot(dest) {
  const roots = [...new Set([dest, fs.realpathSync(dest)])];
  const out = {};
  for (const f of tomlFiles(dest)) {
    let text = fs.readFileSync(path.join(dest, 'agents', f), 'utf8');
    for (const root of roots) text = text.split(root).join('<DEST>');
    out[f] = text;
  }
  return out;
}

// Runs the emit with `readdirSync(src)` forced to return `order`, restoring the real one after.
function installWithListing(dest, src, order) {
  const real = fs.readdirSync;
  const stub = mock.method(fs, 'readdirSync', (p, ...rest) =>
    path.resolve(String(p)) === path.resolve(src) ? order.slice() : real.call(fs, p, ...rest));
  try {
    return installCodexConfig(dest, src);
  } finally {
    stub.mock.restore();
  }
}

describe('#6158: Codex emit writes one .toml per role from the canonical source', () => {
  test('real roster: one .toml per canonical agent, count equals roles, payload equals the canonical-only install', () => {
    const roster = listAgentFiles();
    const allFiles = fs.readdirSync(AGENTS_DIR).filter(f => /^gsd-.*\.md$/.test(f));
    assert.ok(allFiles.length > roster.length, 'sanity: the real agents/ directory ships compact alternates');

    const full = makeDirs('real-full');
    const canonicalOnly = makeDirs('real-canonical');
    try {
      for (const stem of roster) fs.copyFileSync(path.join(AGENTS_DIR, `${stem}.md`), path.join(canonicalOnly.src, `${stem}.md`));

      const count = installCodexConfig(full.dest, AGENTS_DIR);
      installCodexConfig(canonicalOnly.dest, canonicalOnly.src);

      assert.deepEqual(tomlFiles(full.dest), roster.map(s => `${s}.toml`).sort());
      assert.equal(count, roster.length, 'the reported count is the number of distinct roles');
      assert.deepEqual(snapshot(full.dest), snapshot(canonicalOnly.dest), 'every payload equals the canonical-source payload');
    } finally {
      cleanup(full.src); cleanup(full.dest); cleanup(canonicalOnly.src); cleanup(canonicalOnly.dest);
    }
  });

  test('a destination is written once per install (no role emitted twice)', () => {
    const { src, dest } = makeDirs('writes');
    const writes = [];
    const realWrite = fs.writeFileSync;
    const stub = mock.method(fs, 'writeFileSync', (p, ...rest) => {
      if (String(p).endsWith('.toml') && String(p).startsWith(path.join(dest, 'agents'))) writes.push(String(p));
      return realWrite.call(fs, p, ...rest);
    });
    try {
      fs.writeFileSync(path.join(src, 'gsd-alpha.md'), agentSource('gsd-alpha', 'canonical alpha'));
      fs.writeFileSync(path.join(src, 'gsd-alpha.compact.md'), agentSource('gsd-alpha', 'compact alpha'));
      installCodexConfig(dest, src);
    } finally {
      stub.mock.restore();
      cleanup(src); cleanup(dest);
    }
    assert.deepEqual(writes, [path.join(dest, 'agents', 'gsd-alpha.toml')]);
  });

  for (const [label, order] of [
    ['compact first', ['gsd-alpha.compact.md', 'gsd-beta.compact.md', 'gsd-alpha.md', 'gsd-beta.md']],
    ['compact last', ['gsd-alpha.md', 'gsd-beta.md', 'gsd-alpha.compact.md', 'gsd-beta.compact.md']],
    ['reversed', ['gsd-beta.md', 'gsd-beta.compact.md', 'gsd-alpha.md', 'gsd-alpha.compact.md']],
  ]) {
    test(`output is byte-identical when the directory lists ${label}`, () => {
      const base = makeDirs('order-base');
      const probe = makeDirs('order-probe');
      try {
        for (const d of [base, probe]) {
          for (const n of ['alpha', 'beta']) {
            fs.writeFileSync(path.join(d.src, `gsd-${n}.md`), agentSource(`gsd-${n}`, `canonical ${n}`));
            fs.writeFileSync(path.join(d.src, `gsd-${n}.compact.md`), agentSource(`gsd-${n}`, `compact ${n}`));
          }
        }
        const baseCount = installWithListing(base.dest, base.src, ['gsd-alpha.md', 'gsd-alpha.compact.md', 'gsd-beta.md', 'gsd-beta.compact.md']);
        const probeCount = installWithListing(probe.dest, probe.src, order);
        assert.equal(baseCount, 2);
        assert.equal(probeCount, 2);
        assert.deepEqual(snapshot(probe.dest), snapshot(base.dest));
        assert.match(snapshot(probe.dest)['gsd-alpha.toml'], /canonical alpha/);
        assert.doesNotMatch(snapshot(probe.dest)['gsd-alpha.toml'], /compact alpha/);
      } finally {
        cleanup(base.src); cleanup(base.dest); cleanup(probe.src); cleanup(probe.dest);
      }
    });
  }

  test('property: any listing order of a roster with compact alternates yields identical output', () => {
    const files = ['gsd-a.md', 'gsd-a.compact.md', 'gsd-b.md', 'gsd-b.compact.md', 'gsd-c.md', 'gsd-c.compact.md'];
    const ref = makeDirs('prop-ref');
    try {
      for (const f of files) {
        const role = f.replace(/\.compact\.md$|\.md$/, '');
        fs.writeFileSync(path.join(ref.src, f), agentSource(role, f.includes('compact') ? `compact ${role}` : `canonical ${role}`));
      }
      installWithListing(ref.dest, ref.src, files);
      const expected = snapshot(ref.dest);
      fc.assert(
        fc.property(fc.shuffledSubarray(files, { minLength: files.length, maxLength: files.length }), (order) => {
          const run = makeDirs('prop-run');
          try {
            for (const f of files) fs.copyFileSync(path.join(ref.src, f), path.join(run.src, f));
            const count = installWithListing(run.dest, run.src, order);
            assert.equal(count, 3);
            assert.deepEqual(snapshot(run.dest), expected);
          } finally {
            cleanup(run.src); cleanup(run.dest);
          }
        }),
        { numRuns: 25 },
      );
    } finally {
      cleanup(ref.src); cleanup(ref.dest);
    }
  });

  test('two non-compact sources that name one role fail the install and write no agent .toml', () => {
    const { src, dest } = makeDirs('collision');
    try {
      fs.writeFileSync(path.join(src, 'gsd-alpha.md'), agentSource('gsd-alpha', 'first'));
      fs.writeFileSync(path.join(src, 'gsd-zeta-clone.md'), agentSource('gsd-alpha', 'second'));
      assert.throws(
        () => installCodexConfig(dest, src),
        (err) => /gsd-alpha/.test(err.message) && /gsd-alpha\.md/.test(err.message) && /gsd-zeta-clone\.md/.test(err.message),
      );
      assert.deepEqual(tomlFiles(dest), []);
    } finally {
      cleanup(src); cleanup(dest);
    }
  });

  test('roles differing only in case collide (one file on a case-insensitive volume)', () => {
    const { src, dest } = makeDirs('case');
    try {
      fs.writeFileSync(path.join(src, 'gsd-foo.md'), agentSource('gsd-foo', 'lower'));
      fs.writeFileSync(path.join(src, 'gsd-foo-upper.md'), agentSource('gsd-FOO', 'upper'));
      assert.throws(() => installCodexConfig(dest, src), /gsd-foo/i);
      assert.deepEqual(tomlFiles(dest), []);
    } finally {
      cleanup(src); cleanup(dest);
    }
  });

  test('an escaping role name in a later source writes no earlier role', () => {
    const { src, dest } = makeDirs('escape');
    try {
      fs.writeFileSync(path.join(src, 'gsd-alpha.md'), agentSource('gsd-alpha', 'fine'));
      fs.writeFileSync(path.join(src, 'gsd-zeta.md'), agentSource('../config', 'escape'));
      assert.throws(() => installCodexConfig(dest, src));
      assert.deepEqual(tomlFiles(dest), []);
    } finally {
      cleanup(src); cleanup(dest);
    }
  });

  test('a compact file with no canonical sibling is not a role: nothing emitted, count 0', () => {
    const { src, dest } = makeDirs('lone');
    try {
      fs.writeFileSync(path.join(src, 'gsd-solo.compact.md'), agentSource('gsd-solo', 'compact only'));
      assert.equal(installCodexConfig(dest, src), 0);
      assert.deepEqual(tomlFiles(dest), []);
    } finally {
      cleanup(src); cleanup(dest);
    }
  });

  for (const n of [0, 1, 2]) {
    test(`a ${n}-file roster emits ${n} role(s)`, () => {
      const { src, dest } = makeDirs(`size${n}`);
      try {
        const names = ['gsd-one', 'gsd-two'].slice(0, n);
        for (const name of names) fs.writeFileSync(path.join(src, `${name}.md`), agentSource(name, name));
        assert.equal(installCodexConfig(dest, src), n);
        assert.deepEqual(tomlFiles(dest), names.map(x => `${x}.toml`));
      } finally {
        cleanup(src); cleanup(dest);
      }
    });
  }

  test('parity: the Codex emit roster is the shared agent-roster helper\'s roster, sorted', () => {
    assert.deepEqual(
      codexAgentSourceFiles(AGENTS_DIR).map(f => f.replace(/\.md$/, '')),
      listAgentFiles(),
    );
    const { src } = makeDirs('parity');
    try {
      for (const f of ['gsd-b.md', 'gsd-a.compact.md', 'gsd-a.md', 'README.md', 'other.md']) fs.writeFileSync(path.join(src, f), agentSource('gsd-x', f));
      assert.deepEqual(
        codexAgentSourceFiles(src).map(f => f.replace(/\.md$/, '')),
        listAgentFiles(src),
      );
    } finally {
      cleanup(src);
    }
  });
});
