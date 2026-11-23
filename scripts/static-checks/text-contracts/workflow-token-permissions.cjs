'use strict';

// A workflow step that enables GitHub native auto-merge (`gh pr merge --auto`) calls the enablePullRequestAutoMerge
// GraphQL mutation, which needs BOTH `pull-requests: write` and `contents: write` on GITHUB_TOKEN (#5136). A
// `permissions` block resets every unlisted scope to none, so the effective permissions are checked: a job-level
// block replaces the workflow-level one. dependabot-auto-merge.yml must still be found enabling auto-merge, so the
// check cannot go vacuous. The command is found by walking tokens, so no amount of whitespace between `gh`, `pr` and
// `merge` hides it; a workflow that does not parse, or a job or step that is not a mapping, is a finding for that
// file and the other files are still checked. Was tests/workflow-token-permissions.test.cjs.

const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);
const endsWithWord = (token, word) => token.endsWith(word) && (token.length === word.length || !isWordChar(token[token.length - word.length - 1]));
const startsWithWord = (token, word) => token.startsWith(word) && (token.length === word.length || !isWordChar(token[word.length]));

// A wrapped `gh pr merge \` line is one command: the backslash, the newline and the whitespace after it become one space.
function joinWrapped(run) {
  const out = [];
  let carried = null;
  for (const line of run.split('\n')) {
    if (carried !== null && line.trim() === '') continue;
    const text = carried === null ? line : `${carried}${line.trimStart()}`;
    const stripped = text.trimEnd();
    if (stripped.endsWith('\\')) {
      carried = `${stripped.slice(0, -1)} `;
    } else {
      out.push(text);
      carried = null;
    }
  }
  if (carried !== null) out.push(carried);
  return out.join('\n');
}

// The whitespace-separated tokens of a text, each with the line it is on.
function tokensWithLines(text) {
  const tokens = [];
  let line = 0;
  let current = '';
  const flush = () => {
    if (current !== '') tokens.push({ text: current, line });
    current = '';
  };
  for (const ch of text) {
    if (ch === '\n') {
      flush();
      line += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return tokens;
}

// `gh pr merge ... --auto`: three consecutive tokens, then `--auto` on the same line as `merge`.
function enablesAutoMerge(run) {
  const tokens = tokensWithLines(joinWrapped(run));
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (!(endsWithWord(tokens[i].text, 'gh') && tokens[i + 1].text === 'pr' && startsWithWord(tokens[i + 2].text, 'merge'))) continue;
    const mergeLine = tokens[i + 2].line;
    for (let j = i + 3; j < tokens.length && tokens[j].line === mergeLine; j++) {
      if (startsWithWord(tokens[j].text, '--auto')) return true;
    }
  }
  return false;
}

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The jobs of a parsed workflow that enable auto-merge, and what is wrong with the structure.
function autoMergeJobs(workflow) {
  const jobs = [];
  const problems = [];
  if (!isMapping(workflow)) return { jobs, problems: ['the workflow is not a mapping'] };
  if (workflow.jobs === undefined || workflow.jobs === null) return { jobs, problems };
  if (!isMapping(workflow.jobs)) return { jobs, problems: ['jobs is not a mapping'] };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!isMapping(job)) {
      problems.push(`job "${name}" is not a mapping`);
      continue;
    }
    if (job.steps !== undefined && job.steps !== null && !Array.isArray(job.steps)) {
      problems.push(`job "${name}" has steps that are not a list`);
      continue;
    }
    const steps = job.steps || [];
    if (steps.some((step) => !isMapping(step))) problems.push(`job "${name}" has a step that is not a mapping`);
    if (steps.some((step) => isMapping(step) && typeof step.run === 'string' && enablesAutoMerge(step.run))) jobs.push([name, job]);
  }
  return { jobs, problems };
}

// The parsed workflow, or the reason it does not parse.
function parse(text) {
  try {
    return { workflow: require('js-yaml').load(text) };
  } catch (err) {
    return { error: `the workflow does not parse: ${String(err.message).split('\n')[0]}` };
  }
}

// The workflow-level or job-level block, whichever applies; null when neither is declared.
function effectivePermissions(workflow, job) {
  const declared = job.permissions !== undefined ? job.permissions : workflow.permissions;
  return declared === undefined ? null : declared;
}

module.exports = {
  id: 'workflow-token-permissions',
  issue: '#5136',
  check(ctx) {
    ctx.doc('.github/workflows/dependabot-auto-merge.yml').satisfies((text) => {
      const parsed = parse(text);
      if (parsed.error) return parsed.error;
      const found = autoMergeJobs(parsed.workflow);
      if (found.problems.length > 0) return found.problems.join('; ');
      return found.jobs.length === 1 || `found ${found.jobs.length} auto-merge job(s), expected 1`;
    }, 'dependabot-auto-merge.yml must enable auto-merge (guards against the check going vacuous)');

    // The workflows directly under .github/workflows (the test read the directory without descending).
    const files = ctx.list('.github/workflows', '', 'the workflows are what the permissions are checked on')
      .filter((rel) => rel.split('/').length === 3 && /\.ya?ml$/.test(rel));
    for (const rel of files) {
      ctx.doc(rel).satisfies((text) => {
        const parsed = parse(text);
        if (parsed.error) return parsed.error;
        const found = autoMergeJobs(parsed.workflow);
        if (found.problems.length > 0) return found.problems.join('; ');
        for (const [name, job] of found.jobs) {
          const perms = effectivePermissions(parsed.workflow, job);
          if (!perms || typeof perms !== 'object') return `job "${name}" must declare explicit permissions`;
          if (perms.contents !== 'write') return `job "${name}" must grant contents: write (has ${JSON.stringify(perms.contents)})`;
          if (perms['pull-requests'] !== 'write') return `job "${name}" must grant pull-requests: write (has ${JSON.stringify(perms['pull-requests'])})`;
        }
        return true;
      }, 'a workflow must parse and its jobs must be mappings, and a job that enables native auto-merge must grant contents: write and pull-requests: write');
    }
  },
};
