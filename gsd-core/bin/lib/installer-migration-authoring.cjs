"use strict";
/**
 * Installer Migration Authoring — validation helpers for installer migration records and actions.
 *
 * ADR-457 build-at-publish: the hand-written
 * bin/lib/installer-migration-authoring.cjs collapsed to a TypeScript source
 * of truth. Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateInstallerMigrationRecord = validateInstallerMigrationRecord;
exports.validateInstallerMigrationActions = validateInstallerMigrationActions;
const node_path_1 = __importDefault(require("node:path"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
function getStr(record, field) {
    const v = record[field];
    return typeof v === 'string' ? v : '';
}
function requireNonEmptyString(record, field, source) {
    const v = record[field];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`migration record must include a non-empty ${field}: ${source}`);
    }
}
function isNonEmptyStringArray(arr) {
    return Array.isArray(arr) && arr.length > 0 && arr.every((v) => typeof v === 'string' && v.trim() !== '');
}
function validateStringArray(record, field, source) {
    if (record[field] === undefined)
        return;
    if (!isNonEmptyStringArray(record[field])) {
        throw new Error(`migration record ${field} must be a non-empty string array when provided: ${source}`);
    }
}
function requireStringArray(record, field, source) {
    if (!isNonEmptyStringArray(record[field])) {
        throw new Error(`migration record ${field} must be a non-empty string array: ${source}`);
    }
}
function recordSource(record, fallback) {
    const id = getStr(record, 'id');
    return fallback ?? (id.trim() ? id : '<unknown>');
}
function actionSource(migration, action) {
    const migrationId = getStr(migration, 'id') || '<unknown>';
    const relPath = getStr(action, 'relPath') || '<unknown>';
    return `${migrationId} ${relPath}`;
}
function requireActionEvidence(action, field, migration) {
    const v = action[field];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`migration action ${getStr(action, 'type')} must include ${field}: ${actionSource(migration, action)}`);
    }
}
function validateSafeRelPath(relPath, migration, actionType) {
    const source = actionSource(migration, { relPath });
    const normalized = (0, shell_command_projection_cjs_1.posixNormalize)(relPath);
    if (node_path_1.default.isAbsolute(normalized) || node_path_1.default.win32.isAbsolute(normalized)) {
        throw new Error(`migration action ${actionType} relPath must stay inside configDir: ${source}`);
    }
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`migration action ${actionType} relPath must stay inside configDir: ${source}`);
    }
}
function validateInstallerMigrationRecord(record, source) {
    const rec = record;
    const displaySource = recordSource(rec, source);
    if (!record || typeof record !== 'object') {
        throw new Error(`migration record must export an object: ${displaySource}`);
    }
    // Authoring contract follows docs/installer-migrations.md#authoring-workflow
    // and docs/adr/0008-installer-migration-module.md#decision.
    requireNonEmptyString(rec, 'id', displaySource);
    requireNonEmptyString(rec, 'title', displaySource);
    requireNonEmptyString(rec, 'description', displaySource);
    requireNonEmptyString(rec, 'introducedIn', displaySource);
    if (typeof rec['destructive'] !== 'boolean') {
        throw new Error(`migration record must declare destructive as a boolean: ${displaySource}`);
    }
    validateStringArray(rec, 'runtimes', displaySource);
    requireStringArray(rec, 'scopes', displaySource);
    if (typeof rec['plan'] !== 'function') {
        throw new Error(`migration record must include a plan function: ${displaySource}`);
    }
    return rec;
}
function validateInstallerMigrationActions(actions, migration) {
    if (!Array.isArray(actions)) {
        throw new Error(`migration ${getStr(migration, 'id')} plan must return an array`);
    }
    for (const action of actions) {
        if (!action || typeof action !== 'object') {
            throw new Error(`migration action must be an object: ${getStr(migration, 'id')}`);
        }
        const act = action;
        const actType = getStr(act, 'type');
        const actRelPath = getStr(act, 'relPath');
        if (!actType || actType.trim() === '') {
            throw new Error(`migration action must include a non-empty type: ${getStr(migration, 'id')}`);
        }
        if (!actRelPath || actRelPath.trim() === '') {
            throw new Error(`migration action ${actType} must include a non-empty relPath: ${getStr(migration, 'id')}`);
        }
        validateSafeRelPath(actRelPath, migration, actType);
        // Ownership and runtime-contract evidence are required by
        // docs/installer-migrations.md#action-types and
        // docs/adr/0008-installer-migration-module.md#runtime-contract-decision.
        // `remove-empty-dir` carries the same evidence bar as `remove-managed`: it is
        // still a destructive removal, just of a directory node instead of a file.
        if (actType === 'remove-managed' || actType === 'rewrite-json' || actType === 'remove-empty-dir') {
            requireActionEvidence(act, 'ownershipEvidence', migration);
        }
        if (actType === 'rewrite-json') {
            const rc = getStr(migration, 'runtimeContract');
            if (!rc || rc.trim() === '') {
                throw new Error(`migration action rewrite-json requires migration runtimeContract: ${actionSource(migration, act)}`);
            }
        }
    }
    return actions;
}
