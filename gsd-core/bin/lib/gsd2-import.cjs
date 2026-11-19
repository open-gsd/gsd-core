"use strict";
/**
 * gsd2-import — Reverse migration from GSD-2 (.gsd/) to GSD v1 (.planning/)
 *
 * Reads a GSD-2 project directory structure and produces a complete
 * .planning/ artifact tree in GSD v1 format.
 *
 * GSD-2 hierarchy:  Milestone → Slice → Task
 * GSD v1 hierarchy: Milestone (in ROADMAP.md) → Phase → Plan
 *
 * Mapping rules:
 *   - Slices are numbered sequentially across all milestones (01, 02, …)
 *   - Tasks within a slice become plans (01-01, 01-02, …)
 *   - Completed slices ([x] in ROADMAP) → [x] phases in ROADMAP.md
 *   - Tasks with a SUMMARY file → SUMMARY.md written
 *   - Slice RESEARCH.md → phase XX-RESEARCH.md
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/gsd2-import.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const runtime_slash_cjs_1 = require("./runtime-slash.cjs");
const clock_cjs_1 = require("./clock.cjs");
const phase_lifecycle_cjs_1 = require("./phase-lifecycle.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
const coreUtilsMod = require("./core-utils.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
const frontmatterMod = require("./frontmatter.cjs");
const { output } = ioMod;
const { transliterateForSlug } = coreUtilsMod;
const { stripFrontmatter } = frontmatterMod;
// ─── Utilities ──────────────────────────────────────────────────────────────
function readOptional(filePath) {
    try {
        return node_fs_1.default.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function zeroPad(n, width = 2) {
    return String(n).padStart(width, '0');
}
function slugify(title) {
    // #2848: transliterate Cyrillic to ASCII before the filter so a non-Latin
    // title does not collapse to an empty slug. The shared primitive keeps this
    // in sync with generateSlugInternal. slugify's DISTINCT contract is preserved:
    // single leading/trailing hyphen strip (/^-|-$/), and NO 60-char truncation.
    return transliterateForSlug(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// ─── GSD-2 Parser ───────────────────────────────────────────────────────────
/**
 * Find the .gsd/ directory starting from a project root.
 * Returns the absolute path or null if not found.
 */
function findGsd2Root(startPath) {
    if (node_path_1.default.basename(startPath) === '.gsd' && node_fs_1.default.existsSync(startPath)) {
        return startPath;
    }
    const candidate = node_path_1.default.join(startPath, '.gsd');
    if (node_fs_1.default.existsSync(candidate) && node_fs_1.default.statSync(candidate).isDirectory()) {
        return candidate;
    }
    return null;
}
/**
 * Parse the ## Slices section from a GSD-2 milestone ROADMAP.md.
 * Each slice entry looks like:
 *   - [x] **S01: Title** `risk:medium` `depends:[S00]`
 */
