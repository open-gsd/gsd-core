'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const runtime = require('../gsd-core/bin/gsd-tools.cjs');
const commandAliases = require('../gsd-core/bin/lib/command-aliases.cjs');

const ROOT = path.join(__dirname, '..');
const AGENT_PATH = path.join(ROOT, 'agents', 'gsd-plan-checker.md');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [fullPath] : [];
  });
}

function queryNames(content) {
  const names = [];
  for (const line of content.split(/\r?\n/)) {
    // Scan every occurrence, including shell substitutions, pipelines, and inline examples.
    const re = /\b(?:gsd_run|gsd-tools)\s+query\s+([\w.-]+)(?:\s+([\w.-]+))?/g;
    let match;
    while ((match = re.exec(line))) {
      const before = line.slice(0, match.index);
      // Ignore grammatical mentions; count shell starts, shell control operators/substitutions,
      // and Markdown code spans so embedded executable calls remain covered without a word list.
      if (before.trim() && !/(?:\$\(\s*|&&\s*|\|\|\s*|\|\s*|;\s*|\b(?:if|then|do|else|elif|while|until)\s*|`[^`]*$)$/.test(before)) continue;
      names.push([match[1], match[2]].filter(Boolean));
    }
  }
  return names;
}

function documentedQueryNames(files) {
  const names = files.flatMap((file) => queryNames(fs.readFileSync(file, 'utf8')));
  return [...new Map(names.map((parts) => [parts.join(' '), parts])).values()];
}

function runtimeRegisteredNames() {
  const registered = new Set(Object.keys(runtime.HOST_COMMAND_ROUTERS));
  const commandList = runtime.TOP_LEVEL_USAGE.match(/Commands: ([^\n]+)/)?.[1] || '';
  for (const name of commandList.split(/,\s*/)) if (name) registered.add(name.trim());
  const families = new Set();
  const capabilities = require('../gsd-core/bin/lib/capability-registry.cjs');
  for (const name of Object.keys(capabilities.commandFamilies)) registered.add(name);
  const phase = require('../gsd-core/bin/lib/phase.cjs');
  for (const handler of Object.keys(phase).filter((name) => /^cmdPhase[A-Z]/.test(name))) {
    const subcommand = handler.slice('cmdPhase'.length).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    registered.add(`phase.${subcommand}`);
  }
  for (const value of Object.values(commandAliases)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry.canonical !== 'string') continue;
      registered.add(entry.canonical);
      if (entry.subcommand) families.add(entry.canonical.split('.')[0]);
      for (const alias of entry.aliases || []) registered.add(alias);
    }
  }
  return { registered, families };
}

function registeredName(parts, registry) {
  const [name, subcommand] = parts;
  const root = name.split('.')[0];
  if (registry.families.has(root)) {
    const canonical = name.includes('.') ? name : `${name}.${subcommand || ''}`;
    return Boolean(subcommand || name.includes('.')) && (registry.registered.has(canonical) || registry.registered.has(canonical.replace('.', ' ')));
  }
  return registry.registered.has(name) || registry.registered.has(root);
}

function findUnregisteredQueries(files, registry) {
  const failures = [];
  for (const file of files) {
    const filePath = typeof file === 'string' ? file : file.path;
    const relative = path.relative(ROOT, filePath).split(path.sep).join('/');
    const content = typeof file === 'string' ? fs.readFileSync(file, 'utf8') : file.content;
    for (const parts of queryNames(content)) {
      if (!registeredName(parts, registry)) {
        failures.push(`${relative}: ${parts.join(' ')}`);
      }
    }
  }
  return failures;
}

