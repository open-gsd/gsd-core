// allow-test-rule: source-text-is-the-product (see #1990)
// Command/workflow markdown is deployed runtime product; source-text assertions
// below verify the installed command contract. CLI assertions exercise real
// gsd-tools behavior through the public command boundary.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');

const ROOT = path.join(__dirname, '..');
const CMD_PATH = path.join(ROOT, 'commands', 'gsd', 'onboard.md');
const WF_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'onboard.md');

describe('init onboard public CLI projection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture({ planning: false, projectDoc: false });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('reports brownfield code, docs, and missing planning state', () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'server.ts'), 'export const server = true;\n');
    fs.mkdirSync(path.join(tmpDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'adr', '0001-runtime.md'), '# ADR: Runtime\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.planning_exists, false);
    assert.strictEqual(parsed.project_exists, false);
    assert.strictEqual(parsed.has_existing_code, true);
    assert.strictEqual(parsed.has_codebase_map, false);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 1);
    assert.deepStrictEqual(parsed.codebase_map_files_present, []);
    assert.ok(parsed.doc_candidates.includes('docs/adr/0001-runtime.md'));
    for (const file of ['STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md']) {
      assert.ok(parsed.missing_codebase_map_files.includes(file), `missing map files should include ${file}`);
    }
    assert.strictEqual(parsed.onboarding_summary_exists, false);
    assert.strictEqual(parsed.text_mode, false);
  });

  test('detects planning docs in top-level ADR, PRD, and RFC folders', () => {
    fs.mkdirSync(path.join(tmpDir, 'prd'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'prd', 'product.md'), '# Product Requirements\n');
    fs.mkdirSync(path.join(tmpDir, 'adr'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'adr', 'decision.md'), '# Architecture Decision\n');
    fs.mkdirSync(path.join(tmpDir, 'rfc'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'rfc', 'proposal.md'), '# Request for Comments\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 3);
    assert.deepStrictEqual(parsed.doc_candidates, [
      'adr/decision.md',
      'prd/product.md',
      'rfc/proposal.md',
    ]);
  });

  test('detects root-level planning docs without broad repo scan', () => {
    fs.writeFileSync(path.join(tmpDir, 'PRD.md'), '# Product Requirements\n');
    fs.writeFileSync(path.join(tmpDir, 'SPEC.md'), '# Specification\n');
    fs.writeFileSync(path.join(tmpDir, 'RFC.md'), '# Request for Comments\n');
    fs.writeFileSync(path.join(tmpDir, 'ADR.md'), '# Architecture Decision\n');
    fs.writeFileSync(path.join(tmpDir, 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(tmpDir, '0001-decision.md'), '# Decision\n');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'PRD.md'), '# Nested Product Requirements\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_docs_candidates, true);
    assert.strictEqual(parsed.doc_candidate_count, 6);
    assert.deepStrictEqual(parsed.doc_candidates, [
      '0001-decision.md',
      'ADR.md',
      'PRD.md',
      'REQUIREMENTS.md',
      'RFC.md',
      'SPEC.md',
    ]);
  });

  test('reports complete codebase map and onboarding summary in existing planning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'ARCHITECTURE', 'STRUCTURE', 'CONVENTIONS', 'TESTING', 'INTEGRATIONS', 'CONCERNS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.mkdirSync(path.join(tmpDir, '.planning', 'onboarding'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'onboarding', 'SUMMARY.md'), '# Onboarding Summary\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({ workflow: { text_mode: true } }));

    const trackedFiles = [
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      path.join(tmpDir, '.planning', 'STATE.md'),
      path.join(tmpDir, '.planning', 'onboarding', 'SUMMARY.md'),
    ];
    const before = new Map(trackedFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    for (const file of trackedFiles) {
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before.get(file), `${path.basename(file)} must not be mutated by init onboard`);
    }

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.planning_exists, true);
    assert.strictEqual(parsed.project_exists, true);
    assert.strictEqual(parsed.requirements_exists, true);
    assert.strictEqual(parsed.roadmap_exists, true);
    assert.strictEqual(parsed.state_exists, true);
    assert.strictEqual(parsed.has_codebase_map, true);
    assert.deepStrictEqual(parsed.missing_codebase_map_files, []);
    assert.strictEqual(parsed.onboarding_summary_exists, true);
    assert.strictEqual(parsed.onboarding_summary_path, '.planning/onboarding/SUMMARY.md');
    assert.strictEqual(parsed.text_mode, true);
  });

  test('reports fast codebase map readiness for the default fast subset', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'INTEGRATIONS', 'ARCHITECTURE', 'STRUCTURE']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const result = runGsdTools(['init', 'onboard', '--fast', '--raw'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_codebase_map, false);
    assert.strictEqual(parsed.has_fast_codebase_map, true);
    assert.strictEqual(parsed.needs_codebase_map, false);
    assert.deepStrictEqual(parsed.fast_codebase_map_files_required, [
      'STACK.md',
      'INTEGRATIONS.md',
      'ARCHITECTURE.md',
      'STRUCTURE.md',
    ]);
    assert.deepStrictEqual(parsed.missing_fast_codebase_map_files, []);
  });

  test('reports missing requirements in otherwise existing planning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.project_exists, true);
    assert.strictEqual(parsed.requirements_exists, false);
    assert.strictEqual(parsed.roadmap_exists, true);
    assert.strictEqual(parsed.state_exists, true);
  });

  test('ignores generated and vendor directories when detecting existing code', () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'export const ignored = true;\n');
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'console.log("ignored");\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_existing_code, false);
    assert.strictEqual(parsed.has_package_file, false);
    assert.strictEqual(parsed.is_brownfield, false);
    assert.strictEqual(parsed.needs_codebase_map, false);
  });

  test('treats package manifests as brownfield even without source files', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const result = runGsdTools('init onboard --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init onboard should succeed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.has_existing_code, false);
    assert.strictEqual(parsed.has_package_file, true);
    assert.strictEqual(parsed.is_brownfield, true);
    assert.strictEqual(parsed.needs_codebase_map, true);
  });

  test('dotted query init.onboard matches direct init onboard', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"fixture"}\n');

    const direct = runGsdTools(['init', 'onboard', '--raw'], tmpDir, { HOME: tmpDir });
    const query = runGsdTools(['query', 'init.onboard', '--raw'], tmpDir, { HOME: tmpDir });
    assert.equal(direct.success, true, direct.error || direct.output);
    assert.equal(query.success, true, query.error || query.output);
    assert.deepStrictEqual(JSON.parse(query.output), JSON.parse(direct.output));
  });

});

