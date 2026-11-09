#!/usr/bin/env node
'use strict';

/**
 * Reproduces the CI figures in tests/helpers/timeouts.cjs TIMEOUT_EVIDENCE (the entries sourced
 * from CI_SOURCE / CI_WINDOW) from data that lives in the repo and in downloaded CI artifacts.
 *
 * READS
 *   --artifacts <dir>  A directory of downloaded `test-timings-<os>-job<N>` artifacts laid out as
 *                      <dir>/<runId>/<artifactName>/*.jsonl or <dir>/<runId>/*.jsonl (the lane's
 *                      os is read from the artifact folder name, else the file name: ubuntu =
 *                      linux, windows = win32, macos = darwin; an undeterminable os, or no lane
 *                      file at all, exits 2). Each
 *                      jsonl line of type `seam:spawn-stall` is one record (file, command, argv,
 *                      durationMs, timeoutMs, startedAt); each `test:summary` line names a test
 *                      file the lane ran.
 *   --repo <root>      The checkout whose tests/**\/*.cjs are scanned (default: this script's
 *                      repo root). tests/helpers/timeouts.cjs of that checkout supplies the
 *                      constant names and values.
 *
 * DOES
 *   1. Census: parses every tests/**\/*.cjs with espree and records each `timeout` / `timeoutMs`
 *      object property whose value references a timeouts.cjs export.
 *   2. Classification: decides per call site whether the call is routed through
 *      tests/helpers/process-seam.cjs (SEAM, visible to the CI spawn log) or calls child_process
 *      directly (DIRECT, invisible). The callee binding is resolved in its own file and through
 *      relative requires; sites the resolver cannot resolve use MANUAL_RESOLUTIONS below.
 *   3. Attribution: each seam:spawn-stall record is credited to a constant when the record's
 *      test file (or a helper it requires, only if the file has no in-file candidate) has a seam
 *      site of a constant whose value equals the record's timeoutMs and whose callee is
 *      compatible with the record's command. A site reached only through a helper must also show
 *      one of its own string literals (3+ characters, not a flag) in the record's argv when it
 *      has any; records failing either test are unmatched. Remaining ties are narrowed by argv
 *      literals; a record still matching two constants is ambiguous and credited to neither.
 *   4. Summary per constant: p50 / p99 / max / samples per platform, worst platform, lanes that
 *      ran the constant's seam sites, seam and raw site counts, ambiguous record count.
 *
 * PRINTS (stdout only; no file is written)
 *   --format json (default)  the full evidence object
 *   --format md              the same figures as markdown tables
 *   --raw-sites              the non-seam call sites grouped by constant, one
 *                            `- [ ] tests/x.test.cjs:LINE (CONSTANT)` line per site
 *
 * DOWNLOADING IS A SEPARATE STEP. This script never talks to GitHub. Fetch the artifacts first,
 * for example: list successful test.yml runs of the push and merge_group events created after the
 * window start (`gh run list --workflow test.yml --event push --status success --limit 400
 * --json databaseId,createdAt`), then per run id
 * `gh run download <id> --pattern 'test-timings-*' --dir <dir>/<id>`; with several matching artifacts gh creates one
 * `<dir>/<id>/<artifactName>/` folder per artifact, with a single match it extracts straight into
 * `<dir>/<id>/`; both layouts are read here. Expired
 * artifacts cannot be downloaded and are skipped.
 *
 * Exported functions are pure (filesystem access goes through a `view` object) so tests can feed
 * synthetic inputs.
 */

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const PLATFORMS = ['win32', 'darwin', 'linux'];
const SPAWN_CALLS = new Set(['execFileSync', 'spawnSync', 'execSync', 'spawn', 'execFile', 'exec']);
const TIMEOUTS_REL = 'tests/helpers/timeouts.cjs';

// Constants whose evidence comes from the local harness, not from CI records.
const HARNESS_ONLY = new Set(['SCAN_USAGE_ERROR_TIMEOUT_MS', 'MALFORMED_INPUT_HOOK_TIMEOUT_MS', 'REAL_REPO_GIT_TIMEOUT_MS']);

/**
 * CI records carry the timeoutMs the tested commit used, not the value at the checkout being
 * measured. A constant whose value changed after the CI window lists the values it had during the
 * window here, so those records still reach it (and are narrowed against the other constants that
 * share the value by command and argv, exactly as when the values are equal).
 * LOOP_HOOK_POINT_CLI_TIMEOUT_MS was 60000 in the window; runGsdTools (tests/helpers.cjs) ran at
 * the process seam's 60000 fallback then and is bound to this constant (now 80000) at HEAD.
 */
const HISTORICAL_VALUES = { LOOP_HOOK_POINT_CLI_TIMEOUT_MS: [60000] };

/**
 * Sites the callee resolver cannot classify, resolved by reading the source. An entry applies to
 * every census site in `file` whose census callee text equals `callee` (a bare callee name, or
 * `(not-direct-arg)` plus ` var=<name>` when the options object is held in a variable). The
 * resolution replaces the AST result for those sites. Sites left unresolved and entries that
 * match nothing are reported in the output (`unresolvedSites`, `unusedResolutions`).
 */
