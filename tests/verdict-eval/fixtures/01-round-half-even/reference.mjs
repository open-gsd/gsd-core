// Reference: round half to EVEN (banker's rounding) on exact ties.
export function roundTo(value, dp = 0) {
  const f = 10 ** dp;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let rounded;
  if (Math.abs(diff - 0.5) < EPS) {
    rounded = floor % 2 === 0 ? floor : floor + 1; // tie → nearest even
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / f;
}
