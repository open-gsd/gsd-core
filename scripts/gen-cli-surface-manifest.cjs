#!/usr/bin/env node
'use strict';

/**
 * Generates docs/CLI-SURFACE-MANIFEST.json from the CLI surface registry
 * (`src/cli-surface.cts`, compiled to `gsd-core/bin/lib/cli-surface.cjs`) and the
 * command aliases (`gsd-core/bin/lib/command-aliases.cjs`). ADR-4909 D2, #6087.
 *
 * Usage:
 *   node scripts/gen-cli-surface-manifest.cjs                 # print the manifest to stdout
 *   node scripts/gen-cli-surface-manifest.cjs --write          # rewrite the manifest file
 *   node scripts/gen-cli-surface-manifest.cjs --check          # exit 1 if the manifest is missing/stale
 *   node scripts/gen-cli-surface-manifest.cjs --check --json   # machine-readable report
 *   node scripts/gen-cli-surface-manifest.cjs --manifest-path <p>  # test-only: target another file
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_REL = 'docs/CLI-SURFACE-MANIFEST.json';
const MANIFEST_PATH = path.join(ROOT, MANIFEST_REL);
const SURFACE_REL = 'gsd-core/bin/lib/cli-surface.cjs';
const SURFACE_PATH = path.join(ROOT, SURFACE_REL);
const ALIASES_PATH = path.join(ROOT, 'gsd-core/bin/lib/command-aliases.cjs');

const USAGE =
  'Usage: node scripts/gen-cli-surface-manifest.cjs [--write | --check] [--json] [--manifest-path <path>]';

// Each compiled module the manifest reads, beside the source it is built from. The registry
// is read through its compiled form, so a stale compile would write or check a stale manifest.
const COMPILED_PAIRS = [
  { source: path.join(ROOT, 'src/cli-surface.cts'), compiled: SURFACE_PATH },
  {
    source: path.join(ROOT, 'src/command-arg-projection.cts'),
    compiled: path.join(ROOT, 'gsd-core/bin/lib/command-arg-projection.cjs'),
  },
];

/**
 * Whether the compiled file is exactly what the build would emit for the source: true or false,
 * or null when typescript or the build options cannot be loaded (the caller falls back to mtime).
 */
function compiledMatchesSource(source, compiled, loadTypescript) {
  try {
    const ts = loadTypescript();
    const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.build.json'), ts.sys.readFile);
    if (config.error !== undefined) return null;
    // parseJsonConfigFileContent resolves `extends`; 18003 (no input files) is about the include globs, not the options.
    const { options, errors } = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    if (errors.some((e) => e.code !== 18003)) return null;
    const emitted = ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: options, fileName: source });
    return emitted.outputText === fs.readFileSync(compiled, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Why the compiled registry cannot be trusted, or null when it is fresh: a compiled file that
 * is missing, or older than the source beside it, means `npm run build:lib` has not run since
 * the source changed. A source that is not on disk (an installed package) is not checked.
 * Pairs are compared one to one: tsc leaves an unchanged module's output alone, so a source that
 * is newer by mtime only (a checkout, a touch) is judged by content: the source is transpiled
 * with the repo's own typescript and the build options of tsconfig.build.json, and equal to the
 * compiled text means fresh. When typescript cannot be loaded the mtime comparison decides.
 *
 * @param {Array<{source: string, compiled: string}>} [pairs]
 * @param {() => object} [loadTypescript]
 * @returns {string | null}
 */
function staleCompileProblem(pairs = COMPILED_PAIRS, loadTypescript = () => require('typescript')) {
  for (const { source, compiled } of pairs) {
    const rel = (p) => path.relative(ROOT, p) || p;
    if (!fs.existsSync(compiled)) {
      return `compiled artifact not found at ${rel(compiled)}. Run \`npm run build:lib\` first.`;
    }
    if (!fs.existsSync(source)) continue;
    if (fs.statSync(source).mtimeMs > fs.statSync(compiled).mtimeMs) {
      if (compiledMatchesSource(source, compiled, loadTypescript) === true) continue;
      return (
        `${rel(compiled)} is older than ${rel(source)}. Run \`npm run build:lib\` first ` +
        '(if it emits nothing, delete tsconfig.build.tsbuildinfo and run it again).'
      );
    }
  }
  return null;
}

function loadSurface() {
  const problem = staleCompileProblem();
  if (problem !== null) throw new ExitError(2, `gen-cli-surface-manifest: ${problem}`);
  return require(SURFACE_PATH);
}

/** canonical -> sorted, unique aliases, across every `*_COMMAND_ALIASES` array. */
function aliasMap() {
  const mod = require(ALIASES_PATH);
  const collected = new Map();
  for (const [key, value] of Object.entries(mod)) {
    if (!key.endsWith('_COMMAND_ALIASES') || !Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry.canonical !== 'string') continue;
      const set = collected.get(entry.canonical) ?? new Set();
      for (const alias of entry.aliases ?? []) set.add(alias);
      collected.set(entry.canonical, set);
    }
  }
  return new Map([...collected].map(([canonical, set]) => [canonical, [...set].sort()]));
}