const GIT_OR_THROW = 'tests/helpers/git-fixture.cjs gitOrThrow forwards options.timeoutMs to runGit (process seam)';
const MANUAL_RESOLUTIONS = [
  { file: 'tests/commit-docs-bypass.test.cjs', callee: 'gitOrThrow', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: GIT_OR_THROW },
  { file: 'tests/gsd-statusline.test.cjs', callee: 'gitOrThrow', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: GIT_OR_THROW },
  { file: 'tests/worktree-cleanup.test.cjs', callee: 'gitOrThrow', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: GIT_OR_THROW },
  { file: 'tests/fixtures/index.cjs', callee: '(not-direct-arg) var=gitOpts', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: 'gitOpts variable is passed to gitOrThrow' },
  { file: 'tests/gsd-agent-isolation-guard.test.cjs', callee: '(not-direct-arg) var=gitOpts', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: 'gitOpts variable is passed to gitOrThrow' },
  { file: 'tests/state.test.cjs', callee: '(not-direct-arg) var=gitOpts', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: 'gitOpts variable is passed to gitOrThrow' },
  { file: 'tests/verification-status.test.cjs', callee: '(not-direct-arg) var=gitOpts', cls: 'SEAM', resolvedCallee: 'gitOrThrow', note: 'gitOpts variable is passed to gitOrThrow' },
  { file: 'tests/hooks-crash-policy.test.cjs', callee: '(not-direct-arg)', cls: 'SEAM', resolvedCallee: 'runHookSeam', note: 'default parameter of runHook, forwarded as opts.timeoutMs to runHookSeam' },
  { file: 'tests/lint-compiled-artifact-sync.test.cjs', callee: '(not-direct-arg) var=options', cls: 'SEAM', resolvedCallee: 'runGit|runNode', note: 'run() helper forwards options to runGit / runNode' },
  { file: 'tests/install-regressions.test.cjs', callee: '(not-direct-arg) var=runOpts', cls: 'SEAM', resolvedCallee: 'runNode', note: 'runOpts is passed to runNode' },
  { file: 'tests/install-regressions.test.cjs', callee: '(not-direct-arg)', cls: 'SEAM', resolvedCallee: 'runNode', note: 'nested options object is passed to runNode' },
  { file: 'tests/helpers/opencode-real.cjs', callee: '(not-direct-arg)', cls: 'DIRECT', resolvedCallee: 'spawn', note: 'realRun default timeoutMs is passed to child_process spawn as {timeout}' },
  { file: 'tests/loop-walk.qa.test.cjs', callee: 'execFileAsync', cls: 'DIRECT', resolvedCallee: 'execFileAsync', note: 'execFileAsync = promisify(execFile) from child_process' },
  { file: 'tests/review-lane-availability.test.cjs', callee: 'run', cls: 'DIRECT', resolvedCallee: 'run', note: 'run = promisify(execFile) from child_process' },
  { file: 'tests/review-lane-no-redirect-5433.test.cjs', callee: 'run', cls: 'DIRECT', resolvedCallee: 'run', note: 'run = promisify(execFile) from child_process' },
  { file: 'tests/criterion-replay.test.cjs', callee: 'projection.execArgvQuarantined', cls: 'DIRECT', resolvedCallee: 'execArgvQuarantined', note: 'src/shell-command-projection.cts execArgvQuarantined calls childProcess.spawnSync directly' },
];

// ---------------------------------------------------------------------------------------------
// Constants taken from timeouts.cjs

/**
 * Splits timeouts.cjs exports into the census set (every export that can bound a spawn or
 * a test: kinds measured, mirror, test-backstop) and the evidence set (measured and mirror).
 * Fixture-data exports are not timeouts and are excluded from both.
 */
function constantsFromTimeouts(T) {
  const ev = T.TIMEOUT_EVIDENCE || {};
  const values = {};
  const censusNames = [];
  const evidenceNames = [];
  for (const [name, entry] of Object.entries(ev)) {
    if (entry.kind === 'fixture-data') continue;
    values[name] = T[name];
    censusNames.push(name);
    if (entry.kind === 'measured' || entry.kind === 'mirror') evidenceNames.push(name);
  }
  return { values, censusNames, evidenceNames };
}

// ---------------------------------------------------------------------------------------------
// Census

function parseSource(src) {
  const base = { ecmaVersion: 'latest', loc: true };
  try { return espree.parse(src, { ...base, sourceType: 'commonjs' }); } catch { return espree.parse(src, { ...base, sourceType: 'module' }); }
}

function keyName(p) {
  if (p.computed) return null;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'Literal') return String(p.key.value);
  return null;
}

function calleeText(c) {
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const o = c.object.type === 'Identifier' ? c.object.name : c.object.type === 'ThisExpression' ? 'this' : (calleeText(c.object) || '?');
    const pr = c.computed ? '[computed]' : (c.property.name || String(c.property.value));
    return o + '.' + pr;
  }
  if (c.type === 'CallExpression') return calleeText(c.callee) + '()';
  return c.type;
}

function childNodes(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x); } else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

function refsIn(node, names, found) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier' && names.has(node.name)) found.push(node.name);
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && names.has(node.property.name)) {
    found.push(node.property.name);
    refsIn(node.object, names, found);
    return;
  }
  for (const c of childNodes(node)) refsIn(c, names, found);
}

/**
 * Census of one source string: every `timeout` / `timeoutMs` property whose value references one
 * of `names`, and every file-local redefinition of one of `names`.
 * @returns {{propRows: object[], localRedefs: object[], parseError: string|null}}
 */
