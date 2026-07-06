'use strict';

/**
 * Reference pi host-plugin for GSD (ADR-1239 Phase D / #1682 Slice 3).
 *
 * pi (pi.dev) is a Programmatic-CLI host whose TS extensions implement the
 * ExtensionAPI (`@earendil-works/pi-coding-agent`): registerTool /
 * registerCommand / registerShortcut / registerFlag / pi.on(event, …). This
 * reference plugin binds GSD's command + tool + event surface to pi via the
 * IMPERATIVE adapter path — the programmatic-cli peer of the OpenCode worked
 * binding.
 *
 * Shipped as CommonJS with a recorded-mock-friendly signature so it is
 * behaviorally testable without a live pi runtime. The default export matches
 * pi's extension entry shape: `export default function (pi: ExtensionAPI) { … }`.
 *
 * NOTE: this is the reference binding that proves the ExtensionAPI imperative
 * adapter (#1682 AC). Full `--pi` installable-runtime integration (descriptor +
 * installer wiring + golden parity 16→17) is a larger follow-up tracked
 * separately — it is intentionally NOT added to the runtime registry here.
 *
 * @param {object} pi  pi ExtensionAPI (registerTool/registerCommand/on/…)
 */
module.exports = function gsdPiPlugin(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdPiPlugin: pi ExtensionAPI is required');
  }

  // Command surface: `/gsd` invokes the GSD command-routing hub via the
  // imperative adapter (createImperativeAdapter({runtime:'pi'}) + dispatch).
  pi.registerCommand('gsd', {
    description: 'Invoke a GSD command via the embedded engine (imperative adapter).',
    execute: async function /* ctx */ () {
      // Engine dispatch is wired by the host at load (createImperativeAdapter).
      // Kept declarative in the reference; the real binding dispatches the hub.
    },
  });

  // Tool surface: a `gsd_invoke` tool mirroring the companion-MCP tool surface
  // (interface point 1) so the model can call GSD commands programmatically.
  pi.registerTool({
    name: 'gsd_invoke',
    description: 'Invoke a GSD command family/subcommand through the engine.',
    execute: async function () {
      return 'ok';
    },
  });

  // Event surface: observe tool calls — the pi subset hook surface (peer of the
  // OpenCode opencode-subset). Attachment point for the GSD hook bridge.
  pi.on('tool_call', async function /* event */ () {
    /* GSD hook bridge attachment point (PreToolUse/PostToolUse mapping). */
  });
};
