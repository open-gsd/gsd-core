"use strict";
/**
 * The OpenCode MCP entry GSD's installer writes (`mcp.gsd`, or the 2.x native `mcp.servers.gsd`).
 * One owner for "is this entry ours" so install, uninstall and migration 011 cannot drift apart
 * (#5333, #5338; epic #5331).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GSD_MCP_NO_PROMPTS_FLAG = void 0;
exports.isGsdMcpEntry = isGsdMcpEntry;
exports.hasNoPromptsFlag = hasNoPromptsFlag;
exports.withNoPromptsFlag = withNoPromptsFlag;
const package_identity_cjs_1 = require("./package-identity.cjs");
/** Withholds the MCP prompt catalog: OpenCode turns MCP prompts into `<server>:<prompt>` slash commands. */
exports.GSD_MCP_NO_PROMPTS_FLAG = '--no-prompts';
/**
 * True when `entry` is the MCP server entry the installer writes: a local `npx … gsd-mcp-server`
 * command for this package, pinned or not. A user-edited or user-defined `gsd` entry does not match.
 * Recognizes both generations' shapes (`enabled` on 1.x, `disabled` on 2.x) because it keys only on
 * `type` and `command`.
 */
function isGsdMcpEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return false;
    const e = entry;
    if (e.type !== 'local' || !Array.isArray(e.command))
        return false;
    const [bin, ...rest] = e.command;
    if (bin !== 'npx' || !rest.includes('gsd-mcp-server'))
        return false;
    return rest.some((a) => typeof a === 'string' && (a === package_identity_cjs_1.PACKAGE_NAME || a.startsWith(`${package_identity_cjs_1.PACKAGE_NAME}@`)));
}
/** True when the entry already carries the no-prompts flag. */
function hasNoPromptsFlag(entry) {
    return entry.command.includes(exports.GSD_MCP_NO_PROMPTS_FLAG);
}
/** The entry with `--no-prompts` appended to its command (other fields untouched). */
function withNoPromptsFlag(entry) {
    return hasNoPromptsFlag(entry) ? entry : { ...entry, command: [...entry.command, exports.GSD_MCP_NO_PROMPTS_FLAG] };
}
