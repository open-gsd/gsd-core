'use strict';

// #5607 — "Reviewed or maintainer": a PR passes when its author is a listed
// maintainer, or when someone else with write access has approved the CURRENT
// head. Tests assert on the typed REASON enum, never on free text.
//
// Asymmetry that shapes the suite: a false PASS lets an unreviewed outside PR
// through; a false FAIL only makes a maintainer ask for a review. So the weight
// is on every way an approval can be counted that should not be: stale sha,
// self-approval, a read-only reviewer, a later dismissal or change request,
// an unknown role, a truncated review list, and an unreadable maintainer file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  REASON,
  parseMaintainers,
  evaluateReviewed,
} = require('../scripts/reviewed-or-maintainer-policy.cjs');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const maintainers = new Set(['trek-e']);

function review(login, state, commit = HEAD) {
  return { user: { login }, state, commit_id: commit };
}

function verdict(overrides) {
  return evaluateReviewed({
    authorLogin: 'outsider',
    maintainers,
    reviews: [],
    roles: {},
    headSha: HEAD,
    reviewsComplete: true,
    ...overrides,
  });
}

describe('parseMaintainers', () => {
  test('reads logins, ignores comments and blank lines, lowercases', () => {
    const parsed = parseMaintainers('# who may merge without a second reviewer\n\nTrek-E\n  other-dev  # trailing\n');
    assert.equal(parsed.ok, true);
    assert.deepEqual([...parsed.logins].sort(), ['other-dev', 'trek-e']);
  });

  test('a file with no logins is not a usable list', () => {
    assert.equal(parseMaintainers('# nobody yet\n').ok, false);
    assert.equal(parseMaintainers('').ok, false);
  });

  test('non-string input is not a usable list', () => {
    for (const bad of [null, undefined, 42, {}]) assert.equal(parseMaintainers(bad).ok, false);
  });

  test('a malformed line is reported and never becomes a login', () => {
    const parsed = parseMaintainers('trek-e\nnot a login!\n../etc\n');
    assert.equal(parsed.ok, true);
    assert.deepEqual([...parsed.logins], ['trek-e']);
    assert.deepEqual(parsed.invalid, ['not a login!', '../etc']);
  });
});

describe('author is a maintainer', () => {
  test('passes with no reviews at all', () => {
    assert.deepEqual(verdict({ authorLogin: 'trek-e' }), { ok: true, reason: REASON.OK_MAINTAINER_AUTHOR });
  });

  test('matches case-insensitively', () => {
    assert.equal(verdict({ authorLogin: 'Trek-E' }).ok, true);
  });

  test('is decided before the review list is consulted', () => {
    assert.equal(verdict({ authorLogin: 'trek-e', reviewsComplete: false }).reason, REASON.OK_MAINTAINER_AUTHOR);
  });
});

