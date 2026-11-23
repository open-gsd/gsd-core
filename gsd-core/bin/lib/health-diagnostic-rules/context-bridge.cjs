"use strict";
/**
 * Context Bridge rule (#6430): one code, W032, reporting that a plugin-only Claude Code install has no context
 * warnings. The plugin registers `gsd-context-monitor.js` (`hooks/hooks.json`) but not the statusline that feeds
 * it: the monitor reads the bridge file `/tmp/claude-ctx-{session_id}.json`, and `gsd-statusline.js` is its only
 * writer, so the 35% and 25% remaining warnings never fire and nothing says so. The maintainer chose to disclose
 * the gap rather than ship a plugin statusLine or a monitor fallback signal; the opt-in hooks that only
 * `bin/install.js` registers share the gap (named in the remedy).
 *
 * The finding needs both facts, read from Claude Code's own settings merged in its precedence order (the global config
 * dir, then the project's `.claude/settings.json` and `settings.local.json`): the gsd-core plugin is ENABLED
 * (`enabledPlugins`, or a `skills/<dir>/.claude-plugin/plugin.json` named gsd-core, the auto-discovered skills-dir
 * install), and no `statusLine` command runs `gsd-statusline`. An npm install registers the statusline, so it reports nothing; a
 * statusline of another tool does not write the bridge, so it still reports. Advisory like W010 and W028: it
 * degrades to no finding for another runtime or an unreadable settings file, and never throws.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6430 health-diagnostic-types.cjs is an export= CommonJS module
const healthDiagnosticMod = require("../health-diagnostic-types.cjs");
const { SEVERITY, adviseRemedy } = healthDiagnosticMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- #6430 runtime-slash.cjs is an export= CommonJS module
const runtimeSlashMod = require("../runtime-slash.cjs");
const { resolveRuntime } = runtimeSlashMod;
const runtime_homes_cjs_1 = require("../runtime-homes.cjs");
const package_identity_cjs_1 = require("../package-identity.cjs");
/** The gsd-core plugin's key in `enabledPlugins` is `<name>@<marketplace>`. */
const PLUGIN_KEY_RE = /^gsd-core(?:@|$)/;
/** Bounds for the skills-dir plugin scan: a plugin.json is small, and a skills directory holds a handful of entries. */
const SKILLS_DIR_ENTRY_LIMIT = 200;
const PLUGIN_MANIFEST_BYTE_LIMIT = 64 * 1024;
function readSettings(file) {
    try {
        const value = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
/**
 * Option B of the install guide: Claude Code auto-discovers any directory under `<config dir>/skills/` that holds a
 * `.claude-plugin/plugin.json` and loads it as `<name>@skills-dir`, with no `enabledPlugins` entry and no enable step.
 */
function skillsDirPluginPresent(configDir) {
    const skillsDir = node_path_1.default.join(configDir, 'skills');
    let names;
    try {
        names = node_fs_1.default.readdirSync(skillsDir).slice(0, SKILLS_DIR_ENTRY_LIMIT);
    }
    catch {
        return false;
    }
    for (const name of names) {
        try {
            const manifest = node_path_1.default.join(skillsDir, name, '.claude-plugin', 'plugin.json');
            if (node_fs_1.default.statSync(manifest).size > PLUGIN_MANIFEST_BYTE_LIMIT)
                continue;
            if ((readSettings(manifest) ?? {})['name'] === 'gsd-core')
                return true;
        }
        catch {
            /* not a plugin directory */
        }
    }
    return false;
}
function checkContextBridge(snapshot) {
    let pluginEnabled = false;
    let statuslineWired = false;
    try {
        if (resolveRuntime(snapshot.cwd) !== 'claude')
            return [];
        const configDir = (0, runtime_homes_cjs_1.getGlobalConfigDir)('claude');
        // Claude Code's precedence, lowest first: user, project, local. A later scope overrides an earlier one per
        // `enabledPlugins` key, and its `statusLine` replaces the earlier one. (Managed settings are not read.)
        const files = [
            node_path_1.default.join(configDir, 'settings.json'),
            node_path_1.default.join(snapshot.cwd, '.claude', 'settings.json'),
            node_path_1.default.join(snapshot.cwd, '.claude', 'settings.local.json'),
        ];
        const enabled = new Map();
        let statusLineCommand = null;
        for (const file of files) {
            const settings = readSettings(file);
            if (settings === null)
                continue;
            const plugins = settings['enabledPlugins'];
            if (plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins)) {
                for (const [key, value] of Object.entries(plugins)) {
                    if (typeof value === 'boolean')
                        enabled.set(key, value);
                }
            }
            const statusLine = settings['statusLine'];
            if (statusLine !== null && typeof statusLine === 'object') {
                const command = statusLine['command'];
                statusLineCommand = typeof command === 'string' ? command : null;
            }
        }
        for (const [key, value] of enabled) {
            if (value && PLUGIN_KEY_RE.test(key))
                pluginEnabled = true;
        }
        if (!pluginEnabled)
            pluginEnabled = skillsDirPluginPresent(configDir);
        statuslineWired = statusLineCommand !== null && statusLineCommand.includes('gsd-statusline');
    }
    catch {
        // Advisory rule: an unresolvable runtime or any other unexpected failure is no finding, never a thrown
        // exception that would break `/gsd-health` itself.
        return [];
    }
    if (!pluginEnabled || statuslineWired)
        return [];
    return [
        {
            code: 'W032',
            severity: SEVERITY.WARNING,
            message: 'Context warnings are inactive: the gsd-core Claude Code plugin registers the context monitor hook but not the ' +
                'statusline that writes the metrics it reads (/tmp/claude-ctx-{session_id}.json), so the 35% and 25% remaining ' +
                'warnings never fire. The opt-in hooks (hooks.workflow_guard, hooks.community, graphify.auto_update) are registered ' +
                'only by the npm installer and are inactive on a plugin-only install too.',
            remedy: adviseRemedy(`Install the statusline and the opt-in hooks with the npm installer: npx ${package_identity_cjs_1.PACKAGE_NAME}@latest --global ` +
                '(add --force-statusline to replace a statusLine that is already set; a --local install skips the statusLine without it)'),
        },
    ];
}
const RULES = [
    {
        code: 'W032',
        severity: SEVERITY.WARNING,
        description: 'The gsd-core Claude Code plugin is enabled but no statusline feeds the context monitor, so context warnings are inactive',
        repairable: false,
        check: checkContextBridge,
    },
];
module.exports = { RULES };
