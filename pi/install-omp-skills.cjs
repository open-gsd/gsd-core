'use strict';

/**
 * Adds OMP-native execution semantics to the generated GSD skill files that
 * OMP discovers from its global agent directory.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OMP_SKILL_BLOCKS = {
  'gsd-execute-phase': `<omp_native_execution>
**OMP:** Native \`task\` is the executor primitive. Replace every \`Agent(...)\` dispatch in the execution workflow with a native \`task\` dispatch; do not fall back to inline execution merely because Claude's \`Agent\` API is absent.

- Create one task per plan. A parallel wave is one native task batch: provide shared top-level \`context\` and \`tasks[]\`; use \`job poll\` when blocked on the wave barrier and consume every spawned native result before progressing. Never use \`irc wait\` as a task-completion mechanism.
- Each executor item needs a stable \`name\` such as \`Phase{PHASE}Plan{PLAN_COMPACT}Executor\` (remove plan punctuation), \`agent: "gsd-executor"\`, its complete self-contained plan assignment in \`task\`, and \`isolated: true\`. Do not put \`agent\` at the top level or invent \`id\`, \`role\`, \`description\`, or \`assignment\` fields.
- On an IRC status request, reply before further tool use with the current step, blocker (or \`none\`), and whether execution remains active. This is coordination, not a new research assignment.
- Treat a native task result as a lifecycle signal only. Before marking a plan complete, preserve the workflow's required SUMMARY.md, commit, merge, post-wave test, and STATE.md gates.
- Require every executor's final report to end with \`[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed\`, or \`failed\` / \`cancelled\`, then follow OMP's terminal \`yield\` protocol so the report is delivered without reminder retries.
- Never invoke \`git worktree\` yourself. OMP owns isolation setup and cleanup.
</omp_native_execution>`,
  'gsd-progress': `<omp_artifact_handling>
**OMP:** \`.planning/debug/\` and \`.planning/todos/pending/\` are optional. Their absence means zero active debug sessions and zero pending todo artifacts; do not emit an error or invoke Glob/Grep with either missing directory as its root. When checking optional artifacts, scan an existing \`.planning\` root and filter matching paths. A truncated summary glob may supply recent-work examples only; never use it to derive plan or summary counts.
</omp_artifact_handling>`,
};

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function projectSkillContent(content, runtimeRoot) {
  const runtimeGsdRoot = toPosixPath(path.join(runtimeRoot, 'gsd-core'));
  return content.replaceAll('~/.claude/gsd-core', runtimeGsdRoot);
}

function applyOmpSkillBlock(name, content) {
  const block = OMP_SKILL_BLOCKS[name];
  if (!block || content.includes(block)) return content;
  const marker = content.includes('<context>') ? '<context>' : '<process>';
  const index = content.indexOf(marker);
  if (index < 0) throw new Error(`Missing ${marker} in ${name}/SKILL.md`);
  return `${content.slice(0, index)}${block}\n\n${content.slice(index)}`;
}

function installOmpSkills(skillsDir, sourceSkillsDir = path.resolve(__dirname, '..', 'skills')) {
  if (!fs.existsSync(sourceSkillsDir)) return [];
  const runtimeRoot = path.dirname(path.resolve(skillsDir));
  const installed = [];
  for (const entry of fs.readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
    const sourceSkillPath = path.join(sourceSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(sourceSkillPath)) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    const source = fs.readFileSync(sourceSkillPath, 'utf8');
    const content = applyOmpSkillBlock(entry.name, projectSkillContent(source, runtimeRoot));
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, content);
    installed.push(skillPath);
  }
  return installed;
}

if (require.main === module) {
  const skillsDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'skills');
  const installed = installOmpSkills(skillsDir, path.resolve(__dirname, '..', 'skills'));
  process.stdout.write(JSON.stringify({ skillsDir, installed: installed.length }) + '\n');
}

module.exports = { installOmpSkills };
