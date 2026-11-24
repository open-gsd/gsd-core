'use strict';

// Partial-init routing (#4040): the progress, resume-project and new-project workflows route an interrupted
// bootstrap (`init_incomplete` from the init.progress / init.resume payload) to initialization RECOVERY, and that
// branch comes BEFORE the branches that mis-classified the state: progress.md's Route F (between milestones), its
// "no planning structure found" branch, resume-project.md's "reconstruct STATE.md", and new-project.md's "project
// already initialized" error. Was tests/partial-init-routing.test.cjs.

const WORKFLOWS = 'gsd-core/workflows';

module.exports = {
  id: 'partial-init-routing',
  issue: '#4040',
  check(ctx) {
    ctx.doc(`${WORKFLOWS}/progress.md`)
      .satisfies((text) => text.indexOf('init_incomplete') > -1, 'progress.md must branch on init_incomplete')
      .satisfies((text) => text.indexOf('Route F: Between milestones') > -1, 'the Route F definition must exist')
      .satisfies((text) => {
        const recovery = text.indexOf('init_incomplete');
        const routeF = text.indexOf('Route F: Between milestones');
        return recovery > -1 && routeF > -1 && recovery < routeF;
      }, 'the init_incomplete recovery branch must appear before the Route F (between milestones) definition')
      .satisfies((text) => {
        const recovery = text.indexOf('init_incomplete');
        if (recovery === -1) return false;
        const slice = text.slice(recovery, recovery + 1200);
        return /REQUIREMENTS\.md/.test(slice) && /ROADMAP\.md/.test(slice) && /STATE\.md/.test(slice);
      }, 'the recovery branch must name the missing REQUIREMENTS.md / ROADMAP.md / STATE.md artifacts')
      .satisfies((text) => {
        const recovery = text.indexOf('init_incomplete');
        return recovery > -1 && text.slice(recovery, recovery + 1200).includes('new-project');
      }, 'the recovery branch must route to /gsd:new-project to resume initialization')
      .satisfies((text) => text.indexOf('No planning structure found') > -1, 'the no-planning branch must exist')
      .satisfies((text) => {
        const noPlanning = text.indexOf('No planning structure found');
        return noPlanning > -1 && text.slice(Math.max(0, noPlanning - 600), noPlanning).includes('planning_exists');
      }, 'the no-planning branch must check planning_exists so an existing-but-partial .planning/ is not reported as absent');

    ctx.doc(`${WORKFLOWS}/resume-project.md`)
      .satisfies((text) => text.indexOf('init_incomplete') > -1, 'resume-project.md must branch on init_incomplete')
      .satisfies((text) => text.indexOf('Offer to reconstruct STATE.md') > -1, 'the STATE reconstruction branch must exist')
      .satisfies((text) => {
        const recovery = text.indexOf('init_incomplete');
        const reconstruct = text.indexOf('Offer to reconstruct STATE.md');
        return recovery > -1 && reconstruct > -1 && recovery < reconstruct;
      }, 'the init_incomplete recovery branch must appear before the reconstruct-STATE.md branch')
      .satisfies((text) => {
        const parse = text.indexOf('Parse JSON for');
        return parse > -1 && text.slice(parse, parse + 400).includes('init_incomplete');
      }, 'the resume parse list must include init_incomplete (the payload is the source of truth)');

    ctx.doc(`${WORKFLOWS}/new-project.md`)
      .satisfies((text) => {
        const named = text.indexOf('project_already');
        const gate = named > -1 ? named : text.indexOf('If `project_exists` is true');
        return gate > -1;
      }, 'the project_exists gate must exist')
      .satisfies((text) => {
        const named = text.indexOf('project_already');
        const gate = named > -1 ? named : text.indexOf('If `project_exists` is true');
        return gate > -1 && text.slice(gate, gate + 1500).includes('init_incomplete');
      }, 'the project_exists gate must discriminate on init_incomplete (resume a partial bootstrap instead of erroring)');
  },
};
