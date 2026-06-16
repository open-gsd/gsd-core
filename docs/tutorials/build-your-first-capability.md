# Build Your First Capability

In this tutorial you will build a tiny, fully declarative GSD capability from scratch and watch it act inside your project's loop. By the end you will have a working capability installed, visible in `gsd capability list`, and firing at the `plan:pre` extension point.

No code is required. Declarative capabilities — those that own only prompt fragments and hook declarations, with no executable hook scripts or MCP servers — require no trust prompt at install time.

We will build a capability called `hello-note`. It registers a `step` at the `plan:pre` extension point that injects a short greeting fragment into the planner's context and declares that it produces a file called `HELLO.md`.

---

## Before you begin

You need:

- GSD 1.6.0 or later (`gsd --version`).
- A throwaway project directory. Create one now:

```bash
mkdir ~/hello-demo && cd ~/hello-demo
gsd init
```

You will work inside `~/hello-demo` for the rest of this tutorial.

---

## Step 1 — Scaffold the capability folder

Capabilities live in a `capabilities/<id>/` folder. Create the folder structure:

```bash
mkdir -p capabilities/hello-note/fragments
```

Your project tree now looks like this:

```text
~/hello-demo/
  .gsd/
  capabilities/
    hello-note/
      fragments/        ← prompt fragments live here
```

---

## Step 2 — Write the prompt fragment

The fragment is a short Markdown file that will be injected into the planner's context when the `plan:pre` hook fires. Create it:

```bash
cat > capabilities/hello-note/fragments/plan-pre.md << 'EOF'
## Hello from hello-note

This planning session was started with the hello-note capability active.
Record a brief note in HELLO.md summarising the plan goal in one sentence.
EOF
```

Notice that the fragment is plain prose. The capability system inlines it into the agent prompt at dispatch time.

---

## Step 3 — Write `capability.json`

Create the manifest at `capabilities/hello-note/capability.json`:

```json
{
  "id": "hello-note",
  "role": "feature",
  "version": "0.1.0",
  "title": "Hello Note",
  "description": "Injects a greeting note step at plan:pre and produces HELLO.md.",
  "tier": "standard",
  "requires": [],
  "engines": { "gsd": ">=1.6.0" },
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": [],
  "agents": [],
  "config": {},
  "steps": [
    {
      "point": "plan:pre",
      "fragment": { "path": "fragments/plan-pre.md" },
      "produces": ["HELLO.md"],
      "consumes": [],
      "onError": "skip"
    }
  ],
  "contributions": [],
  "gates": []
}
```

A few things to notice:

- `version` is required in 1.6.0. Use semver.
- `engines.gsd` is a hard gate: GSD will refuse to install or load this capability on any version older than 1.6.0.
- `role: "feature"` means this capability adds optional behaviour to the loop — it is not a runtime descriptor.
- The single entry in `steps` attaches at `plan:pre`. `produces` tells the registry that this step writes `HELLO.md`, which lets the registry order hooks and detect unsatisfied dependencies in more complex setups.
- `onError: "skip"` means the loop continues even if this step fails. For a first capability that is the safe choice.

No `ref.agent` or `ref.skill` is declared here because this is a fragment-only step: the planner receives the fragment text inline and acts on it. This keeps the capability completely declarative.

---

## Step 4 — Install the capability into your project

Install from the local path with `--scope project` so it is scoped only to this demo project:

```bash
gsd capability install ./capabilities/hello-note --scope project
```

You will see output similar to:

```
Installing hello-note 0.1.0 …
  Role      : feature
  Scope     : project
  Hooks     : 1 (plan:pre step)
  Executable surfaces : none
✔ hello-note installed.
```

Because `hello-note` declares no executable surfaces (no hook scripts, no MCP servers, no command modules) GSD copies the files to the project capability ledger without displaying a consent prompt. That is intentional — declarative capabilities are safe to install without reviewing runnable code.

---

## Step 5 — Confirm the installation

```bash
gsd capability list
```

You will see at least one row for `hello-note`:

```
id           version  role     scope    status
hello-note   0.1.0    feature  project  enabled
```

You can also query the active hook set for the `plan:pre` point:

```bash
gsd capability hooks plan:pre
```

Expected output (abbreviated):

```json
[
  {
    "capability": "hello-note",
    "point": "plan:pre",
    "kind": "step",
    "produces": ["HELLO.md"],
    "fragment": { "inline": "## Hello from hello-note\n…" }
  }
]
```

Notice that `fragment.inline` now contains the materialised text from `fragments/plan-pre.md`. The capability system inlined it at install time.

---

## Step 6 — Trigger the loop step

Start a planning session. The planner will receive the `hello-note` fragment as part of its context:

```bash
gsd plan
```

Watch the planner output. You will see a line noting that `hello-note` contributed a `plan:pre` step. The planner will produce `HELLO.md` in your project's planning directory as directed by the fragment.

If you are running in an environment where the planner agent is not configured, you can inspect what the resolver would dispatch without running the full agent:

```bash
gsd loop render-hooks plan:pre --raw
```

The JSON output will include your `hello-note` step with its inlined fragment, confirming that the capability is wired into the loop.

---

## Step 7 — Disable the capability

When you want to stop the step from firing, disable the capability:

```bash
gsd capability disable hello-note
```

Run `gsd capability list` again. The `status` column will now show `disabled`. Run `gsd loop render-hooks plan:pre --raw` and you will see that `hello-note` is absent from the active hook set. Disabled capabilities are removed from the resolver output by construction — there is nothing feature-specific for the loop to run.

To re-enable it:

```bash
gsd capability enable hello-note
```

---

## You have built your first capability

You scaffolded a capability folder, wrote a manifest with a single `plan:pre` step, installed it into a project-scoped ledger without a trust prompt, confirmed it in the active hook set, watched it contribute to the planning loop, and disabled it cleanly.

The capability you built is fully declarative: it owns a prompt fragment and a hook declaration, and no executable code was involved at any point.

---

## Where next

- [Publish a capability](../how-to/publish-a-capability.md) — package and share your capability via a URL or registry.
- [Import a capability from a URL](../how-to/import-a-capability-from-a-url.md) — install a third-party capability from a git URL, tarball, or npm package.
- [Capability manifest reference](../reference/capability-manifest.md) — all fields, types, and validation rules for `capability.json`.
- [Capability trust model](../explanation/capability-trust-model.md) — why declarative capabilities need no consent prompt and how executable surfaces are disclosed.
