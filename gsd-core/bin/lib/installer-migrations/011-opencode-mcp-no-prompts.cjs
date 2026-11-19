"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const jsonc_edit_cjs_1 = require("../jsonc-edit.cjs");
const opencode_mcp_entry_cjs_1 = require("../opencode-mcp-entry.cjs");
/** OpenCode reads `opencode.jsonc` in preference to `opencode.json` when both exist. */
const CONFIG_CANDIDATES = ['opencode.jsonc', 'opencode.json'];
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const migration = {
    id: '2026-10-12-opencode-mcp-no-prompts',
    title: 'Stop the GSD MCP companion duplicating GSD commands in OpenCode',
    description: 'Add --no-prompts to the GSD-written `gsd` MCP server entry in opencode.json(c) (mcp.gsd, and the ' +
        'OpenCode 2.x native mcp.servers.gsd) so OpenCode no longer lists every GSD command a second time as ' +
        'a `gsd:<name>` MCP-prompt command. Only the entry the installer wrote is changed; comments and ' +
        'layout in a JSONC config are preserved (#5338, #5334).',
    introducedIn: '1.17.0',
    runtimes: ['opencode'],
    scopes: ['global', 'local'],
    destructive: false,
    runtimeContract: 'docs/installer-migrations.md#runtime-configuration-contract-registry OpenCode row',
    plan: (ctx) => {
        if (ctx.runtime !== 'opencode')
            return [];
        // The file OpenCode (and the installer's resolveOpencodeConfigPath) treats as THE config.
        const relPath = CONFIG_CANDIDATES.find((name) => node_fs_1.default.existsSync(node_path_1.default.join(ctx.configDir, name)));
        if (!relPath)
            return [];
        let config;
        try {
            config = (0, jsonc_edit_cjs_1.parseJsonc)(node_fs_1.default.readFileSync(node_path_1.default.join(ctx.configDir, relPath), 'utf8'));
        }
        catch {
            return []; // unparseable: never touch a config we cannot read (same posture as the installer)
        }
        if (!isPlainObject(config) || !isPlainObject(config['mcp']))
            return [];
        const mcp = config['mcp'];
        const edits = [];
        const next = { ...config, mcp: { ...mcp } };
        const nextMcp = next['mcp'];
        const legacy = mcp['gsd'];
        if ((0, opencode_mcp_entry_cjs_1.isGsdMcpEntry)(legacy) && !(0, opencode_mcp_entry_cjs_1.hasNoPromptsFlag)(legacy)) {
            const updated = (0, opencode_mcp_entry_cjs_1.withNoPromptsFlag)(legacy);
            nextMcp['gsd'] = updated;
            edits.push({ path: ['mcp', 'gsd', 'command'], value: updated.command });
        }
        const servers = mcp['servers'];
        if (isPlainObject(servers)) {
            const native = servers['gsd'];
            if ((0, opencode_mcp_entry_cjs_1.isGsdMcpEntry)(native) && !(0, opencode_mcp_entry_cjs_1.hasNoPromptsFlag)(native)) {
                const updated = (0, opencode_mcp_entry_cjs_1.withNoPromptsFlag)(native);
                nextMcp['servers'] = { ...servers, gsd: updated };
                edits.push({ path: ['mcp', 'servers', 'gsd', 'command'], value: updated.command });
            }
        }
        if (edits.length === 0)
            return [];
        return [
            {
                type: 'rewrite-json',
                relPath,
                value: next,
                edits,
                reason: 'the GSD MCP companion advertised its prompt catalog, which OpenCode lists as a second set of ' +
                    '`gsd:<name>` slash commands next to the installed command files',
                ownershipEvidence: "the entry matches the exact shape configureOpencodePermissions writes: type 'local' and a command " +
                    "array of `npx … <package> gsd-mcp-server`; a user-edited or user-defined `gsd` server does not match",
            },
        ];
    },
};
module.exports = migration;
