'use strict';

// A workflow step that enables GitHub native auto-merge (`gh pr merge --auto`) calls the enablePullRequestAutoMerge
// GraphQL mutation, which needs BOTH `pull-requests: write` and `contents: write` on GITHUB_TOKEN (#5136). A
// `permissions` block resets every unlisted scope to none, so the effective permissions are checked: a job-level
// block replaces the workflow-level one. dependabot-auto-merge.yml must still be found enabling auto-merge, so the
// check cannot go vacuous. The command is found by walking tokens in linear time, so no amount of whitespace between
// `gh`, `pr` and `merge`, and no quoting of the flag, hides it; a workflow that does not parse (or is empty), or a job
// or step that is not a mapping, is a finding for that file and the other files are still checked.
// Was tests/workflow-token-permissions.test.cjs.

const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);
const startsWithWord = (token, word) => token.startsWith(word) && (token.length === word.length || !isWordChar(token[word.length]));

// True when `--auto` occurs in the text with a non-word character (or the end) after it, wherever it sits (a quoted flag too).
function hasAutoFlag(text) {
  for (let at = text.indexOf('--auto'); at !== -1; at = text.indexOf('--auto', at + 1)) {
    if (!isWordChar(text[at + '--auto'.length])) return true;
  }
  return false;
}

// A wrapped `gh pr merge \` line is one command: the backslash, the newline and the whitespace after it become one
// space. Only the end of the current line is looked at, and the parts are joined once, so the work is linear.
function joinWrapped(run) {
  const out = [];
  let parts = [];
  let carrying = false;
  for (const line of run.split('\n')) {
    if (carrying && line.trim() === '') continue;
    const piece = carrying ? line.trimStart() : line;
    // The backslash must be the last character before the newline (a carriage return before it aside): `\ ` is an escaped space.
    const body = piece.endsWith('\r') ? piece.slice(0, -1) : piece;
    if (body.endsWith('\\')) {
      parts.push(`${body.slice(0, -1)} `);
      carrying = true;
    } else {
      parts.push(piece);
      out.push(parts.join(''));
      parts = [];
      carrying = false;
    }
  }
  if (carrying) out.push(parts.join(''));
  return out.join('\n');
}

// The whitespace-separated tokens of a text (any `\s` character separates, as in the old pattern), each with the
// line it is on; only `\n` ends a line.
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
    } else if (/\s/.test(ch)) {
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
  // autoFrom[j]: a `--auto` flag in token j or in a later token on the same line, computed once from the end.
  const autoFrom = new Array(tokens.length + 1).fill(false);
  for (let j = tokens.length - 1; j >= 0; j--) {
    const sameLineNext = j + 1 < tokens.length && tokens[j + 1].line === tokens[j].line;
    autoFrom[j] = hasAutoFlag(tokens[j].text) || (sameLineNext && autoFrom[j + 1]);
  }
  for (let i = 0; i + 2 < tokens.length; i++) {
    // The old pattern had no boundary before `gh`: any token that ends with it (xgh, my_gh, /usr/bin/gh) counts.
    if (!(tokens[i].text.endsWith('gh') && tokens[i + 1].text === 'pr' && startsWithWord(tokens[i + 2].text, 'merge'))) continue;
    // `--auto` glued to `merge` itself, or in a later token of the same line.
    if (hasAutoFlag(tokens[i + 2].text.slice('merge'.length))) return true;
    if (i + 3 < tokens.length && tokens[i + 3].line === tokens[i + 2].line && autoFrom[i + 3]) return true;
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
