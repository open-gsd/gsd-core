'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const espree = require('espree');
const { PathAcceptance, assertWithinRoot, tryWithinRoot, tryWithinRootLexical } = require('../gsd-core/bin/lib/security.cjs');
const ROOT = path.resolve(__dirname, '..');
const DENY_NETWORK = path.join(ROOT, 'tests', 'fixtures', 'deny-network.cjs');
const CHILD_TIMEOUT_MS = 120000;
const CHILD_KILL_SIGNAL = 'SIGKILL';
const PRIVATE_KEY = /(?:^|_)(?:argv|stdout|stderr|diagnostic|error|stack|prompt|token|secret|credential|password|pid|path|url|header|body|environment|session|directory|response|log)(?:_|$)/i;
function fail(message) { throw new Error(message); }
function assertUnicode(value) { for (let i = 0; i < value.length; i += 1) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid Unicode scalar value'); i += 1; } else if (code >= 0xdc00 && code <= 0xdfff) fail('invalid Unicode scalar value'); } }
function jcs(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('noncanonical number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map((key) => { assertUnicode(key); return `${JSON.stringify(key)}:${jcs(value[key])}`; }).join(',')}}`;
  fail('unsupported canonical value');
}
function digest(domain, value) { if (typeof domain !== 'string' || domain.includes('\0')) fail('invalid digest domain'); return crypto.createHash('sha256').update(domain, 'utf8').update(Buffer.from([0])).update(jcs(value), 'utf8').digest('hex'); }
function relativeFile(file, root = ROOT) { if (typeof file !== 'string' || !file) fail('file is required'); const absolute = assertWithinRoot(file, root, 'focused test file', PathAcceptance.AbsoluteInsideRoot); if (absolute === root) fail('file must name a project file'); return path.relative(root, absolute).split(path.sep).join('/'); }
function walk(node, visit) { if (!node || typeof node !== 'object') return; if (node.type) visit(node); for (const [key, value] of Object.entries(node)) { if (['parent', 'range', 'loc'].includes(key)) continue; if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit)); else walk(value, visit); } }
function mandatoryLiterals(source, required) {
  if (typeof source !== 'string' || !Array.isArray(required) || !required.length || required.some((name) => typeof name !== 'string' || !name) || new Set(required).size !== required.length) fail('invalid mandatory literal request');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true }); const found = new Map(required.map((name) => [name, []]));
  walk(ast, (node) => { const literal = node.arguments?.[0]; if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'test' && literal?.type === 'Literal' && typeof literal.value === 'string' && found.has(literal.value)) found.get(literal.value).push({ name: literal.value, start: literal.range[0] }); });
  return required.map((name) => { const matches = found.get(name); if (!matches.length) fail(`missing mandatory literal: ${name}`); if (matches.length !== 1) fail(`duplicate mandatory literal: ${name}`); return matches[0]; });
}
function parseTap(text) {
  if (typeof text !== 'string' || text.includes('\0')) fail('malformed TAP');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== 'TAP version 13') fail('malformed TAP version');
  const indentation = (line) => line.match(/^ */)[0].length;
  const skipDiagnostics = (start, indent) => {
    if (lines[start]?.trim() !== '---' || indentation(lines[start]) <= indent) return start;
    const yamlIndent = indentation(lines[start]);
    for (let at = start + 1; at < lines.length; at += 1) {
      if (indentation(lines[at]) === yamlIndent && lines[at].trim() === '...') return at + 1;
      if (lines[at] && indentation(lines[at]) < yamlIndent) fail('truncated TAP diagnostics');
    }
    fail('truncated TAP diagnostics');
  };
  const block = (start, indent) => {
    const localRows = [];
    let at = start, assertionCount = 0, pending = null, pendingNested = false;
    while (at < lines.length) {
      if (!lines[at]) { at += 1; continue; }
      const leading = indentation(lines[at]), body = lines[at].slice(leading);
      if (leading < indent) fail('truncated TAP subtest');
      if (leading > indent) {
        const next = skipDiagnostics(at, indent);
        if (next !== at) { at = next; continue; }
        fail('malformed TAP indentation');
      }
      const declaration = body.match(/^# Subtest: (.+)$/);
      if (declaration) {
        if (pending) fail('unpaired TAP subtest');
        pending = declaration[1]; at += 1;
        while (at < lines.length && !lines[at]) at += 1;
        if (at >= lines.length) fail('dangling TAP subtest');
        if (at < lines.length && indentation(lines[at]) === indent + 4) {
          const nested = block(at, indent + 4); localRows.push(...nested.rows); at = nested.at; pendingNested = true;
        }
        continue;
      }
      const plan = body.match(/^1\.\.(\d+)(?:\s+#.*)?$/);
      if (plan) {
        if (pending || Number(plan[1]) !== assertionCount || assertionCount < 1) fail('TAP plan or result count mismatch');
        return { at: at + 1, rows: localRows };
      }
      const assertion = body.match(/^(ok|not ok)\s+(\d+)\s+-\s+(.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/i);
      if (assertion) {
        assertionCount += 1;
        if (Number(assertion[2]) !== assertionCount) fail('TAP numbering mismatch');
        const name = assertion[3].trim();
        if (pending && name !== pending) fail('TAP subtest name mismatch');
        let status = assertion[1].toLowerCase() === 'ok' ? 'pass' : 'fail';
        if (assertion[4]) status = assertion[4].toLowerCase();
        const diagnosticStart = at + 1;
        const next = skipDiagnostics(diagnosticStart, indent);
        if (status === 'fail' && next !== diagnosticStart && /cancelledByParent|cancelled/i.test(lines.slice(diagnosticStart, next).join('\n'))) status = 'cancelled';
        if (pendingNested && status !== 'pass') fail(`nested TAP parent is ${status}`);
        if (!pendingNested) localRows.push({ name, status });
        pending = null; pendingNested = false; at = next; continue;
      }
      if (body.startsWith('#') && !/^# Subtest:/.test(body)) { at += 1; continue; }
      fail('malformed TAP token');
    }
    fail('truncated TAP plan');
  };
  const parsed = block(1, 0);
  for (let at = parsed.at; at < lines.length; at += 1) if (lines[at] && !lines[at].startsWith('#')) fail('trailing TAP token');
  if (!parsed.rows.length) fail('zero executed tests');
  return parsed.rows;
}
function aggregateResults(rows, options = {}) { if (!Array.isArray(rows) || !rows.length) fail('zero executed tests'); const result = { executed: rows.length, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 }; for (const row of rows) { if (!row || typeof row.name !== 'string' || !['pass', 'fail', 'skip', 'todo', 'cancelled'].includes(row.status)) fail('malformed TAP status'); const field = row.status === 'pass' ? 'passed' : row.status === 'fail' ? 'failed' : row.status === 'skip' ? 'skipped' : row.status; result[field] += 1; } if (!options.allowFailures && (result.failed || result.skipped || result.todo || result.cancelled)) fail(`forbidden TAP result: failed=${result.failed} skipped=${result.skipped} todo=${result.todo} cancelled=${result.cancelled}`); return result; }
function requiredSubset(rows, required, expected = 'pass') { if (!Array.isArray(rows) || !rows.length) fail('zero selection'); if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length || new Set(required.map((name) => name.toLowerCase())).size !== required.length) fail('invalid or case-colliding required subset'); for (const name of required) { if (rows.some((row) => row.name !== name && row.name.toLowerCase() === name.toLowerCase())) fail(`case-colliding required result: ${name}`); const hits = rows.filter((row) => row.name === name); if (hits.length !== 1) fail(`required result must occur exactly once: ${name}`); if (hits[0].status !== expected) fail(`required result has wrong status: ${name}`); } return { ok: true }; }
function nodeTestArgv(files) { if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string' || !file || file.startsWith('-'))) fail('invalid whole-file test list'); return [process.execPath, '--unhandled-rejections=strict', '--test', '--test-reporter=tap', ...files]; }
function offlineEnvironment(environment = process.env) {
  const child = {};
  for (const key of ['PATH','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','LC_CTYPE','TZ']) {
    if (typeof environment?.[key] === 'string' && !/[\0\r\n]/.test(environment[key])) child[key] = environment[key];
  }
  child.NODE_OPTIONS = `--require=${JSON.stringify(DENY_NETWORK)}`;
  return child;
}
function focusedEnvironment(environment = process.env, forbidLive = false) { const child = offlineEnvironment(environment); if (forbidLive) child.GSD_FOCUSED_FORBID_LIVE = '1'; return child; }
function assertPrivateSafe(value) { const visit = (item) => { if (Array.isArray(item)) return item.forEach(visit); if (item && typeof item === 'object') return Object.entries(item).forEach(([key, child]) => { if (PRIVATE_KEY.test(key)) fail(`private field: ${key}`); visit(child); }); if (typeof item === 'string' && (item.includes('\n') || /(?:https?:\/\/|-----BEGIN|\b(?:token|secret|password|credential)\b)/i.test(item))) fail('private value'); }; visit(value); return true; }
function nearestExistingParent(candidate, io = fs) { let current=path.resolve(candidate); while(!io.existsSync(current)){const parent=path.dirname(current);if(parent===current)fail('no existing destination parent');current=parent;} const stat=io.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())fail('destination parent is unsafe');return current;}
function assertExternalDestination(destination, io = fs) { if(typeof destination!=='string'||!path.isAbsolute(destination))fail('record must be an absolute path');const absolute=path.resolve(destination);if(tryWithinRootLexical(absolute,ROOT)!==null)fail('record must be outside project');const ancestor=nearestExistingParent(path.dirname(absolute),io),realAncestor=io.realpathSync?io.realpathSync(ancestor):ancestor;if(tryWithinRoot(realAncestor,ROOT,PathAcceptance.AbsoluteInsideRoot)!==null)fail('record directory resolves inside project');io.mkdirSync(path.dirname(absolute),{recursive:true});const realDirectory=io.realpathSync?io.realpathSync(path.dirname(absolute)):path.dirname(absolute);if(tryWithinRoot(realDirectory,ROOT,PathAcceptance.AbsoluteInsideRoot)!==null)fail('record directory resolves inside project');return absolute;}
function writeAtomicRecord(destination, record, io = fs) {
  assertPrivateSafe(record); const absolute=assertExternalDestination(destination,io),directory=path.dirname(absolute); if(io.existsSync(absolute))fail('record destination already exists'); const temporary = path.join(directory, `.${path.basename(absolute)}.${crypto.randomUUID()}.tmp`); let descriptor;
  try { descriptor = io.openSync(temporary, 'wx', 0o600); io.writeFileSync(descriptor, `${jcs(record)}\n`, 'utf8'); io.fsyncSync(descriptor); const stat=io.fstatSync(descriptor); if(!stat.isFile())fail('temporary record is not regular'); io.closeSync(descriptor); descriptor = undefined; io.linkSync(temporary, absolute); const directoryDescriptor = io.openSync(directory, 'r'); try { io.fsyncSync(directoryDescriptor); } finally { io.closeSync(directoryDescriptor); } }
  finally { if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} } try { if (io.existsSync(temporary)) io.unlinkSync(temporary); } catch {} }
}
function argumentsFrom(argv) { const options = { files: [], required: [] }; for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; const next = () => { const value = argv[++i]; if (!value) fail(`missing value for ${token}`); return value; }; if (token === '--file') options.files.push(relativeFile(next())); else if (token === '--require-set' || token === '--require-each') options.required = next().split(','); else if (token === '--require-name') options.required = [next()]; else if (token === '--record') options.record = next(); else if (token === '--expect') options.expect = next(); else if (token === '--source-manifest') options.sourceManifest = next(); else if (token === '--forbid-live') options.forbidLive = true; else fail(`unknown argument: ${token}`); } if (!options.files.length || !options.required.length || !options.record || !['pass', 'red'].includes(options.expect) || (options.sourceManifest && options.sourceManifest !== 'literal-node-test-v1') || new Set(options.required).size !== options.required.length || new Set(options.required.map((name) => name.toLowerCase())).size !== options.required.length) fail('invalid focused evidence arguments'); assertExternalDestination(options.record); return options; }
function focusedProducerArgv(options) { const argv=[process.execPath,'scripts/run-focused-test-evidence.cjs']; for(const file of options.files)argv.push('--file',file); if(options.sourceManifest)argv.push('--source-manifest',options.sourceManifest); argv.push(options.sourceManifest?'--require-each':options.required.length===1?'--require-name':'--require-set',options.required.join(',')); if(options.forbidLive)argv.push('--forbid-live'); argv.push('--expect',options.expect,'--record',options.record); return argv; }
function sourceEvidence(files, required, root = ROOT) {
  const sources = files.map((file) => ({ file, bytes: fs.readFileSync(path.join(root, file), 'utf8') })), literals = [];
  for (const name of required) { const matches = []; for (const source of sources) { try { matches.push({ file: source.file, ...mandatoryLiterals(source.bytes, [name])[0] }); } catch (error) { if (!/missing mandatory literal/.test(error.message)) throw error; } } if (matches.length !== 1) fail(`mandatory literal source mismatch: ${name}`); literals.push(matches[0]); }
  const manifest = { files: sources.map((source) => ({ file: source.file, digest: digest('source', source.bytes) })), literals };
  return { source_file_set_digest: digest('source-files', files), source_manifest_digest: digest('source-manifest', manifest), source_file_count: files.length, source_required_literal_count: literals.length };
}
function run(options, dependencies = {}) {
  const root = dependencies.root || ROOT, now = dependencies.now || Date.now, started = now(), source = sourceEvidence(options.files, options.required, root), argv = nodeTestArgv(options.files), spawn = dependencies.spawnSync || spawnSync;
  const child = spawn(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', shell: false, env: focusedEnvironment(dependencies.environment || process.env, options.forbidLive === true), timeout: CHILD_TIMEOUT_MS, killSignal: CHILD_KILL_SIGNAL, maxBuffer: 8 * 1024 * 1024 }); if (child.error || child.signal || !Number.isInteger(child.status)) fail('test child did not complete'); const rows = parseTap(child.stdout || ''), aggregate = aggregateResults(rows, { allowFailures: options.expect === 'red' });
  if (options.expect === 'pass') { if (child.status !== 0) fail('test child failed'); requiredSubset(rows, options.required); } else { if (child.status === 0 || aggregate.failed !== options.required.length || aggregate.skipped || aggregate.todo || aggregate.cancelled) fail('red result set mismatch'); requiredSubset(rows, options.required, 'fail'); if (rows.some((row) => row.status === 'fail' && !options.required.includes(row.name))) fail('unrelated red result'); }
  const pass = options.expect === 'pass'; const payload = options.sourceManifest ? { required_count: options.required.length, required_seen_count: options.required.length, required_passed_count: pass ? options.required.length : 0, required_failed: pass ? 0 : options.required.length, required_skipped: 0, required_todo: 0, required_cancelled: 0, required_set_digest: digest('required-set', options.required), executed_count: aggregate.executed, passed_count: aggregate.passed, failed_count: aggregate.failed, skipped_count: aggregate.skipped, todo_count: aggregate.todo, cancelled_count: aggregate.cancelled, aggregate_result_digest: digest('tap-results', rows), source_manifest_kind: 'literal-node-test-v1', ...source, static_required_literals_verified: true, required_subset_verified: true, digest_count_match: true } : { selected: options.required.length, passed: pass ? options.required.length : 0, failed: pass ? 0 : options.required.length, skipped: 0, todo: 0, cancelled: 0, required_set_digest: digest('required-set', options.required) };
  const record = { schema: 'opencode-v2-command-evidence.v1', id: path.basename(options.record, '.json'), verdict: pass ? 'PASS' : 'RED', started_ms: started, finished_ms: now(), command_digest: digest('command', focusedProducerArgv(options)), project_digest: digest('project', fs.realpathSync(root)), atomic_complete: true, privacy_verified: true, payload };
  (dependencies.writeAtomicRecord || writeAtomicRecord)(options.record, record); return record;
}
if (require.main === module) { try { run(argumentsFrom(process.argv.slice(2))); } catch (error) { process.stderr.write(`focused-test-evidence: ${error.message}\n`); process.exitCode = 1; } }
module.exports = { CHILD_KILL_SIGNAL, CHILD_TIMEOUT_MS, aggregateResults, argumentsFrom, assertExternalDestination, assertPrivateSafe, digest, focusedEnvironment, focusedProducerArgv, jcs, mandatoryLiterals, nodeTestArgv, offlineEnvironment, parseTap, requiredSubset, run, sourceEvidence, writeAtomicRecord };