function censusSource(src, rel, names) {
  const nameSet = names instanceof Set ? names : new Set(names);
  let ast;
  try { ast = parseSource(src); } catch (e) { return { propRows: [], localRedefs: [], parseError: e.message }; }
  const propRows = [];
  const localRedefs = [];
  const isRequire = (init) => init && ((init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require') ||
    (init.type === 'MemberExpression' && init.object.type === 'CallExpression' && init.object.callee.type === 'Identifier' && init.object.callee.name === 'require'));
  function walk(node, anc) {
    if (node.type === 'Property') {
      const kn = keyName(node);
      if (kn === 'timeout' || kn === 'timeoutMs') {
        const found = [];
        refsIn(node.value, nameSet, found);
        if (found.length) {
          const obj = anc[anc.length - 1];
          const holder = anc[anc.length - 2];
          let callee;
          if (holder && (holder.type === 'CallExpression' || holder.type === 'NewExpression') && holder.arguments.includes(obj)) {
            callee = calleeText(holder.callee);
          } else {
            callee = '(not-direct-arg)';
            if (holder && holder.type === 'VariableDeclarator' && holder.id.type === 'Identifier') callee += ' var=' + holder.id.name;
          }
          propRows.push({ file: rel, line: node.loc.start.line, constants: [...new Set(found)], callee, valueIsBare: node.value.type === 'Identifier' && nameSet.has(node.value.name) });
        }
      }
    }
    if (node.type === 'VariableDeclarator') {
      const check = (nameNode, line) => {
        if (nameNode && nameNode.type === 'Identifier' && nameSet.has(nameNode.name) && !isRequire(node.init)) {
          localRedefs.push({ file: rel, line, name: nameNode.name, initType: node.init ? node.init.type : null });
        }
      };
      if (node.id.type === 'Identifier') check(node.id, node.loc.start.line);
      else if (node.id.type === 'ObjectPattern') {
        for (const p of node.id.properties) if (p.type === 'Property') check(p.value.type === 'AssignmentPattern' ? p.value.left : p.value, p.loc.start.line);
      }
    }
    anc.push(node);
    for (const c of childNodes(node)) walk(c, anc);
    anc.pop();
  }
  walk(ast, []);
  return { propRows, localRedefs, parseError: null };
}

/** Census of every file the view lists under tests/ (timeouts.cjs itself excluded). */
function censusRepo(view, names) {
  const nameSet = new Set(names);
  const files = view.listFiles().filter((f) => f !== TIMEOUTS_REL).sort();
  const propRows = [];
  const localRedefs = [];
  const parseFailures = [];
  for (const rel of files) {
    const r = censusSource(view.read(rel) || '', rel, nameSet);
    if (r.parseError) { parseFailures.push({ file: rel, error: r.parseError }); continue; }
    propRows.push(...r.propRows);
    localRedefs.push(...r.localRedefs);
  }
  return { fileCount: files.length, parseFailures, propRows, localRedefs };
}

// ---------------------------------------------------------------------------------------------
// Seam vs raw classification

function requiredModule(x) {
  if (!x) return null;
  if (x.type === 'CallExpression' && x.callee.type === 'Identifier' && x.callee.name === 'require' && x.arguments[0] && x.arguments[0].type === 'Literal') return String(x.arguments[0].value);
  if (x.type === 'MemberExpression') return requiredModule(x.object);
  return null;
}

function resolveRelative(fromRel, mod) {
  if (!mod.startsWith('.')) return { builtin: mod };
  let p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), mod));
  if (!/\.(c?js|json)$/.test(p)) p += '.cjs';
  return { rel: p };
}

function modKind(mod) {
  if (mod === 'child_process' || mod === 'node:child_process') return 'cp';
  if (/process-seam(\.cjs)?$/.test(mod)) return 'seam';
  return null;
}

function collectBindings(ast) {
  const bindings = {};
  const add = (name, b) => { (bindings[name] = bindings[name] || []).push(b); };
  (function collect(n) {
    if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name, { kind: 'fn', node: n, line: n.loc.start.line });
    if (n.type === 'VariableDeclarator') {
      const init = n.init;
      if (n.id.type === 'Identifier') {
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) add(n.id.name, { kind: 'fn', node: init, line: n.loc.start.line });
        else {
          const r = requiredModule(init);
          if (r) {
            const prop = init.type === 'MemberExpression' && !init.computed ? init.property.name : null;
            add(n.id.name, { kind: 'req', mod: r, prop, line: n.loc.start.line });
          } else if (init && init.type === 'MemberExpression' && init.object.type === 'Identifier') {
            add(n.id.name, { kind: 'alias', obj: init.object.name, prop: init.property.name, line: n.loc.start.line });
          } else if (init && init.type === 'Identifier') {
            add(n.id.name, { kind: 'idalias', to: init.name, line: n.loc.start.line });
          }
        }
      } else if (n.id.type === 'ObjectPattern') {
        const r = requiredModule(init);
        for (const p of n.id.properties) {
          if (p.type !== 'Property' || p.key.type !== 'Identifier') continue;
          const local = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
          if (local.type !== 'Identifier') continue;
          if (r) add(local.name, { kind: 'req', mod: r, prop: p.key.name, line: p.loc.start.line });
          else if (init && init.type === 'Identifier') add(local.name, { kind: 'alias', obj: init.name, prop: p.key.name, line: p.loc.start.line });
        }
      }
    }
    for (const c of childNodes(n)) collect(c);
  })(ast);
  return bindings;
}

function bodyCalls(fnNode) {
  const calls = [];
  (function w(n) {
    if (n.type === 'CallExpression') calls.push(n);
    for (const c of childNodes(n)) w(c);
  })(fnNode.body);
  return calls;
}

/**
 * Builds a classifier for callee names over `view`. classify(row) returns
 * {cls: SEAM|DIRECT|MIXED|NONE|UNKNOWN|UNCLASSIFIED, ev}.
 */