const sorted = (list) => [...(list ?? [])].sort();

function flagKinds(spec) {
  const repeatable = new Set(spec.repeatableFlags ?? []);
  const bare = new Set(spec.bareEmptyFlags ?? []);
  const kinds = {};
  for (const f of spec.valueFlags ?? []) {
    kinds[f] = repeatable.has(f) ? 'repeatable' : bare.has(f) ? 'value-or-bare' : 'value';
  }
  for (const f of spec.booleanFlags ?? []) kinds[f] = 'boolean';
  for (const f of spec.optionalValueFlags ?? []) kinds[f] = 'optional-value';
  for (const f of spec.listFlags ?? []) kinds[f] = 'list';
  for (const f of spec.multiwordFlags ?? []) kinds[f] = 'multiword';
  return sortedObject(kinds);
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function buildVerbEntry(verb, spec, aliases) {
  const entry = {
    verb,
    aliases: sorted(aliases.get(verb)),
    positionals: spec.positionals,
    flags: flagKinds(spec),
    required: sorted(spec.requiredFlags),
    workstreamScoped: !!spec.workstreamScoped,
  };
  if (spec.freePositionals) entry.freePositionals = true;
  if (spec.rejectShortFlags) entry.rejectShortFlags = true;
  if ((spec.eqFlags ?? []).length > 0) entry.eq = sorted(spec.eqFlags);
  if ((spec.nonEmptyFlags ?? []).length > 0) entry.nonEmpty = sorted(spec.nonEmptyFlags);
  if ((spec.emptyValueFlags ?? []).length > 0) entry.emptyValue = sorted(spec.emptyValueFlags);
  if ((spec.emptyEqFlags ?? []).length > 0) entry.emptyEq = sorted(spec.emptyEqFlags);
  if (spec.passthroughAfter) entry.passthroughAfter = spec.passthroughAfter;
  if (spec.thirdParty) entry.thirdParty = true;
  return entry;
}

function buildManifest() {
  const { CLI_SURFACE, GLOBAL_FLAGS, UNDECLARED_VERBS } = loadSurface();
  const aliases = aliasMap();
  const flags = {};
  for (const f of GLOBAL_FLAGS.valueFlags ?? []) flags[f] = 'value';
  for (const f of GLOBAL_FLAGS.booleanFlags ?? []) flags[f] = 'boolean';
  const verbs = Object.keys(CLI_SURFACE)
    .sort()
    .map((verb) => buildVerbEntry(verb, CLI_SURFACE[verb], aliases));
  return {
    schema: 1,
    global: {
      flags: sortedObject(flags),
      eq: sorted(GLOBAL_FLAGS.eqFlags),
      help: [...(GLOBAL_FLAGS.helpTokens ?? [])],
      rejected: [...(GLOBAL_FLAGS.rejectedTokens ?? [])],
    },
    verbs,
    undeclared: sorted(UNDECLARED_VERBS),
  };
}

function serialize(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function diffVerbs(expected, actual) {
  const exp = new Map(expected.verbs.map((v) => [v.verb, JSON.stringify(v)]));
  const act = new Map((actual.verbs ?? []).map((v) => [v.verb, JSON.stringify(v)]));
  const added = [...exp.keys()].filter((k) => !act.has(k));
  const removed = [...act.keys()].filter((k) => !exp.has(k));
  const changed = [...exp.keys()].filter((k) => act.has(k) && act.get(k) !== exp.get(k));
  return { added, removed, changed };
}

/**
 * @param {{manifestPath?: string}} [opts]
 * @returns {{ok: boolean, problems: Array<{kind: 'missing'|'stale'|'invalid-json', subject: string, message: string}>}}
 */
function checkReport({ manifestPath = MANIFEST_PATH } = {}) {
  const problems = [];
  if (!fs.existsSync(manifestPath)) {
    problems.push({
      kind: 'missing',
      subject: manifestPath,
      message: `${manifestPath} not found. Run: node scripts/gen-cli-surface-manifest.cjs --write`,
    });
    return { ok: false, problems };
  }
  const text = fs.readFileSync(manifestPath, 'utf8');
  let actual;
  try {
    actual = JSON.parse(text);
  } catch (err) {
    problems.push({
      kind: 'invalid-json',
      subject: manifestPath,
      message: `${manifestPath} is not valid JSON (${err.message}). Run: node scripts/gen-cli-surface-manifest.cjs --write`,
    });
    return { ok: false, problems };
  }
  const expected = buildManifest();
  if (serialize(expected) !== text) {
    const { added, removed, changed } = diffVerbs(expected, actual);
    const parts = [];
    if (added.length) parts.push(`missing verbs: ${added.join(', ')}`);
    if (removed.length) parts.push(`removed verbs: ${removed.join(', ')}`);
    if (changed.length) parts.push(`changed verbs: ${changed.join(', ')}`);
    if (!parts.length) parts.push('global/undeclared sections or formatting differ');
    const subject = [...added, ...removed, ...changed][0] ?? 'global';
    problems.push({
      kind: 'stale',
      subject,
      message: `${manifestPath} is stale (${parts.join('; ')}). Run: node scripts/gen-cli-surface-manifest.cjs --write`,
    });
  }
  return { ok: problems.length === 0, problems };
}

function parseArgs(argv) {
  const opts = { write: false, check: false, json: false, manifestPath: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--manifest-path') {
      const value = argv[i + 1];
      if (value === undefined) throw new ExitError(2, `--manifest-path requires a path argument.\n${USAGE}`);
      opts.manifestPath = path.resolve(value);
      i++;
    } else {
      throw new ExitError(2, `unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (opts.write && opts.check) throw new ExitError(2, `--write and --check are mutually exclusive.\n${USAGE}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.write) {
    const manifest = buildManifest();
    fs.mkdirSync(path.dirname(opts.manifestPath), { recursive: true });
    const tmp = `${opts.manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serialize(manifest), 'utf8');
    fs.renameSync(tmp, opts.manifestPath);
    process.stdout.write(`Wrote ${opts.manifestPath} - ${manifest.verbs.length} verb(s).\n`);
    return 0;
  }

  if (opts.check) {
    const report = checkReport({ manifestPath: opts.manifestPath });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (report.ok) {
      process.stdout.write(`${opts.manifestPath} is up to date.\n`);
    } else {
      for (const p of report.problems) process.stderr.write(`${p.kind}: ${p.subject}: ${p.message}\n`);
    }
    if (!report.ok) throw new ExitError(1);
    return 0;
  }

  process.stdout.write(serialize(buildManifest()));
  return 0;
}

if (require.main === module) runMain(main);

module.exports = { buildManifest, checkReport, serialize, staleCompileProblem, aliasMap, MANIFEST_PATH };
