'use strict';

// PR policy workflows (#1389, #1404, #2331): maintainer-authored PRs are skipped, fork PRs get the verdict on a
// pull_request_target trigger with exactly the one write scope the comment call needs, the verdict sits after the
// comment-posting catch block (read from the comment-stripped code), untrusted text loses its backticks before it is
// echoed, the draft sweep is timer-driven with the same carve-out and message, the issue-link verdict stays a step-level
// `if:` that delegates to the policy module, and auto-backmerge version-only filtering never excludes the lockfile.
// The old test's backmerge behaviour case (it runs the policy module) stays in tests/workflow-maintainer-skip.test.cjs;
// its sanitizer case exercised a helper defined in the test and is dropped (the real sanitizer lines are checked here);
// its ordering-predicate case lives on as a case over the verdict-ordering walk below.
// Every pattern is a linear walk over one file read once. Was tests/workflow-maintainer-skip.test.cjs.

const { LINE_ENDS } = require('./lib/line-ends.cjs');
const { loadLib } = require('./lib/load-lib.cjs');

const CLOSE_DRAFT = '.github/workflows/close-draft-prs.yml';
const SWEEP = '.github/workflows/close-draft-prs-sweep.yml';
const TARGET = '.github/workflows/pr-target-validator.yml';
const TITLE = '.github/workflows/pr-title-validator.yml';
const ISSUE_LINK = '.github/workflows/require-issue-link.yml';
const BACKMERGE = '.github/workflows/auto-backmerge.yml';

const MAINTAINER_SKIP_EXPR = 'contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.pull_request.author_association) == false';
const SANITIZER_TAIL = ').replace(/`/g, "\'")';

const need = (condition, message) => condition || message;
const isSpace = (char) => char !== undefined && /\s/.test(char);
const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);
const skipSpaces = (text, from) => {
  let at = from;
  while (at < text.length && isSpace(text[at])) at += 1;
  return at;
};

// The text between the previous line end (or the start) and `at` is blanks only: `at` begins a key after `^\s*`.
function startsKey(text, at) {
  for (let back = at - 1; back >= 0 && !LINE_ENDS.has(text[back]); back -= 1) {
    if (!isSpace(text[back])) return false;
  }
  return true;
}

// Every index at which `word` occurs and a line holds only blanks before it.
function keyAt(text, key, visit) {
  let at = text.indexOf(key);
  while (at !== -1) {
    if (startsKey(text, at) && visit(at + key.length)) return true;
    at = text.indexOf(key, at + 1);
  }
  return false;
}

// Up to the next line end of `from` holds blanks only (`\s*$`).
function blankToLineEnd(text, from) {
  for (let at = from; at < text.length && !LINE_ENDS.has(text[at]); at += 1) {
    if (!isSpace(text[at])) return false;
  }
  return true;
}

// /^\s*KEY/m: a line starts with the key after blanks.
const hasKeyLine = (text, key) => keyAt(text, key, () => true);

// /^\s*KEY\s*$/m: the key stands alone on its line.
const hasBareKey = (text, key) => keyAt(text, key, (after) => blankToLineEnd(text, after));

// /^\s*SCOPE:\s*write\s*$/m: the scope's write permission (the blanks after the colon may span lines).
const hasWriteScope = (text, scope) => keyAt(text, `${scope}:`, (after) => {
  const at = skipSpaces(text, after);
  return text.startsWith('write', at) && blankToLineEnd(text, at + 5);
});

// /\btry\s*\{/
function hasTryBlock(text) {
  let at = text.indexOf('try');
  while (at !== -1) {
    if (!isWordChar(text[at - 1]) && text[skipSpaces(text, at + 3)] === '{') return true;
    at = text.indexOf('try', at + 1);
  }
  return false;
}

// /catch\s*\(err\)\s*\{[\s\S]*?core\.warning/
function hasCatchWarning(text) {
  const lastWarning = text.lastIndexOf('core.warning');
  if (lastWarning === -1) return false;
  let at = text.indexOf('catch');
  while (at !== -1) {
    const open = skipSpaces(text, at + 5);
    if (text.startsWith('(err)', open)) {
      const brace = skipSpaces(text, open + 5);
      if (text[brace] === '{' && lastWarning > brace) return true;
    }
    at = text.indexOf('catch', at + 1);
  }
  return false;
}

// The workflow without whole-line YAML (`#`) and JS (`//`) comments: positional checks see executable text only.
const codeOnly = (text) => text.split('\n').filter((line) => {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('//');
}).join('\n');

// The verdict call sits after the comment-posting catch block (#2331).
function verdictSurvivesCommentFailure(code) {
  const catchWarning = code.indexOf('Could not post');
  const verdict = code.indexOf('core.setFailed(');
  if (catchWarning === -1 || verdict === -1) return false;
  return verdict > catchWarning;
}

