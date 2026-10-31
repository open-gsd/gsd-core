# Plan Bounce (Optional External Refinement)

Step 12.5 of `/gsd:plan-phase`. The spine reads this file only when bounce is activated.

**Skip if:** `--skip-bounce`, `--gaps`, or bounce not activated (`--bounce` flag or `workflow.plan_bounce` config; `--skip-bounce` always wins). Requires `workflow.plan_bounce_script` set to a valid script path — warn and skip if bounce is activated with no script configured.

For each `*-PLAN.md`: back it up to `*-PLAN.pre-bounce.md`, invoke `${BOUNCE_SCRIPT}` with the plan file and `workflow.plan_bounce_passes` (default 2), validate the result's YAML frontmatter integrity, and restore from backup on either broken frontmatter or a non-zero script exit. After all plans are bounced, re-run the plan checker (step 10) on the modified plans, restoring any that fail. Commit surviving bounced plans if at least one survived (`refactor(${padded_phase}): bounce plans through external refinement`), display a `{survived}/{total}` summary, and remove all `*-PLAN.pre-bounce.md` backups. Exact banner text, messages, and commands: `gsd-core/workflows/plan-phase/detail/elaboration.md` § 12.5.
