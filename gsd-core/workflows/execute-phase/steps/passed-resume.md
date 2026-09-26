Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="passed_resume">
Every plan is summarized, verification is `passed`, and the phase is not marked complete. The
run died between `verify_phase_goal` and `update_roadmap` (#3684); verification already exists,
so do not rerun it or any gate that preceded it.

Report:

`"Phase {X} is verified but never marked complete — resuming at update_roadmap (#3684)."`

Continue directly at `update_roadmap`; the remaining tail steps then run in their normal order.
</step>
