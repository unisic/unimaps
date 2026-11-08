/**
 * The two pure fix-time / cruise-speed rules of backend/src/route_info.rs (estimate_fix_at, next_speed), mirrored
 * from the former lib/route-info.ts so test/vehicle-motion-sim.test.ts can feed the client motion engine the way
 * the server does. A change to either Rust function must be made here too.
 */

/**
 * When did the current position first appear upstream? KB sends no fix time,
 * so a change seen at poll `updatedAt` happened somewhere since the previous
 * poll — the midpoint of that window halves the systematic lag (the gap is
 * capped so a long pause doesn't push the estimate far into the past).
 */
export function estimateFixAt(
  prev: { fixAt?: number; updatedAt: number } | undefined,
  updatedAt: number,
  moved: boolean,
  capSec = 30,
): number {
  if (!prev) return updatedAt;
  if (!moved) return prev.fixAt ?? prev.updatedAt;
  const gap = Math.min(Math.max(0, updatedAt - prev.updatedAt), capSec);
  return updatedAt - gap / 2;
}

const MOVING_M = 20;
const SPEED_MAX = 25;
const SPEED_REJECT = 33;
const SPEED_TAU_S = 20;

/**
 * Cruise-speed EMA update from one pair of distinct fixes, or null when the
 * pair is not a "moving pair": both fixes must have moved ≥20 m from their
 * predecessor, the earlier one must not have been sitting still for long
 * (`prevHeldSec` > 30 s means it was a dwell; KB upstream alone can
 * leave a moving bus unchanged for ~25 s), neither may be inside a stop
 * zone (braking/pulling away would drag the cruise speed down) and Δt must be
 * sane. Standing still is the client's hold rule's job — not something to
 * average in.
 */
export function nextSpeed(
  prevSpeed: number | null | undefined,
  prevMoveDs: number | undefined,
  ds: number,
  dt: number,
  prevHeldSec = 0,
  inStopZone = false,
): number | null {
  if (inStopZone) return null;
  // the first-ever fix has no history: its displacement spans an unknown
  // interval (it may have been reported long before we first saw it), so a
  // pair starting there would wildly overestimate the speed
  if (!(prevMoveDs !== undefined && prevMoveDs >= MOVING_M)) return null;
  if (!(ds >= MOVING_M) || !(dt >= 3 && dt <= 45) || prevHeldSec > 30) return null;
  const sample = ds / dt;
  if (sample > SPEED_REJECT) return null;
  const v = Math.min(SPEED_MAX, sample);
  if (prevSpeed == null || !Number.isFinite(prevSpeed)) return v;
  const a = 1 - Math.exp(-dt / SPEED_TAU_S);
  return prevSpeed + a * (v - prevSpeed);
}
