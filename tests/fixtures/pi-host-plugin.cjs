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
 * #2102 Stage 2: registerCommand takes `handler(args, ctx)` (args is the raw
 * string after the command) — NOT `execute(ctx)`, which the original #1682
 * cut used. gsd_invoke's `execute` takes pi's real 5-arg tool-execute
 * signature `(toolCallId, params, signal, onUpdate, ctx)`. See pi/gsd.cjs for
 * the full production binding this reference fixture mirrors.
 *
 * NOTE: this is the reference binding that proves the ExtensionAPI imperative
 * adapter (#1682 AC), kept as a mock-friendly fixture independent of the real
 * `pi/gsd.cjs` extension. Full `--pi` installable-runtime integration
 * (descriptor + installer wiring + golden parity 16→17) shipped in #2102
 * Stage 1 — see capabilities/pi/capability.json and
 * tests/fixtures/golden-install-parity/pi.json.
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
    handler: async function (args, ctx) {
      void args;
      void ctx;
      // Engine dispatch is wired by the host at load (createImperativeAdapter).
      // Kept declarative in the reference; the real binding (pi/gsd.cjs)
      // dispatches through gsd-tools.cjs via dispatchGsdCommand.
    },
  });

  // Tool surface: a `gsd_invoke` tool mirroring the companion-MCP tool surface
  // (interface point 1) so the model can call GSD commands programmatically.
  pi.registerTool({
    name: 'gsd_invoke',
    description: 'Invoke a GSD command family/subcommand through the engine.',
    execute: async function (toolCallId, params, signal, onUpdate, ctx) {
      void toolCallId;
      void params;
      void signal;
      void onUpdate;
      void ctx;
      return 'ok';
    },
  });

  // Event surface: observe tool calls — the pi subset hook surface (peer of the
  // OpenCode opencode-subset). Attachment point for the GSD hook bridge.
  pi.on('tool_call', async function /* event */ () {
    /* GSD hook bridge attachment point (PreToolUse/PostToolUse mapping). */
  });
};
