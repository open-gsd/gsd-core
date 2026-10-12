/**
 * The OpenCode MCP entry GSD's installer writes (`mcp.gsd`, or the 2.x native `mcp.servers.gsd`).
 * One owner for "is this entry ours" so install, uninstall and migration 011 cannot drift apart
 * (#5333, #5338; epic #5331).
 */

import { PACKAGE_NAME } from './package-identity.cjs';

/** Withholds the MCP prompt catalog: OpenCode turns MCP prompts into `<server>:<prompt>` slash commands. */
export const GSD_MCP_NO_PROMPTS_FLAG = '--no-prompts';

export interface OpencodeMcpEntry {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

/**
 * True when `entry` is the MCP server entry the installer writes: a local `npx … gsd-mcp-server`
 * command for this package, pinned or not. A user-edited or user-defined `gsd` entry does not match.
 * Recognizes both generations' shapes (`enabled` on 1.x, `disabled` on 2.x) because it keys only on
 * `type` and `command`.
 */
export function isGsdMcpEntry(entry: unknown): entry is OpenCodeMcpEntryShape {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as OpencodeMcpEntry;
  if (e.type !== 'local' || !Array.isArray(e.command)) return false;
  const [bin, ...rest] = e.command as unknown[];
  if (bin !== 'npx' || !rest.includes('gsd-mcp-server')) return false;
  return rest.some((a) => typeof a === 'string' && (a === PACKAGE_NAME || a.startsWith(`${PACKAGE_NAME}@`)));
}

type OpenCodeMcpEntryShape = OpencodeMcpEntry & { command: unknown[] };

/** True when the entry already carries the no-prompts flag. */
export function hasNoPromptsFlag(entry: OpenCodeMcpEntryShape): boolean {
  return entry.command.includes(GSD_MCP_NO_PROMPTS_FLAG);
}

/** The entry with `--no-prompts` appended to its command (other fields untouched). */
export function withNoPromptsFlag(entry: OpenCodeMcpEntryShape): OpenCodeMcpEntryShape {
  return hasNoPromptsFlag(entry) ? entry : { ...entry, command: [...entry.command, GSD_MCP_NO_PROMPTS_FLAG] };
}