function createClassifier(view) {
  const cache = {};
  function load(rel) {
    if (cache[rel]) return cache[rel];
    const src = view.read(rel);
    if (src === null) throw new Error('cannot read ' + rel);
    const ast = parseSource(src);
    return (cache[rel] = { rel, ast, bindings: collectBindings(ast) });
  }
  function classifyName(rel, name, depth, seen) {
    if (depth > 4) return { cls: 'UNKNOWN', ev: 'depth' };
    const key = rel + '::' + name;
    if (seen.has(key)) return { cls: 'UNKNOWN', ev: 'cycle' };
    seen.add(key);
    const f = load(rel);
    const bs = f.bindings[name];
    if (!bs) {
      if (SPAWN_CALLS.has(name)) return { cls: 'DIRECT', ev: `${rel}: bare ${name} (no binding; assumed child_process global)` };
      return { cls: 'UNKNOWN', ev: `${rel}: no binding for ${name}` };
    }
    const results = [];
    for (const b of bs) {
      if (b.kind === 'req') {
        const mk = modKind(b.mod);
        if (mk === 'cp') results.push({ cls: 'DIRECT', ev: `${rel}:${b.line} ${name} from require('${b.mod}')` });
        else if (mk === 'seam') results.push({ cls: 'SEAM', ev: `${rel}:${b.line} ${name} from require('${b.mod}')` });
        else {
          const r = resolveRelative(rel, b.mod);
          if (r.rel && b.prop && view.read(r.rel) !== null) {
            const sub = classifyName(r.rel, b.prop, depth + 1, seen);
            results.push({ cls: sub.cls, ev: `${rel}:${b.line} ${name}<-${b.mod}; ${sub.ev}` });
          } else results.push({ cls: 'UNKNOWN', ev: `${rel}:${b.line} ${name} from ${b.mod}` });
        }
      } else if (b.kind === 'alias') {
        const sub = classifyMember(rel, b.obj, b.prop, depth + 1, seen);
        results.push({ cls: sub.cls, ev: `${rel}:${b.line} ${name}=${b.obj}.${b.prop}; ${sub.ev}` });
      } else if (b.kind === 'idalias') {
        const sub = classifyName(rel, b.to, depth + 1, seen);
        results.push({ cls: sub.cls, ev: `${rel}:${b.line} ${name}=${b.to}; ${sub.ev}` });
      } else if (b.kind === 'fn') {
        const subs = [];
        for (const c of bodyCalls(b.node)) {
          let r = null;
          if (c.callee.type === 'Identifier' && c.callee.name !== name) r = classifyName(rel, c.callee.name, depth + 1, new Set(seen));
          else if (c.callee.type === 'MemberExpression' && c.callee.object.type === 'Identifier' && !c.callee.computed) r = classifyMember(rel, c.callee.object.name, c.callee.property.name, depth + 1, new Set(seen));
          else if (c.callee.type === 'MemberExpression' && c.callee.object.type === 'CallExpression' && !c.callee.computed) r = classifyMember(rel, null, c.callee.property.name, depth + 1, new Set(seen), c.callee.object);
          if (r && (r.cls === 'SEAM' || r.cls === 'DIRECT')) subs.push({ ...r, line: c.loc.start.line });
        }
        if (!subs.length) results.push({ cls: 'NONE', ev: `${rel}:${b.line} fn ${name} body has no seam/child_process call` });
        else {
          const set = new Set(subs.map((s) => s.cls));
          const cls = set.size > 1 ? 'MIXED' : subs[0].cls;
          results.push({ cls, ev: `${rel}:${b.line} fn ${name} -> ${subs.map((s) => s.cls + '@' + s.line + ' ' + s.ev).join(' | ').slice(0, 300)}` });
        }
      }
    }
    const set = new Set(results.map((r) => r.cls));
    return { cls: set.size === 1 ? results[0].cls : 'MIXED', ev: results.map((r) => r.ev).join(' || ') };
  }
  function classifyMember(rel, objName, prop, depth, seen, objNode) {
    if (SPAWN_CALLS.has(prop) && objName && /^(cp|childProcess|child_process|cpMod)$/.test(objName)) return { cls: 'DIRECT', ev: `${objName}.${prop}` };
    if (objNode) {
      if (objNode.type === 'CallExpression' && objNode.callee.type === 'Identifier' && objNode.callee.name === 'require' && objNode.arguments[0]) {
        const mod = String(objNode.arguments[0].value);
        const mk = modKind(mod);
        if (mk === 'cp') return { cls: 'DIRECT', ev: `require('${mod}').${prop}` };
        if (mk === 'seam') return { cls: 'SEAM', ev: `require('${mod}').${prop}` };
      }
      return { cls: 'UNKNOWN', ev: `call-obj.${prop}` };
    }
    const f = load(rel);
    for (const b of f.bindings[objName] || []) {
      if (b.kind === 'req' && !b.prop) {
        const mk = modKind(b.mod);
        if (mk === 'cp') return { cls: 'DIRECT', ev: `${rel}:${b.line} ${objName}=require('${b.mod}').${prop}` };
        if (mk === 'seam') return { cls: 'SEAM', ev: `${rel}:${b.line} ${objName}=require('${b.mod}').${prop}` };
        const r = resolveRelative(rel, b.mod);
        if (r.rel && view.read(r.rel) !== null) return classifyName(r.rel, prop, depth + 1, seen);
      }
    }
    if (SPAWN_CALLS.has(prop)) return { cls: 'DIRECT', ev: `${objName}.${prop} (unbound object, child_process method name)` };
    return { cls: 'UNKNOWN', ev: `${objName}.${prop} unresolved` };
  }
  function classify(row) {
    const c = row.callee;
    if (c === 'test') return { cls: 'NONE', ev: `${row.file}: test(name,{timeout}) node:test runner option` };
    if (c.startsWith('(not-direct-arg)')) return { cls: 'UNCLASSIFIED', ev: 'options object not a direct call argument' };
    if (c.endsWith('()')) return { cls: 'UNKNOWN', ev: 'call-chain callee' };
    if (/^require\(\)\./.test(c)) {
      const prop = c.split('.')[1];
      let found = null;
      (function w(n) {
        if (found) return;
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'CallExpression' && n.callee.object.callee.name === 'require' && n.callee.property.name === prop && n.loc.start.line <= row.line && n.loc.end.line >= row.line) found = n;
        for (const ch of childNodes(n)) w(ch);
      })(load(row.file).ast);
      if (found) return classifyMember(row.file, null, prop, 0, new Set(), found.callee.object);
      return { cls: 'UNKNOWN', ev: 'require() inline callee not located' };
    }
    if (c.includes('.')) {
      const parts = c.split('.');
      const p = parts.pop();
      return classifyMember(row.file, parts.join('.'), p, 0, new Set());
    }
    return classifyName(row.file, c, 0, new Set());
  }
  return { classify };
}