describe('author is not a maintainer', () => {
  test('no reviews fails', () => {
    assert.deepEqual(verdict({}), { ok: false, reason: REASON.FAIL_NO_APPROVAL });
  });

  test('an approval from a write-access reviewer on the current head passes', () => {
    const v = verdict({ reviews: [review('trek-e', 'APPROVED')], roles: { 'trek-e': 'admin' } });
    assert.deepEqual(v, { ok: true, reason: REASON.OK_APPROVED });
  });

  for (const role of ['write', 'maintain', 'admin']) {
    test(`role ${role} may approve`, () => {
      assert.equal(verdict({ reviews: [review('rev', 'APPROVED')], roles: { rev: role } }).ok, true);
    });
  }

  for (const role of ['read', 'triage', 'none', '', undefined]) {
    test(`role ${JSON.stringify(role)} may not approve`, () => {
      const v = verdict({ reviews: [review('rev', 'APPROVED')], roles: { rev: role } });
      assert.equal(v.ok, false);
      assert.equal(v.reason, REASON.FAIL_NO_APPROVAL);
    });
  }

  test('a reviewer with no role entry does not count', () => {
    assert.equal(verdict({ reviews: [review('rev', 'APPROVED')], roles: {} }).ok, false);
  });

  test('the author approving their own PR does not count', () => {
    const v = verdict({ reviews: [review('outsider', 'APPROVED')], roles: { outsider: 'write' } });
    assert.equal(v.ok, false);
  });

  test('self-approval is matched case-insensitively', () => {
    const v = verdict({ reviews: [review('OutSider', 'APPROVED')], roles: { outsider: 'write' } });
    assert.equal(v.ok, false);
  });

  test('an approval on an older head is stale, with its own reason', () => {
    const v = verdict({ reviews: [review('rev', 'APPROVED', OLD)], roles: { rev: 'write' } });
    assert.deepEqual(v, { ok: false, reason: REASON.FAIL_STALE_APPROVAL_ONLY });
  });

  test('a stale approval plus a current one passes', () => {
    const v = verdict({
      reviews: [review('rev', 'APPROVED', OLD), review('rev2', 'APPROVED')],
      roles: { rev: 'write', rev2: 'write' },
    });
    assert.equal(v.ok, true);
  });

  test("a reviewer's later change request replaces their earlier approval", () => {
    const v = verdict({
      reviews: [review('rev', 'APPROVED'), review('rev', 'CHANGES_REQUESTED')],
      roles: { rev: 'write' },
    });
    assert.equal(v.ok, false);
  });

  test("a reviewer's later dismissal replaces their earlier approval", () => {
    const v = verdict({ reviews: [review('rev', 'APPROVED'), review('rev', 'DISMISSED')], roles: { rev: 'write' } });
    assert.equal(v.ok, false);
  });

  test("a later plain comment does not cancel a reviewer's approval", () => {
    const v = verdict({ reviews: [review('rev', 'APPROVED'), review('rev', 'COMMENTED')], roles: { rev: 'write' } });
    assert.equal(v.ok, true);
  });

  test('a pending review is ignored', () => {
    assert.equal(verdict({ reviews: [review('rev', 'PENDING')], roles: { rev: 'write' } }).ok, false);
  });

  test('a reviewer re-approving after a change request counts', () => {
    const v = verdict({
      reviews: [review('rev', 'CHANGES_REQUESTED', OLD), review('rev', 'APPROVED')],
      roles: { rev: 'write' },
    });
    assert.equal(v.ok, true);
  });

  test('an approval by one reviewer is not cancelled by another reviewer\'s change request', () => {
    // GitHub shows that state natively; this check only asks "is there a qualifying approval".
    const v = verdict({
      reviews: [review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')],
      roles: { a: 'write', b: 'write' },
    });
    assert.equal(v.ok, true);
  });

  test('an approval by an app or bot never counts, whatever permission it holds', () => {
    const asBotType = { user: { login: 'some-app', type: 'Bot' }, state: 'APPROVED', commit_id: HEAD };
    const asBotLogin = { user: { login: 'github-actions[bot]' }, state: 'APPROVED', commit_id: HEAD };
    for (const entry of [asBotType, asBotLogin]) {
      const v = verdict({
        reviews: [entry],
        roles: { 'some-app': 'admin', 'github-actions[bot]': 'admin' },
      });
      assert.equal(v.ok, false);
      assert.equal(v.reason, REASON.FAIL_NO_APPROVAL);
    }
  });

  test('a bot approval does not hide a genuine human approval', () => {
    const bot = { user: { login: 'github-actions[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: HEAD };
    const v = verdict({ reviews: [bot, review('rev', 'APPROVED')], roles: { 'github-actions[bot]': 'admin', rev: 'write' } });
    assert.equal(v.ok, true);
  });

  test('a truncated review list fails closed', () => {
    const v = verdict({ reviews: [review('rev', 'APPROVED')], roles: { rev: 'write' }, reviewsComplete: false });
    assert.deepEqual(v, { ok: false, reason: REASON.FAIL_REVIEWS_INCOMPLETE });
  });

  test('a missing reviewsComplete flag is treated as incomplete', () => {
    const v = evaluateReviewed({
      authorLogin: 'outsider', maintainers, reviews: [review('rev', 'APPROVED')], roles: { rev: 'write' }, headSha: HEAD,
    });
    assert.equal(v.reason, REASON.FAIL_REVIEWS_INCOMPLETE);
  });
});

describe('inputs that cannot be trusted fail closed', () => {
  test('an unreadable maintainer list', () => {
    for (const bad of [null, undefined, new Set(), []]) {
      assert.equal(verdict({ maintainers: bad }).reason, REASON.FAIL_MAINTAINERS_UNREADABLE, String(bad));
    }
  });

  test('a missing or empty author', () => {
    for (const bad of ['', null, undefined, 7]) {
      assert.equal(verdict({ authorLogin: bad }).reason, REASON.FAIL_INPUT_INVALID, String(bad));
    }
  });

  test('a head sha that is not 40 hex characters', () => {
    for (const bad of ['', 'abc', 'g'.repeat(40), null, undefined]) {
      assert.equal(verdict({ headSha: bad }).reason, REASON.FAIL_INPUT_INVALID, String(bad));
    }
  });

  test('reviews that are not an array', () => {
    assert.equal(verdict({ reviews: null }).reason, REASON.FAIL_INPUT_INVALID);
    assert.equal(verdict({ reviews: {} }).reason, REASON.FAIL_INPUT_INVALID);
  });

  test('malformed review entries are skipped, never counted', () => {
    const v = verdict({ reviews: [null, {}, { user: null, state: 'APPROVED', commit_id: HEAD }], roles: {} });
    assert.equal(v.ok, false);
    assert.equal(v.reason, REASON.FAIL_NO_APPROVAL);
  });
});

// ---------------------------------------------------------------------------
// Properties: every way an approval could wrongly count must stay uncounted.
// ---------------------------------------------------------------------------

const loginArb = fc.stringMatching(/^[a-z][a-z0-9]{2,12}$/);

describe('property: nothing but a current, human, non-author, write-access approval passes', () => {
  // Each generated approval is spoiled in exactly one way; whatever the mix, the
  // verdict must never be ok.
  const spoiledApproval = fc.record({
    login: loginArb,
    how: fc.constantFrom('stale', 'low-role', 'author', 'bot-type', 'bot-login', 'no-role'),
  });

  test('any list of spoiled approvals fails', () => {
    fc.assert(
      fc.property(fc.array(spoiledApproval, { maxLength: 8 }), (spoiled) => {
        const reviews = [];
        const roles = {};
        spoiled.forEach(({ login, how }, i) => {
          const name = how === 'author' ? 'outsider' : how === 'bot-login' ? `${login}${i}[bot]` : `${login}${i}`;
          const entry = { user: { login: name }, state: 'APPROVED', commit_id: HEAD };
          if (how === 'bot-type') entry.user.type = 'Bot';
          if (how === 'stale') entry.commit_id = OLD;
          if (how !== 'no-role') roles[name.toLowerCase()] = how === 'low-role' ? 'read' : 'admin';
          reviews.push(entry);
        });
        return verdict({ reviews, roles }).ok === false;
      }),
      { numRuns: 300 },
    );
  });

  test('one genuine approval among any amount of spoiled ones passes', () => {
    fc.assert(
      fc.property(fc.array(spoiledApproval, { maxLength: 6 }), fc.nat({ max: 6 }), (spoiled, at) => {
        const reviews = spoiled.map(({ login }, i) => ({ user: { login: `${login}${i}` }, state: 'APPROVED', commit_id: OLD }));
        const roles = Object.fromEntries(reviews.map((r) => [r.user.login.toLowerCase(), 'admin']));
        reviews.splice(Math.min(at, reviews.length), 0, review('genuine', 'APPROVED'));
        roles.genuine = 'write';
        return verdict({ reviews, roles }).ok === true;
      }),
      { numRuns: 200 },
    );
  });

  test('a later non-approving standing review always withdraws that reviewer\'s approval', () => {
    fc.assert(
      fc.property(fc.constantFrom('CHANGES_REQUESTED', 'DISMISSED'), (state) => {
        const v = verdict({ reviews: [review('rev', 'APPROVED'), review('rev', state)], roles: { rev: 'admin' } });
        return v.ok === false;
      }),
    );
  });
});

describe('property: parseMaintainers only ever admits well-formed logins', () => {
  const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;

  test('every admitted login is well-formed, lowercase, and came from the text', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 50 }), { maxLength: 12 }), (lines) => {
        const parsed = parseMaintainers(lines.join('\n'));
        const sourceLines = new Set(
          lines.join('\n').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim().toLowerCase()),
        );
        return [...parsed.logins].every((l) => LOGIN.test(l) && l === l.toLowerCase() && sourceLines.has(l));
      }),
      { numRuns: 300 },
    );
  });

  test('a login line that fails the pattern never becomes a login', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 !@$%^&*()+=<>?/\\|~,;:'"`]{1,30}$/), (line) => {
        const trimmed = line.replace(/#.*$/, '').trim();
        fc.pre(trimmed !== '' && !LOGIN.test(trimmed));
        return !parseMaintainers(`trek-e\n${line}`).logins.has(trimmed.toLowerCase());
      }),
      { numRuns: 300 },
    );
  });

  test('the length boundary is 39 characters', () => {
    const at = (n) => 'a'.repeat(n);
    assert.equal(parseMaintainers(at(38)).logins.has(at(38)), true);
    assert.equal(parseMaintainers(at(39)).logins.has(at(39)), true);
    assert.equal(parseMaintainers(at(40)).logins.has(at(40)), false);
  });

  test('CRLF line endings and trailing whitespace are tolerated', () => {
    assert.deepEqual([...parseMaintainers('trek-e \r\nother\r\n').logins].sort(), ['other', 'trek-e']);
  });
});

