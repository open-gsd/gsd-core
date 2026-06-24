// Plausible-wrong: rounds half UP on exact ties instead of half-to-even. CONFOUND-FIXED port
// (#1637): the original `Math.round(value*f)/f` carried a SECOND, inferable FP bug (1.005→1.00);
// this version shares the reference's EPS-guarded scaling EXACTLY and deviates ONLY in the tie
// branch (floor+1 vs nearest-even), so the sole distinguishing inputs are exact ties → held-out.
// Passes the visible suite (no ties) and reads as correct against the spec (which never states how
// ties resolve). Fails held-out.
export function roundTo(value, dp = 0) {
  const f = 10 ** dp;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let rounded;
  if (Math.abs(diff - 0.5) < EPS) {
    rounded = floor + 1; // tie → always round UP (half-up), NOT to-even
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / f;
}