function parseSlicesFromRoadmap(content) {
    const slices = [];
    const sectionMatch = content.match(/## Slices\n([\s\S]*?)(?:\n## |\n# |$)/);
    if (!sectionMatch)
        return slices;
    for (const line of sectionMatch[1].split('\n')) {
        const m = line.match(/^- \[([x ])\]\s+\*\*(\w+):\s*([^*]+)\*\*/);
        if (!m)
            continue;
        slices.push({ done: m[1] === 'x', id: m[2].trim(), title: m[3].trim() });
    }
    return slices;
}
/**
 * Parse the milestone title from the first heading in a GSD-2 ROADMAP.md.
 * Format: # M001: Title
 */
function parseMilestoneTitle(content) {
    const m = content.match(/^# \w+:\s*(.+)/m);
    return m ? m[1].trim() : null;
}
/**
 * Parse a task title from a GSD-2 T##-PLAN.md.
 * Format: # T01: Title
 */
function parseTaskTitle(content, fallback) {
    const m = content.match(/^# \w+:\s*(.+)/m);
    return m ? m[1].trim() : fallback;
}
/**
 * Parse the ## Description body from a GSD-2 task plan.
 */
function parseTaskDescription(content) {
    const m = content.match(/## Description\n+([\s\S]+?)(?:\n## |\n# |$)/);
    return m ? m[1].trim() : '';
}
/**
 * Parse ## Must-Haves items from a GSD-2 task plan.
 */
function parseTaskMustHaves(content) {
    const m = content.match(/## Must-Haves\n+([\s\S]+?)(?:\n## |\n# |$)/);
    if (!m)
        return [];
    return m[1].split('\n')
        .map(l => l.match(/^- \[[ x]\]\s*(.+)/))
        .filter((match) => match !== null)
        .map(match => match[1].trim());
}
/**
 * Read all task plan files from a GSD-2 tasks/ directory.
 */
// #3183 (ADR-3180 Decision 4(a) — bucket B, out of scope for the
// scanPhasePlans migration): this reads a FOREIGN GSD-2 legacy project's own
// `tasks/` directory convention (`T##-PLAN.md`) during a one-time import —
// it is not this project's `.planning/phases/<phase>/` layout at all, has no
// nested-plans/superseded-status concept, and scanPhasePlans's grammar
// (which is scoped to GSD's OWN phase directories) does not apply here.
function readTasksDir(tasksDir) {
    if (!node_fs_1.default.existsSync(tasksDir))
        return [];
    return node_fs_1.default.readdirSync(tasksDir)
        .filter(f => f.endsWith('-PLAN.md'))
        .sort()
        .map(tf => {
        const tid = tf.replace('-PLAN.md', '');
        const plan = readOptional(node_path_1.default.join(tasksDir, tf));
        const summary = readOptional(node_path_1.default.join(tasksDir, `${tid}-SUMMARY.md`));
        return {
            id: tid,
            title: plan ? parseTaskTitle(plan, tid) : tid,
            description: plan ? parseTaskDescription(plan) : '',
            mustHaves: plan ? parseTaskMustHaves(plan) : [],
            plan,
            summary,
            done: !!summary,
        };
    });
}
/**
 * Parse a complete GSD-2 .gsd/ directory into a structured representation.
 */
function parseGsd2(gsdDir) {
    const data = {
        projectContent: readOptional(node_path_1.default.join(gsdDir, 'PROJECT.md')),
        requirements: readOptional(node_path_1.default.join(gsdDir, 'REQUIREMENTS.md')),
        milestones: [],
    };
    const milestonesBase = node_path_1.default.join(gsdDir, 'milestones');
    if (!node_fs_1.default.existsSync(milestonesBase))
        return data;
    const milestoneIds = node_fs_1.default.readdirSync(milestonesBase)
        .filter(d => node_fs_1.default.statSync(node_path_1.default.join(milestonesBase, d)).isDirectory())
        .sort();
    for (const mid of milestoneIds) {
        const mDir = node_path_1.default.join(milestonesBase, mid);
        const roadmapContent = readOptional(node_path_1.default.join(mDir, `${mid}-ROADMAP.md`));
        const slicesDir = node_path_1.default.join(mDir, 'slices');
        const sliceInfos = roadmapContent ? parseSlicesFromRoadmap(roadmapContent) : [];
        const slices = sliceInfos.map(info => {
            const sDir = node_path_1.default.join(slicesDir, info.id);
            const hasSDir = node_fs_1.default.existsSync(sDir);
            return {
                id: info.id,
                title: info.title,
                done: info.done,
                plan: hasSDir ? readOptional(node_path_1.default.join(sDir, `${info.id}-PLAN.md`)) : null,
                summary: hasSDir ? readOptional(node_path_1.default.join(sDir, `${info.id}-SUMMARY.md`)) : null,
                research: hasSDir ? readOptional(node_path_1.default.join(sDir, `${info.id}-RESEARCH.md`)) : null,
                context: hasSDir ? readOptional(node_path_1.default.join(sDir, `${info.id}-CONTEXT.md`)) : null,
                tasks: hasSDir ? readTasksDir(node_path_1.default.join(sDir, 'tasks')) : [],
            };
        });
        data.milestones.push({
            id: mid,
            title: roadmapContent ? (parseMilestoneTitle(roadmapContent) ?? mid) : mid,
            research: readOptional(node_path_1.default.join(mDir, `${mid}-RESEARCH.md`)),
            slices,
        });
    }
    return data;
}
// ─── Artifact Builders ──────────────────────────────────────────────────────
/**
 * Build a GSD v1 PLAN.md from a GSD-2 task.
 */
function buildPlanMd(task, phasePrefix, planPrefix, phaseSlug, milestoneTitle) {
    const lines = [
        '---',
        `phase: "${phasePrefix}"`,
        `plan: "${planPrefix}"`,
        'type: "implementation"',
        '---',
        '',
        '<objective>',
        task.title,
        '</objective>',
        '',
        '<context>',
        `Phase: ${phasePrefix} (${phaseSlug}) — Milestone: ${milestoneTitle}`,
    ];
    if (task.description) {
        lines.push('', task.description);
    }
    lines.push('</context>');
    if (task.mustHaves.length > 0) {
        lines.push('', '<must_haves>');
        for (const mh of task.mustHaves) {
            lines.push(`- ${mh}`);
        }
        lines.push('</must_haves>');
    }
    return lines.join('\n') + '\n';
}
/**
 * Build a GSD v1 SUMMARY.md from a GSD-2 task summary.
 * Strips the GSD-2 frontmatter and preserves the body.
 */
function buildSummaryMd(task, phasePrefix, planPrefix) {
    const raw = task.summary || '';
    // Strip the GSD-2 frontmatter block via the canonical primitive (#2703). The
    // previous local regex required a bare `\n` after the closing `---`, so a
    // CRLF-authored summary never matched, fell through to the untouched-raw
    // branch, and had its frontmatter emitted a second time inside the body of
    // the document this function then wrapped in a fresh v1 block.
    //
    // `extractFrontmatter` — which the issue names — returns only the parsed
    // object and never the body, so it cannot serve this call site;
    // `stripFrontmatter` is the same module's canonical body primitive.
    //
    // `once` is load-bearing. A GSD-2 summary is an arbitrary user-authored
    // document, not a GSD artefact with a known frontmatter-doubling failure
    // mode, so a body opening with a thematic-break-delimited section
    // (`---` / heading / `---`) is far likelier than a corrupt second header —
    // and the default greedy loop would delete it without a trace.
    const body = stripFrontmatter(raw, { once: true }).trim();
    return [
        '---',
        `phase: "${phasePrefix}"`,
        `plan: "${planPrefix}"`,
        '---',
        '',
        body || 'Task completed (migrated from GSD-2).',
        '',
    ].join('\n');
}
/**
 * Build a GSD v1 XX-CONTEXT.md from a GSD-2 slice.
 */
function buildContextMd(slice, phasePrefix) {
    const lines = [
        `# Phase ${phasePrefix} Context`,
        '',
        `Migrated from GSD-2 slice ${slice.id}: ${slice.title}`,
    ];
    const extra = slice.context || '';
    if (extra.trim()) {
        lines.push('', extra.trim());
    }
    return lines.join('\n') + '\n';
}
/**
 * Build the GSD v1 ROADMAP.md with milestone-sectioned format.
 */
function buildRoadmapMd(milestones, phaseMap) {
    const lines = ['# Roadmap', ''];
    for (const milestone of milestones) {
        lines.push(`## ${milestone.id}: ${milestone.title}`, '');
        const mPhases = phaseMap.filter(p => p.milestoneId === milestone.id);
        for (const { slice, phaseNum } of mPhases) {
            const prefix = zeroPad(phaseNum);
            const slug = slugify(slice.title);
            const check = slice.done ? 'x' : ' ';
            lines.push(`- [${check}] **Phase ${prefix}: ${slug}** — ${slice.title}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Build the GSD v1 STATE.md reflecting the current position in the project.
 */
function buildStateMd(phaseMap) {
    const currentEntry = phaseMap.find(p => !p.slice.done);
    const totalPhases = phaseMap.length;
    const donePhases = phaseMap.filter(p => p.slice.done).length;
    // ADR-3180 D7: one owner for completion percent. clampPercent's 100 ceiling is
    // unreachable here (donePhases is a subset of totalPhases) — the value is unchanged.
    const pct = (0, phase_lifecycle_cjs_1.clampPercent)(donePhases, totalPhases);
    const currentPhaseNum = currentEntry ? zeroPad(currentEntry.phaseNum) : zeroPad(totalPhases);
    const currentSlug = currentEntry ? slugify(currentEntry.slice.title) : 'complete';
    const status = currentEntry ? 'Ready to plan' : 'All phases complete';
    const bar = `[${(0, phase_lifecycle_cjs_1.renderProgressBar)(pct, 10)}]`;
    const today = clock_cjs_1.realClock.localToday();
    return [
        '# Project State',
        '',
        '## Project Reference',
        '',
        'See: .planning/PROJECT.md',
        '',
        `**Current focus:** Phase ${currentPhaseNum} (${currentSlug})`,
        '',
        '## Current Position',
        '',
        `Phase: ${currentPhaseNum} of ${zeroPad(totalPhases)} (${currentSlug})`,
        `Status: ${status}`,
        `Last activity: ${today} — Migrated from GSD-2`,
        '',
        `Progress: ${bar} ${pct}%`,
        '',
        '## Accumulated Context',
        '',
        '### Decisions',
        '',
        'Migrated from GSD-2. Review PROJECT.md for key decisions.',
        '',
        '### Blockers/Concerns',
        '',
        'None.',
        '',
        '## Session Continuity',
        '',
        `Last session: ${today}`,
        'Stopped at: Migration from GSD-2 completed',
        'Resume file: None',
        '',
    ].join('\n');
}
// ─── Transformer ─────────────────────────────────────────────────────────────
/**
 * Convert parsed GSD-2 data into a map of relative path → file content.
 * All paths are relative to the .planning/ root.
 */
function buildPlanningArtifacts(gsd2Data) {
    const artifacts = new Map();
    // Passthrough files
    artifacts.set('PROJECT.md', gsd2Data.projectContent || '# Project\n\n(Migrated from GSD-2)\n');
    if (gsd2Data.requirements) {
        artifacts.set('REQUIREMENTS.md', gsd2Data.requirements);
    }
    // Minimal valid v1 config
    artifacts.set('config.json', JSON.stringify({ version: 1 }, null, 2) + '\n');
    // Build sequential phase map: flatten Milestones → Slices into numbered phases
    const phaseMap = [];
    let phaseNum = 1;
    for (const milestone of gsd2Data.milestones) {
        for (const slice of milestone.slices) {
            phaseMap.push({ milestoneId: milestone.id, milestoneTitle: milestone.title, slice, phaseNum });
            phaseNum++;
        }
    }
    artifacts.set('ROADMAP.md', buildRoadmapMd(gsd2Data.milestones, phaseMap));
    artifacts.set('STATE.md', buildStateMd(phaseMap));
    for (const { slice, phaseNum: pNum, milestoneTitle } of phaseMap) {
        const prefix = zeroPad(pNum);
        const slug = slugify(slice.title);
        const dir = `phases/${prefix}-${slug}`;
        artifacts.set(`${dir}/${prefix}-CONTEXT.md`, buildContextMd(slice, prefix));
        if (slice.research) {
            artifacts.set(`${dir}/${prefix}-RESEARCH.md`, slice.research);
        }
        for (let i = 0; i < slice.tasks.length; i++) {
            const task = slice.tasks[i];
            const planPrefix = zeroPad(i + 1);
            artifacts.set(`${dir}/${prefix}-${planPrefix}-PLAN.md`, buildPlanMd(task, prefix, planPrefix, slug, milestoneTitle));
            if (task.done && task.summary) {
                artifacts.set(`${dir}/${prefix}-${planPrefix}-SUMMARY.md`, buildSummaryMd(task, prefix, planPrefix));
            }
        }
    }
    return artifacts;
}
// ─── Preview ─────────────────────────────────────────────────────────────────
/**
 * Format a dry-run preview string for display before writing.
 */
function buildPreview(gsd2Data, artifacts, projectDir) {
    const lines = ['Preview — files that will be created in .planning/:'];
    for (const rel of artifacts.keys()) {
        lines.push(`  ${rel}`);
    }
    const totalSlices = gsd2Data.milestones.reduce((s, m) => s + m.slices.length, 0);
    const doneSlices = gsd2Data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
    const allTasks = gsd2Data.milestones.flatMap(m => m.slices.flatMap(sl => sl.tasks));
    const doneTasks = allTasks.filter(t => t.done).length;
    lines.push('');
    lines.push(`Milestones: ${gsd2Data.milestones.length}`);
    lines.push(`Phases (slices): ${totalSlices} (${doneSlices} completed)`);
    lines.push(`Plans (tasks): ${allTasks.length} (${doneTasks} completed)`);
    lines.push('');
    lines.push('Cannot migrate automatically:');
    lines.push('  - GSD-2 cost/token ledger (no v1 equivalent)');
    lines.push(`  - GSD-2 database state (rebuilt from files on first ${(0, runtime_slash_cjs_1.formatGsdSlash)('health', (0, runtime_slash_cjs_1.resolveRuntime)(projectDir))})`);
    lines.push('  - VS Code extension state');
    return lines.join('\n');
}
// ─── Writer ───────────────────────────────────────────────────────────────────
/**
 * Write all artifacts to the .planning/ directory.
 */
function writePlanningDir(artifacts, planningRoot) {
    for (const [rel, content] of artifacts) {
        const absPath = node_path_1.default.join(planningRoot, rel);
        (0, shell_command_projection_cjs_1.platformWriteSync)(absPath, content);
    }
}
// ─── Command Handler ──────────────────────────────────────────────────────────
/**
 * Entry point called from gsd-tools.cjs.
 * Supports: --force, --dry-run, --path <dir>
 */
function cmdFromGsd2(args, cwd, raw) {
    const force = args.includes('--force');
    const dryRun = args.includes('--dry-run');
    const pathIdx = args.indexOf('--path');
    const projectDir = pathIdx >= 0 && args[pathIdx + 1]
        ? node_path_1.default.resolve(cwd, args[pathIdx + 1])
        : cwd;
    const gsdDir = findGsd2Root(projectDir);
    if (!gsdDir) {
        output({ success: false, error: `No .gsd/ directory found in ${projectDir}` }, raw, undefined);
        return;
    }
    const planningRoot = node_path_1.default.join(node_path_1.default.dirname(gsdDir), '.planning');
    if (node_fs_1.default.existsSync(planningRoot) && !force) {
        output({
            success: false,
            error: `.planning/ already exists at ${planningRoot}. Pass --force to overwrite.`,
        }, raw, undefined);
        return;
    }
    const gsd2Data = parseGsd2(gsdDir);
    const artifacts = buildPlanningArtifacts(gsd2Data);
    // Use projectDir (resolved from --path) — not the process cwd — so the
    // preview command targets the project actually being imported (#3584).
    const preview = buildPreview(gsd2Data, artifacts, projectDir);
    if (dryRun) {
        output({ success: true, dryRun: true, preview }, raw, undefined);
        return;
    }
    writePlanningDir(artifacts, planningRoot);
    output({
        success: true,
        planningDir: planningRoot,
        filesWritten: artifacts.size,
        milestones: gsd2Data.milestones.length,
        preview,
    }, raw, undefined);
}
module.exports = {
    findGsd2Root,
    parseGsd2,
    buildPlanningArtifacts,
    buildPreview,
    writePlanningDir,
    cmdFromGsd2,
    // Exported for unit tests
    parseSlicesFromRoadmap,
    parseMilestoneTitle,
    parseTaskTitle,
    parseTaskDescription,
    parseTaskMustHaves,
    buildPlanMd,
    buildSummaryMd,
    buildContextMd,
    buildRoadmapMd,
    buildStateMd,
    slugify,
    zeroPad,
};
