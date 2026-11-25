# How to enable Serply for web research

**Goal:** Let the researcher agents use [Serply](https://serply.io) Google search for web discovery instead of dropping to the built-in `websearch` fallback.

**Prerequisites:** A Serply API key and a runtime that can run MCP servers.

Serply sits after Exa, Tavily, Perplexity, and Brave in the web waterfall and before the built-in `websearch` fallback. If one of those earlier providers is enabled, it wins and Serply is not called. Serply is off unless you complete both steps below, so nothing is sent to Serply by default.

---

## 1. Tell GSD the key exists

Pick one:

```bash
export SERPLY_API_KEY="<your key>"
```

or put the key in `~/.gsd/serply_api_key` (under `$GSD_HOME` when it is set). New projects then get `serply_search: true` in `.planning/config.json`. For an existing project, set it yourself:

```bash
gsd-tools config-set serply_search true
```

## 2. Register the Serply MCP server as `serply`

The agents call `mcp__serply__google_search`, so the server must be registered under the name `serply`. Follow the [serply-inc/mcp](https://github.com/serply-inc/mcp) setup, for example for Claude Code:

```bash
claude mcp add serply --env SERPLY_API_KEY="<your key>" -- <command from the serply-inc/mcp README>
```

GSD does not register or version the server for you.

---

## Check that it is used

Run a research step (`/gsd-plan-phase` on a phase that needs current web information) and look for `serply` as the provider on the web questions in the research plan.

| What you see | Cause | Fix |
| --- | --- | --- |
| Web questions use `websearch` | `serply_search` is `false` or unset | Complete step 1 and confirm the flag in `.planning/config.json` |
| Web questions use `brave`, `exa`, `tavily`, or `perplexity` | An earlier provider is enabled and wins | Disable that provider's flag if you want Serply |
| `serply` is chosen but the call fails | MCP server missing or not named `serply`, or the key is invalid | Re-do step 2 and check the server runs |

Web results from Serply are rated LOW confidence unless corroborated, the same as the other web providers.

See [Configuration](../CONFIGURATION.md) for the `serply_search` key.
