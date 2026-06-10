#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSSIBLE_DUPLICATE_LABEL = 'possible-duplicate';
const HUMAN_REVIEW_LABEL = 'needs-maintainer-review';
const CHALLENGE_MARKER = '<!-- gsd-dedupe-challenge -->';
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_CANDIDATES = 5;
const MIN_TOKEN_LENGTH = 3;

const EXEMPT_LABELS = [
  'priority: critical',
  'pinned',
  'confirmed-bug',
  'confirmed',
  'fix-pending',
  'needs-maintainer-review',
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was',
  'be', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from',
  'this', 'that', 'it', 'its', 'not', 'no', 'when', 'what', 'why', 'how',
  'does', 'do', 'doing', 'did', 'can', 'will', 'would', 'should',
  'i', 'we', 'you', 'your', 'my', 'me',
  'issue', 'bug', 'error', 'problem', 'feature', 'request',
  'help', 'support', 'please', 'question',
  'after', 'before', 'into', 'only', 'then', 'than', 'them', 'they',
  'use', 'used', 'using',
]);

// ---------------------------------------------------------------------------
// tokenize(title) -> string[]
//
// Lowercase the title, replace any non-[a-z0-9] run with a space, split on
// whitespace, drop tokens shorter than MIN_TOKEN_LENGTH, drop STOPWORDS, and
// dedupe while preserving stable first-occurrence order.
//
// Non-string, null, or empty input returns []. Must not throw on any input.
// ---------------------------------------------------------------------------

function tokenize(title) {
  if (typeof title !== 'string' || !title) return [];

  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return [];

  const seen = new Set();
  const result = [];

  for (const token of normalized.split(' ')) {
    if (!token || token.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }

  return result;
}

// ---------------------------------------------------------------------------
// diceSimilarity(aTokens, bTokens) -> number 0..1
//
// Sørensen–Dice over the token sets: 2 * |A ∩ B| / (|A| + |B|).
// Both inputs are treated as sets (duplicates ignored). Empty either side -> 0.
// Identical sets -> 1.
// ---------------------------------------------------------------------------

function diceSimilarity(aTokens, bTokens) {
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }

  return (2 * intersection) / (setA.size + setB.size);
}

// ---------------------------------------------------------------------------
// scoreCandidates(newTitle, candidates, opts) -> [{number, title, score}]
//
// opts: { threshold=DEFAULT_THRESHOLD, limit=DEFAULT_MAX_CANDIDATES, excludeNumber }
//
// Tokenizes newTitle once. If no tokens -> []. Filters out null/garbage
// candidates, those missing a number, and the excluded number. Scores each
// using diceSimilarity. Keeps score >= threshold. Sorts DESC by score,
// tie-break ASC by number. Caps to limit.
// ---------------------------------------------------------------------------

function scoreCandidates(newTitle, candidates, opts) {
  const threshold = (opts && opts.threshold != null) ? opts.threshold : DEFAULT_THRESHOLD;
  const limit = (opts && opts.limit != null) ? opts.limit : DEFAULT_MAX_CANDIDATES;
  const excludeNumber = opts && opts.excludeNumber;

  const newTokens = tokenize(newTitle);
  if (newTokens.length === 0) return [];

  const scored = [];

  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  for (const candidate of safeCandidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!(typeof candidate.number === 'number' && Number.isFinite(candidate.number))) continue;
    if (candidate.number === excludeNumber) continue;

    const score = diceSimilarity(newTokens, tokenize(candidate.title));
    if (score < threshold) continue;

    scored.push({ number: candidate.number, title: candidate.title, score });
  }

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    return a.number - b.number;
  });

  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// renderChallengeComment(candidates, opts) -> string
//
// opts: { windowHours=DEFAULT_WINDOW_HOURS }
//
// Deterministic. Must start with CHALLENGE_MARKER on its own line. Must list
// each candidate as a line with #<number>, title, and percentage similarity.
// Must mention windowHours and the 👎 veto.
// ---------------------------------------------------------------------------

function renderChallengeComment(candidates, opts) {
  const windowHours = (opts && opts.windowHours != null) ? opts.windowHours : DEFAULT_WINDOW_HOURS;

  const lines = [CHALLENGE_MARKER, ''];

  lines.push('**Possible duplicate detected.** This issue may already be reported:');
  lines.push('');

  for (const candidate of candidates) {
    const pct = Math.round(candidate.score * 100);
    lines.push(`- #${candidate.number} — ${candidate.title} (similarity ${pct}%)`);
  }

  lines.push('');
  lines.push(
    `If this is **not** a duplicate, react with 👎 on this comment to veto and keep the issue open. ` +
    `If no response is received within ${windowHours} hours, this issue may be closed as a duplicate.`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// isChallengeComment(body) -> boolean
//
// True iff body is a string containing CHALLENGE_MARKER.
// ---------------------------------------------------------------------------

function isChallengeComment(body) {
  if (typeof body !== 'string') return false;
  return body.includes(CHALLENGE_MARKER);
}

// ---------------------------------------------------------------------------
// hasExemptLabel(labels) -> boolean
//
// labels may be an array of strings or array of {name}. True if any name is
// in EXEMPT_LABELS.
// ---------------------------------------------------------------------------

function hasExemptLabel(labels) {
  if (!Array.isArray(labels)) return false;
  const exemptSet = new Set(EXEMPT_LABELS);
  for (const label of labels) {
    const name = typeof label === 'string' ? label : (label && label.name);
    if (name && exemptSet.has(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// toMs(value) -> number
//
// Coerce a Date, ISO string, or ms-number to milliseconds since epoch.
// ---------------------------------------------------------------------------

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  return Number(value);
}

// ---------------------------------------------------------------------------
// shouldClose(input) -> {close: boolean, reason: string}
//
// input: { now, labels, challengeComment, laterUserComments, windowHours=DEFAULT_WINDOW_HOURS }
//
// Decision order (returns first match):
//   1. hasExemptLabel(labels)          -> {close:false, reason:'exempt-label'}
//   2. !challengeComment               -> {close:false, reason:'no-challenge-comment'}
//   3. challengeComment.downvoted      -> {close:false, reason:'vetoed'}
//   4. laterUserComments > 0           -> {close:false, reason:'reporter-responded'}
//   5. ageHours < windowHours          -> {close:false, reason:'within-window'}
//   6. else                            -> {close:true,  reason:'duplicate-no-response'}
// ---------------------------------------------------------------------------

function shouldClose(input) {
  const {
    now,
    labels = [],
    challengeComment,
    laterUserComments = 0,
  } = input;
  const windowHours = (input.windowHours != null) ? input.windowHours : DEFAULT_WINDOW_HOURS;

  if (hasExemptLabel(labels)) {
    return { close: false, reason: 'exempt-label' };
  }

  if (!challengeComment) {
    return { close: false, reason: 'no-challenge-comment' };
  }

  if (challengeComment.downvoted) {
    return { close: false, reason: 'vetoed' };
  }

  if (laterUserComments > 0) {
    return { close: false, reason: 'reporter-responded' };
  }

  const nowMs = toMs(now);
  const createdMs = toMs(challengeComment.createdAt);

  if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs)) {
    return { close: false, reason: 'invalid-timestamp' };
  }

  const ageHours = (nowMs - createdMs) / 3600000;

  if (ageHours < windowHours) {
    return { close: false, reason: 'within-window' };
  }

  return { close: true, reason: 'duplicate-no-response' };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
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
};