/**
 * Turns census rows into call sites: classify once per (file, callee text), apply manual
 * resolutions, drop sites of file-local redefinitions and node:test runner options.
 */
function buildSites({ propRows, localRedefs }, classifier, resolutions = MANUAL_RESOLUTIONS) {
  const classmap = new Map();
  const used = new Set();
  const sites = [];
  const dropped = [];
  for (const r of propRows) {
    const key = r.file + '\t' + r.callee;
    if (!classmap.has(key)) classmap.set(key, classifier.classify(r));
    const m = classmap.get(key);
    const ovIdx = resolutions.findIndex((o) => o.file === r.file && o.callee === r.callee);
    const ov = ovIdx >= 0 ? resolutions[ovIdx] : null;
    if (ov) used.add(ovIdx);
    const cls = ov ? ov.cls : m.cls;
    const base = { file: r.file, line: r.line, constants: r.constants, callee: ov ? ov.resolvedCallee : r.callee, cls, via: ov ? 'manual:' + ov.note : 'ast' };
    const redef = localRedefs.filter((x) => x.file === r.file && r.constants.includes(x.name));
    if (redef.length) { dropped.push({ ...base, why: 'file-local redefinition at line ' + redef[0].line }); continue; }
    if (cls === 'NONE') { dropped.push({ ...base, why: 'node:test runner option, not a spawn' }); continue; }
    sites.push(base);
  }
  return {
    sites,
    dropped,
    unresolvedSites: sites.filter((s) => s.cls !== 'SEAM' && s.cls !== 'DIRECT'),
    unusedResolutions: resolutions.filter((_, i) => !used.has(i)),
  };
}

// ---------------------------------------------------------------------------------------------
// Attribution

const baseName = (s) => String(s).split(/[\\/]/).pop();
const osOfArtifact = (name) => (/ubuntu/.test(name) ? 'linux' : /windows/.test(name) ? 'win32' : /macos/.test(name) ? 'darwin' : 'other');

/** Parses one lane jsonl text into its stall records and the test files it ran; `skippedLines` counts lines that name a record type but are not valid JSON. */
function parseLane(text, meta) {
  const lane = { os: meta.os, runId: meta.runId, art: meta.art, stalls: [], files: new Set(), skippedLines: 0, startedMin: null, startedMax: null };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j;
    if (line.includes('seam:spawn-stall')) {
      try { j = JSON.parse(line); } catch { lane.skippedLines++; continue; }
      if (j.type === 'seam:spawn-stall') {
        lane.stalls.push(j);
        if (j.startedAt) {
          if (!lane.startedMin || j.startedAt < lane.startedMin) lane.startedMin = j.startedAt;
          if (!lane.startedMax || j.startedAt > lane.startedMax) lane.startedMax = j.startedAt;
        }
      }
    } else if (line.includes('test:summary')) {
      try { j = JSON.parse(line); } catch { lane.skippedLines++; continue; }
      if (j.type === 'test:summary' && j.data && j.data.file) lane.files.add(baseName(j.data.file));
    }
  }
  return lane;
}

/** Percentile of an ascending-sorted list (nearest rank); null for an empty list. */
function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] : null;
}

/** {records, p50, p99, max} of a list of durations in any order. */
function summarizeDurations(durations) {
  const d = durations.slice().sort((a, b) => a - b);
  return { records: d.length, p50: percentile(d, 50), p99: percentile(d, 99), max: d.length ? d[d.length - 1] : null };
}

/** Lazy per-file AST access, relative-require closures and site shapes over `view`. */
function createRepoIndex(view) {
  const astCache = new Map();
  function fileAst(rel) {
    if (!astCache.has(rel)) {
      const ast = parseSource(view.read(rel));
      const consts = {};
      (function w(n) {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) consts[n.id.name] = n.init;
        for (const c of childNodes(n)) w(c);
      })(ast);
      astCache.set(rel, { ast, consts });
    }
    return astCache.get(rel);
  }
  function literalsOf(node, consts, depth, out) {
    if (!node || typeof node.type !== 'string' || depth > 3) return;
    if (node.type === 'Literal' && typeof node.value === 'string') out.add(node.value);
    else if (node.type === 'TemplateLiteral') node.quasis.forEach((q) => q.value.cooked && out.add(q.value.cooked));
    else if (node.type === 'Identifier' && consts[node.name]) literalsOf(consts[node.name], consts, depth + 1, out);
    else if (node.type === 'ObjectExpression') return;
    else for (const c of childNodes(node)) literalsOf(c, consts, depth + 1, out);
  }
  const calleeName = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '');
  const shapeCache = new Map();
  /** The innermost call around a site: its callee name and the string literals of its arguments. */
  function siteShape(s) {
    const key = s.file + ':' + s.line;
    if (shapeCache.has(key)) return shapeCache.get(key);
    const { ast, consts } = fileAst(s.file);
    let best = null;
    (function w(n) {
      if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.loc.start.line <= s.line && n.loc.end.line >= s.line) {
        if (!best || n.loc.start.line > best.loc.start.line || (n.loc.start.line === best.loc.start.line && (n.end - n.start) < (best.end - best.start))) best = n;
      }
      for (const c of childNodes(n)) w(c);
    })(ast);
    const lits = new Set();
    let name = s.callee;
    if (best) { name = calleeName(best.callee) || s.callee; for (const a of best.arguments) literalsOf(a, consts, 0, lits); }
    const shape = { callee: name, lits: [...lits].filter(isDistinctiveLiteral) };
    shapeCache.set(key, shape);
    return shape;
  }
  const reqCache = {};
  function relRequires(rel) {
    if (reqCache[rel]) return reqCache[rel];
    const out = new Set();
    let ast;
    try { ast = fileAst(rel).ast; } catch { return (reqCache[rel] = out); }
    (function w(n) {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0] && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string' && n.arguments[0].value.startsWith('.')) {
        const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), n.arguments[0].value));
        for (const t of [p, p + '.cjs', p + '.js', path.posix.join(p, 'index.cjs')]) {
          if (t.startsWith('tests/') && view.read(t) !== null) { out.add(t); break; }
        }
      }
      for (const c of childNodes(n)) w(c);
    })(ast);
    return (reqCache[rel] = out);
  }
  const closureCache = {};
  /** Every tests/ file reachable from `testRel` through relative requires. */
  function helperClosure(testRel) {
    if (closureCache[testRel]) return closureCache[testRel];
    const seen = new Set();
    const q = [testRel];
    while (q.length) { const f = q.pop(); for (const r of relRequires(f)) if (!seen.has(r)) { seen.add(r); q.push(r); } }
    return (closureCache[testRel] = seen);
  }
  const testsByBase = {};
  for (const f of view.listFiles()) (testsByBase[baseName(f)] = testsByBase[baseName(f)] || []).push(f);
  return { fileAst, siteShape, helperClosure, testsByBase };
}

