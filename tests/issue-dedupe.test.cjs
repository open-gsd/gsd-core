'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  POSSIBLE_DUPLICATE_LABEL,
  HUMAN_REVIEW_LABEL,
  CHALLENGE_MARKER,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_CANDIDATES,
  MIN_TOKEN_LENGTH,
  EXEMPT_LABELS,
  STOPWORDS,
  tokenize,
  diceSimilarity,
  scoreCandidates,
  renderChallengeComment,
  isChallengeComment,
  hasExemptLabel,
  shouldClose,
} = require('../scripts/issue-dedupe.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('issue-dedupe constants', () => {
  test('POSSIBLE_DUPLICATE_LABEL is correct string', () => {
    assert.equal(POSSIBLE_DUPLICATE_LABEL, 'possible-duplicate');
  });

  test('HUMAN_REVIEW_LABEL is correct string', () => {
    assert.equal(HUMAN_REVIEW_LABEL, 'needs-maintainer-review');
  });

  test('CHALLENGE_MARKER is an HTML comment string', () => {
    assert.ok(typeof CHALLENGE_MARKER === 'string');
    assert.ok(CHALLENGE_MARKER.startsWith('<!--'));
    assert.ok(CHALLENGE_MARKER.endsWith('-->'));
  });

  test('DEFAULT_WINDOW_HOURS is 24', () => {
    assert.equal(DEFAULT_WINDOW_HOURS, 24);
  });

  test('DEFAULT_THRESHOLD is 0.6', () => {
    assert.equal(DEFAULT_THRESHOLD, 0.6);
  });

  test('DEFAULT_MAX_CANDIDATES is 5', () => {
    assert.equal(DEFAULT_MAX_CANDIDATES, 5);
  });

  test('MIN_TOKEN_LENGTH is 3', () => {
    assert.equal(MIN_TOKEN_LENGTH, 3);
  });

  test('EXEMPT_LABELS includes required entries', () => {
    assert.ok(Array.isArray(EXEMPT_LABELS));
    for (const label of ['priority: critical', 'pinned', 'confirmed-bug', 'needs-maintainer-review']) {
      assert.ok(EXEMPT_LABELS.includes(label), `EXEMPT_LABELS must contain "${label}"`);
    }
  });

  test('STOPWORDS is a Set containing common words', () => {
    assert.ok(STOPWORDS instanceof Set, 'STOPWORDS must be a Set');
    for (const word of ['the', 'and', 'bug', 'issue', 'please']) {
      assert.ok(STOPWORDS.has(word), `STOPWORDS must contain "${word}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  test('lowercases, strips punctuation, drops stopwords, dedupes', () => {
    // 'CLI', 'crashes', '--flag', 'input' survive; 'Bug', 'on', 'with' are stopwords
    const tokens = tokenize('Bug: CLI crashes on --flag with input!!!');
    assert.ok(Array.isArray(tokens));
    assert.ok(tokens.includes('cli'));
    assert.ok(tokens.includes('crashes'));
    assert.ok(tokens.includes('flag'));
    assert.ok(tokens.includes('input'));
    // stopwords must be absent
    assert.ok(!tokens.includes('bug'));
    assert.ok(!tokens.includes('on'));
    assert.ok(!tokens.includes('with'));
    // all lowercase
    for (const t of tokens) assert.equal(t, t.toLowerCase());
  });

  test('drops tokens shorter than MIN_TOKEN_LENGTH', () => {
    // 'ab' is 2 chars, 'xy' is 2 chars — both under MIN_TOKEN_LENGTH=3
    const tokens = tokenize('ab xy hello');
    assert.ok(!tokens.includes('ab'));
    assert.ok(!tokens.includes('xy'));
    assert.ok(tokens.includes('hello'));
  });

  test('deduplicates tokens (stable first-occurrence order)', () => {
    const tokens = tokenize('crash crash crash happened happened');
    assert.equal(tokens.filter((t) => t === 'crash').length, 1);
    assert.equal(tokens.filter((t) => t === 'happened').length, 1);
    // first occurrence order: crash before happened
    assert.ok(tokens.indexOf('crash') < tokens.indexOf('happened'));
  });

  test('emoji-only title returns empty array and does not throw', () => {
    const tokens = tokenize('🔥🔥');
    assert.ok(Array.isArray(tokens));
    assert.equal(tokens.length, 0);
  });

  test('empty string returns empty array', () => {
    assert.deepEqual(tokenize(''), []);
  });

  test('null returns empty array', () => {
    assert.deepEqual(tokenize(null), []);
  });

  test('non-string number returns empty array', () => {
    assert.deepEqual(tokenize(123), []);
  });

  test('all-stopword title returns empty array', () => {
    const tokens = tokenize('the and or but if');
    assert.deepEqual(tokens, []);
  });

  test('complex real-world title with mixed punctuation and short words', () => {
    const tokens = tokenize('Bug: CLI crashes on --flag with空 input!!!');
    // non-ascii gets stripped along with punctuation — '空' becomes empty
    // remaining meaningful tokens should be present
    assert.ok(tokens.includes('cli'));
    assert.ok(tokens.includes('crashes'));
    assert.ok(tokens.includes('flag'));
    assert.ok(tokens.includes('input'));
  });

  test('title with only very short words returns empty array', () => {
    // 'to', 'be', 'or', 'it' are all either stopwords or too short (<3 chars)
    const tokens = tokenize('to be or it');
    assert.deepEqual(tokens, []);
  });
});

// ---------------------------------------------------------------------------
// diceSimilarity
// ---------------------------------------------------------------------------

describe('diceSimilarity', () => {
  test('identical token arrays return 1', () => {
    assert.equal(diceSimilarity(['foo', 'bar', 'baz'], ['foo', 'bar', 'baz']), 1);
  });

  test('disjoint token arrays return 0', () => {
    assert.equal(diceSimilarity(['foo', 'bar'], ['baz', 'qux']), 0);
  });

  test('partial overlap returns expected dice coefficient', () => {
    // A = {a,b,c}, B = {b,c,d}: intersection = {b,c} -> 2*2/(3+3) = 4/6 ≈ 0.6667
    const score = diceSimilarity(['a', 'b', 'c'], ['b', 'c', 'd']);
    assert.ok(Math.abs(score - (4 / 6)) < 0.001, `Expected ~0.6667, got ${score}`);
  });

  test('empty first array returns 0', () => {
    assert.equal(diceSimilarity([], ['foo', 'bar']), 0);
  });

  test('empty second array returns 0', () => {
    assert.equal(diceSimilarity(['foo', 'bar'], []), 0);
  });

  test('both empty returns 0', () => {
    assert.equal(diceSimilarity([], []), 0);
  });

  test('single common token: A={x}, B={x} -> 1', () => {
    assert.equal(diceSimilarity(['x'], ['x']), 1);
  });

  test('single token each, different: 0', () => {
    assert.equal(diceSimilarity(['x'], ['y']), 0);
  });

  test('treats token arrays as sets (duplicates in input do not inflate score)', () => {
    // Even if caller somehow passes duplicates, score should still be well-formed
    // A={foo,bar}, B={foo,bar}: expect 1 even with duplicates in input
    const score = diceSimilarity(['foo', 'foo', 'bar'], ['foo', 'bar', 'bar']);
    // The function works on sets internally; result should be 1
    assert.equal(score, 1);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates
// ---------------------------------------------------------------------------

describe('scoreCandidates', () => {
  const candidates = [
    { number: 10, title: 'CLI crashes on startup with bad config' },
    { number: 11, title: 'Something entirely different here' },
    { number: 12, title: 'CLI crashes with segfault on startup' },
    { number: 13, title: 'Feature request add dark mode' },
  ];

  test('excludeNumber excludes self from results', () => {
    const results = scoreCandidates('CLI crashes on startup with bad config', candidates, { excludeNumber: 10 });
    assert.ok(!results.some((r) => r.number === 10));
  });

  test('threshold filters out low-scoring candidates', () => {
    const results = scoreCandidates('CLI crashes on startup', candidates, { threshold: 0.9 });
    // Only very close matches should survive
    for (const r of results) {
      assert.ok(r.score >= 0.9, `Score ${r.score} for #${r.number} is below threshold`);
    }
  });

  test('results are sorted descending by score, ascending by number on tie', () => {
    const results = scoreCandidates('CLI crashes startup config', candidates, { threshold: 0 });
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (Math.abs(prev.score - curr.score) < 0.0001) {
        // tie-break: ascending number
        assert.ok(prev.number < curr.number, 'Tie-break should be ascending by number');
      } else {
        assert.ok(prev.score >= curr.score, 'Results should be sorted descending by score');
      }
    }
  });

  test('limit caps the number of results', () => {
    const manyCandidates = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: `CLI crashes startup config issue ${i}`,
    }));
    const results = scoreCandidates('CLI crashes startup config', manyCandidates, { threshold: 0, limit: 3 });
    assert.ok(results.length <= 3);
  });

  test('all-stopword newTitle returns empty array', () => {
    const results = scoreCandidates('the and or but', candidates, { threshold: 0 });
    assert.deepEqual(results, []);
  });

  test('null candidate entries are tolerated (filtered out)', () => {
    const messyCandidates = [null, undefined, { number: 1, title: 'CLI crashes badly' }, { title: 'no number' }, { number: 2, title: null }];
    let results;
    assert.doesNotThrow(() => {
      results = scoreCandidates('CLI crashes', messyCandidates, { threshold: 0 });
    });
    // entry without number should be skipped; entry with null title should survive (tokenize(null) = [])
    assert.ok(!results.some((r) => r.number === undefined || r.number === null));
  });

  test('each result has number, title, and score fields', () => {
    const results = scoreCandidates('CLI crashes on startup', candidates, { threshold: 0 });
    for (const r of results) {
      assert.ok('number' in r, 'result must have number');
      assert.ok('title' in r, 'result must have title');
      assert.ok('score' in r, 'result must have score');
      assert.ok(typeof r.score === 'number');
      assert.ok(r.score >= 0 && r.score <= 1);
    }
  });

  test('defaults: threshold=DEFAULT_THRESHOLD, limit=DEFAULT_MAX_CANDIDATES', () => {
    // With default opts, results should respect DEFAULT_THRESHOLD
    const results = scoreCandidates('CLI crashes', candidates);
    for (const r of results) {
      assert.ok(r.score >= DEFAULT_THRESHOLD);
    }
    assert.ok(results.length <= DEFAULT_MAX_CANDIDATES);
  });

  test('candidate with missing number is skipped', () => {
    const withNoNumber = [{ title: 'CLI crashes badly' }, { number: 5, title: 'CLI crashes badly' }];
    const results = scoreCandidates('CLI crashes', withNoNumber, { threshold: 0 });
    assert.ok(!results.some((r) => r.number === undefined));
    assert.ok(results.some((r) => r.number === 5));
  });

  test('default threshold 0.6 excludes near-miss ~0.545, but explicit 0.5 includes it', () => {
    // newTitle tokens: ['cli', 'crashes', 'startup'] (3 tokens — 'on' is stopword)
    // candidate tokens: ['cli', 'crashes', 'startup', 'mode', 'display', 'render', 'timeout'] (7 tokens)
    // intersection = 3, dice = 2*3/(3+7) = 6/10 = 0.6 exactly — adjust to get below 0.6
    // newTitle tokens: ['crashes', 'startup'] (2 tokens after removing 'cli' via excludeNumber not applicable here)
    // Use a 4-token new title and 7-token candidate with 3 shared for 6/11 ≈ 0.545
    // newTitle: 'CLI crashes startup config' → tokens: ['cli','crashes','startup','config'] (4 tokens)
    // candidate: 'CLI crashes startup mode display render timeout' → tokens: ['cli','crashes','startup','mode','display','render','timeout'] (7 tokens)
    // intersection = {cli,crashes,startup} = 3; dice = 2*3/(4+7) = 6/11 ≈ 0.5454
    const nearMissCandidate = [{ number: 99, title: 'CLI crashes startup mode display render timeout' }];
    const scoreVal = 6 / 11; // ≈ 0.5454
    assert.ok(scoreVal < 0.6, 'sanity: near-miss score is below 0.6');
    assert.ok(scoreVal > 0.5, 'sanity: near-miss score is above 0.5');

    // Default threshold (0.6) should exclude it
    const withDefault = scoreCandidates('CLI crashes startup config', nearMissCandidate);
    assert.equal(withDefault.length, 0, 'default threshold 0.6 must exclude ~0.545 score');

    // Explicit threshold 0.5 should include it
    const withLower = scoreCandidates('CLI crashes startup config', nearMissCandidate, { threshold: 0.5 });
    assert.equal(withLower.length, 1, 'explicit threshold 0.5 must include ~0.545 score');
    assert.ok(withLower[0].score > 0.5 && withLower[0].score < 0.6);
  });
});