// ---------------------------------------------------------------------------
// The entry point: env wiring, exit code, and the GITHUB_OUTPUT contract.
// ---------------------------------------------------------------------------

const SCRIPT = path.join(__dirname, '..', 'scripts', 'reviewed-or-maintainer-policy.cjs');

describe('main(): environment wiring and exit code', () => {
  function run(t, { maintainersText = 'trek-e\n', reviews, roles, env = {} } = {}) {
    const dir = createTempDir('gsd-5607-main-');
    t.after(() => cleanup(dir));
    const maintainersFile = path.join(dir, 'MAINTAINERS');
    const outputFile = path.join(dir, 'github_output');
    if (maintainersText !== null) fs.writeFileSync(maintainersFile, maintainersText);
    const reviewsFile = path.join(dir, 'reviews.json');
    const rolesFile = path.join(dir, 'roles.json');
    if (reviews !== undefined) fs.writeFileSync(reviewsFile, typeof reviews === 'string' ? reviews : JSON.stringify(reviews));
    if (roles !== undefined) fs.writeFileSync(rolesFile, JSON.stringify(roles));
    const result = runNode([SCRIPT], {
      cwd: dir,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        MAINTAINERS_FILE: maintainersFile,
        GITHUB_OUTPUT: outputFile,
        PR_AUTHOR_LOGIN: 'outsider',
        HEAD_SHA: HEAD,
        ...(reviews !== undefined ? { REVIEWS_FILE: reviewsFile } : {}),
        ...(roles !== undefined ? { ROLES_FILE: rolesFile } : {}),
        REVIEWS_COMPLETE: 'true',
        ...env,
      },
    });
    const outputs = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
    return { result, outputs, verdict: JSON.parse(result.stdout.trim().split('\n').pop() || 'null') };
  }

  test('a maintainer author exits 0 and writes ok=true', (t) => {
    const r = run(t, { env: { PR_AUTHOR_LOGIN: 'trek-e' }, reviews: [] });
    assert.equal(r.result.exitCode, 0);
    assert.deepEqual(r.verdict, { ok: true, reason: REASON.OK_MAINTAINER_AUTHOR });
    assert.match(r.outputs, /^ok=true$/m);
    assert.match(r.outputs, new RegExp(`^reason=${REASON.OK_MAINTAINER_AUTHOR}$`, 'm'));
  });

  test('an outsider with no approval exits 1 and writes ok=false', (t) => {
    const r = run(t, { reviews: [], roles: {} });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_NO_APPROVAL);
    assert.match(r.outputs, /^ok=false$/m);
  });

  test('a genuine approval read from the files exits 0', (t) => {
    const r = run(t, { reviews: [review('rev', 'APPROVED')], roles: { rev: 'write' } });
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.verdict.reason, REASON.OK_APPROVED);
  });

  test('REVIEWS_COMPLETE other than the string true fails closed', (t) => {
    for (const value of ['false', '', 'TRUE', '1']) {
      const r = run(t, { reviews: [review('rev', 'APPROVED')], roles: { rev: 'write' }, env: { REVIEWS_COMPLETE: value } });
      assert.equal(r.result.exitCode, 1, `REVIEWS_COMPLETE=${JSON.stringify(value)}`);
      assert.equal(r.verdict.reason, REASON.FAIL_REVIEWS_INCOMPLETE);
    }
  });

  test('an unreadable or missing reviews file fails closed as invalid input', (t) => {
    assert.equal(run(t, { reviews: 'not json {' , roles: {} }).verdict.reason, REASON.FAIL_INPUT_INVALID);
    assert.equal(run(t, { roles: {} }).verdict.reason, REASON.FAIL_INPUT_INVALID);
  });

  test('a missing or empty maintainer file fails closed', (t) => {
    assert.equal(run(t, { maintainersText: null, reviews: [], roles: {} }).verdict.reason, REASON.FAIL_MAINTAINERS_UNREADABLE);
    assert.equal(run(t, { maintainersText: '# nobody\n', reviews: [], roles: {} }).verdict.reason, REASON.FAIL_MAINTAINERS_UNREADABLE);
  });

  test('a missing roles file leaves approvers without a role, so no approval counts', (t) => {
    const r = run(t, { reviews: [review('rev', 'APPROVED')] });
    assert.equal(r.result.exitCode, 1);
    assert.equal(r.verdict.reason, REASON.FAIL_NO_APPROVAL);
  });

  test('a malformed MAINTAINERS line is warned about on stderr and ignored', (t) => {
    const r = run(t, { maintainersText: 'trek-e\nbad line!\n', reviews: [], roles: {}, env: { PR_AUTHOR_LOGIN: 'trek-e' } });
    assert.equal(r.result.exitCode, 0);
    assert.match(r.result.stderr, /MAINTAINERS: ignored malformed line/);
  });
});