/** A site literal that can tell two sites apart in argv: at least 3 characters and not a flag. */
function isDistinctiveLiteral(x) {
  return x.length >= 3 && !x.startsWith('-');
}

function cmdCompatible(callee, command) {
  const c = baseName(command || '').replace(/\.exe$/i, '');
  const n = callee.toLowerCase();
  if (/git/.test(n)) return c === 'git';
  if (/runnode|installrun|node/.test(n) && !/hook/.test(n)) return c === 'node';
  // Hook runners spawn node, bash, sh, python and others: any command is compatible.
  if (/hook/.test(n)) return true;
  return true;
}

/**
 * Credits each stall record to one constant, or to none.
 * @param lanes parsed lanes
 * @param ctx {sites, values, index, historicalValues} `historicalValues` maps a constant to
 *   extra timeoutMs values that count as that constant (see HISTORICAL_VALUES).
 */
function attributeRecords(lanes, { sites, values, index, historicalValues = {} }) {
  const hasValue = (c, ms) => values[c] === ms || (historicalValues[c] || []).includes(ms);
  const seamSites = sites.filter((s) => s.cls === 'SEAM');
  const seamByFile = {};
  const seamByRel = {};
  for (const s of seamSites) {
    (seamByFile[baseName(s.file)] = seamByFile[baseName(s.file)] || []).push(s);
    (seamByRel[s.file] = seamByRel[s.file] || []).push(s);
  }
  const helperSitesFor = (fileBase) => {
    const out = [];
    for (const rel of index.testsByBase[fileBase] || []) {
      for (const h of index.helperClosure(rel)) if (!/\.test\.cjs$/.test(h)) for (const s of seamByRel[h] || []) out.push(s);
    }
    return out;
  };
  const credited = {};
  const ambiguous = [];
  const unmatched = [];
  let total = 0;
  let narrowed = 0;
  let viaHelper = 0;
  for (const lane of lanes) {
    for (const j of lane.stalls) {
      total++;
      const rec = { os: lane.os, runId: lane.runId, file: j.file, command: j.command, argv: j.argv || [], durationMs: j.durationMs, timeoutMs: j.timeoutMs, startedAt: j.startedAt };
      const fb = baseName(j.file || '');
      const has = (c) => hasValue(c, j.timeoutMs);
      let cands = (seamByFile[fb] || []).filter((s) => s.constants.some(has));
      let helper = false;
      if (!cands.length) {
        cands = helperSitesFor(fb).filter((s) => s.constants.some(has));
        helper = cands.length > 0;
      }
      if (!cands.length) { unmatched.push(rec); continue; }
      const argvStr = rec.argv.join(' ');
      const constsOf = (list) => {
        const out = new Set();
        for (const s of list) for (const c of s.constants) if (has(c)) out.add(c);
        return out;
      };
      const allConsts = constsOf(cands);
      let comp = cands.filter((s) => cmdCompatible(index.siteShape(s).callee, rec.command));
      if (helper) {
        // A helper is shared by many tests: require the record's argv to show one of the site's own literals.
        comp = comp.filter((s) => { const l = index.siteShape(s).lits; return !l.length || l.some((x) => argvStr.includes(x)); });
      }
      if (!comp.length) { unmatched.push(rec); continue; }
      if (helper) { viaHelper++; rec.viaHelper = true; }
      const consts = constsOf(comp);
      let winner = null;
      if (consts.size === 1) winner = [...consts][0];
      else {
        const scored = comp.map((s) => ({ s, score: index.siteShape(s).lits.filter((l) => argvStr.includes(l)).length }));
        const maxScore = scored.reduce((a, b) => Math.max(a, b.score), 0);
        const top = maxScore > 0 ? scored.filter((x) => x.score === maxScore) : scored;
        const tc = constsOf(top.map((x) => x.s));
        if (tc.size === 1) winner = [...tc][0];
      }
      if (winner && allConsts.size > 1) narrowed++;
      if (!winner) { rec.candidates = [...consts]; ambiguous.push(rec); continue; }
      rec.constant = winner;
      (credited[winner] = credited[winner] || []).push(rec);
    }
  }
  return { credited, ambiguous, unmatched, total, narrowed, viaHelper };
}

/** Lanes per platform that ran at least one test file whose seam sites include this constant's. */
function laneCoverage(lanes, seamSitesOfConstant, index) {
  const siteFiles = new Set(seamSitesOfConstant.map((s) => baseName(s.file)));
  const siteRels = new Set(seamSitesOfConstant.map((s) => s.file));
  const covers = (f) => {
    if (siteFiles.has(f)) return true;
    for (const rel of index.testsByBase[f] || []) for (const h of index.helperClosure(rel)) if (siteRels.has(h)) return true;
    return false;
  };
  const out = {};
  for (const p of PLATFORMS) out[p] = 0;
  for (const l of lanes) {
    for (const f of l.files) if (covers(f)) { out[l.os] = (out[l.os] || 0) + 1; break; }
  }
  return out;
}

