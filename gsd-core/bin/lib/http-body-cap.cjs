"use strict";
/**
 * Bounded response-body read for reachability probes (#5963).
 *
 * A default-host availability probe judges the SHAPE of a 2xx body, so it must read one, but the
 * service on that port is unrelated and unknown: the read stops at `cap` bytes and cancels the
 * stream, so a large or endless 2xx body costs bounded memory. An over-cap body is truncated and
 * therefore fails any shape check.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROBE_BODY_CAP_BYTES = void 0;
exports.readCappedBody = readCappedBody;
exports.probeBody = probeBody;
/** Cap for a `/v1/models` probe body: a models listing is a few KiB; 1 MiB is generous. */
exports.PROBE_BODY_CAP_BYTES = 1 << 20;
async function readCappedBody(res, cap = exports.PROBE_BODY_CAP_BYTES) {
    const reader = res.body ? res.body.getReader() : null;
    if (!reader)
        return '';
    const chunks = [];
    let size = 0;
    while (size < cap) {
        const { done, value } = await reader.read();
        if (done || !value)
            break;
        chunks.push(Buffer.from(value));
        size += value.length;
    }
    // Best-effort release of the connection: the body is already judged, a failing cancel changes nothing.
    reader.cancel().catch(() => { });
    return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
}
/**
 * The body a reachability probe returns for `res`: '' (status-only, the body is cancelled so a stalled
 * stream cannot turn a replying server into `missing`) unless `readBody` is set AND the answer is 2xx,
 * in which case the capped body is returned.
 */
async function probeBody(res, readBody) {
    if (readBody && res.ok)
        return readCappedBody(res);
    res.body?.cancel().catch(() => { });
    return '';
}