// ---------------------------------------------------------------------------
// renderChallengeComment
// ---------------------------------------------------------------------------

describe('renderChallengeComment', () => {
  const sampleCandidates = [
    { number: 42, title: 'CLI crashes on startup', score: 0.83 },
    { number: 7, title: 'Segfault when starting CLI', score: 0.66 },
  ];

  test('output starts with CHALLENGE_MARKER on its own line', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    const firstLine = output.split('\n')[0];
    assert.equal(firstLine.trim(), CHALLENGE_MARKER);
  });

  test('output contains each candidate number prefixed with #', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    assert.ok(output.includes('#42'));
    assert.ok(output.includes('#7'));
  });

  test('output contains each candidate title', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    assert.ok(output.includes('CLI crashes on startup'));
    assert.ok(output.includes('Segfault when starting CLI'));
  });

  test('output includes percentage similarity rounded correctly', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    // 0.83 -> 83%, 0.66 -> 66%
    assert.ok(output.includes('83%'), 'Expected 83% in output');
    assert.ok(output.includes('66%'), 'Expected 66% in output');
  });

  test('output mentions the windowHours', () => {
    const output = renderChallengeComment(sampleCandidates, { windowHours: 48 });
    assert.ok(output.includes('48'), 'Output must mention windowHours=48');
  });

  test('output includes 👎 veto character', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    assert.ok(output.includes('👎'), 'Output must include the 👎 veto emoji');
  });

  test('output is deterministic (same input produces same output)', () => {
    const a = renderChallengeComment(sampleCandidates, {});
    const b = renderChallengeComment(sampleCandidates, {});
    assert.equal(a, b);
  });

  test('isChallengeComment(renderChallengeComment(...)) is true', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    assert.equal(isChallengeComment(output), true);
  });

  test('uses DEFAULT_WINDOW_HOURS when windowHours not provided', () => {
    const output = renderChallengeComment(sampleCandidates, {});
    assert.ok(output.includes(String(DEFAULT_WINDOW_HOURS)));
  });
});

