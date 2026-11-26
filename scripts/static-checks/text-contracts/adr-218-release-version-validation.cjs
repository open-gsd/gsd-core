'use strict';

// ADR-218 release-workflow version validation (#1186): release.yml carries a validate-version job that gates the create, rc
// and finalize jobs (each lists it in `needs`, and it is declared before them), a "Validate version format" step followed by
// the npm "Reject already-published versions" pre-check (an `npm view` call), and at least two `grep -qE` version patterns.
// The behaviour of those patterns (the shipped regex strings run against a boundary table of accepted and rejected versions)
// is not repo text and stays in tests/adr-218-release-version-validation.test.cjs. The job wiring is read from the parsed
// YAML where the old test scanned job headers by text: a job is a key of `jobs`, and a scalar `needs` must equal the job name
// (the old create check accepted any text starting with `needs: validate-version`). Was the structural half of that test.

const { loadLib } = require('./lib/load-lib.cjs');

const WORKFLOW = '.github/workflows/release.yml';
const GATE = 'validate-version';
const GATED_JOBS = ['create', 'rc', 'finalize'];
const FORMAT_STEP = 'Validate version format';
const DUPLICATE_STEP = 'Reject already-published versions';
const MIN_GREP_PATTERNS = 2;
const MAX_NEEDS_SHOWN = 8;
const YAML_LIB_OWNER = 'package.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (ch) => ch !== undefined && /\s/.test(ch);

// The pattern of a `grep -qE` call at `at` (where `grep` starts) and the index after it, or null: the walk of
// /grep\s+-qE\s+(?:'([^']+)'|"([^"]+)")/ anchored at one position.
function grepPatternAt(text, at) {
  let pos = at + 'grep'.length;
  if (!isBlank(text[pos])) return null;
  while (isBlank(text[pos])) pos += 1;
  if (!text.startsWith('-qE', pos)) return null;
  pos += '-qE'.length;
  if (!isBlank(text[pos])) return null;
  while (isBlank(text[pos])) pos += 1;
  const quote = text[pos];
  if (quote !== "'" && quote !== '"') return null;
  const close = text.indexOf(quote, pos + 1);
  if (close === -1 || close === pos + 1) return null;
  return { pattern: text.slice(pos + 1, close), end: close + 1 };
}

// Every `grep -qE '...'` or `grep -qE "..."` pattern, in order: the walk of the global pattern above.
function extractGrepPatterns(text) {
  const found = [];
  let from = 0;
  for (let at = text.indexOf('grep', from); at !== -1; at = text.indexOf('grep', from)) {
    const match = grepPatternAt(text, at);
    if (match === null) {
      from = at + 1;
    } else {
      found.push(match.pattern);
      from = match.end;
    }
  }
  return found;
}

// The `needs` of a job as a list: a scalar is one name, a sequence is its items.
const needsOf = (job) => [].concat(job.needs || []);

// A bounded description of a needs value: YAML anchors can make it a circular list, which JSON.stringify would throw on.
function describeNeeds(needs) {
  if (typeof needs === 'string') return JSON.stringify(needs);
  const name = (value) => (value === null ? 'null' : typeof value === 'object' ? (Array.isArray(value) ? 'a list' : 'an object') : String(value));
  if (Array.isArray(needs)) return `[${needs.slice(0, MAX_NEEDS_SHOWN).map(name).join(', ')}${needs.length > MAX_NEEDS_SHOWN ? `, ... ${needs.length} items` : ''}]`;
  return name(needs);
}

// The parsed workflow, or the reason it cannot be read.
function parse(text, yaml) {
  let workflow;
  try {
    workflow = yaml.load(text);
  } catch (err) {
    return { error: `release.yml is not valid YAML: ${err.message}` };
  }
  return isObject(workflow) && isObject(workflow.jobs) ? { jobs: workflow.jobs } : { error: 'release.yml is not a workflow with a jobs mapping' };
}

module.exports = {
  // The linear walk, exported for the differential property of tests/text-contracts.batch12.test.cjs.
  walkers: { extractGrepPatterns },
  id: 'adr-218-release-version-validation',
  issue: '#1186',
  check(ctx, load = () => require('js-yaml')) {
    // The parser is loaded once: a module that cannot be loaded is one finding of its own, the text checks still run, and only the
    // job wiring that needs the parsed workflow is skipped.
    const loadedYaml = loadLib(load, 'js-yaml');
    const doc = ctx.doc(WORKFLOW);
    let jobs = null;
    if (loadedYaml.error) {
      ctx.fail(YAML_LIB_OWNER, loadedYaml.error);
    } else {
      doc.satisfies((text) => {
        const parsed = parse(text, loadedYaml.lib);
        if (parsed.error) return parsed.error;
        jobs = parsed.jobs;
        return true;
      }, 'release.yml must be a workflow with a jobs mapping');
    }
    doc
      .satisfies((text) => {
        const patterns = extractGrepPatterns(text);
        return patterns.length >= MIN_GREP_PATTERNS || `found ${patterns.length}: ${JSON.stringify(patterns)}`;
      }, `release.yml must contain at least ${MIN_GREP_PATTERNS} leading-zero-aware grep -qE version patterns`)
      .has(DUPLICATE_STEP, `release.yml must contain a step named "${DUPLICATE_STEP}" (ADR-218 Decision #2)`)
      .has('npm view', 'release.yml must contain an `npm view` call for the duplicate-version pre-check (ADR-218 Decision #2)')
      .satisfies((text) => {
        const dupAt = text.indexOf(DUPLICATE_STEP);
        if (dupAt === -1) return true; // the missing step is already one finding
        const formatAt = text.indexOf(FORMAT_STEP);
        if (formatAt === -1) return `no "${FORMAT_STEP}" step`;
        return dupAt > formatAt || `"${DUPLICATE_STEP}" is at offset ${dupAt}, "${FORMAT_STEP}" at ${formatAt}`;
      }, `"${DUPLICATE_STEP}" must appear after "${FORMAT_STEP}": format validation gates before the npm pre-check`);
    if (jobs === null) return;

    const names = Object.keys(jobs);
    const hasGate = names.includes(GATE);
    doc.satisfies(() => hasGate || 'no such job', `release.yml must define a \`${GATE}:\` job (ADR-218 requires it as the gate)`);
    for (const name of GATED_JOBS) {
      const job = jobs[name];
      let problem = null;
      if (!names.includes(name)) problem = 'no such job';
      else if (!isObject(job)) problem = 'the job is not a mapping';
      doc.satisfies(() => problem === null || problem, `release.yml must have a \`${name}:\` job`);
      if (problem === null) {
        doc.satisfies(() => needsOf(job).includes(GATE) || `needs is ${describeNeeds(job.needs)}`,
          `the \`${name}\` job must list ${GATE} in its \`needs:\` (ADR-218 gate must run before ${name})`);
      }
      if (hasGate && names.includes(name)) {
        doc.satisfies(() => names.indexOf(GATE) < names.indexOf(name) || `${GATE} is job ${names.indexOf(GATE)}, ${name} is job ${names.indexOf(name)}`,
          `${GATE} must be declared before the ${name} job in release.yml`);
      }
    }
  },
};