const floor2 = (x) => Math.floor(x * 100) / 100;

/** Per-constant evidence from attribution results. */
function summarizeConstants({ names, values, sites, lanes, index, attribution }) {
  const { credited, ambiguous } = attribution;
  const constants = {};
  for (const c of names) {
    const val = values[c];
    const cs = sites.filter((s) => s.constants.includes(c));
    const seamN = cs.filter((s) => s.cls === 'SEAM');
    const rawN = cs.filter((s) => s.cls === 'DIRECT');
    const rs = credited[c] || [];
    const per = {};
    let worst = null;
    for (const p of PLATFORMS) {
      const a = rs.filter((r) => r.os === p).sort((x, y) => x.durationMs - y.durationMs);
      const sum = summarizeDurations(a.map((r) => r.durationMs));
      const w = a.length ? a[a.length - 1] : null;
      per[p] = { ...sum, worst: w ? { file: w.file, command: w.command, argv: w.argv, ms: w.durationMs, runId: w.runId, startedAt: w.startedAt } : null };
      if (w && (!worst || w.durationMs > worst.ms)) worst = { platform: p, ...per[p].worst };
    }
    constants[c] = {
      value: val,
      siteOnly: HARNESS_ONLY.has(c),
      seamSites: seamN.length,
      rawSites: rawN.length,
      seamFiles: new Set(seamN.map((s) => baseName(s.file))).size,
      rawFiles: new Set(rawN.map((s) => s.file)).size,
      laneCoverage: laneCoverage(lanes, seamN, index),
      perPlatform: per,
      worst,
      recordsTotal: rs.length,
      viaHelper: rs.filter((r) => r.viaHelper).length,
      margin: worst ? floor2(val / worst.ms) : null,
      ambiguousCandidateCount: ambiguous.filter((r) => r.candidates.includes(c)).length,
    };
  }
  return constants;
}

/** Everything the CLI prints, from already-loaded inputs. */
function buildEvidence({ lanes, runDirectories, view, names, evidenceNames, values, census, historicalValues = HISTORICAL_VALUES }) {
  const index = createRepoIndex(view);
  const built = buildSites(census, createClassifier(view));
  const attribution = attributeRecords(lanes, { sites: built.sites, values, index, historicalValues });
  const runIds = new Set(lanes.map((l) => l.runId));
  let dmin = null;
  let dmax = null;
  for (const l of lanes) {
    if (l.startedMin && (!dmin || l.startedMin < dmin)) dmin = l.startedMin;
    if (l.startedMax && (!dmax || l.startedMax > dmax)) dmax = l.startedMax;
  }
  const lanesByPlatform = {};
  for (const l of lanes) lanesByPlatform[l.os] = (lanesByPlatform[l.os] || 0) + 1;
  const durations = lanes.flatMap((l) => l.stalls.map((j) => j.durationMs));
  const ambiguousByCandidates = {};
  for (const r of attribution.ambiguous) {
    const k = r.candidates.slice().sort().join('+') + ' @' + r.timeoutMs;
    ambiguousByCandidates[k] = (ambiguousByCandidates[k] || 0) + 1;
  }
  const unmatchedByTimeout = {};
  for (const r of attribution.unmatched) unmatchedByTimeout[r.timeoutMs] = (unmatchedByTimeout[r.timeoutMs] || 0) + 1;
  return {
    window: { runDirectories, runs: runIds.size, laneArtifacts: lanes.length, lanesByPlatform, firstSpawnStartedAt: dmin, lastSpawnStartedAt: dmax, skippedMalformedLines: lanes.reduce((a, l) => a + (l.skippedLines || 0), 0) },
    totalRecords: attribution.total,
    creditedRecords: Object.values(attribution.credited).reduce((a, b) => a + b.length, 0),
    ambiguousRecords: attribution.ambiguous.length,
    unmatchedRecords: attribution.unmatched.length,
    narrowedByArgv: attribution.narrowed,
    viaHelper: attribution.viaHelper,
    minDurationMs: durations.length ? Math.min(...durations) : null,
    census: { fileCount: census.fileCount, parseFailures: census.parseFailures, propRows: census.propRows.length, keptSites: built.sites.length, droppedSites: built.dropped.length, localRedefs: census.localRedefs },
    unresolvedSites: built.unresolvedSites,
    unusedResolutions: built.unusedResolutions,
    constants: summarizeConstants({ names: evidenceNames, values, sites: built.sites, lanes, index, attribution }),
    droppedSites: built.dropped,
    ambiguousByCandidates,
    unmatchedByTimeout,
    sites: built.sites,
    names,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** One `- [ ] file:line (CONSTANT)` line per non-seam site, grouped by constant. */
function rawSiteLines(sites, names) {
  const raw = sites.filter((s) => s.cls === 'DIRECT').slice().sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  const out = [];
  for (const c of names) {
    const rows = raw.filter((s) => s.constants.includes(c));
    if (!rows.length) continue;
    out.push(`## ${c}`, '', ...rows.map((s) => `- [ ] ${s.file}:${s.line} (${c})`), '');
  }
  return out.join('\n');
}

function renderMarkdown(ev, evidenceNames) {
  const L = [];
  const w = ev.window;
  L.push('# CI timeout evidence (per-call-site attribution)', '');
  L.push(`${w.runDirectories} run directories, ${w.runs} with spawn-stall data; ${w.laneArtifacts} lane artifacts (win32 ${w.lanesByPlatform.win32 || 0}, darwin ${w.lanesByPlatform.darwin || 0}, linux ${w.lanesByPlatform.linux || 0}); spawn startedAt ${w.firstSpawnStartedAt} .. ${w.lastSpawnStartedAt}. Smallest durationMs: ${ev.minDurationMs}.`, '');
  L.push(`Records: ${ev.totalRecords}; credited ${ev.creditedRecords}; ambiguous ${ev.ambiguousRecords}; unmatched ${ev.unmatchedRecords}; narrowed by command/argv ${ev.narrowedByArgv}; credited via helper ${ev.viaHelper}; malformed lines skipped ${w.skippedMalformedLines}.`, '');
  L.push('| constant | value | seam sites | raw sites | records (win32/darwin/linux) | lanes (win32/darwin/linux) | worst platform | worst max ms | margin | via helper | ambiguous cand. |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of evidenceNames) {
    const r = ev.constants[c];
    L.push(`| ${c} | ${r.value} | ${r.seamSites} | ${r.rawSites} | ${PLATFORMS.map((p) => r.perPlatform[p].records).join('/')} | ${PLATFORMS.map((p) => r.laneCoverage[p]).join('/')} | ${r.worst ? r.worst.platform : 'n/a'} | ${r.worst ? r.worst.ms : 'none'} | ${r.margin === null ? 'n/a' : r.margin} | ${r.viaHelper} | ${r.ambiguousCandidateCount} |`);
  }
  L.push('', '## Per platform', '', '| constant | platform | records | p50 | p99 | max |', '|---|---|---|---|---|---|');
  for (const c of evidenceNames) {
    for (const p of PLATFORMS) {
      const x = ev.constants[c].perPlatform[p];
      L.push(`| ${c} | ${p} | ${x.records} | ${x.p50 === null ? '-' : x.p50} | ${x.p99 === null ? '-' : x.p99} | ${x.max === null ? '-' : x.max} |`);
    }
  }
  L.push('', '## Dropped sites', '');
  for (const d of ev.droppedSites) L.push(`- ${d.file}:${d.line} ${d.constants.join()} - ${d.why}`);
  L.push('', '## Ambiguous by candidate-constant set', '');
  for (const [k, v] of Object.entries(ev.ambiguousByCandidates).sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${v}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// I/O

function diskView(root) {
  const read = (rel) => {
    try {
      const p = path.join(root, rel);
      return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
    } catch { return null; }
  };
  const listFiles = () => {
    const out = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(rel); } else if (e.isFile() && e.name.endsWith('.cjs')) out.push(rel);
      }
    })('tests');
    return out.sort();
  };
  return { read, listFiles };
}

