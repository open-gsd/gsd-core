'use strict';

/**
 * Behavior locks for the gsd-tools host routers migrated onto the flag-declaration seam in
 * batch 1 (#6087, P1a of #6051). Each case pins the observable result of a VALID argv form on the
 * code as it stood BEFORE the migration: exit code, typed reason (--json-errors) and the stdout
 * shape. The migration (ADR-4909 D1) must leave every one of them unchanged; only argv that no
 * router reads (undeclared flags, stray positionals) becomes a rejection, and the parity test
 * (tests/cli-surface-parity.test.cjs) covers those.
 *
 * Batch 2 (CASES_B2) pins the remaining routers the same way: list-flag runs, multi-word values,
 * eq-forms, repeatable and last-wins flags, bare presence flags and the `--` passthrough.
 *
 * Verbs that already have dedicated flag coverage are not repeated here (see the commit body).
 * Cases that would touch the user's global store (learnings, research-store hits) are limited to
 * the usage paths, and HOME / GSD_HOME point at a throwaway directory for the whole suite.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGit, runNode } = require('./helpers/process-seam.cjs');

const { runTools } = require('./helpers/gsd-tools-cli.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const CASES = [
  {"id":"resolve-granularity bare","argv":["resolve-granularity"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"resolve-granularity flag","argv":["resolve-granularity","--granularity","coarse"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"resolve-granularity positional then flag","argv":["resolve-granularity","standard","--granularity","fine"],"expect":{"exit":0,"reason":null,"shape":"keys:granularity,phase_type,unknown_phase_type"}},
  {"id":"resolve-granularity flag then positional","argv":["resolve-granularity","--granularity","fine","standard"],"expect":{"exit":0,"reason":null,"shape":"keys:granularity,phase_type,unknown_phase_type"}},
  {"id":"resolve-granularity positional only","argv":["resolve-granularity","standard"],"expect":{"exit":0,"reason":null,"shape":"keys:granularity,phase_type,unknown_phase_type"}},
  {"id":"config-path","argv":["config-path"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"migrate-config","argv":["migrate-config"],"expect":{"exit":0,"reason":null,"shape":"keys:migrated,normalizations,skipped,wrote"}},
  {"id":"config-set dry-run","argv":["config-set","workflow.research","false","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:dry_run,key,value,would_update"}},
  {"id":"config-set","argv":["config-set","workflow.research","false"],"expect":{"exit":0,"reason":null,"shape":"keys:key,updated,value"}},
  {"id":"config-new-project dry-run after","argv":["config-new-project","{}","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:config,dry_run,path,would_create"}},
  {"id":"config-new-project dry-run before","argv":["config-new-project","--dry-run","{}"],"expect":{"exit":0,"reason":null,"shape":"keys:config,dry_run,path,would_create"}},
  {"id":"config-new-project dry-run only","argv":["config-new-project","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:config,dry_run,path,would_create"}},
  {"id":"config-new-project choices","argv":["config-new-project","{\"mode\":\"yolo\"}","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:config,dry_run,path,would_create"}},
  {"id":"config-new-project two positionals","argv":["config-new-project","{}","{}"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"config-new-project negative number","argv":["config-new-project","-1"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"check-commit","argv":["check-commit"],"expect":{"exit":0,"reason":null,"shape":"keys:allowed,reason"}},
  {"id":"commit-docs-guard enable","argv":["commit-docs-guard","enable"],"git":true,"expect":{"exit":0,"reason":null,"shape":"keys:action,enabled,path"}},
  {"id":"commit-docs-guard disable","argv":["commit-docs-guard","disable"],"git":true,"expect":{"exit":0,"reason":null,"shape":"keys:action,disabled,path"}},
  {"id":"commit-docs-guard unknown","argv":["commit-docs-guard","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"commit-docs-guard none","argv":["commit-docs-guard"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"runtime-identity","argv":["runtime-identity"],"expect":{"exit":0,"reason":null,"shape":"keys:packageName,version"}},
  {"id":"current-timestamp","argv":["current-timestamp"],"expect":{"exit":0,"reason":null,"shape":"keys:timestamp"}},
  {"id":"current-timestamp date","argv":["current-timestamp","date"],"expect":{"exit":0,"reason":null,"shape":"keys:timestamp"}},
  {"id":"current-timestamp filename","argv":["current-timestamp","filename"],"expect":{"exit":0,"reason":null,"shape":"keys:timestamp"}},
  {"id":"list-todos","argv":["list-todos"],"expect":{"exit":0,"reason":null,"shape":"keys:count,todos"}},
  {"id":"list-todos area","argv":["list-todos","ui"],"expect":{"exit":0,"reason":null,"shape":"keys:count,todos"}},
  {"id":"list-seeds","argv":["list-seeds"],"expect":{"exit":0,"reason":null,"shape":"keys:count,seeds,summary"}},
  {"id":"list-seeds status","argv":["list-seeds","active"],"expect":{"exit":0,"reason":null,"shape":"keys:count,seeds,summary"}},
  {"id":"verify-path-exists present","argv":["verify-path-exists",".planning"],"expect":{"exit":0,"reason":null,"shape":"keys:exists,type"}},
  {"id":"verify-path-exists absent","argv":["verify-path-exists","nope"],"expect":{"exit":0,"reason":null,"shape":"keys:exists,type"}},
  {"id":"quick-tasks-migrate no state","argv":["quick-tasks-migrate"],"expect":{"exit":0,"reason":null,"shape":"keys:migrated,ok,reason"}},
  {"id":"normalize-test-command","argv":["normalize-test-command","npm test"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"resolve-package-manager","argv":["resolve-package-manager","test"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"history-digest","argv":["history-digest"],"expect":{"exit":0,"reason":null,"shape":"keys:decisions,phases,tech_stack"}},
  {"id":"progress bare","argv":["progress"],"expect":{"exit":0,"reason":null,"shape":"keys:milestone_name,milestone_version,percent,phase_scope,phases,total_plans,total_summaries"}},
  {"id":"progress json","argv":["progress","json"],"expect":{"exit":0,"reason":null,"shape":"keys:milestone_name,milestone_version,percent,phase_scope,phases,total_plans,total_summaries"}},
  {"id":"progress table","argv":["progress","table"],"expect":{"exit":0,"reason":null,"shape":"keys:rendered"}},
  {"id":"progress bar","argv":["progress","bar"],"expect":{"exit":0,"reason":null,"shape":"keys:bar,completed,percent,total"}},
  {"id":"stats bare","argv":["stats"],"expect":{"exit":0,"reason":null,"shape":"keys:git_commits,git_first_commit_date,last_activity,milestone_name,milestone_version,percent,phase_scope,phases,phases_completed,phases_total,plan_percent,requirements_complete,requirements_total,total_plans,total_summaries"}},
  {"id":"stats json","argv":["stats","json"],"expect":{"exit":0,"reason":null,"shape":"keys:git_commits,git_first_commit_date,last_activity,milestone_name,milestone_version,percent,phase_scope,phases,phases_completed,phases_total,plan_percent,requirements_complete,requirements_total,total_plans,total_summaries"}},
  {"id":"stats table","argv":["stats","table"],"expect":{"exit":0,"reason":null,"shape":"keys:rendered"}},
  {"id":"phase-plan-index","argv":["phase-plan-index","1"],"expect":{"exit":0,"reason":null,"shape":"keys:error,has_checkpoints,incomplete,phase,plans,ready_plans,runnable,waves"}},
  {"id":"state-snapshot","argv":["state-snapshot"],"files":{".planning/STATE.md":"---\nstatus: executing\n---\n# Project State\n\n## Current Position\n\nPhase: 1\nStatus: executing\n"},"expect":{"exit":0,"reason":null,"shape":"keys:blockers,current_phase,current_phase_name,current_plan,decisions,last_activity,last_activity_desc,paused_at,progress_percent,session,status,total_phases,total_plans_in_phase"}},
  {"id":"skills-root claude","argv":["skills-root","claude"],"expect":{"exit":0,"reason":null,"shape":"keys:skills_root"}},
  {"id":"skills-root unknown","argv":["skills-root","bogus-runtime"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"skills-root none","argv":["skills-root"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"research-store get bad key","argv":["research-store","get","zzz"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-store get no key","argv":["research-store","get"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-store put bad key","argv":["research-store","put","zzz"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-store put missing flags","argv":["research-store","put","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","--content","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-store unknown","argv":["research-store","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"research-plan no input","argv":["research-plan"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-plan missing file","argv":["research-plan","--input","missing.json"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"research-plan bad shape","argv":["research-plan","--input","in.json"],"files":{"in.json":"[]"},"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"template select","argv":["template","select","summary"],"expect":{"exit":0,"reason":null,"shape":"keys:error,template,type"}},
  {"id":"template select none","argv":["template","select"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"template fill","argv":["template","fill","summary","--phase","1","--plan","01","--name","x"],"expect":{"exit":0,"reason":null,"shape":"keys:error,phase"}},
  {"id":"template unknown","argv":["template","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"todo complete dry-run","argv":["todo","complete","nope.md","--dry-run"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"todo complete missing","argv":["todo","complete","nope.md"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"todo match-phase","argv":["todo","match-phase","1"],"expect":{"exit":0,"reason":null,"shape":"keys:matches,phase,todo_count"}},
  {"id":"todo unknown","argv":["todo","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"learnings query no tag","argv":["learnings","query"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"learnings prune no duration","argv":["learnings","prune"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"learnings delete no id","argv":["learnings","delete"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"learnings unknown","argv":["learnings","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"workstream list","argv":["workstream","list"],"expect":{"exit":0,"reason":null,"shape":"keys:message,mode,workstreams"}},
  {"id":"workstream create","argv":["workstream","create","ws1","--no-migrate"],"expect":{"exit":0,"reason":null,"shape":"keys:active,created,migration,path,phases_path,state_path,workstream"}},
  {"id":"workstream create migrate-name","argv":["workstream","create","ws2","--migrate-name","old"],"expect":{"exit":0,"reason":null,"shape":"keys:active,created,migration,path,phases_path,state_path,workstream"}},
  {"id":"workstream get","argv":["workstream","get"],"expect":{"exit":0,"reason":null,"shape":"keys:active,mode"}},
  {"id":"workstream progress","argv":["workstream","progress"],"expect":{"exit":0,"reason":null,"shape":"keys:message,mode,workstreams"}},
  {"id":"workstream status","argv":["workstream","status","nope"],"expect":{"exit":0,"reason":null,"shape":"keys:found,workstream"}},
  {"id":"workstream set","argv":["workstream","set","nope"],"expect":{"exit":0,"reason":null,"shape":"keys:active,error,workstream"}},
  {"id":"workstream complete","argv":["workstream","complete","nope"],"expect":{"exit":0,"reason":null,"shape":"keys:completed,error,workstream"}},
  {"id":"workstream unknown","argv":["workstream","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"drift-guard authority","argv":["drift-guard","authority"],"expect":{"exit":0,"reason":null,"shape":"scalar:string"}},
  {"id":"drift-guard severity","argv":["drift-guard","severity","--status","VERIFIED"],"expect":{"exit":0,"reason":null,"shape":"keys:hardBlock,severity"}},
  {"id":"drift-guard severity authority","argv":["drift-guard","severity","--status","MISSING","--authority","intel"],"expect":{"exit":0,"reason":null,"shape":"keys:hardBlock,severity"}},
  {"id":"drift-guard severity no status","argv":["drift-guard","severity"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --status"}},
  {"id":"drift-guard phase-status","argv":["drift-guard","phase-status"],"files":{".planning/STATE.md":"---\nstatus: executing\n---\n# Project State\n\n## Current Position\n\nPhase: 1\nStatus: executing\n",".planning/ROADMAP.md":"# Roadmap\n\n### Phase 1: First\n\n**Goal:** thing\n"},"expect":{"exit":0,"reason":null,"shape":"keys:authority,phase,reason,roadmapRank,roadmapStatus,stateRank,stateStatus,verdict"}},
  {"id":"drift-guard phase-status phase","argv":["drift-guard","phase-status","--phase","1"],"files":{".planning/STATE.md":"---\nstatus: executing\n---\n# Project State\n\n## Current Position\n\nPhase: 1\nStatus: executing\n",".planning/ROADMAP.md":"# Roadmap\n\n### Phase 1: First\n\n**Goal:** thing\n"},"expect":{"exit":0,"reason":null,"shape":"keys:authority,phase,reason,roadmapRank,roadmapStatus,stateRank,stateStatus,verdict"}},
  {"id":"drift-guard unknown","argv":["drift-guard","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"milestone archive-quick dry-run","argv":["milestone","archive-quick","v1.0","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:archive_dir,dry_run,version,would_archive"}},
  {"id":"milestone archive-quick","argv":["milestone","archive-quick","v1.0"],"expect":{"exit":0,"reason":null,"shape":"keys:archive_dir,archived,entries,state_updated,version,warnings"}},
  {"id":"milestone unknown","argv":["milestone","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"dispatch-should-flatten","argv":["dispatch-should-flatten"],"expect":{"exit":0,"reason":null,"shape":"scalar:boolean"}},
  {"id":"dispatch-should-flatten json","argv":["dispatch-should-flatten","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:dispatch,runtime,shouldFlatten"}},
  {"id":"dispatch-capacity","argv":["dispatch-capacity"],"expect":{"exit":0,"reason":null,"shape":"scalar:number"}},
  {"id":"dispatch-capacity json","argv":["dispatch-capacity","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:capacity,declared,reason,runtime,source"}},
  {"id":"dispatch-isolation","argv":["dispatch-isolation"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"dispatch-isolation json","argv":["dispatch-isolation","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"dispatch-isolation force","argv":["dispatch-isolation","--json","--force-isolation","none"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"dispatch-isolation phase plan","argv":["dispatch-isolation","--json","--phase","1","--plan","01"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"dispatch-isolation cwd-target prompt","argv":["dispatch-isolation","--json","--cwd-target","wt","--prompt","hi"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"inspect-dispatch-isolation","argv":["inspect-dispatch-isolation"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"inspect-dispatch-isolation json","argv":["inspect-dispatch-isolation","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"inspect-dispatch-isolation target","argv":["inspect-dispatch-isolation","--json","--cwd-target","wt","--prompt","hi"],"expect":{"exit":0,"reason":null,"shape":"keys:exec,harnessFlag,isolation,runtime"}},
  {"id":"inspect-dispatch-isolation rejects phase","argv":["inspect-dispatch-isolation","--phase","1"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"resolve-dispatch-type none","argv":["resolve-dispatch-type"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"resolve-dispatch-type requested","argv":["resolve-dispatch-type","--requested","gsd-planner"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"resolve-dispatch-type json","argv":["resolve-dispatch-type","--requested","gsd-planner","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:dispatch,requested,resolved,runtime"}},
  {"id":"resolve-agent none","argv":["resolve-agent"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"resolve-agent name","argv":["resolve-agent","--name","gsd-planner"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"resolve-agent json","argv":["resolve-agent","--name","nonexistent-agent","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:fallback,requested,resolved,runtime"}},
  {"id":"assumption-delta scan","argv":["assumption-delta","scan","1"],"files":{".planning/ROADMAP.md":"# Roadmap\n\n### Phase 1: First\n\n**Goal:** thing\n"},"expect":{"exit":0,"reason":null,"shape":"keys:detected,signals,terms"}},
  {"id":"assumption-delta scan terms","argv":["assumption-delta","scan","1","--terms","a,b"],"files":{".planning/ROADMAP.md":"# Roadmap\n\n### Phase 1: First\n\n**Goal:** thing\n"},"expect":{"exit":0,"reason":null,"shape":"keys:detected,signals,terms"}},
  {"id":"assumption-delta scan terms first","argv":["assumption-delta","scan","--terms","a,b","1"],"files":{".planning/ROADMAP.md":"# Roadmap\n\n### Phase 1: First\n\n**Goal:** thing\n"},"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"assumption-delta no phase","argv":["assumption-delta","scan"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"assumption-delta unknown","argv":["assumption-delta","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"verify-summary","argv":["verify-summary","S.md"],"files":{"S.md":"---\nphase: 01\nplan: 01\nprovides: [a]\nrequires: []\n---\n# Summary\n\nOne-liner: did it\n"},"expect":{"exit":0,"reason":null,"shape":"keys:checks,errors,passed"}},
  {"id":"verify-summary check-count","argv":["verify-summary","S.md","--check-count","3"],"files":{"S.md":"---\nphase: 01\nplan: 01\nprovides: [a]\nrequires: []\n---\n# Summary\n\nOne-liner: did it\n"},"expect":{"exit":0,"reason":null,"shape":"keys:checks,errors,passed"}},
  {"id":"summary-extract","argv":["summary-extract","S.md"],"files":{"S.md":"---\nphase: 01\nplan: 01\nprovides: [a]\nrequires: []\n---\n# Summary\n\nOne-liner: did it\n"},"expect":{"exit":0,"reason":null,"shape":"keys:decisions,key_files,one_liner,path,patterns,requirements_completed,tech_added"}},
  {"id":"summary-extract fields","argv":["summary-extract","S.md","--fields","provides,phase"],"files":{"S.md":"---\nphase: 01\nplan: 01\nprovides: [a]\nrequires: []\n---\n# Summary\n\nOne-liner: did it\n"},"expect":{"exit":0,"reason":null,"shape":"keys:path"}},
  {"id":"websearch bare","argv":["websearch","query"],"expect":{"exit":0,"reason":null,"shape":"keys:available,reason"}},
  {"id":"websearch flags","argv":["websearch","query","--limit","3","--freshness","week"],"expect":{"exit":0,"reason":null,"shape":"keys:available,reason"}},
  {"id":"teams-status","argv":["teams-status"],"expect":{"exit":0,"reason":null,"shape":"keys:active,env_present,runtime,source"}},
  {"id":"teams-status active","argv":["teams-status","--active"],"expect":{"exit":1,"reason":null,"shape":"empty"}},
  {"id":"user-story valid","argv":["user-story","validate","--story","As a user, I want to log in, so that I can work."],"expect":{"exit":0,"reason":null,"shape":"keys:errors,slots,valid"}},
  {"id":"user-story invalid","argv":["user-story","validate","--story","nonsense"],"expect":{"exit":0,"reason":null,"shape":"keys:errors,slots,valid"}},
  {"id":"user-story empty","argv":["user-story","validate"],"expect":{"exit":0,"reason":null,"shape":"keys:errors,slots,valid"}},
  {"id":"user-story unknown","argv":["user-story","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
];

function lastJsonLine(text) {
  const rows = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(rows[i]);
    } catch {
      // keep scanning
    }
  }
  return null;
}

function shapeOf(stdout) {
  if (!stdout) return 'empty';
  try {
    const value = JSON.parse(stdout);
    if (Array.isArray(value)) return 'array';
    if (value !== null && typeof value === 'object') return 'keys:' + Object.keys(value).sort().join(',');
    return 'scalar:' + typeof value;
  } catch {
    return 'text';
  }
}

describe('gsd-tools host routers, batch 1: valid argv forms keep their behavior', () => {
  const saved = {};
  let scratchHome;
  before(() => {
    scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6087-locks-home-'));
    for (const key of ['HOME', 'USERPROFILE', 'GSD_HOME', 'BRAVE_API_KEY']) saved[key] = process.env[key];
    process.env.HOME = scratchHome;
    process.env.USERPROFILE = scratchHome;
    process.env.GSD_HOME = scratchHome;
    process.env.BRAVE_API_KEY = '';
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(scratchHome);
  });

  for (const c of CASES) {
    test(c.id, () => {
      const project = createTempProject();
      try {
        for (const [file, content] of Object.entries(c.files ?? {})) {
          fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
          fs.writeFileSync(path.join(project, file), content);
        }
        if (c.git) runCommand(['git', 'init', '-q'], project);
        const r = runTools(['--json-errors', ...c.argv], project);
        const body = lastJsonLine(r.stderr);
        const reason = body && body.ok === false ? body.reason : null;
        const { message, ...expected } = c.expect;
        if (message !== undefined) {
          assert.ok(body && String(body.message).includes(message), `${c.id}: expected message to mention "${message}", got ${r.stderr.slice(0, 200)}`);
        }
        assert.deepEqual(
          { exit: r.exitCode, reason, shape: shapeOf(r.stdout) },
          expected,
          `${c.id}: stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`,
        );
      } finally {
        cleanup(project);
      }
    });
  }
});

// Batch 2 cases carry optional fixtures beyond `files`: `git` (init + identity), `pre` (argv lists run
// after the files are written), `remove` (files deleted after `pre`), plus extra expectations:
// `stdout` (exact, trimmed), `post` (stdout of a follow-up command) and `exists` (paths present after).
const CASES_B2 = [
  {"id":"re bare","argv":["resolve-execution","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re effort sp","argv":["resolve-execution","gsd-executor","--effort","high"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re effort eq","argv":["resolve-execution","gsd-executor","--effort=high"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re effort before","argv":["resolve-execution","--effort","high","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fast true","argv":["resolve-execution","gsd-executor","--fast-mode","true"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fast eq false","argv":["resolve-execution","gsd-executor","--fast-mode=false"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re attempt sp","argv":["resolve-execution","gsd-executor","--attempt","1"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re attempt eq","argv":["resolve-execution","gsd-executor","--attempt=2"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fc sp","argv":["resolve-execution","gsd-executor","--failure-class","quota-exceeded"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,escalation,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fc eq","argv":["resolve-execution","gsd-executor","--failure-class=unknown-failure"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,escalation,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re host","argv":["resolve-execution","gsd-executor","--host","claude"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_argv,effort_argv_string,effort_argv_value,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,effort_surface,fast_mode,fast_mode_supported,host,model,profile"}},
  {"id":"re combo","argv":["resolve-execution","gsd-executor","--effort=low","--attempt","1","--host","codex"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_argv,effort_argv_string,effort_argv_value,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,effort_surface,fast_mode,fast_mode_supported,host,model,profile"}},
  {"id":"re effort missing","argv":["resolve-execution","gsd-executor","--effort"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re effort flagval","argv":["resolve-execution","gsd-executor","--effort","--host","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re attempt bad","argv":["resolve-execution","gsd-executor","--attempt","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re attempt neg","argv":["resolve-execution","gsd-executor","--attempt=-1"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re fc bad","argv":["resolve-execution","gsd-executor","--failure-class","bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re none","argv":["resolve-execution"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re two","argv":["resolve-execution","gsd-executor","gsd-planner"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop point","argv":["loop","render-hooks","plan:pre"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"loop cfg sp","argv":["loop","render-hooks","plan:pre","--config-dir","cfg"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"loop cfg eq","argv":["loop","render-hooks","plan:pre","--config-dir=cfg"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"loop cap sp","argv":["loop","render-hooks","plan:pre","--active-cap","tdd"],"expect":{"exit":0,"reason":null,"shape":"scalar:boolean"}},
  {"id":"loop cap eq","argv":["loop","render-hooks","plan:pre","--active-cap=tdd"],"expect":{"exit":0,"reason":null,"shape":"scalar:boolean"}},
  {"id":"loop rt sp","argv":["loop","render-hooks","plan:pre","--runtime","claude"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"loop rt eq","argv":["loop","render-hooks","plan:pre","--runtime=claude"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"loop fp sp","argv":["loop","render-hooks","plan:pre","--after-fingerprint","ph"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"loop fp eq","argv":["loop","render-hooks","plan:pre","--after-fingerprint=ph"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"loop cfg missing","argv":["loop","render-hooks","plan:pre","--config-dir"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop cfg eq empty","argv":["loop","render-hooks","plan:pre","--config-dir="],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop cap flagval","argv":["loop","render-hooks","plan:pre","--active-cap","--runtime","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop rt missing","argv":["loop","render-hooks","plan:pre","--runtime"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop fp missing","argv":["loop","render-hooks","plan:pre","--after-fingerprint"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop unknown sub","argv":["loop","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"effort sync","argv":["effort","sync"],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort apply","argv":["effort","sync","--apply","--config-dir","cfg","--runtime","claude"],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort dry","argv":["effort","sync","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort cfg eq","argv":["effort","sync","--config-dir=cfg","--runtime=claude"],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort cfg missing","argv":["effort","sync","--config-dir"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"effort rt missing","argv":["effort","sync","--runtime","--apply"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"effort positional","argv":["effort","sync","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"effort unknown","argv":["effort","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"uc bare","argv":["update-context"],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc json","argv":["update-context","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc cfg sp","argv":["update-context","--config-dir","cfg","--runtime","claude"],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc cfg eq","argv":["update-context","--config-dir=cfg","--runtime=claude"],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc cfg missing","argv":["update-context","--config-dir"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"uc rt missing","argv":["update-context","--runtime","--json"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cp class","argv":["context-predicates","--class","META"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp class eq","argv":["context-predicates","--class=META"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp prefix","argv":["context-predicates","--prefix","RULESET.TESTS"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp prefix eq","argv":["context-predicates","--prefix=RULESET.TESTS"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp contains eq","argv":["context-predicates","--contains=--since"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp contains","argv":["context-predicates","--contains","since"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp anded","argv":["context-predicates","--class","META","--prefix","RULESET"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp none","argv":["context-predicates"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cp class missing","argv":["context-predicates","--class"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cp ws","argv":["context-predicates","--class","   "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cp dup","argv":["context-predicates","--class","META","--class","NOPE"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp dup eq first wins","argv":["context-predicates","--class=A","--class==B"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates"}},
  {"id":"cp dup eq first rejected","argv":["context-predicates","--class==B","--class=A"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"pif bare","argv":["project-instruction-file"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":"AGENTS.md"}},
  {"id":"pif pos","argv":["project-instruction-file","claude"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif sp","argv":["project-instruction-file","--runtime","claude"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif eq","argv":["project-instruction-file","--runtime=claude"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif flag wins","argv":["project-instruction-file","codex","--runtime","claude"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif bare flag","argv":["project-instruction-file","--runtime"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":"AGENTS.md"}},
  {"id":"pif bare flag pos","argv":["project-instruction-file","claude","--runtime"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif eq empty pos","argv":["project-instruction-file","--runtime=","claude"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":".claude/CLAUDE.md"}},
  {"id":"pif retired","argv":["project-instruction-file","--runtime","windsurf"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":"AGENTS.md"}},
  {"id":"rdi none","argv":["record-dispatch-isolation","--isolation","none"],"expect":{"exit":0,"reason":null,"shape":"keys:path,recorded"}},
  {"id":"rdi hf eq","argv":["record-dispatch-isolation","--isolation","harness-worktree","--harness-flag=--worktree"],"expect":{"exit":0,"reason":null,"shape":"keys:path,recorded"}},
  {"id":"rdi hf sp","argv":["record-dispatch-isolation","--isolation","orchestrator-worktree","--harness-flag","x","--phase","1","--plan","01"],"expect":{"exit":0,"reason":null,"shape":"keys:path,recorded"}},
  {"id":"rdi missing","argv":["record-dispatch-isolation"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rdi bad","argv":["record-dispatch-isolation","--isolation","bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rdi flagval","argv":["record-dispatch-isolation","--isolation","--phase","1"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"commit msg files","argv":["commit","msg one","--files","a.txt","b.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"msg one\n\nA\ta.txt\nA\tb.txt"}},
  {"id":"commit multiword msg","argv":["commit","multi","word","msg","--files","a.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"multi word msg\n\nA\ta.txt"}},
  {"id":"commit list amend run","argv":["commit","first","--files","a.txt","--no-verify","b.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"first\n\nA\ta.txt\nA\tb.txt"}},
  {"id":"commit repeated files","argv":["commit","rep","--files","a.txt","--files","b.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"rep\n\nA\ta.txt\nA\tb.txt"}},
  {"id":"commit flag mid","argv":["commit","x","--no-verify","y","--files","a.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"x y\n\nA\ta.txt"}},
  {"id":"commit no msg","argv":["commit","--files","a.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"commit bare","argv":["commit"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"cts files","argv":["commit-to-subrepo","msg","--files","a.txt","b.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"cts no files","argv":["commit-to-subrepo","msg"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"cts bare","argv":["commit-to-subrepo"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"prs full","argv":["pr-subrepo","msg","--repo","r","--branch","b"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"prs no msg","argv":["pr-subrepo","--repo","r"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"prs bare","argv":["pr-subrepo"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"prs flags first","argv":["pr-subrepo","--branch","b","--repo","r"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"ms complete dry","argv":["milestone","complete","v1.0","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:accomplishments,dry_run,name,stats,version,would_archive,would_update"}},
  {"id":"ms complete name","argv":["milestone","complete","v1.0","--name","My","Big","Release","--dry-run"],"expect":{"exit":0,"reason":null,"shape":"keys:accomplishments,dry_run,name,stats,version,would_archive,would_update"}},
  {"id":"ms complete name last","argv":["milestone","complete","v1.0","--dry-run","--name","My","Big","Release"],"expect":{"exit":0,"reason":null,"shape":"keys:accomplishments,dry_run,name,stats,version,would_archive,would_update"}},
  {"id":"ms complete noarch","argv":["milestone","complete","v1.0","--dry-run","--no-archive-phases","--force","--archive-quick"],"expect":{"exit":0,"reason":null,"shape":"keys:accomplishments,dry_run,name,stats,version,would_archive,would_update"}},
  {"id":"ms complete relmap","argv":["milestone","complete","v1.0","--dry-run","--release-map","rm.json"],"files":{"rm.json":"[]"},"expect":{"exit":0,"reason":null,"shape":"keys:accomplishments,dry_run,name,stats,version,would_archive,would_update"}},
  {"id":"ms complete relmap missing","argv":["milestone","complete","v1.0","--release-map"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"ms complete relmap flagval","argv":["milestone","complete","v1.0","--release-map","--dry-run"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"ms complete noconfirm","argv":["milestone","complete","v1.0"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"ms complete none","argv":["milestone","complete"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"ms release-tags","argv":["milestone","release-tags"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"ms none","argv":["milestone"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"scaffold phase-dir","argv":["scaffold","phase-dir","--phase","2","--name","Multi","Word","Name"],"exists":[".planning/phases/02-multi-word-name"],"expect":{"exit":0,"reason":null,"shape":"keys:created,directory,path","exists":[".planning/phases/02-multi-word-name"]}},
  {"id":"scaffold name first","argv":["scaffold","phase-dir","--name","Multi","Word","--phase","3"],"exists":[".planning/phases/03-multi-word"],"expect":{"exit":0,"reason":null,"shape":"keys:created,directory,path","exists":[".planning/phases/03-multi-word"]}},
  {"id":"scaffold bare","argv":["scaffold"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"scaffold unknown type","argv":["scaffold","bogus"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"rl sections","argv":["review-lane","sections","--selected","codex,gemini"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":"codex Codex"}},
  {"id":"rl sections default","argv":["review-lane","sections"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"rl flags","argv":["review-lane","flags"],"expect":{"exit":0,"reason":null,"shape":"text"}},
  {"id":"rl plan","argv":["review-lane","plan","--selected","codex","--run-dir","rd","--repo-root","."],"expect":{"exit":0,"reason":null,"shape":"array"}},
  {"id":"rl avail","argv":["review-lane","availability","--selected","codex"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"rl efa","argv":["review-lane","explicit-from-argv","--","--codex","--agy"],"expect":{"exit":0,"reason":null,"shape":"text","stdout":"antigravity,codex"}},
  {"id":"rl efa none","argv":["review-lane","explicit-from-argv"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"rl efa flags before","argv":["review-lane","explicit-from-argv","--selected","codex","--","--gemini"],"expect":{"exit":0,"reason":null,"shape":"empty","stdout":""}},
  {"id":"rl efa dashed value","argv":["review-lane","explicit-from-argv","--","--bogus","--run-dir","x"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"rl dispatch","argv":["review-lane","dispatch-step","--explicit","codex","--depth","standard","--base-sha","abc","--cap-id","c","--point","p"],"expect":{"exit":0,"reason":null,"shape":"keys:dispatched,ok,reason,results"}},
  {"id":"rl dispatch bare","argv":["review-lane","dispatch-step"],"expect":{"exit":0,"reason":null,"shape":"keys:dispatched,ok,reason,results"}},
  {"id":"rl invoke noslug","argv":["review-lane","invoke"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --slug"}},
  {"id":"rl invoke unknown slug","argv":["review-lane","invoke","--slug","nope"],"expect":{"exit":0,"reason":null,"shape":"keys:detail,ok,reason,slug"}},
  {"id":"rl invoke explicit","argv":["review-lane","invoke","--slug","nope","--explicit","--as","x","--model","m","--agent","a","--prompt-file","p.md"],"expect":{"exit":0,"reason":null,"shape":"keys:detail,ok,reason,slug"}},
  {"id":"rl bogus","argv":["review-lane","bogus"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"rl none","argv":["review-lane"],"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"as bare","argv":["agent-skills","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"as json after","argv":["agent-skills","gsd-executor","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:agent_payload_variant,agent_type,block,configured,degraded,reason,skills_count,source,value,warnings"}},
  {"id":"as json before","argv":["agent-skills","--json","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"keys:agent_payload_variant,agent_type,block,configured,degraded,reason,skills_count,source,value,warnings"}},
  {"id":"as so","argv":["agent-skills","gsd-executor","--skills-only"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"as so before","argv":["agent-skills","--skills-only","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"as both","argv":["agent-skills","--json","--skills-only","gsd-executor"],"expect":{"exit":0,"reason":null,"shape":"keys:agent_payload_variant,agent_type,block,configured,degraded,reason,skills_count,source,value,warnings"}},
  {"id":"as both after","argv":["agent-skills","gsd-executor","--skills-only","--json"],"expect":{"exit":0,"reason":null,"shape":"keys:agent_payload_variant,agent_type,block,configured,degraded,reason,skills_count,source,value,warnings"}},
  {"id":"as none","argv":["agent-skills"],"expect":{"exit":0,"reason":null,"shape":"scalar:string"}},
  {"id":"as none json","argv":["agent-skills","--json"],"expect":{"exit":0,"reason":null,"shape":"scalar:string"}},
  {"id":"as extra pos","argv":["agent-skills","gsd-executor","extra"],"expect":{"exit":0,"reason":null,"shape":"empty"}},
  {"id":"qta task","argv":["quick-tasks-append","--task","do the thing"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant"}},
  {"id":"qta pos","argv":["quick-tasks-append","do the thing"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant"}},
  {"id":"qta all","argv":["quick-tasks-append","--task","x","--quick-id","260101-abc","--slug","sl","--status","Verified"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant"}},
  {"id":"qta dir","argv":["quick-tasks-append","--task","x","--directory","dd"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant"}},
  {"id":"qta none","argv":["quick-tasks-append"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"qta no state","argv":["quick-tasks-append","--task","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"qta two pos","argv":["quick-tasks-append","a","b"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant"}},
  {"id":"pb ok","argv":["prompt-budget","--budget","100000","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"exists":["out.md","out.json"],"expect":{"exit":0,"reason":null,"shape":"empty","exists":["out.md","out.json"]}},
  {"id":"pb two plans","argv":["prompt-budget","--budget","100000","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json","--plan-file","p2.md"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"exists":["out.md","out.json"],"expect":{"exit":0,"reason":null,"shape":"empty","exists":["out.md","out.json"]}},
  {"id":"pb optional","argv":["prompt-budget","--budget","100000","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json","--safety-margin-pct","5","--project-md-head-lines","2","--project-file","proj.md","--context-file","proj.md","--research-file","proj.md","--requirements-file","proj.md"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"exists":["out.md","out.json"],"expect":{"exit":0,"reason":null,"shape":"empty","exists":["out.md","out.json"]}},
  {"id":"pb no budget","argv":["prompt-budget","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --budget"}},
  {"id":"pb bad budget","argv":["prompt-budget","--budget","zero","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":null,"shape":"empty"}},
  {"id":"pb no plan","argv":["prompt-budget","--budget","10","--instructions-file","instr.md","--roadmap-file","road.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --plan-file"}},
  {"id":"pb no instr","argv":["prompt-budget","--budget","10","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --instructions-file"}},
  {"id":"pb no out","argv":["prompt-budget","--budget","10","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","p1.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --output-prompt"}},
  {"id":"pb missing file","argv":["prompt-budget","--budget","10","--instructions-file","nope.md","--roadmap-file","road.md","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":null,"shape":"empty"}},
  {"id":"pb plan flagval","argv":["prompt-budget","--budget","10","--instructions-file","instr.md","--roadmap-file","road.md","--plan-file","--output-prompt","out.md","--output-metadata","out.json"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n","p1.md":"plan one\n","p2.md":"plan two\n","proj.md":"a\nb\nc\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --plan-file"}},
  {"id":"dcf nomanifest","argv":["detect-custom-files","--config-dir","cfg"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:custom_count,custom_files,manifest_found"}},
  {"id":"dcf missing","argv":["detect-custom-files"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"dcf nodir","argv":["detect-custom-files","--config-dir","nope"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"dcf flagval","argv":["detect-custom-files","--config-dir","--bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rcf nomanifest","argv":["restore-custom-files","--config-dir","cfg"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:applied,backup_dir,backup_found,eligible_count,entries,manifest_found,restored_count,skipped_count,warning_count"}},
  {"id":"rcf apply","argv":["restore-custom-files","--config-dir","cfg","--apply"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:applied,backup_dir,backup_found,eligible_count,entries,manifest_found,restored_count,skipped_count,warning_count"}},
  {"id":"rcf apply first","argv":["restore-custom-files","--apply","--config-dir","cfg"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:applied,backup_dir,backup_found,eligible_count,entries,manifest_found,restored_count,skipped_count,warning_count"}},
  {"id":"rcf last wins ok","argv":["restore-custom-files","--config-dir","nope","--config-dir","cfg"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:applied,backup_dir,backup_found,eligible_count,entries,manifest_found,restored_count,skipped_count,warning_count"}},
  {"id":"rcf last wins bad","argv":["restore-custom-files","--config-dir","cfg","--config-dir","nope"],"files":{"cfg/x.txt":"x"},"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rcf missing","argv":["restore-custom-files"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rcf blank","argv":["restore-custom-files","--config-dir"," "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cc provider","argv":["classify-confidence","--provider","official"],"expect":{"exit":0,"reason":null,"shape":"keys:confidence,ecosystem,legitimacyVerdict,package,provider,verified"}},
  {"id":"cc verified","argv":["classify-confidence","--provider","official","--verified"],"expect":{"exit":0,"reason":null,"shape":"keys:confidence,ecosystem,legitimacyVerdict,package,provider,verified"}},
  {"id":"cc flags order","argv":["classify-confidence","--verified","--provider","official"],"expect":{"exit":0,"reason":null,"shape":"keys:confidence,ecosystem,legitimacyVerdict,package,provider,verified"}},
  {"id":"cc none","argv":["classify-confidence"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cc provider flagval","argv":["classify-confidence","--provider","--verified"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cc pkg noeco","argv":["classify-confidence","--provider","x","--package","left-pad"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cc pkg badeco","argv":["classify-confidence","--provider","x","--package","left-pad","--ecosystem","bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"cc eco only","argv":["classify-confidence","--provider","x","--ecosystem","npm"],"expect":{"exit":0,"reason":null,"shape":"keys:confidence,ecosystem,legitimacyVerdict,package,provider,verified"}},
  {"id":"pl none","argv":["package-legitimacy"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"pl unknown sub","argv":["package-legitimacy","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"pl noeco","argv":["package-legitimacy","check","left-pad"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"pl badeco","argv":["package-legitimacy","check","--ecosystem","bogus","x"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"pl nopkg","argv":["package-legitimacy","check","--ecosystem","npm"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"pl unknown flag","argv":["package-legitimacy","check","--ecosystem","npm","--bogus","pkg"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"pl eco flagval","argv":["package-legitimacy","check","--ecosystem","--bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"srv no scope","argv":["select-revert-commits","--range","HEAD~1..HEAD"],"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"srv no range","argv":["select-revert-commits","--phase","1"],"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"srv both","argv":["select-revert-commits","--phase","1","--plan","1-1","--range","HEAD"],"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"fm get","argv":["frontmatter","get","f.md","--field","a"],"files":{"f.md":"---\na: 1\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:a"}},
  {"id":"fm set","argv":["frontmatter","set","f.md","--field","a","--value","2"],"files":{"f.md":"---\na: 1\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:field,updated,value"}},
  {"id":"fm merge","argv":["frontmatter","merge","f.md","--data","{\"b\":2}"],"files":{"f.md":"---\na: 1\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:fields,merged"}},
  {"id":"fm validate","argv":["frontmatter","validate","f.md","--schema","plan"],"files":{"f.md":"---\na: 1\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:invalidValue,missing,present,schema,valid"}},
  {"id":"uat render","argv":["uat","render-checkpoint","--file","u.md"],"files":{"u.md":"---\nstatus: testing\n---\n# UAT\n"},"expect":{"exit":1,"reason":"unknown","shape":"empty"}},
  {"id":"uat complete","argv":["uat","complete-session","u.md","--message","m"],"files":{"u.md":"---\nstatus: testing\n---\n# UAT\n"},"expect":{"exit":0,"reason":null,"shape":"keys:changed,committed,reason,status"}},
  {"id":"uat classify","argv":["uat","classify-coverage","--summary","s.md"],"files":{"s.md":"---\nphase: 01\n---\n# S\n"},"expect":{"exit":0,"reason":null,"shape":"keys:all_auto_covered,auto_passed,errors,mode,present,summary_file,total"}},
  {"id":"uat bogus","argv":["uat","bogus"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
  {"id":"commit files removed","argv":["commit","rm","--files","a.txt","--files-removed","c.txt","d.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"pre":[["git","add","c.txt","d.txt"],["git","commit","-q","-m","seed"]],"remove":["c.txt","d.txt"],"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"rm\n\nA\ta.txt\nD\tc.txt\nD\td.txt"}},
  {"id":"commit removed first","argv":["commit","rm","--files-removed","c.txt","--files","a.txt","b.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"pre":[["git","add","c.txt","d.txt"],["git","commit","-q","-m","seed"]],"remove":["c.txt"],"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"rm\n\nA\ta.txt\nA\tb.txt\nD\tc.txt"}},
  {"id":"commit amend seeded","argv":["commit","am","--amend","--files","a.txt"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"pre":[["git","add","c.txt","d.txt"],["git","commit","-q","-m","seed"]],"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"seed\n\nA\ta.txt\nA\tc.txt\nA\td.txt"}},
  {"id":"commit amend after list","argv":["commit","am2","--files","a.txt","--amend"],"files":{"a.txt":"a\n","b.txt":"b\n","c.txt":"c\n","d.txt":"d\n"},"git":true,"pre":[["git","add","c.txt","d.txt"],["git","commit","-q","-m","seed"]],"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"seed\n\nA\ta.txt\nA\tc.txt\nA\td.txt"}},
  {"id":"scm all","argv":["stamp-codebase-map"],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"pre":[["git","add","."],["git","commit","-q","-m","seed"]],"expect":{"exit":0,"reason":null,"shape":"keys:commit,failed,reason,skipped,stamped,stamped_at"}},
  {"id":"scm files","argv":["stamp-codebase-map","--files","STACK.md,ARCHITECTURE.md"],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"pre":[["git","add","."],["git","commit","-q","-m","seed"]],"expect":{"exit":0,"reason":null,"shape":"keys:commit,failed,reason,skipped,stamped,stamped_at"}},
  {"id":"scm files spaced","argv":["stamp-codebase-map","--files"," STACK.md , TESTING.md "],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"pre":[["git","add","."],["git","commit","-q","-m","seed"]],"expect":{"exit":0,"reason":null,"shape":"keys:commit,failed,reason,skipped,stamped,stamped_at"}},
  {"id":"scm bare files","argv":["stamp-codebase-map","--files"],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"pre":[["git","add","."],["git","commit","-q","-m","seed"]],"expect":{"exit":0,"reason":null,"shape":"keys:commit,reason,skipped,stamped,stamped_at"}},
  {"id":"scm empty files","argv":["stamp-codebase-map","--files",""],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"pre":[["git","add","."],["git","commit","-q","-m","seed"]],"expect":{"exit":0,"reason":null,"shape":"keys:commit,reason,skipped,stamped,stamped_at"}},
  {"id":"scm files then flag","argv":["stamp-codebase-map","--files","--bogus"],"files":{".planning/codebase/STACK.md":"# Stack\n",".planning/codebase/ARCHITECTURE.md":"# Arch\n",".planning/codebase/TESTING.md":"# Testing\n"},"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"scaffold ctx","argv":["scaffold","context","--phase","1"],"files":{".planning/phases/01-x/.keep":""},"exists":[".planning/phases/01-x/01-CONTEXT.md"],"expect":{"exit":0,"reason":null,"shape":"keys:created,path","exists":[".planning/phases/01-x/01-CONTEXT.md"]}},
  {"id":"scaffold ctx name","argv":["scaffold","context","--phase","1","--name","Two","Words"],"files":{".planning/phases/01-x/.keep":""},"exists":[".planning/phases/01-x/01-CONTEXT.md"],"expect":{"exit":0,"reason":null,"shape":"keys:created,path","exists":[".planning/phases/01-x/01-CONTEXT.md"]}},
  // Review fixes (#6087): empty and padded values, duplicate flags (the seam is first-wins), stray words and
  // trailing valueless flags, pinned on the behavior of the code before the migration where it was kept.
  {"id":"uc runtime empty","argv":["update-context","--runtime",""],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc runtime eq empty","argv":["update-context","--runtime="],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc cfg empty","argv":["update-context","--config-dir",""],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc cfg eq empty","argv":["update-context","--config-dir="],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"uc runtime dup","argv":["update-context","--runtime","claude","--runtime","codex"],"expect":{"exit":0,"reason":null,"shape":"keys:gsdDir,installedVersion,runtime,scope"}},
  {"id":"re effort empty","argv":["resolve-execution","gsd-executor","--effort",""],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re effort eq empty","argv":["resolve-execution","gsd-executor","--effort="],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fast empty","argv":["resolve-execution","gsd-executor","--fast-mode",""],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re fast eq empty","argv":["resolve-execution","gsd-executor","--fast-mode="],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re host empty","argv":["resolve-execution","gsd-executor","--host",""],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile"}},
  {"id":"re attempt empty","argv":["resolve-execution","gsd-executor","--attempt",""],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re attempt eq empty","argv":["resolve-execution","gsd-executor","--attempt="],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re fc empty","argv":["resolve-execution","gsd-executor","--failure-class",""],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"re fc eq empty","argv":["resolve-execution","gsd-executor","--failure-class="],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"effort rt eq empty","argv":["effort","sync","--runtime="],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort cfg eq empty","argv":["effort","sync","--config-dir="],"expect":{"exit":0,"reason":null,"shape":"keys:agents_dir,changes,dry_run,reason,skipped,synced"}},
  {"id":"effort rt empty","argv":["effort","sync","--runtime",""],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"effort cfg empty","argv":["effort","sync","--config-dir",""],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop rt eq blank","argv":["loop","render-hooks","plan:pre","--runtime= "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop cfg eq blank","argv":["loop","render-hooks","plan:pre","--config-dir=  "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop cap eq blank","argv":["loop","render-hooks","plan:pre","--active-cap= "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop fp eq blank","argv":["loop","render-hooks","plan:pre","--after-fingerprint= "],"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"loop fp eq padded","argv":["loop","render-hooks","plan:pre","--after-fingerprint= ph"],"expect":{"exit":1,"reason":"unknown","shape":"empty","message":"unreadable: ph ("}},
  {"id":"loop rt eq padded","argv":["loop","render-hooks","plan:pre","--runtime= claude"],"expect":{"exit":0,"reason":null,"shape":"keys:activeHooks,point,rendered"}},
  {"id":"prs stray word","argv":["pr-subrepo","msg","extra","--repo","r"],"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty","message":"unexpected positional argument \"extra\""}},
  {"id":"prs stray word no msg","argv":["pr-subrepo","--repo","r","extra"],"git":true,"expect":{"exit":1,"reason":"usage","shape":"empty","message":"unexpected positional argument \"extra\""}},
  {"id":"rcf trailing bare","argv":["restore-custom-files","--config-dir","cfg","--config-dir"],"files":{"cfg/x.txt":"x"},"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rcf trailing flagval","argv":["restore-custom-files","--config-dir","cfg","--config-dir","--apply"],"files":{"cfg/x.txt":"x"},"expect":{"exit":1,"reason":"usage","shape":"empty"}},
  {"id":"rcf empty then good","argv":["restore-custom-files","--config-dir","","--config-dir","cfg"],"files":{"cfg/x.txt":"x"},"expect":{"exit":0,"reason":null,"shape":"keys:applied,backup_dir,backup_found,eligible_count,entries,manifest_found,restored_count,skipped_count,warning_count"}},
  {"id":"commit bare dashes in list","argv":["commit","dd","--files","a.txt","--","b.txt"],"git":true,"files":{"a.txt":"a\n","b.txt":"b\n"},"post":["git","log","--format=%s","--name-status","-1"],"expect":{"exit":0,"reason":null,"shape":"keys:committed,hash,reason","post":"dd\n\nA\ta.txt\nA\tb.txt"}},
  {"id":"re dup effort first wins","argv":["resolve-execution","gsd-executor","--effort","low","--effort","high"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile","json":{"effort":"low"}}},
  {"id":"re dup effort space then eq","argv":["resolve-execution","gsd-executor","--effort","low","--effort=high"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile","json":{"effort":"low"}}},
  {"id":"re dup effort eq then space","argv":["resolve-execution","gsd-executor","--effort=high","--effort","low"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile","json":{"effort":"high"}}},
  {"id":"loop dup fingerprint first wins","argv":["loop","render-hooks","plan:pre","--after-fingerprint","ph","--after-fingerprint=qq"],"expect":{"exit":1,"reason":"unknown","shape":"empty","message":"unreadable: ph ("}},
  {"id":"loop dup fingerprint eq first","argv":["loop","render-hooks","plan:pre","--after-fingerprint=qq","--after-fingerprint","ph"],"expect":{"exit":1,"reason":"unknown","shape":"empty","message":"unreadable: qq ("}},
  {"id":"rdi dup harness-flag space first","argv":["record-dispatch-isolation","--isolation","harness-worktree","--harness-flag","x","--harness-flag=--worktree"],"post":["node","-e","console.log(JSON.parse(require('fs').readFileSync('.gsd/dispatch-isolation-sentinel.json','utf8')).harness_flag)"],"expect":{"exit":0,"reason":null,"shape":"keys:path,recorded","post":"x"}},
  {"id":"rdi dup harness-flag eq first","argv":["record-dispatch-isolation","--isolation","harness-worktree","--harness-flag=--worktree","--harness-flag","x"],"post":["node","-e","console.log(JSON.parse(require('fs').readFileSync('.gsd/dispatch-isolation-sentinel.json','utf8')).harness_flag)"],"expect":{"exit":0,"reason":null,"shape":"keys:path,recorded","post":"--worktree"}},
  {"id":"qta leading flag then word","argv":["quick-tasks-append","--status","ok","desc words"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant","contains":{"row":"desc words"},"excludes":{"row":"--status"}}},
  {"id":"qta leading flag only","argv":["quick-tasks-append","--status","ok"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"requires --task"}},
  {"id":"qta task flag wins over word","argv":["quick-tasks-append","word","--task","flagged"],"files":{".planning/STATE.md":"# Project State\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Directory |\n|---|-------------|------|--------|-----------|\n"},"expect":{"exit":0,"reason":null,"shape":"keys:ok,row,variant","contains":{"row":"flagged"}}},
  {"id":"fm get positional field","argv":["frontmatter","get","f.md","title"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:title","json":{"title":"Hi"}}},
  {"id":"fm get positional field via query","argv":["query","frontmatter.get","f.md","status"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:status","json":{"status":"complete"}}},
  {"id":"fm get field flag","argv":["frontmatter","get","f.md","--field","title"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:title","json":{"title":"Hi"}}},
  {"id":"fm get no field","argv":["frontmatter","get","f.md"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":0,"reason":null,"shape":"keys:status,title"}},
  {"id":"fm get two positional fields","argv":["frontmatter","get","f.md","title","status"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"unexpected positional argument \"status\""}},
  {"id":"fm get field flag and positional","argv":["frontmatter","get","f.md","--field","title","status"],"files":{"f.md":"---\ntitle: Hi\nstatus: complete\n---\nbody\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"unexpected positional argument \"status\""}},
  {"id":"re short flag","argv":["resolve-execution","gsd-executor","-x"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"Unknown flag for resolve-execution: -x"}},
  {"id":"re unknown long flag","argv":["resolve-execution","gsd-executor","--bogus"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"Unknown flag for resolve-execution: --bogus"}},
  {"id":"loop cap space blank passes untrimmed","argv":["loop","render-hooks","plan:pre","--active-cap","  "],"expect":{"exit":0,"reason":null,"shape":"scalar:boolean"}},
  {"id":"loop fp space padded stays padded","argv":["loop","render-hooks","plan:pre","--after-fingerprint"," x "],"expect":{"exit":1,"reason":"unknown","shape":"empty","message":"unreadable:  x  ("}},
  {"id":"loop fp eq padded is trimmed","argv":["loop","render-hooks","plan:pre","--after-fingerprint=  x "],"expect":{"exit":1,"reason":"unknown","shape":"empty","message":"unreadable: x ("}},
  {"id":"cp class space leading equals is a value","argv":["context-predicates","--class","=A"],"expect":{"exit":0,"reason":null,"shape":"keys:matched,predicates","json":{"matched":0}}},
  {"id":"cp class eq double equals","argv":["context-predicates","--class==A"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --class requires a non-empty value"}},
  {"id":"cp prefix eq double equals","argv":["context-predicates","--prefix==A"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --prefix requires a non-empty value"}},
  {"id":"cp class eq empty wording","argv":["context-predicates","--class="],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --class requires a non-empty value"}},
  {"id":"cp class absent wording","argv":["context-predicates","--class"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --class requires a non-empty value"}},
  {"id":"cp class eq blank wording","argv":["context-predicates","--class= "],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --class requires a non-empty value"}},
  {"id":"cp class space blank wording","argv":["context-predicates","--class","  "],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"context-predicates: --class requires a non-empty value"}},
  {"id":"pb nothing reports budget first","argv":["prompt-budget"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --budget"}},
  {"id":"pb only plan reports budget first","argv":["prompt-budget","--plan-file","p1.md","--output-prompt","out.md","--output-metadata","out.json"],"files":{"p1.md":"plan one\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --budget"}},
  {"id":"pb budget only reports instructions next","argv":["prompt-budget","--budget","10"],"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --instructions-file"}},
  {"id":"pb budget instructions reports roadmap next","argv":["prompt-budget","--budget","10","--instructions-file","instr.md"],"files":{"instr.md":"instructions\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --roadmap-file"}},
  {"id":"pb budget instructions roadmap reports plan next","argv":["prompt-budget","--budget","10","--instructions-file","instr.md","--roadmap-file","road.md"],"files":{"instr.md":"instructions\n","road.md":"# Roadmap\n"},"expect":{"exit":1,"reason":"usage","shape":"empty","message":"missing required flag --plan-file"}},
  {"id":"re dup effort first wins high then low","argv":["resolve-execution","gsd-executor","--effort","high","--effort","low"],"expect":{"exit":0,"reason":null,"shape":"keys:effort,effort_clamp_reason,effort_clamped,effort_effective,effort_effective_source,effort_param,effort_propagation,effort_rendered,effort_requested,fast_mode,fast_mode_supported,model,profile","json":{"effort":"high"}}},
];

function runCommand(argv, cwd) {
  let r;
  if (argv[0] === 'git') r = runGit(argv.slice(1), { cwd, timeoutMs: GIT_TIMEOUT_MS });
  else if (argv[0] === 'node') r = runNode(argv.slice(1), { cwd, timeoutMs: GIT_TIMEOUT_MS });
  else throw new Error(`runCommand: unsupported command ${argv[0]}`);
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.summary}`);
  return r.stdout;
}

describe('gsd-tools host routers, batch 2: valid argv forms keep their behavior', () => {
  const saved = {};
  let scratchHome;
  before(() => {
    scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-6087-locks-b2-home-'));
    for (const key of ['HOME', 'USERPROFILE', 'GSD_HOME', 'BRAVE_API_KEY']) saved[key] = process.env[key];
    process.env.HOME = scratchHome;
    process.env.USERPROFILE = scratchHome;
    process.env.GSD_HOME = scratchHome;
    process.env.BRAVE_API_KEY = '';
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(scratchHome);
  });

  for (const c of CASES_B2) {
    test(c.id, () => {
      const project = createTempProject();
      try {
        for (const [file, content] of Object.entries(c.files ?? {})) {
          fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
          fs.writeFileSync(path.join(project, file), content);
        }
        if (c.git) {
          runCommand(['git', 'init', '-q'], project);
          runCommand(['git', 'config', 'user.email', 'locks@example.invalid'], project);
          runCommand(['git', 'config', 'user.name', 'locks'], project);
        }
        for (const step of c.pre ?? []) runCommand(step, project);
        for (const file of c.remove ?? []) cleanup(path.join(project, file));
        const r = runTools(['--json-errors', ...c.argv], project);
        const body = lastJsonLine(r.stderr);
        const reason = body && body.ok === false ? body.reason : null;
        const actual = { exit: r.exitCode, reason, shape: shapeOf(r.stdout) };
        const { message, json, contains, excludes, ...expected } = c.expect;
        if (message !== undefined) {
          assert.ok(body && String(body.message).includes(message), `${c.id}: expected error to mention "${message}", got ${r.stderr.slice(0, 200)}`);
        }
        if (json !== undefined) {
          const parsed = JSON.parse(r.stdout);
          for (const [key, value] of Object.entries(json)) assert.deepEqual(parsed[key], value, `${c.id}: ${key}`);
        }
        if (contains !== undefined || excludes !== undefined) {
          const parsed = JSON.parse(r.stdout);
          for (const [key, value] of Object.entries(contains ?? {})) assert.ok(String(parsed[key]).includes(value), `${c.id}: ${key} should include ${value}: ${parsed[key]}`);
          for (const [key, value] of Object.entries(excludes ?? {})) assert.ok(!String(parsed[key]).includes(value), `${c.id}: ${key} should not include ${value}: ${parsed[key]}`);
        }
        if (c.expect.stdout !== undefined) actual.stdout = r.stdout.trim().replace(/\s+/g, ' ');
        if (c.post) actual.post = runCommand(c.post, project).trim();
        if (c.exists) actual.exists = c.exists.filter((f) => fs.existsSync(path.join(project, f)));
        assert.deepEqual(actual, expected, `${c.id}: stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
      } finally {
        cleanup(project);
      }
    });
  }
});
