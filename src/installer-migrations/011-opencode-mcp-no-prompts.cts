/**
 * Installer migration: stop the GSD MCP companion from duplicating every GSD command in OpenCode
 * (#5338; epic #5331, ADR-5331 D6).
 *
 * OpenCode turns each MCP prompt into a `<server>:<prompt>` slash command. The GSD companion server
 * advertised its whole prompt catalog, so with the command files the installer already writes every GSD
 * command appeared twice (`gsd-plan-phase` and `gsd:plan-phase`; 143 entries against 72 observed on
 * OpenCode 2.0.27). New installs register the server with `--no-prompts`. This migration converges an
 * existing install by adding that flag to the `gsd` MCP entry GSD itself wrote — and only that entry: a
 * `gsd` server the user edited or defined does not match the installer's shape and is never touched.
 *
 * It applies to OpenCode on both generations (the entry is the same shape), covers the 1.x `mcp.gsd` and
 * the 2.x native `mcp.servers.gsd` locations, and edits the config as text so a commented `opencode.jsonc`
 * keeps its comments and layout (#5334).
 *
 * Is the action safe in non-interactive install?
 *   Yes. `rewrite-json` is non-interactive and journaled; the rewrite is a one-token append to a command
 *   array the installer wrote.
 *
 * See docs/installer-migrations.md#shipped-migrations and the OpenCode row of
 * docs/installer-migrations.md#runtime-configuration-contract-registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../jsonc-edit.cjs';
import { isGsdMcpEntry, hasNoPromptsFlag, withNoPromptsFlag } from '../opencode-mcp-entry.cjs';

interface MigrationPlanContext {
  configDir: string;
  runtime: string | null;
  scope: string;
}

interface JsoncEdit {
  path: string[];
  value: unknown;
}

interface MigrationAction {
  type: 'rewrite-json';
  relPath: string;
  value: unknown;
  edits: JsoncEdit[];
  reason: string;
  ownershipEvidence: string;
}

interface InstallerMigration {
  id: string;
  title: string;
  description: string;
  introducedIn: string;
  runtimes: string[];
  scopes: string[];
  destructive: boolean;
  runtimeContract: string;
  plan: (ctx: MigrationPlanContext) => MigrationAction[];
}

/** OpenCode reads `opencode.jsonc` in preference to `opencode.json` when both exist. */
const CONFIG_CANDIDATES = ['opencode.jsonc', 'opencode.json'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const migration: InstallerMigration = {
  id: '2026-10-12-opencode-mcp-no-prompts',
  title: 'Stop the GSD MCP companion duplicating GSD commands in OpenCode',
  description:
    'Add --no-prompts to the GSD-written `gsd` MCP server entry in opencode.json(c) (mcp.gsd, and the ' +
    'OpenCode 2.x native mcp.servers.gsd) so OpenCode no longer lists every GSD command a second time as ' +
    'a `gsd:<name>` MCP-prompt command. Only the entry the installer wrote is changed; comments and ' +
    'layout in a JSONC config are preserved (#5338, #5334).',
  introducedIn: '1.17.0',
  runtimes: ['opencode'],
  scopes: ['global', 'local'],
  destructive: false,
  runtimeContract: 'docs/installer-migrations.md#runtime-configuration-contract-registry OpenCode row',
  plan: (ctx: MigrationPlanContext): MigrationAction[] => {
    if (ctx.runtime !== 'opencode') return [];

    // The file OpenCode (and the installer's resolveOpencodeConfigPath) treats as THE config.
    const relPath = CONFIG_CANDIDATES.find((name) => fs.existsSync(path.join(ctx.configDir, name)));
    if (!relPath) return [];

    let config: unknown;
    try {
      config = parseJsonc(fs.readFileSync(path.join(ctx.configDir, relPath), 'utf8'));
    } catch {
      return []; // unparseable: never touch a config we cannot read (same posture as the installer)
    }
    if (!isPlainObject(config) || !isPlainObject(config['mcp'])) return [];

    const mcp = config['mcp'];
    const edits: JsoncEdit[] = [];
    const next: Record<string, unknown> = { ...config, mcp: { ...mcp } };
    const nextMcp = next['mcp'] as Record<string, unknown>;

    const legacy = mcp['gsd'];
    if (isGsdMcpEntry(legacy) && !hasNoPromptsFlag(legacy)) {
      const updated = withNoPromptsFlag(legacy);
      nextMcp['gsd'] = updated;
      edits.push({ path: ['mcp', 'gsd', 'command'], value: updated.command });
    }

    const servers = mcp['servers'];
    if (isPlainObject(servers)) {
      const native = servers['gsd'];
      if (isGsdMcpEntry(native) && !hasNoPromptsFlag(native)) {
        const updated = withNoPromptsFlag(native);
        nextMcp['servers'] = { ...servers, gsd: updated };
        edits.push({ path: ['mcp', 'servers', 'gsd', 'command'], value: updated.command });
      }
    }

    if (edits.length === 0) return [];
    return [
      {
        type: 'rewrite-json',
        relPath,
        value: next,
        edits,
        reason:
          'the GSD MCP companion advertised its prompt catalog, which OpenCode lists as a second set of ' +
          '`gsd:<name>` slash commands next to the installed command files',
        ownershipEvidence:
          "the entry matches the exact shape configureOpencodePermissions writes: type 'local' and a command " +
          "array of `npx … <package> gsd-mcp-server`; a user-edited or user-defined `gsd` server does not match",
      },
    ];
  },
};

export = migration;