/**
 * Reads every `*.jsonl` under `artifactsDir`. Two layouts are accepted:
 * `<dir>/<runId>/<artifact>/<file>.jsonl` and `<dir>/<runId>/<file>.jsonl` (what `gh run download
 * --pattern X --dir <dir>/<runId>` writes when X matches a single artifact). The lane's os comes
 * from the artifact folder name, else from the file name; a file whose os cannot be determined, or
 * that sits outside `<runId>/`, throws, as does a directory holding no lane file. Directory entries
 * are visited in sorted order.
 */
function loadLanes(artifactsDir) {
  const lanes = [];
  (function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        const parts = path.relative(artifactsDir, p).split(path.sep);
        if (parts.length < 2) throw new Error('lane file outside a <runId>/ directory: ' + p);
        const art = parts.length >= 3 ? parts[1] : e.name.replace(/\.jsonl$/, '');
        let os = osOfArtifact(art);
        if (os === 'other') os = osOfArtifact(e.name);
        if (os === 'other') throw new Error('cannot determine the os of lane file ' + p + ' (artifact name must contain ubuntu, windows or macos)');
        lanes.push(parseLane(fs.readFileSync(p, 'utf8'), { os, runId: parts[0], art }));
      }
    }
  })(artifactsDir);
  if (!lanes.length) throw new Error('no lane *.jsonl files found under ' + artifactsDir);
  return lanes;
}

function parseArgs(argv) {
  const opts = { artifacts: null, repo: path.resolve(__dirname, '..'), format: 'json', rawSites: false };
  const valueOf = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(flag + ' requires a value');
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artifacts') opts.artifacts = valueOf(a, i++);
    else if (a === '--repo') opts.repo = path.resolve(valueOf(a, i++));
    else if (a === '--format') opts.format = valueOf(a, i++);
    else if (a === '--raw-sites') opts.rawSites = true;
    else throw new Error('unknown argument: ' + a);
  }
  if (!opts.artifacts) throw new Error('--artifacts <dir> is required');
  if (opts.format !== 'json' && opts.format !== 'md') throw new Error('--format must be json or md');
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const T = require(path.join(path.resolve(opts.repo), TIMEOUTS_REL));
  const { values, censusNames, evidenceNames } = constantsFromTimeouts(T);
  const view = diskView(opts.repo);
  const census = censusRepo(view, censusNames);
  const artifactsDir = path.resolve(opts.artifacts);
  const lanes = loadLanes(artifactsDir);
  const runDirectories = fs.readdirSync(artifactsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  const ev = buildEvidence({ lanes, runDirectories, view, names: censusNames, evidenceNames, values, census });
  if (opts.rawSites) process.stdout.write(rawSiteLines(ev.sites, censusNames) + '\n');
  else if (opts.format === 'md') process.stdout.write(renderMarkdown(ev, evidenceNames));
  else process.stdout.write(JSON.stringify(ev, null, 1) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) {
    process.stderr.write('timeout-evidence-from-ci: ' + e.message + '\n');
    process.exitCode = 2;
  }
}

module.exports = {
  MANUAL_RESOLUTIONS,
  HISTORICAL_VALUES,
  constantsFromTimeouts,
  censusSource,
  censusRepo,
  createClassifier,
  buildSites,
  parseLane,
  percentile,
  summarizeDurations,
  createRepoIndex,
  attributeRecords,
  laneCoverage,
  summarizeConstants,
  buildEvidence,
  rawSiteLines,
  renderMarkdown,
  diskView,
  loadLanes,
  parseArgs,
  osOfArtifact,
};
