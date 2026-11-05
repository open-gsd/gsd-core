'use strict';

/**
 * Per-repository milestone completion flow (#5707, phase 3 of epic #3628).
 *
 * Drives the verbs the workflow calls (`milestone release-tags`, then
 * `milestone complete --release-map`) in the order
 * `gsd-core/workflows/complete-milestone/steps/release-map.md` documents, against
 * real temporary git repositories. The workflow files are read as data to resolve
 * their references and to pin the shared enumerations; nothing here greps source.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const fc = require('fast-check');
const { cleanup } = require('./helpers.cjs');
const { GIT_FIXTURE_TIMEOUT_MS, GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  RELEASE_MAP_STATUSES,
  RELEASE_MAP_TAG_STATES,
  readArchivedReleaseMap,
} = require('../gsd-core/bin/lib/milestone-release-map.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const SPINE = path.join(ROOT, 'gsd-core', 'workflows', 'complete-milestone.md');
const GIT_TAG_STEP = path.join(ROOT, 'gsd-core', 'workflows', 'complete-milestone', 'steps', 'git-tag.md');
const RELEASE_MAP_STEP = path.join(ROOT, 'gsd-core', 'workflows', 'complete-milestone', 'steps', 'release-map.md');
const HOW_TO = path.join(ROOT, 'docs', 'how-to', 'tag-a-multi-repo-milestone.md');
const DOCS_README = path.join(ROOT, 'docs', 'README.md');

const read = (p) => fs.readFileSync(p, 'utf8');

// ─── helpers ────────────────────────────────────────────────────────────────

function git(dir, ...args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    timeout: GIT_FIXTURE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(dir, name) {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  git(dir, 'add', name);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD');
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  return commit(dir, 'a.txt');
}

function tagNames(dir) {
  const out = git(dir, 'tag', '--list');
  return out === '' ? [] : out.split('\n');
}

function runCli(cwd, args) {
  const r = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GSD_TEST_MODE: '1' },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** A GSD project root with initialised sub-repos and one completable phase. */
