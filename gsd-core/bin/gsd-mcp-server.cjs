#!/usr/bin/env node
'use strict';
/**
 * gsd-mcp-server — companion MCP server bin entry (ADR-1239 Phase C-2 / #1681).
 *
 * A stdio JSON-RPC 2.0 server exposing GSD interface points 1 (command) + 5
 * (state IO) so any MCP-consuming host (Claude/Codex/OpenCode/VS Code/Gemini/
 * Cursor/Cline/Hermes) can drive GSD with no bespoke plugin. Delegates to the
 * tested server module (lib/mcp-server.cjs runServer). Reads line-delimited
 * JSON-RPC from stdin, writes one response object + newline per request to
 * stdout, and exits cleanly when stdin closes.
 *
 * The protocol logic (handleMessage) + the injectable-stream loop (runServer)
 * are unit-tested in tests/gsd-mcp-server.test.cjs; the process lifecycle
 * (spawn → JSON-RPC → clean exit) is tested in tests/gsd-mcp-server-bin.test.cjs.
 */
const { runServer } = require('./lib/mcp-server.cjs');

runServer({
  input: process.stdin,
  output: process.stdout,
  ctx: { cwd: process.cwd() },
}).catch((err) => {
  process.stderr.write(String((err && err.message) || err) + '\n');
  // eslint-disable-next-line n/no-process-exit -- bin entry: exit non-zero on a fatal server error.
  process.exit(1);
});
