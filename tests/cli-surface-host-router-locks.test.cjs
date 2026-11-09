'use strict';

/**
 * Behavior locks for the gsd-tools host routers migrated onto the flag-declaration seam in
 * batch 1 (#6087, P1a of #6051). Each case pins the observable result of a VALID argv form on the
 * code as it stood BEFORE the migration: exit code, typed reason (--json-errors) and the stdout
 * shape. The migration (ADR-4909 D1) must leave every one of them unchanged; only argv that no
 * router reads (undeclared flags, stray positionals) becomes a rejection, and the parity test
 * (tests/cli-surface-parity.test.cjs) covers those.
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
const { execFileSync } = require('node:child_process');

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
  {"id":"drift-guard severity no status","argv":["drift-guard","severity"],"expect":{"exit":1,"reason":"sdk_unknown_command","shape":"empty"}},
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
        if (c.git) execFileSync('git', ['init', '-q'], { cwd: project, timeout: GIT_TIMEOUT_MS });
        const r = runTools(['--json-errors', ...c.argv], project);
        const body = lastJsonLine(r.stderr);
        const reason = body && body.ok === false ? body.reason : null;
        assert.deepEqual(
          { exit: r.exitCode, reason, shape: shapeOf(r.stdout) },
          c.expect,
          `${c.id}: stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`,
        );
      } finally {
        cleanup(project);
      }
    });
  }
});
