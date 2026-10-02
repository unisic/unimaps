/**
 * Pure per-vehicle route math the pollers attach to positions for the client
 * motion engine: when a fix really happened, how far along its shape it is,
 * and a cruise speed that a dwell can't drag down.
 */
import type { KbPattern } from "./shape-patterns";
import type { ShapeGeometry } from "./shape-store";
import { projectOnPolyline } from "./shared/polyline";
import type { VehicleJson, VehiclePos } from "./types";

/** What the KB poller needs from the shape store (kept narrow for tests). */
export interface KbShapeSink {
  touchKb(p: KbPattern, prio: "urgent" | "background"): void;
  geometry(key: string): ShapeGeometry | null;
}

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

function finiteAt(stops: ReadonlyArray<number | null>, from: number, step: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < stops.length; i += step) {
    const s = stops[i];
    if (s !== null && s !== undefined) return s;
  }
  return null;
}

/**
 * Metres along the shape for a KB fix, searched between the last reached stop
 * (vti) and the next one so the opposite leg of an out-and-back can't win.
 * Falls back to a strict whole-line search; null when the fix is off-route.
 */
export function kbDistAlong(
  geom: ShapeGeometry,
  lat: number,
  lon: number,
  vti: number | null,
  nextSeq: number | null,
  hint?: number,
): number | null {
  const maxOff = geom.src === "straight" ? 150 : 60;
  if (vti !== null && vti >= 0) {
    const lo = finiteAt(geom.stops, Math.min(vti, geom.stops.length - 1), -1);
    const hiIdx = nextSeq !== null && nextSeq > vti ? nextSeq : vti + 1;
    const hi = finiteAt(geom.stops, hiIdx, 1);
    const p = projectOnPolyline(geom.pl, lat, lon, (lo ?? 0) - 100, (hi ?? geom.pl.length) + 100, { hint });
    if (p && p.d <= maxOff) return Math.round(p.s * 10) / 10;
  }
  const p = projectOnPolyline(geom.pl, lat, lon, 0, Infinity, { hint });
  return p && p.d <= 40 ? Math.round(p.s * 10) / 10 : null;
}

/**
 * Motion extras for the client (kept out of vehicleToJson, the Python port).
 * Never throws: a bad entry just ships the vehicle without them.
 */
export function vehicleExtras(v: VehiclePos, shapes: { wireId(key: string): string | null } | null, nowEpoch: number): Partial<VehicleJson> {
  try {
    const out: Partial<VehicleJson> = {};
    if (v.fixAt != null && Number.isFinite(v.fixAt)) out.fix_at = Math.round(v.fixAt * 10) / 10;
    if (v.nextStopSeq != null) out.next_stop_seq = v.nextStopSeq;
    if (v.speed != null && Number.isFinite(v.speed) && v.speedAt != null && nowEpoch - v.speedAt <= 90) {
      out.speed = Math.round(v.speed * 10) / 10;
    }
    if (shapes && v.shapeKey) {
      const id = shapes.wireId(v.shapeKey);
      if (id) {
        out.shape = id;
        if (v.distM != null && Number.isFinite(v.distM) && v.distRev === id.slice(-6)) out.dist_m = Math.round(v.distM);
      }
    }
    return out;
  } catch {
    return {};
  }
}
