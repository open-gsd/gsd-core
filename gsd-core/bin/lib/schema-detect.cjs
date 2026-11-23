"use strict";
/**
 * Schema Drift Detection — detects schema-relevant file changes and verifies
 * that the appropriate database push command was executed during a phase
 * (ADR-457 build-at-publish: the hand-written bin/lib/schema-detect.cjs
 * collapsed to a TypeScript source of truth). Behaviour is preserved
 * byte-for-behaviour from the prior hand-written .cjs; only types are added.
 *
 * This module does not read the filesystem directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORM_INFO = exports.SCHEMA_PATTERNS = void 0;
exports.detectSchemaFiles = detectSchemaFiles;
exports.detectSchemaOrm = detectSchemaOrm;
exports.checkSchemaDrift = checkSchemaDrift;
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
exports.SCHEMA_PATTERNS = [
    { pattern: /^src\/collections\/.*\.ts$/, orm: 'payload' },
    { pattern: /^src\/globals\/.*\.ts$/, orm: 'payload' },
    { pattern: /^prisma\/schema\.prisma$/, orm: 'prisma' },
    { pattern: /^prisma\/schema\/.*\.prisma$/, orm: 'prisma' },
    { pattern: /^drizzle\/schema\.ts$/, orm: 'drizzle' },
    { pattern: /^src\/db\/schema\.ts$/, orm: 'drizzle' },
    { pattern: /^drizzle\/.*\.ts$/, orm: 'drizzle' },
    { pattern: /^supabase\/migrations\/.*\.sql$/, orm: 'supabase' },
    { pattern: /^src\/entities\/.*\.ts$/, orm: 'typeorm' },
    { pattern: /^src\/migrations\/.*\.ts$/, orm: 'typeorm' },
];
exports.ORM_INFO = {
    payload: {
        pushCommand: 'npx payload migrate',
        envHint: 'CI=true PAYLOAD_MIGRATING=true npx payload migrate',
        interactiveWarning: 'Payload migrate may require interactive prompts — use CI=true PAYLOAD_MIGRATING=true to suppress',
        evidencePatterns: [/payload\s+migrate/i, /PAYLOAD_MIGRATING/],
    },
    prisma: {
        pushCommand: 'npx prisma db push',
        envHint: 'npx prisma db push --accept-data-loss (if destructive changes are intended)',
        interactiveWarning: 'Prisma db push may prompt for confirmation on destructive changes — use --accept-data-loss to bypass',
        evidencePatterns: [/prisma\s+db\s+push/i, /prisma\s+migrate\s+deploy/i, /prisma\s+migrate\s+dev/i],
    },
    drizzle: {
        pushCommand: 'npx drizzle-kit push',
        envHint: 'npx drizzle-kit push',
        interactiveWarning: null,
        evidencePatterns: [/drizzle-kit\s+push/i, /drizzle-kit\s+migrate/i],
    },
    supabase: {
        pushCommand: 'supabase db push',
        envHint: 'supabase db push',
        interactiveWarning: 'Supabase db push may require authentication — ensure SUPABASE_ACCESS_TOKEN is set',
        evidencePatterns: [/supabase\s+db\s+push/i, /supabase\s+migration\s+up/i],
    },
    typeorm: {
        pushCommand: 'npx typeorm migration:run',
        envHint: 'npx typeorm migration:run -d src/data-source.ts',
        interactiveWarning: null,
        evidencePatterns: [/typeorm\s+migration:run/i, /typeorm\s+schema:sync/i],
    },
};
function detectSchemaFiles(files) {
    const matches = [];
    const orms = new Set();
    for (const rawFile of files) {
        const file = (0, shell_command_projection_cjs_1.posixNormalize)(rawFile);
        for (const { pattern, orm } of exports.SCHEMA_PATTERNS) {
            if (pattern.test(file)) {
                matches.push(rawFile);
                orms.add(orm);
                break;
            }
        }
    }
    return {
        detected: matches.length > 0,
        matches,
        orms: [...orms],
    };
}
function detectSchemaOrm(ormName) {
    return exports.ORM_INFO[ormName] || null;
}
function checkSchemaDrift(changedFiles, executionLog, options = {}) {
    const { skipCheck = false } = options;
    const detection = detectSchemaFiles(changedFiles);
    if (!detection.detected) {
        return {
            driftDetected: false,
            blocking: false,
            schemaFiles: [],
            orms: [],
            unpushedOrms: [],
            message: '',
        };
    }
    const pushedOrms = new Set();
    const unpushedOrms = [];
    for (const orm of detection.orms) {
        const info = exports.ORM_INFO[orm];
        if (!info)
            continue;
        const hasPushEvidence = info.evidencePatterns.some(p => p.test(executionLog));
        if (hasPushEvidence) {
            pushedOrms.add(orm);
        }
        else {
            unpushedOrms.push(orm);
        }
    }
    // Suppress unused variable warning — pushedOrms tracks for conceptual clarity
    void pushedOrms;
    const driftDetected = unpushedOrms.length > 0;
    if (!driftDetected) {
        return {
            driftDetected: false,
            blocking: false,
            schemaFiles: detection.matches,
            orms: detection.orms,
            unpushedOrms: [],
            message: '',
        };
    }
    const pushCommands = unpushedOrms
        .map(orm => {
        const info = exports.ORM_INFO[orm];
        return info ? `  ${orm}: ${info.envHint || info.pushCommand}` : null;
    })
        .filter((x) => x !== null)
        .join('\n');
    const message = [
        'Schema drift detected: schema-relevant files changed but no database push was executed.',
        '',
        `Schema files changed: ${detection.matches.join(', ')}`,
        `ORMs requiring push: ${unpushedOrms.join(', ')}`,
        '',
        'Required push commands:',
        pushCommands,
        '',
        'Run the appropriate push command, or set GSD_SKIP_SCHEMA_CHECK=true to bypass this gate.',
    ].join('\n');
    if (skipCheck) {
        return {
            driftDetected: true,
            blocking: false,
            skipped: true,
            schemaFiles: detection.matches,
            orms: detection.orms,
            unpushedOrms,
            message: 'Schema drift detected but check was skipped (GSD_SKIP_SCHEMA_CHECK=true).',
        };
    }
    return {
        driftDetected: true,
        blocking: true,
        schemaFiles: detection.matches,
        orms: detection.orms,
        unpushedOrms,
        message,
    };
}
