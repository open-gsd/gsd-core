"use strict";
/**
 * Installer migration: retire Cursor's duplicate commands/ surface (#2644).
 *
 * Cursor discovers GSD skills as slash-menu entries while also keeping them
 * model-invocable. Older GSD releases installed the same workflows again as
 * commands/gsd-*.md, so every action appeared twice. The skills remain the
 * sole workflow surface; this migration removes only old command files proven
 * managed by gsd-file-manifest.json. Modified files are backed up first and
 * unmanifested files are preserved.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const COMMANDS_DIR = 'commands';
const REASON = 'Cursor exposes skills directly in the slash menu; the parallel command file duplicated the same GSD action (#2644)';
const OWNERSHIP_EVIDENCE = 'pre-#2644 Cursor installs record commands/gsd-*.md in gsd-file-manifest.json';
const migration = {
    id: '2026-07-29-cursor-retire-commands-surface',
    title: 'Retire Cursor duplicate commands surface',
    description: 'Remove manifest-managed Cursor commands/gsd-*.md files now that skills are the single slash-menu and model-invocation surface.',
    introducedIn: '1.8.1',
    runtimes: ['cursor'],
    scopes: ['global', 'local'],
    destructive: true,
    plan: (ctx) => {
        const commandsDir = node_path_1.default.join(ctx.configDir, COMMANDS_DIR);
        let entries;
        try {
            if (!node_fs_1.default.existsSync(commandsDir) || node_fs_1.default.lstatSync(commandsDir).isSymbolicLink())
                return [];
            entries = node_fs_1.default.readdirSync(commandsDir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const actions = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith('gsd-') || !entry.name.endsWith('.md'))
                continue;
            const relPath = node_path_1.default.posix.join(COMMANDS_DIR, entry.name);
            const artifact = ctx.classifyArtifact(relPath);
            if (artifact.classification === 'managed-pristine') {
                actions.push({ type: 'remove-managed', relPath, reason: REASON, ownershipEvidence: OWNERSHIP_EVIDENCE });
            }
            else if (artifact.classification === 'managed-modified') {
                actions.push({ type: 'backup-and-remove', relPath, reason: REASON, ownershipEvidence: OWNERSHIP_EVIDENCE });
            }
        }
        return actions;
    },
};
module.exports = migration;
