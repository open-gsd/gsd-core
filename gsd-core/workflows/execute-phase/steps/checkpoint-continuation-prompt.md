Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="checkpoint_continuation_prompt">
The prompt for step 6 of `checkpoint_handling` — spawning the continuation agent after the user
answers a checkpoint. This is the authoritative form: build the prompt from it, do not look for a
template file. (The template this step used to name was retired in January 2026 when the logic
moved into the subagents; the reference to it survived the deletion and dangled until #4783. The
four values it carried are contracted below.)

Substitute each placeholder, keep the section order, and add nothing the fresh agent cannot verify
from the repository:

```
Continue this plan from a checkpoint. You are a FRESH agent — you did not run the tasks below
and must not assume their state; verify each commit before continuing.

## Completed tasks
{completed_tasks_table}

## Resume at
Task {resume_task_number}: {resume_task_name}

## User response to the checkpoint
{user_response}

## Resume instructions
{resume_instructions}
```

- `{completed_tasks_table}`: From checkpoint return
- `{resume_task_number}` + `{resume_task_name}`: Current task
- `{user_response}`: What user provided
- `{resume_instructions}`: Based on checkpoint type

**Why the prompt lives here rather than being improvised per lane.** Step 6 spawns a fresh agent
precisely so that state is explicit rather than serialized, and "explicit" is only worth anything
if every lane makes it the same way. While the four values were listed with no prompt around them,
each lane wrote its own framing — which is the part a fresh agent actually reads first.
</step>
