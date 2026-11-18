/**
 * Bounded response-body read for reachability probes (#5963).
 *
 * A default-host availability probe judges the SHAPE of a 2xx body, so it must read one, but the
 * service on that port is unrelated and unknown: the read stops at `cap` bytes and cancels the
 * stream, so a large or endless 2xx body costs bounded memory. An over-cap body is truncated and
 * therefore fails any shape check.
 */

/** Cap for a `/v1/models` probe body: a models listing is a few KiB; 1 MiB is generous. */
export const PROBE_BODY_CAP_BYTES = 1 << 20;

export async function readCappedBody(
  res: { body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<unknown> } } | null },
  cap: number = PROBE_BODY_CAP_BYTES,
): Promise<string> {
  const reader = res.body ? res.body.getReader() : null;
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, cap).toString('utf8');
}
