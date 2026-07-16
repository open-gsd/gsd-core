'use strict';

/**
 * Project OMP's task-agent contract from GSD's Claude agent source files.
 *
 * Usage: node pi/install-omp-agents.cjs [destination]
 * Default destination: $PI_CODING_AGENT_DIR/agents or ~/.omp/agent/agents.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCmdNames, transformContentToHyphen } = require('../scripts/fix-slash-commands.cjs');

const ompCommandNames = readCmdNames();

const ompTools = 'read, write, edit, bash, glob, grep, lsp, web_search, task';

const ompOrchestration = `
## OMP native orchestration

This runtime's native task tool owns subagents, jobs, progress, cancellation, artifacts, and isolation. When a GSD workflow asks to spawn an Agent(...), dispatch a native task instead; never emulate a subagent with shell backgrounding or a hand-written worktree.

- Use native task's real batch schema: provide shared top-level \`context\` and \`tasks[]\`; every task item needs a stable \`name\` (for example \`Phase02GapPlanner\`), the per-item \`agent\` type, complete self-contained work in \`task\`, and \`isolated: true\` for executor work. Never put \`agent\` at the top level or invent \`id\`, \`role\`, \`description\`, or \`assignment\` fields.
- Run independent research, planning, verification, and review work as native task jobs. The OMP Job and Subagents panels are the live progress source. Never use \`irc wait\` for task completion: IRC is only for quick coordination. Use \`job poll\` when the workflow is blocked on a wave barrier, and consume every spawned native result before advancing.
- For executor work that writes repository files, set \`isolated: true\` when that field is available. OMP then provisions and cleans the isolated workspace. Never run git worktree yourself.
- If isolated execution is unavailable, stop and report that execution cannot safely proceed. Never write executor changes into the primary checkout as a fallback.
- Research, planning, review, and verification are read-only by default: do not request isolation merely to make them look parallel.
- Preserve GSD's commit, merge, verification, and STATE.md gates. Native task isolation runs work; it does not bypass workflow safety.
- If the parent sends an IRC status request, reply before further tool use with the current step, blocker (or \`none\`), and whether execution remains active. Treat it as coordination, not a new research assignment; do not restart codebase discovery.
`;

function ompResultProtocol(name) {
  if (name !== 'gsd-executor') return '';
  return `
## OMP executor result protocol

The orchestrator reconciles native task results before it updates GSD tracking. Do not report a plan as complete until its required commits and SUMMARY.md have been written.

End the native task's final report with exactly one result line, using the phase, plan, and task name assigned by the orchestrator. Then follow OMP's terminal \`yield\` protocol so the native task runtime delivers that report without reminder retries.

\`\`\`text
[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed
\`\`\`

If execution stops before the plan is complete, end the normal final response with \`failed\` or \`cancelled\` instead of \`completed\`. The result line is a lifecycle record, not a substitute for GSD's filesystem, merge, verification, or STATE.md gates.
`;
}

function rewriteRuntimePaths(content, runtimeRoot) {
  const root = runtimeRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const rewritten = content
    .replace(/~\/\.claude\//g, `${root}/`)
    .replace(/\$HOME\/\.claude\//g, `${root}/`)
    .replace(/~\/\.claude\b/g, root)
    .replace(/\$HOME\/\.claude\b/g, root);
  return transformContentToHyphen(rewritten, ompCommandNames);
}


function projectAgent(content, sourcePath, runtimeRoot, options = {}) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${sourcePath}`);

  const [, frontmatter, rawBody] = match;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const sourceModel = frontmatter.match(/^model:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`Missing name or description: ${sourcePath}`);
  const resolvedModel = options.resolveModel?.(name);
  const model = typeof resolvedModel === 'string' && resolvedModel.trim() ? resolvedModel.trim() : sourceModel;
  const body = rewriteRuntimePaths(rawBody, runtimeRoot);

  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(model ? [`model: ${JSON.stringify(model)}`] : []),
    `tools: ${ompTools}`,
    'spawns: "*"',
    '---',
    '',
    body,
    ompOrchestration,
    ompResultProtocol(name),
  ].join('\n');
}

function installOmpAgents(destinationDir, sourceDir = path.resolve(__dirname, '..', 'agents'), runtimeRoot = path.dirname(destinationDir), options = {}) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const staged = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^gsd-.*\.md$/.test(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(destinationDir, entry.name);
    fs.writeFileSync(targetPath, projectAgent(fs.readFileSync(sourcePath, 'utf8'), sourcePath, runtimeRoot, options));
    staged.push(targetPath);
  }
  return staged;
}

if (require.main === module) {
  const destinationDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent'), 'agents');
  const staged = installOmpAgents(destinationDir);
  process.stdout.write(JSON.stringify({ destinationDir, staged: staged.length }) + '\n');
}

module.exports = { installOmpAgents, projectAgent, rewriteRuntimePaths };