// ---------------------------------------------------------------------------
// isChallengeComment
// ---------------------------------------------------------------------------

describe('isChallengeComment', () => {
  test('returns true when body contains CHALLENGE_MARKER', () => {
    assert.equal(isChallengeComment(`${CHALLENGE_MARKER}\nsome content`), true);
  });

  test('returns false when body does not contain CHALLENGE_MARKER', () => {
    assert.equal(isChallengeComment('just a normal comment'), false);
  });

  test('returns false for empty string', () => {
    assert.equal(isChallengeComment(''), false);
  });

  test('returns false for non-string', () => {
    assert.equal(isChallengeComment(null), false);
    assert.equal(isChallengeComment(undefined), false);
    assert.equal(isChallengeComment(42), false);
  });
});

// ---------------------------------------------------------------------------
// hasExemptLabel
// ---------------------------------------------------------------------------

describe('hasExemptLabel', () => {
  test('returns true for string label matching an exempt label', () => {
    assert.equal(hasExemptLabel(['priority: critical']), true);
  });

  test('returns true for object label {name} matching an exempt label', () => {
    assert.equal(hasExemptLabel([{ name: 'pinned' }]), true);
  });

  test('returns true for confirmed-bug', () => {
    assert.equal(hasExemptLabel(['confirmed-bug']), true);
  });

  test('returns true for needs-maintainer-review', () => {
    assert.equal(hasExemptLabel(['needs-maintainer-review']), true);
  });

  test('returns false for non-exempt string label', () => {
    assert.equal(hasExemptLabel(['bug']), false);
  });

  test('returns false for empty array', () => {
    assert.equal(hasExemptLabel([]), false);
  });

  test('returns false for non-exempt object label', () => {
    assert.equal(hasExemptLabel([{ name: 'enhancement' }]), false);
  });

  test('returns true when one of multiple labels is exempt', () => {
    assert.equal(hasExemptLabel(['bug', 'priority: critical', 'enhancement']), true);
  });

  test('returns true for mixed string and object labels', () => {
    assert.equal(hasExemptLabel(['bug', { name: 'pinned' }]), true);
  });
});

