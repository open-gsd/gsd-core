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