// /const NAME = String\(\w+\)\.replace\(\/`\/g, "'"\)/
function declaresSanitizer(text, name) {
  const head = `const ${name} = String(`;
  let at = text.indexOf(head);
  while (at !== -1) {
    let end = at + head.length;
    while (isWordChar(text[end])) end += 1;
    if (end > at + head.length && text.startsWith(SANITIZER_TAIL, end)) return true;
    at = text.indexOf(head, at + 1);
  }
  return false;
}

// /HEAD\s*TAIL/
function afterBlanks(text, head, tail) {
  let at = text.indexOf(head);
  while (at !== -1) {
    if (text.startsWith(tail, skipSpaces(text, at + head.length))) return true;
    at = text.indexOf(head, at + 1);
  }
  return false;
}

// /!MAINTAINER_ASSOCIATIONS\.has\([^)]*\.author_association\)/: the first `)` after the call ends with the field.
function hasAssociationCheck(text) {
  const head = '!MAINTAINER_ASSOCIATIONS.has(';
  let at = text.indexOf(head);
  while (at !== -1) {
    const close = text.indexOf(')', at + head.length);
    if (close !== -1 && text.slice(at + head.length, close).endsWith('.author_association')) return true;
    at = text.indexOf(head, at + 1);
  }
  return false;
}

// /^\s*pull_request(_target)?:/m
const hasPullRequestTrigger = (text) => hasKeyLine(text, 'pull_request:') || hasKeyLine(text, 'pull_request_target:');

const TRIGGER_FILES = [
  { file: TITLE, name: 'PR title validator', scope: 'pull-requests', otherScope: 'issues', sanitized: 'titleForMarkdown' },
  { file: TARGET, name: 'PR target validator', scope: 'pull-requests', otherScope: 'issues', sanitized: 'headForMarkdown' },
  { file: ISSUE_LINK, name: 'Require issue link', scope: 'issues', otherScope: 'pull-requests', sanitized: null },
];

// The issue-link workflow's job: a finding for each way its shape can differ, never a throw.
function jobProblem(yaml, text) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return `the workflow is not valid YAML: ${err.message}`;
  }
  if (doc === null || typeof doc !== 'object' || doc.jobs === null || typeof doc.jobs !== 'object') return 'the workflow has no jobs mapping';
  const job = doc.jobs['check-issue-link'];
  if (job === null || typeof job !== 'object') return 'the workflow has no check-issue-link job';
  return job.if === undefined ? true : 'the job has an if:';
}

