"use strict";
/**
 * Deterministic eval scoring verb (#10).
 * Moves coverage/infra/overall arithmetic out of the gsd-eval-auditor prompt
 * into code, per the framework's code-delegation discipline.
 */
function parseFlag(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const INFRA_VALUE = { ok: 1, partial: 0.5, missing: 0 };
const INFRA_TOKENS = new Set(Object.keys(INFRA_VALUE));
function computeEvalScore(covered, total, infra) {
    const coverage = total > 0 ? (covered / total) * 100 : 0;
    // unknown/typo tokens are treated as `missing` (score 0) by design — upstream agent only passes ok|partial|missing
    const infraSum = infra.reduce((acc, s) => acc + (INFRA_VALUE[s.trim().toLowerCase()] ?? 0), 0);
    const infraScore = (infraSum / 5) * 100;
    const overall = coverage * 0.6 + infraScore * 0.4;
    const round = (n) => Math.round(n * 100) / 100;
    const o = round(overall);
    const verdict = o >= 80 ? 'PRODUCTION READY' :
        o >= 60 ? 'NEEDS WORK' :
            o >= 40 ? 'SIGNIFICANT GAPS' : 'NOT IMPLEMENTED';
    return { coverage_score: round(coverage), infra_score: round(infraScore), overall_score: o, verdict };
}
function cmdEvalScore(_cwd, args, raw) {
    const coveredRaw = parseFlag(args, '--covered');
    const totalRaw = parseFlag(args, '--total');
    const infraRaw = parseFlag(args, '--infra') || '';
    const infra = infraRaw ? infraRaw.split(',').map((s) => s.trim().toLowerCase()) : [];
    const covered = Number(coveredRaw);
    const total = Number(totalRaw);
    if (coveredRaw === undefined || coveredRaw.trim() === '' ||
        totalRaw === undefined || totalRaw.trim() === '' ||
        !Number.isFinite(covered) || !Number.isFinite(total) ||
        infra.length !== 5) {
        process.stderr.write('Usage: gsd-tools query eval.score --covered N --total N --infra a,b,c,d,e (each ok|partial|missing)\n');
        process.exitCode = 1;
        return;
    }
    // Domain validation: this is a public CLI verb, so reject out-of-domain inputs
    // rather than emit nonsense (covered>total -> coverage_score>100; negatives ->
    // negative scores). Counts must be non-negative integers and covered cannot
    // exceed total; infra tokens must match the documented ok|partial|missing set.
    if (!Number.isInteger(covered) || !Number.isInteger(total) || covered < 0 || total < 0 || covered > total) {
        process.stderr.write('Invalid eval.score domain: require integer counts with 0 <= covered <= total.\n');
        process.exitCode = 1;
        return;
    }
    const invalidInfra = infra.find((s) => !INFRA_TOKENS.has(s));
    if (invalidInfra !== undefined) {
        process.stderr.write(`Invalid eval.score infra token: ${invalidInfra || '<empty>'}. Expected ok|partial|missing.\n`);
        process.exitCode = 1;
        return;
    }
    const result = computeEvalScore(covered, total, infra);
    process.stdout.write(raw ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    process.stdout.write('\n');
}
module.exports = { cmdEvalScore, computeEvalScore };