// ---------------------------------------------------------------------------
// shouldClose
// ---------------------------------------------------------------------------

describe('shouldClose', () => {
  const BASE_NOW = new Date('2026-01-01T12:00:00Z');
  const CHALLENGE_CREATED_RECENT = new Date('2026-01-01T11:30:00Z'); // 30 min ago
  const CHALLENGE_CREATED_OLD = new Date('2026-01-01T09:00:00Z'); // 3 hours ago, >DEFAULT
  const CHALLENGE_CREATED_25H = new Date('2025-12-31T11:00:00Z'); // 25 hours ago

  const baseChallenge = {
    createdAt: CHALLENGE_CREATED_OLD,
    downvoted: false,
  };

  test('exempt-label short-circuits even when overdue', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: ['priority: critical'],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'exempt-label');
  });

  test('no challenge comment returns no-challenge-comment', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: null,
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'no-challenge-comment');
  });

  test('no challenge comment with undefined challengeComment returns no-challenge-comment', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'no-challenge-comment');
  });

  test('downvoted challenge returns vetoed', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H, downvoted: true },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'vetoed');
  });

  test('laterUserComments > 0 returns reporter-responded', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 1,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'reporter-responded');
  });

  test('within window (1h age, 24h window) returns within-window', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_RECENT },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'within-window');
  });

  test('age > windowHours, no reply, not vetoed, not exempt -> close:true duplicate-no-response', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 0,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('createdAt as ISO string works', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H.toISOString() },
      laterUserComments: 0,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('createdAt as Date object works', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 0,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('createdAt as ms-number works', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H.getTime() },
      laterUserComments: 0,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('now as ms-number works', () => {
    const result = shouldClose({
      now: BASE_NOW.getTime(),
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 0,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('custom windowHours is respected', () => {
    // Challenge created 3 hours ago; with windowHours=1 it should be overdue
    const threeHoursAgo = new Date(BASE_NOW.getTime() - 3 * 3600000);
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: threeHoursAgo },
      laterUserComments: 0,
      windowHours: 1,
    });
    assert.equal(result.close, true);
    assert.equal(result.reason, 'duplicate-no-response');
  });

  test('exempt check still short-circuits when within window', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: ['confirmed'],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_RECENT },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'exempt-label');
  });

  test('createdAt as unparseable string returns invalid-timestamp (fail-safe)', () => {
    const result = shouldClose({
      now: BASE_NOW,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: 'not-a-date' },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'invalid-timestamp');
  });

  test('now as NaN returns invalid-timestamp (fail-safe)', () => {
    const result = shouldClose({
      now: NaN,
      labels: [],
      challengeComment: { ...baseChallenge, createdAt: CHALLENGE_CREATED_25H },
      laterUserComments: 0,
    });
    assert.equal(result.close, false);
    assert.equal(result.reason, 'invalid-timestamp');
  });
});
