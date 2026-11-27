'use strict';

// The gsd-planner agent carries the MVP-mode branch: an MVP Mode Detection section in vertical-slice terms, Walking
// Skeleton handling that names SKELETON.md, a conditional reference to planner-mvp-mode.md, no horizontal/MVP mixing
// language (all-or-nothing per phase), and the user-story PLAN.md header format; the two referenced files exist.
// Was tests/planner-mvp-mode.test.cjs.

module.exports = {
  id: 'planner-mvp-mode',
  check(ctx) {
    ctx.doc('agents/gsd-planner.md')
      .has(/MVP\s{0,20}Mode|MVP_MODE/i, 'must reference MVP mode')
      .has(/vertical[\s-]{0,2}slice/i, 'must use vertical-slice terminology')
      .has(/Walking\s{0,20}Skeleton/i, 'must mention Walking Skeleton')
      .has(/SKELETON\.md/, 'must mention SKELETON.md output')
      .has(/references\/planner-mvp-mode\.md/, 'must reference the MVP-mode rules file')
      // Q1: all-or-nothing per phase. Phrasing that would imply mixing is rejected.
      .lacks(/mix[a-z\s]{0,500}horizontal[a-z\s]{0,500}MVP|MVP[a-z\s]{0,500}and[a-z\s]{0,500}horizontal[a-z\s]{0,500}tasks/i, 'agent must enforce all-or-nothing per phase')
      .has(/Phase\s{0,20}Goal/i, 'must mention the "Phase Goal" header')
      .has(/\*\*As a\*\*[^\n]{0,500}\*\*I want to\*\*[^\n]{0,500}\*\*so that\*\*/i, 'must specify the bolded user-story format for the PLAN.md emit')
      .has(/user-story-template\.md/, 'must reference the user-story-template reference file');
    ctx.exists('gsd-core/references/planner-mvp-mode.md', 'planner-mvp-mode.md must exist');
    ctx.exists('gsd-core/references/skeleton-template.md', 'skeleton-template.md must exist');
  },
};
