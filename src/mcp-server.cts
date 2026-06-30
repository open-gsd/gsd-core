/**
 * Companion MCP server (ADR-1239 Phase C-2, #1681 slice 3a).
 *
 * A minimal stdio JSON-RPC 2.0 server exposing two of the six interface points
 * so any MCP-consuming host (Claude/Codex/OpenCode/VS Code/Gemini/Cursor/Cline/
 * Hermes) can drive GSD with NO bespoke plugin:
 *
 *   - point 1 (command): tool `gsd_invoke_command` → the command-routing hub
 *     (`createHub`/`dispatch`, src/command-routing-hub.cts).
 *   - point 5 (state IO): tools `gsd_read_state` / `gsd_write_state` → the
 *     Phase 3 `stateIO` seam (src/state-io.cts, filesystem default).
 *
 * No new runtime dependency — the JSON-RPC stdio loop is hand-rolled (the repo
 * ships only claude-agent-sdk + ws; adding an MCP SDK is a separate packaging
 * decision). The protocol logic (`handleMessage`) is PURE and fully testable;
 * `runServer` is a thin line-delimited-JSON loop over injectable streams.
 *
 * Bin entry / packaging / manifest-version-sync is slice 3b — this module is
 * the additive, importable server surface a host (or the bin shim) drives.
 */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import stateIo = require('./state-io.cjs');

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'gsd-core';
const SERVER_VERSION = '1.7.0';

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpContext {
  cwd?: string;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

const TOOLS = [
  {
    name: 'gsd_invoke_command',
    description: 'Invoke a GSD command via the command-routing hub (interface point 1).',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Command family (e.g. "query", "state", "phase").' },
        subcommand: { type: 'string', description: 'Subcommand name.' },
        args: { type: 'array', items: {}, description: 'Positional args.' },
      },
      required: ['family', 'subcommand'],
    },
  },
  {
    name: 'gsd_read_state',
    description: 'Read a .planning state file (interface point 5).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path under .planning/.' } },
      required: ['path'],
    },
  },
  {
    name: 'gsd_write_state',
    description: 'Write a .planning state file (interface point 5).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path under .planning/.' },
        content: { type: 'string', description: 'File content.' },
      },
      required: ['path', 'content'],
    },
  },
];

function errorResponse(id: unknown, code: number, message: string, data?: unknown) {
  const err: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function okResponse(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function callTool(name: string, args: unknown, ctx: McpContext): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const cwd = asString(ctx.cwd) || process.cwd();
  try {
    if (name === 'gsd_invoke_command') {
      const family = asString(a.family);
      const subcommand = asString(a.subcommand);
      if (!family || !subcommand) {
        return { isError: true, content: [{ type: 'text', text: 'gsd_invoke_command requires string "family" and "subcommand".' }] };
      }
      const hub = commandRoutingHub.createHub();
      const res = hub.dispatch({ family, subcommand, args: Array.isArray(a.args) ? a.args : [], cwd, raw: undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    }
    if (name === 'gsd_read_state') {
      const p = asString(a.path);
      if (!p) return { isError: true, content: [{ type: 'text', text: 'gsd_read_state requires string "path".' }] };
      const io = stateIo.createStateIO({ io: 'filesystem' });
      return { content: [{ type: 'text', text: io.read(p) }] };
    }
    if (name === 'gsd_write_state') {
      const p = asString(a.path);
      const content = asString(a.content);
      if (!p || content === null) return { isError: true, content: [{ type: 'text', text: 'gsd_write_state requires string "path" and "content".' }] };
      const io = stateIo.createStateIO({ io: 'filesystem' });
      io.write(p, content);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, path: p }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

/**
 * Pure JSON-RPC handler. Takes a parsed request object + context, returns a
 * JSON-RPC response object (or null for JSON-RPC notifications — no id).
 */
export function handleMessage(request: JsonRpcRequest, ctx: McpContext = {}): Record<string, unknown> | null {
  if (!request || typeof request !== 'object') {
    return errorResponse(null, INVALID_REQUEST, 'Invalid Request: not an object.');
  }
  const id = request.id;
  // Notification (no id) → no response per JSON-RPC.
  const isNotification = id === undefined || id === null;
  const method = typeof request.method === 'string' ? request.method : '';

  let result: unknown;
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    case 'tools/call': {
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
      const toolName = asString(params.name);
      if (!toolName) return errorResponse(id, INVALID_PARAMS, 'tools/call requires string "name".');
      result = callTool(toolName, params.arguments, ctx);
      break;
    }
    default:
      if (isNotification) return null;
      return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method || '(empty)'}.`);
  }
  if (isNotification) return null;
  return okResponse(id, result);
}

/**
 * Thin stdio loop over injectable streams. Reads line-delimited JSON-RPC from
 * `input`, writes responses (one JSON object + newline) to `output`. Stops when
 * input ends. Errors in handleMessage are caught and emitted as JSON-RPC error
 * responses (the loop never crashes).
 */
export async function runServer({
  input,
  output,
  ctx = {},
}: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  ctx?: McpContext;
}): Promise<void> {
  for await (const chunk of input as AsyncIterable<Buffer>) {
    const lines = chunk.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        output.write(JSON.stringify(errorResponse(null, PARSE_ERROR, 'Parse error.')) + '\n');
        continue;
      }
      try {
        const response = handleMessage(parsed as JsonRpcRequest, ctx);
        if (response) output.write(JSON.stringify(response) + '\n');
      } catch (e) {
        output.write(JSON.stringify(errorResponse(null, INTERNAL_ERROR, e instanceof Error ? e.message : 'Internal error.')) + '\n');
      }
    }
  }
}

// handleMessage + runServer are exported above (export function); PROTOCOL_VERSION
// + SERVER_NAME are exported above (export const).