function buildCheck(loadYaml = () => require('js-yaml')) {
  return function check(ctx) {
    const docs = {};
    for (const rel of [CLOSE_DRAFT, SWEEP, TARGET, TITLE, ISSUE_LINK, BACKMERGE]) docs[rel] = ctx.doc(rel);
    const loaded = loadLib(loadYaml, 'js-yaml');

    const draft = docs[CLOSE_DRAFT];
    draft.has('github.event.pull_request.draft == true', 'draft PR auto-close must act on draft PRs')
      .has(MAINTAINER_SKIP_EXPR, 'Expected workflow to include maintainer skip expression');
    docs[TARGET].has(MAINTAINER_SKIP_EXPR, 'Expected workflow to include maintainer skip expression');
    draft.satisfies((text) => need(hasKeyLine(text, 'pull_request_target:'), 'no pull_request_target: line'),
      'draft PR auto-close triggers on pull_request_target so fork PRs cannot bypass it')
      .satisfies((text) => need(!hasBareKey(text, 'pull_request:'), 'a bare pull_request: trigger'),
        'draft PR auto-close must not use the bypassable pull_request trigger');

    for (const { file, name, scope, otherScope, sanitized } of TRIGGER_FILES) {
      const doc = docs[file];
      doc.satisfies((text) => need(hasKeyLine(text, 'pull_request_target:'), 'no pull_request_target: line'),
        `${name} triggers on pull_request_target so fork PRs get the verdict, not a 403`)
        .satisfies((text) => need(!hasBareKey(text, 'pull_request:'), 'a bare pull_request: trigger'),
          `${name} must not use the bare pull_request trigger (a fork's read-only token 403s the comment)`)
        .satisfies((text) => need(hasWriteScope(text, scope), `no ${scope}: write line`),
          `${name} keeps the one write scope its comment call needs`)
        .satisfies((text) => need(!hasWriteScope(text, otherScope), `${otherScope}: write is granted`),
          `${file} does not call a ${otherScope}.* API — do not grant it write on a pull_request_target workflow`)
        .satisfies((text) => need(hasTryBlock(text), 'no try block'), `${name} cannot let a failed comment suppress its verdict: the comment sits in a try`)
        .satisfies((text) => need(hasCatchWarning(text), 'no catch (err) block ending in core.warning'),
          `${name} cannot let a failed comment suppress its verdict: the catch warns`)
        .satisfies((text) => need(verdictSurvivesCommentFailure(codeOnly(text)), 'core.setFailed( is not after the Could not post catch'),
          'core.setFailed must sit AFTER the catch block, not inside the try — otherwise a thrown comment error skips the verdict (#2331)');
      if (sanitized !== null) {
        doc.satisfies((text) => need(declaresSanitizer(text, sanitized), `no const ${sanitized} = String(...).replace(/\`/g, "'")`),
          `${name} strips backticks before echoing untrusted text into the comment`)
          .has(`\\\`\${${sanitized}}`, `${name} renders the sanitized ${sanitized}, never the raw value`);
      }
    }

    const sweep = docs[SWEEP];
    sweep.has('schedule:', 'the draft sweep is timer-driven')
      .satisfies((text) => need(afterBlanks(text, 'cron:', "'0 */6 * * *'"), "no cron: '0 */6 * * *'"), 'the draft sweep runs every six hours')
      .has('workflow_dispatch:', 'the draft sweep has a manual dispatch for testing')
      .satisfies((text) => need(!hasPullRequestTrigger(text), 'a pull_request or pull_request_target trigger'),
        'the draft sweep must not be a fork-triggered event')
      .satisfies((text) => need(sweepWrites(text), 'no permissions: pull-requests: write'),
        'the draft sweep needs a write-capable token to close PRs')
      .has("new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])", 'the draft sweep keeps the maintainer carve-out set')
      .satisfies((text) => need(hasAssociationCheck(text), 'no !MAINTAINER_ASSOCIATIONS.has(...author_association) test'),
        'the draft sweep skips maintainer-authored PRs')
      .has('github.paginate(github.rest.pulls.list', 'the draft sweep paginates over open PRs')
      .satisfies((text) => need(afterBlanks(text, 'state:', "'open'"), "no state: 'open'"), 'the draft sweep lists open PRs')
      .has('pr.draft === true', 'the draft sweep filters to drafts')
      .has('## Draft PRs are not accepted', 'the sweep keeps the policy message of close-draft-prs.yml')
      .has('npm run test:coverage', 'the sweep keeps the coverage instruction of the policy message')
      .has('CONTRIBUTING.md#pull-request-guidelines', 'the sweep keeps the guidelines link of the policy message');

    const link = docs[ISSUE_LINK];
    link.has("if: steps.policy.outputs.ok != 'true'", 'the failing step `if:` is keyed on the policy output and is step-level (#1389)')
      .has('node scripts/require-issue-link-policy.cjs', 'the workflow delegates the verdict to the policy module')
      .has('(closes|fixes|resolves)', 'the bootstrap fallback keeps the legacy closing-keyword grep');
    link.satisfies((text) => {
      if (loaded.error) return loaded.error;
      return jobProblem(loaded.lib, text);
    }, 'a job-level `if:` would report "skipped" on an exempt PR and block branch protection (#1389)');

    docs[BACKMERGE].has("VERSION_STAMP_MANIFESTS='package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json'",
      'auto-backmerge.yml must version-only-filter all version-bearing manifests (incl. marketplace.json #1855)')
      .has(`grep -vE '^[+-][[:space:]]*"version":'`, 'auto-backmerge.yml must filter version-only diffs via the "version" grep')
      .lacks(':(exclude)package-lock.json', 'package-lock.json must not be globally excluded; rely on version-only filtering (#1404)');
  };
}

// `permissions:` then blanks then `pull-requests:` then blanks then `write` (the write keyword after the colon).
function sweepWrites(text) {
  let at = text.indexOf('permissions:');
  while (at !== -1) {
    const key = skipSpaces(text, at + 'permissions:'.length);
    if (key > at + 'permissions:'.length && text.startsWith('pull-requests:', key) && text.startsWith('write', skipSpaces(text, key + 'pull-requests:'.length))) return true;
    at = text.indexOf('permissions:', at + 1);
  }
  return false;
}

module.exports = {
  id: 'workflow-maintainer-skip',
  issue: '#2331',
  walkers: {
    hasKeyLine, hasBareKey, hasWriteScope, hasTryBlock, hasCatchWarning, codeOnly, verdictSurvivesCommentFailure,
    declaresSanitizer, afterBlanks, sweepWrites, hasAssociationCheck, hasPullRequestTrigger, jobProblem, buildCheck,
  },
  check: buildCheck(),
};