describe('/gsd:onboard command contract', () => {
  test('command file declares the onboard command and loads its workflow', () => {
    const content = fs.readFileSync(CMD_PATH, 'utf8');
    assert.match(content, /^name:\s*gsd:onboard$/m);
    assert.match(content, /^description:\s*.*(?:existing codebase|brownfield|onboard).*$/mi);
    assert.match(content, /^\s*- AskUserQuestion$/m);
    assert.match(content, /^\s*- Agent$/m);
    assert.ok(content.includes('@~/.claude/gsd-core/workflows/onboard.md'));
    assert.ok(content.includes('@~/.claude/gsd-core/references/ui-brand.md'));
    assert.ok(content.includes('@~/.claude/gsd-core/references/gate-prompts.md'));
  });

  test('workflow routes through existing primitives and protects existing planning', () => {
    const content = fs.readFileSync(WF_PATH, 'utf8');

    assert.ok(content.includes('init onboard'), 'workflow must use init onboard projection');
    assert.match(content, /gsd_run --cwd "\$_GSD_RUNTIME_ROOT" init onboard/, 'workflow must anchor init onboard at runtime root');
    assert.ok(content.includes('has_fast_codebase_map'), 'workflow must parse fast map readiness');
    assert.match(content, /CODEBASE_MAP_READY=.*has_fast_codebase_map/s, 'workflow must treat the fast subset as acceptable in fast mode');
    assert.ok(content.includes('Run from worktree root'), 'workflow handoffs must be anchored at the worktree root');
    for (const runtimeHome of [
      'HERMES_HOME',
      'CURSOR_CONFIG_DIR',
      'CODEX_HOME',
      'GEMINI_CONFIG_DIR',
      'WINDSURF_CONFIG_DIR',
      'OPENCODE_CONFIG_DIR',
    ]) {
      assert.ok(content.includes(runtimeHome), `workflow resolver must include ${runtimeHome}`);
    }
    assert.match(content, /Parse JSON fields:.*`commit_docs`/s, 'workflow must parse commit_docs before using it');
    assert.ok(content.includes('map-codebase'), 'workflow must route to map-codebase');
    assert.ok(content.includes('ingest-docs'), 'workflow must route to ingest-docs');
    assert.match(
      content,
      /If `has_docs_candidates` is true and `project_exists` is false:/,
      'workflow must offer docs ingest before project setup even when codebase mapping already created .planning',
    );
    assert.match(
      content,
      /If `is_brownfield` is false and `planning_exists` is false and `has_docs_candidates` is false, print:/,
      'workflow must not send doc-only repos to new-project before the docs ingest gate',
    );
    assert.ok(content.includes('new-project'), 'workflow must route to new-project');
    assert.ok(content.includes('.planning/onboarding/SUMMARY.md'), 'workflow must create onboarding summary');
    assert.match(
      content,
      /ONBOARDING_ROOT=\{git_worktree_root \|\| _GSD_RUNTIME_ROOT\}/,
      'workflow must resolve a single root for summary writes',
    );
    assert.match(
      content,
      /Create `\{ONBOARDING_ROOT\}\/\.planning\/onboarding\/SUMMARY\.md`/,
      'workflow must anchor summary writes at onboarding root',
    );
    assert.match(
      content,
      /gsd_run --cwd "\$ONBOARDING_ROOT" query commit "docs: create onboarding summary" --files \.planning\/onboarding\/SUMMARY\.md/,
      'workflow must commit the root-relative summary path from onboarding root',
    );
    assert.match(
      content,
      /CODEBASE_MAP_SUMMARY_STATUS=\.planning\/codebase\/ \(fast\/partial-but-accepted codebase map\)/,
      'workflow summary must label fast accepted maps without implying a complete map',
    );
    assert.match(
      content,
      /CODEBASE_MAP_FINAL_STATUS=\(fast\/partial-but-accepted; required fast files present\)/,
      'final status must distinguish complete maps from accepted fast maps',
    );
    const deriveMapStatusIndex = content.indexOf('Before summary keep/update choices, derive map status values safely:');
    const keepExistingSummaryIndex = content.indexOf('If `onboarding_summary_exists` is true:');
    assert.ok(deriveMapStatusIndex >= 0, 'workflow must derive map status values');
    assert.ok(keepExistingSummaryIndex >= 0, 'workflow must define the existing-summary branch');
    assert.ok(
      deriveMapStatusIndex < keepExistingSummaryIndex,
      'workflow must derive final map status before a keep-existing-summary path can skip to final status',
    );
    assert.match(content, /overwrite|idempotent|do not overwrite/i, 'workflow must protect existing planning');
    assert.ok(content.includes('requirements_exists'), 'workflow must parse requirements existence');
    assert.match(content, /REQUIREMENTS\.md: \{requirements_exists \? "present" : "missing"\}/, 'workflow must report missing requirements in partial planning');
    assert.match(content, /If `project_exists` is true and .*`requirements_exists`.* is false/s, 'workflow must gate partial planning on missing requirements');
    assert.ok(content.includes('--text'), 'workflow must document text-mode fallback');
    assert.ok(!content.includes('execute-phase'), 'onboarding must not execute implementation phases');
    assert.ok(!content.includes('gsd:ship'), 'onboarding must not ship work');
  });
});