test('every documented query names a registered command', () => {
  const files = ['agents', path.join('gsd-core', 'workflows'), 'commands']
    .flatMap((root) => markdownFiles(path.join(ROOT, root)));
  const names = documentedQueryNames(files);
  const registered = runtimeRegisteredNames();
  assert.deepEqual(names.filter((parts) => !registeredName(parts, registered)).map((parts) => parts.join(' ')), []);

  const syntheticPath = path.join(ROOT, 'tests', 'synthetic-query-contract.md');
  assert.deepEqual(findUnregisteredQueries([{
    path: syntheticPath,
    content: 'gsd-tools query synthetic.unregistered\n',
  }], registered), ['tests/synthetic-query-contract.md: synthetic.unregistered']);
  assert.deepEqual(findUnregisteredQueries([{
    path: syntheticPath,
    content: 'gsd-tools query verify.plan-structure\n',
  }], registered), []);
});

function frontmatterCalls(agent) {
  const calls = [];
  for (const line of agent.split(/\r?\n/)) {
    const re = /\bgsd_run\s+query\s+frontmatter\.get\s+(.+?)(?=\s*(?:\)|\|\||&&|\||;|$))/g;
    let match;
    while ((match = re.exec(line))) {
      const args = [...match[1].matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)]
        .map(([word]) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_whole, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
      if (args.length) calls.push({ planExpression: args[0], args: args.slice(1) });
    }
  }
  return calls;
}

test('plan-checker frontmatter.get calls return must_haves and files_modified', (t) => {
  const calls = frontmatterCalls(fs.readFileSync(AGENT_PATH, 'utf8'));
  assert.ok(calls.length > 0, 'expected documented frontmatter.get calls');

  const dir = createTempProject('agent-query-contract-');
  t.after(() => cleanup(dir));
  const planPath = path.join(dir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  const expectedMustHaves = { truths: ['Fixture truth'], artifacts: [], key_links: [] };
  const expectedFiles = ['src/example.js'];
  fs.writeFileSync(planPath, [
    '---', 'phase: 1', 'plan: 1',
    'must_haves:', '  truths:', '    - Fixture truth', '  artifacts: []', '  key_links: []',
    'files_modified:', '  - src/example.js', '---', '# Fixture plan', '',
  ].join('\n'));

  for (const call of calls) {
    const fieldIndex = call.args.indexOf('--field');
    const field = fieldIndex >= 0 ? call.args[fieldIndex + 1] : call.args[0];
    const result = runGsdTools(['query', 'frontmatter.get', planPath, ...call.args], dir);
    assert.equal(result.success, true, `${call.planExpression} ${call.args.join(' ')}: ${result.error}`);
    const parsed = JSON.parse(result.output);
    if (field === 'must_haves') assert.deepEqual(parsed.must_haves, expectedMustHaves);
    if (field === 'files_modified') assert.deepEqual(parsed.files_modified, expectedFiles);
  }
  const fields = new Set(calls.map((call) => call.args.includes('--field') ? call.args[call.args.indexOf('--field') + 1] : call.args[0]));
  assert.ok(fields.has('must_haves'), 'expected a documented must_haves query');
  assert.ok(fields.has('files_modified'), 'expected a documented files_modified query');
});

test('plan-checker verify.plan-structure fields match the runtime output', (t) => {
  const dir = createTempProject('agent-query-structure-');
  t.after(() => cleanup(dir));
  const planPath = path.join(dir, '.planning', 'phases', '01-test', '01-01-PLAN.md');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, [
    '---', 'phase: 1', 'plan: 1', 'type: execute', 'wave: 1', '---',
    '# Plan', '', '<tasks>', '<task type="auto">', '<name>Add fixture</name>',
    '<files>src/example.js</files>', '<action>Add fixture behavior.</action>',
    '<verify>node --test</verify>', '<done>Fixture behavior exists.</done>',
    '</task>', '</tasks>', '',
  ].join('\n'));

  const result = runGsdTools(['query', 'verify.plan-structure', planPath], dir);
  assert.equal(result.success, true, result.error);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.task_count, 1);
  assert.ok(Array.isArray(parsed.tasks));
  for (const field of ['name', 'hasFiles', 'hasAction', 'hasVerify', 'hasDone']) {
    assert.ok(Object.hasOwn(parsed.tasks[0], field), `task output is missing ${field}`);
  }
});