function makeProject(t, repoNames, { createTag = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-relmap-flow-')));
  t.after(() => cleanup(root));
  const shas = {};
  for (const name of repoNames) shas[name] = initRepo(path.join(root, name));
  const planning = path.join(root, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-foundation'), { recursive: true });
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify({ sub_repos: repoNames, git: { repo_tagging: 'per_repo', create_tag: createTag } }),
  );
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
  fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nmilestone: v1.0\nstatus: executing\n---\n\n# State\n\n## Current Position\n\nPhase: 1\n');
  fs.writeFileSync(path.join(planning, 'phases', '01-foundation', '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(planning, 'phases', '01-foundation', '01-01-SUMMARY.md'), '---\none-liner: Shipped\n---\n# Summary\n');
  return { root, shas };
}

function writeJson(root, name, value) {
  const p = path.join(root, name);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
}

const parse = (r) => JSON.parse(r.stdout);

/**
 * The mapping rule release-map.md documents: a tagged entry records the verb's
 * per-repository status; a skipped entry records `skipped`; an entry with no
 * tag request records `none`.
 */
function tagStateFor(entry, applyResult) {
  if (entry.tagRequest === 'skip') return 'skipped';
  if (entry.tagRequest === 'none') return 'none';
  return applyResult.repos[entry.repo].status;
}

function releaseMapFrom(entries, applyResult) {
  return entries.map((e) => ({
    repo: e.repo,
    release: e.release,
    reference: e.reference,
    environment: e.environment,
    status: e.status,
    tag: tagStateFor(e, applyResult),
  }));
}

// ─── workflow wiring ──────────────────────────────────────────

describe('workflow wiring', () => {
  test('the spine routes the per-repository path to a step file that exists', () => {
    const spine = read(SPINE);
    const refs = [...spine.matchAll(/gsd-core\/workflows\/complete-milestone\/steps\/([a-z-]+\.md)/g)].map((m) => m[1]);
    assert.ok(refs.includes('release-map.md'), 'spine must reference steps/release-map.md');
    for (const ref of new Set(refs)) {
      assert.ok(
        fs.existsSync(path.join(ROOT, 'gsd-core', 'workflows', 'complete-milestone', 'steps', ref)),
        `spine references steps/${ref} but it does not exist`,
      );
    }
    assert.match(spine, /repo_tagging/);
    assert.match(spine, /sub_repos/);
  });

  test('the single-repository git-tag section is still wired and still prompts once', () => {
    const spine = read(SPINE);
    assert.ok(spine.includes('<!-- gsd:section id="git-tag" when="state:git-create-tag" -->'));
    assert.ok(spine.includes('steps/git-tag.md'));
    assert.ok(read(GIT_TAG_STEP).includes('Push tag to remote? (y/n)'));
  });
});

// ─── end-to-end flow ──────────────────────────────────────────

describe('per-repository completion flow', () => {
  const entries = [
    { repo: 'api', release: 'v5.78.0', reference: 'PR #412', environment: 'production', status: 'released', tagRequest: 'create' },
    { repo: 'web', release: null, reference: null, environment: 'development', status: 'unreleased', tagRequest: 'skip' },
    { repo: 'lib', release: 'v2.14.1', reference: 'PR #91', environment: 'npm', status: 'released', tagRequest: 'none' },
  ];
  const tagRequests = (list) =>
    list.filter((e) => e.tagRequest !== 'none').map((e) =>
      e.tagRequest === 'skip' ? { repo: e.repo, tag: 'unused', skip: true } : { repo: e.repo, tag: e.release },
    );

  test('mixed tagged / skipped / untagged repos archive as recorded', (t) => {
    const { root, shas } = makeProject(t, ['api', 'web', 'lib']);
    const tagsFile = writeJson(root, 'tags.json', tagRequests(entries));

    const dry = parse(runCli(root, ['milestone', 'release-tags', '--map', tagsFile, '--dry-run']));
    assert.equal(dry.ok, true);
    assert.equal(dry.phase, 'dry_run');
    assert.deepEqual(tagNames(path.join(root, 'api')), [], 'dry-run writes nothing');

    const applied = runCli(root, ['milestone', 'release-tags', '--map', tagsFile]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = parse(applied);
    assert.deepEqual(result.created, ['api:v5.78.0']);
    assert.deepEqual(tagNames(path.join(root, 'api')), ['v5.78.0']);
    assert.deepEqual(tagNames(path.join(root, 'web')), []);
    assert.deepEqual(tagNames(path.join(root, 'lib')), []);
    assert.equal(git(path.join(root, 'api'), 'rev-list', '-n', '1', 'v5.78.0'), shas.api);

    const mapFile = writeJson(root, 'release-map.json', releaseMapFrom(entries, result));
    const done = runCli(root, ['milestone', 'complete', 'v1.0', '--name', 'Read API', '--confirm', '--release-map', mapFile]);
    assert.equal(done.status, 0, done.stderr);

    const archived = readArchivedReleaseMap(path.join(root, '.planning', 'milestones'), 'v1.0');
    assert.equal(archived.ok, true);
    assert.deepEqual(archived.map.map((e) => [e.repo, e.tag]), [['api', 'created'], ['web', 'skipped'], ['lib', 'none']]);
    assert.equal(archived.map[1].release, null, 'an unreleased repository keeps no invented version');
  });

  test('apply never pushes: a bare remote stays empty', (t) => {
    const { root } = makeProject(t, ['api']);
    const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-relmap-remote-')));
    t.after(() => cleanup(remote));
    git(remote, 'init', '-q', '--bare');
    git(path.join(root, 'api'), 'remote', 'add', 'origin', remote);

    const tagsFile = writeJson(root, 'tags.json', [{ repo: 'api', tag: 'v1.0.0' }]);
    assert.equal(runCli(root, ['milestone', 'release-tags', '--map', tagsFile]).status, 0);
    assert.deepEqual(tagNames(path.join(root, 'api')), ['v1.0.0']);
    assert.equal(git(remote, 'tag', '--list'), '', 'the remote must hold no tag');
    assert.equal(git(path.join(root, 'api'), 'ls-remote', '--tags', 'origin'), '');
  });

  test('retry is idempotent and the archive accepts already_tagged', (t) => {
    const { root } = makeProject(t, ['api']);
    const only = [entries[0]];
    const tagsFile = writeJson(root, 'tags.json', tagRequests(only));
    assert.deepEqual(parse(runCli(root, ['milestone', 'release-tags', '--map', tagsFile])).created, ['api:v5.78.0']);

    const retry = parse(runCli(root, ['milestone', 'release-tags', '--map', tagsFile]));
    assert.equal(retry.ok, true);
    assert.equal(retry.repos.api.status, 'already_tagged');
    assert.deepEqual(retry.created, []);

    const mapFile = writeJson(root, 'release-map.json', releaseMapFrom(only, retry));
    assert.equal(runCli(root, ['milestone', 'complete', 'v1.0', '--confirm', '--release-map', mapFile]).status, 0);
    const archived = readArchivedReleaseMap(path.join(root, '.planning', 'milestones'), 'v1.0');
    assert.equal(archived.map[0].tag, 'already_tagged');
  });

  test('a tag conflict in one repository writes nothing in any repository', (t) => {
    const { root } = makeProject(t, ['api', 'lib']);
    git(path.join(root, 'api'), 'tag', 'v1.0.0');
    commit(path.join(root, 'api'), 'moved.txt');
    const tagsFile = writeJson(root, 'tags.json', [
      { repo: 'api', tag: 'v1.0.0' },
      { repo: 'lib', tag: 'v2.0.0' },
    ]);
    const res = runCli(root, ['milestone', 'release-tags', '--map', tagsFile]);
    assert.notEqual(res.status, 0);
    const out = parse(res);
    assert.equal(out.ok, false);
    assert.equal(out.phase, 'preflight');
    assert.ok(out.errors.some((e) => e.reason === 'tag_conflict'));
    assert.deepEqual(tagNames(path.join(root, 'lib')), []);
  });

  test('invalid repository paths are refused before any write', (t) => {
    const { root } = makeProject(t, ['api']);
    for (const bad of ['../outside', path.resolve(root, 'api'), 'api/../../x']) {
      const tagsFile = writeJson(root, 'tags.json', [{ repo: 'api', tag: 'v1.0.0' }, { repo: bad, tag: 'v9.9.9' }]);
      const res = runCli(root, ['milestone', 'release-tags', '--map', tagsFile]);
      assert.notEqual(res.status, 0, bad);
      assert.equal(parse(res).ok, false, bad);
      assert.deepEqual(tagNames(path.join(root, 'api')), [], `${bad}: nothing written`);
    }
  });

  test('a detached HEAD in a sub-repository is tagged at the detached commit', (t) => {
    const { root, shas } = makeProject(t, ['api']);
    const api = path.join(root, 'api');
    commit(api, 'second.txt');
    git(api, 'checkout', '-q', '--detach', shas.api);
    const tagsFile = writeJson(root, 'tags.json', [{ repo: 'api', tag: 'v0.1.0' }]);
    const res = runCli(root, ['milestone', 'release-tags', '--map', tagsFile]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git(api, 'rev-list', '-n', '1', 'v0.1.0'), shas.api);
  });

  test('tags land in the sub-repositories whatever the invoking directory', (t) => {
    const { root } = makeProject(t, ['api', 'web']);
    const tagsFile = writeJson(root, 'tags.json', [{ repo: 'api', tag: 'v1.0.0' }, { repo: 'web', tag: 'v2.0.0' }]);
    const res = runCli(path.join(root, 'web'), ['milestone', 'release-tags', '--map', tagsFile]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(tagNames(path.join(root, 'api')), ['v1.0.0']);
    assert.deepEqual(tagNames(path.join(root, 'web')), ['v2.0.0']);
  });

  test('git.create_tag false records the map with every tag state none and creates no tags', (t) => {
    const { root } = makeProject(t, ['api', 'web'], { createTag: false });
    const noTags = entries.slice(0, 2).map((e) => ({ ...e, tagRequest: 'none' }));
    const mapFile = writeJson(root, 'release-map.json', releaseMapFrom(noTags, { repos: {} }));
    assert.equal(runCli(root, ['milestone', 'complete', 'v1.0', '--confirm', '--release-map', mapFile]).status, 0);
    const archived = readArchivedReleaseMap(path.join(root, '.planning', 'milestones'), 'v1.0');
    assert.deepEqual(archived.map.map((e) => e.tag), ['none', 'none']);
    assert.deepEqual(tagNames(path.join(root, 'api')), []);
    assert.deepEqual(tagNames(path.join(root, 'web')), []);
  });
});

// ─── parity ─────────────────────────────────────────────────

describe('limits the workflow tells the user about (validated before any tag is written)', () => {
  const dryRun = (root, map) => {
    const file = writeJson(root, 'release-map.json', map);
    return runCli(root, ['milestone', 'complete', 'v1.0', '--dry-run', '--release-map', file]);
  };
  const one = (overrides = {}) => ({ repo: 'api', release: 'v1', reference: null, environment: null, status: 'released', tag: 'created', ...overrides });

  test('a text field is accepted at 200 characters and refused at 201 (limit and limit+1)', (t) => {
    const { root } = makeProject(t, []);
    assert.equal(dryRun(root, [one({ release: 'v'.repeat(199) })]).status, 0, '199');
    assert.equal(dryRun(root, [one({ release: 'v'.repeat(200) })]).status, 0, '200');
    assert.notEqual(dryRun(root, [one({ release: 'v'.repeat(201) })]).status, 0, '201');
  });

  test('a map is accepted at 256 entries and refused at 257', (t) => {
    const { root } = makeProject(t, []);
    const entries = (n) => Array.from({ length: n }, (_, i) => one({ repo: `r${i}`, release: null, status: 'unreleased', tag: 'none' }));
    assert.equal(dryRun(root, entries(255)).status, 0, '255');
    assert.equal(dryRun(root, entries(256)).status, 0, '256');
    assert.notEqual(dryRun(root, entries(257)).status, 0, '257');
  });
});

describe('shared enumerations', () => {
  test('every success status the tag verb reports is a valid map tag state', (t) => {
    const { root } = makeProject(t, ['api', 'web']);
    const tagsFile = writeJson(root, 'tags.json', [{ repo: 'api', tag: 'v1.0.0' }, { repo: 'web', tag: 'x', skip: true }]);
    const first = parse(runCli(root, ['milestone', 'release-tags', '--map', tagsFile]));
    const second = parse(runCli(root, ['milestone', 'release-tags', '--map', tagsFile]));
    const observed = new Set([...Object.values(first.repos), ...Object.values(second.repos)].map((r) => r.status));
    assert.deepEqual([...observed].sort(), ['already_tagged', 'created', 'skipped']);
    for (const status of observed) {
      assert.ok(RELEASE_MAP_TAG_STATES.includes(status), `${status} must be a release map tag state`);
    }
    assert.ok(RELEASE_MAP_TAG_STATES.includes('none'));
  });

  test('the step file and the how-to name every release map status and tag state', () => {
    for (const file of [RELEASE_MAP_STEP, HOW_TO]) {
      const text = read(file);
      for (const value of [...RELEASE_MAP_STATUSES, ...RELEASE_MAP_TAG_STATES]) {
        assert.match(text, new RegExp(`\`${value}\``), `${path.basename(file)} must document \`${value}\``);
      }
    }
  });
});

// ─── push confirmation ──────────────────────────────────────

describe('push confirmation', () => {
  test('every push command is repository-scoped and tag-scoped', () => {
    const text = read(RELEASE_MAP_STEP);
    const pushLines = text.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l) && !l.includes('remote get-url') &&!/^\s*(#|>|-\s)/.test(l.trim()) && l.trim().startsWith('git'));
    assert.ok(pushLines.length >= 1, 'the step must show the push command');
    for (const line of pushLines) {
      assert.match(line.trim(), /^git -C "\$\{?\w+\}?" push -- "\$\{?\w+\}?" "refs\/tags\/\$\{?\w+\}?"$/, line);
    }
    for (const forbidden of ['--all', '--tags', '--follow-tags', '--force', '--mirror', '--delete']) {
      assert.ok(!text.includes(forbidden), `release-map.md must not mention ${forbidden}`);
    }
  });

  test('the confirmation names the repository and the remote, and the default is no push', () => {
    const text = read(RELEASE_MAP_STEP);
    assert.match(text, /Push tag `?<tag>`? from `?<repo>`? to remote `?<remote>`? \(<url>\)\? \(y\/n\)/);
    assert.match(text, /default[^.\n]*no push|nothing is pushed by default/i);
    // The URL shown is the one the push goes to (a configured pushurl differs from the fetch URL).
    assert.match(text, /git -C "\$REPO" remote get-url --push /);
    assert.match(text, /credentials removed/);
  });

  test('every milestone complete call in the spine carries the release map when per-repo tagging is on', () => {
    const spine = read(SPINE);
    assert.match(spine, /EVERY `milestone complete` call below \(including the `--no-archive-phases` form\)/);
    assert.match(spine, /same `--release-map` argument/);
  });

  test('the single-repository tag section is skipped for per-repo tagging, and the push step follows it', () => {
    const spine = read(SPINE);
    const section = spine.indexOf('<!-- gsd:section id="git-tag"');
    const skip = spine.indexOf('If `PER_REPO_TAGGING` is `true`, skip this section');
    const push = spine.indexOf('<step name="push_release_tags">');
    const commitStep = spine.indexOf('<step name="git_commit_milestone">');
    assert.ok(section >= 0 && skip > section, 'the skip sentence must sit inside the git-tag section');
    assert.ok(push > skip && commitStep > push, 'push_release_tags must follow the git-tag section and precede git_commit_milestone');
  });
});

// ─── docs ───────────────────────────────────────────────────

describe('documentation and reference rule', () => {
  test('the how-to is indexed and states that a milestone version may differ from repository release versions', () => {
    assert.ok(read(DOCS_README).includes('how-to/tag-a-multi-repo-milestone.md'));
    assert.match(read(HOW_TO), /milestone version[^.]*\b(may|can) differ[^.]*repository release version/i);
  });

  test('the documented hex-reference rule accepts 7 and 40 characters and rejects 6 and 41', () => {
    const m = read(RELEASE_MAP_STEP).match(/`(\^\[0-9a-f\]\{7,40\}\$)`/);
    assert.ok(m, 'release-map.md must state the hex reference rule');
    // allow-adhoc-regex-escape: the pattern under test is a regex taken verbatim from the step file
    const re = new RegExp(m[1]);
    assert.equal(re.test('a'.repeat(6)), false);
    assert.equal(re.test('a'.repeat(7)), true);
    assert.equal(re.test('a'.repeat(40)), true);
    assert.equal(re.test('a'.repeat(41)), false);
    assert.equal(re.test('PR #412'), false);
    assert.equal(re.test('abc1234\n'), false, 'a trailing newline must not slip through `$`');
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: 7, maxLength: 40 }).map((a) => a.join('')),
        (s) => re.test(s),
      ),
      { seed: 5707, numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/^[0-9a-f]{7,40}$/.test(s)), (s) => !re.test(s)),
      { seed: 5707, numRuns: 200 },
    );
  });

  test('the documented release-name rule keeps shell metacharacters and option-like names out of a push', () => {
    const m = read(RELEASE_MAP_STEP).match(/`(\^\[A-Za-z0-9\]\[A-Za-z0-9\._\+-\]\{0,199\}\$)`/);
    assert.ok(m, 'release-map.md must state the release-name rule');
    // allow-adhoc-regex-escape: the pattern under test is a regex taken verbatim from the step file
    const re = new RegExp(m[1]);
    for (const ok of ['v5.78.0', '2.14.1-rc.1', 'v1+build.5', 'a', 'a'.repeat(199), 'a'.repeat(200)]) assert.equal(re.test(ok), true, ok);
    for (const bad of ['', '-x', '.hidden', 'v1$(id)', 'v1;id', 'v1"x', 'v1 x', 'v1:x', 'a/b', 'v1\n', 'a'.repeat(201)]) {
      assert.equal(re.test(bad), false, JSON.stringify(bad));
    }
  });

  test('per_repo with no configured sub-repositories exposes both facts the routing predicate needs', (t) => {
    const { root } = makeProject(t, []);
    const res = runCli(root, ['query', 'init.complete-milestone']);
    assert.equal(res.status, 0, res.stderr);
    const init = JSON.parse(res.stdout);
    assert.equal(init.repo_tagging, 'per_repo');
    assert.deepEqual(init.sub_repos, []);
  });
});
