/**
 * Client-side dead reckoning for live vehicles — pure (no Leaflet, no React,
 * no clock reads), so node:test can drive it with synthetic time.
 *
 * Between ~10 s upstream updates each vehicle is moved virtually:
 *  - along its road shape (`route` mode, position = metres along the shape),
 *    or straight towards the next stop (`straight`), or just glided to the
 *    latest fix (`static`);
 *  - at the server's cruise speed, never past the next stop (it'll stop
 *    there), easing to a halt at a horizon if no new fix arrives;
 *  - held still while dwelling at a stop.
 * A new fix never makes the marker jump: behind → it catches up smoothly,
 * ahead → it slows/waits (never visibly drives backwards). Only explicit
 * cases snap (first sight, tab resume, big disagreement).
 *
 * All times are one local monotonic clock (performance.now() in the app);
 * server epoch seconds are mapped through a filtered offset.
 */
import {
  pointAt,
  projectOnPolyline,
  segMeters,
  tangentBearing,
  type PointAt,
  type Polyline,
} from "../shared/polyline";

/** The subset of the /api/vehicles wire record the engine reads. */
export interface MotionInput {
  id: string;
  lat: number;
  lon: number;
  at_stop: boolean;
  current_stop_sequence: number | null;
  bearing: number | null;
  next_stop_lat: number | null;
  next_stop_lon: number | null;
  operator?: "KB" | "MZK";
  shape?: string;
  dist_m?: number;
  fix_at?: number;
  next_stop_seq?: number;
  speed?: number;
}

export interface MotionShape {
  key: string;
  pl: Polyline;
  /** along-route metres per stop index (aligned with current_stop_sequence) */
  stops: ReadonlyArray<number | null>;
}

export interface MotionSample {
  lat: number;
  lon: number;
  heading: number | null;
  moving: boolean;
}

export interface MotionConfig {
  /** hold at a stop when the last fix moved less than this (m) */
  holdKbM: number;
  holdMzkM: number;
  /** stop this far before a stop pole (m) */
  stopMarginM: number;
  /** a pole closer than this ahead is treated as "being served" (m) */
  stopPassM: number;
  vBias: number;
  vMin: number;
  hMinMs: number;
  hMaxMs: number;
  hExtraMs: number;
  rampFrac: number;
  catchupTauS: number;
  catchupMaxMult: number;
  catchupMaxAdd: number;
  aheadFadeM: number;
  aheadStallMs: number;
  snapBehindM: number;
  snapAheadM: number;
  snap2dM: number;
  /** max lateral offset bridged by a glide when the geometry/mode changes (m) */
  reanchorMaxM: number;
  ghostMinMs: number;
  latTauMs: number;
  headTauMs: number;
  followTauMs: number;
  offRouteM: number;
  fixEpsM: number;
  maxSampleGapMs: number;
  goneMs: number;
  maxFixAgeMs: number;
}

/** Tuned with test/vehicle-motion-sim.test.ts (KB-like cadence: upstream every
 *  6–18 s, server poll 10 s, client poll 4 s): distinct fixes arrive 10–30 s
 *  apart, so the horizon must outlast that or buses stall between fixes.
 *  Overshoot (the bus stopped at a light we can't know about) is answered by
 *  waiting, not by pulling the marker back: nobody sees the true position, but
 *  everybody sees a bus reverse — hence the generous ahead-snap/stall limits. */
export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  holdKbM: 20,
  holdMzkM: 10,
  stopMarginM: 8,
  stopPassM: 15,
  vBias: 0.95,
  vMin: 0.8,
  hMinMs: 25_000,
  hMaxMs: 45_000,
  hExtraMs: 12_000,
  rampFrac: 0.6,
  catchupTauS: 2,
  catchupMaxMult: 2,
  catchupMaxAdd: 8,
  aheadFadeM: 60,
  aheadStallMs: 45_000,
  snapBehindM: 400,
  snapAheadM: 400,
  snap2dM: 300,
  reanchorMaxM: 400,
  ghostMinMs: 45_000,
  latTauMs: 500,
  headTauMs: 350,
  followTauMs: 1_000,
  offRouteM: 60,
  fixEpsM: 3,
  maxSampleGapMs: 10_000,
  goneMs: 30_000,
  maxFixAgeMs: 60_000,
};

type Mode = "route" | "straight" | "static";

interface Track {
  id: string;
  /** the latest wire record (dist_m/shape are re-read when a shape arrives) */
  input: MotionInput;
  lastSeen: number;
  pins: number;
  isMzk: boolean;
  /* latest fix */
  fixLat: number;
  fixLon: number;
  fixAtRaw: number | null;
  fixT: number;
  fixS: number | null;
  atStop: boolean;
  stopSeq: number | null;
  nextLat: number | null;
  nextLon: number | null;
  bearing: number | null;
  speed: number | null;
  /** displacement (m) between the last two distinct fixes; null = unknown */
  lastDisp: number | null;
  /** unit vector (east, north) of the last ≥20 m displacement */
  moveE: number;
  moveN: number;
  gapEma: number;
  /* shape */
  wireKey: string | null;
  overrideKey: string | null;
  shape: MotionShape | null;
  mode: Mode;
  /* plan */
  hold: boolean;
  vPred: number;
  capS: number;
  horizonMs: number;
  dirE: number;
  dirN: number;
  capDist: number;
  /* display */
  sampled: boolean;
  snapNext: boolean;
  dispS: number;
  latE: number;
  latN: number;
  dispLat: number;
  dispLon: number;
  heading: number | null;
  lastSampleT: number;
  aheadSince: number | null;
  moving: boolean;
  segHint: number;
}

const RAD = Math.PI / 180;
const M_PER_DEG = 111_320;

const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Distance travelled τ seconds after a fix at speed v: constant speed up to
 * rampFrac·H, then easing to a stop at H (position and velocity continuous).
 */
export function travel(v: number, tauS: number, horizonS: number, rampFrac = 0.6): number {
  if (v <= 0 || tauS <= 0) return 0;
  const t1 = horizonS * rampFrac;
  if (tauS <= t1) return v * tauS;
  const rest = horizonS - t1;
  if (tauS >= horizonS) return v * (t1 + rest / 2);
  const u = tauS - t1;
  return v * (t1 + u - (u * u) / (2 * rest));
}

/** Build a MotionShape from a prepared polyline + aligned stop distances. */
export function makeMotionShape(key: string, pl: Polyline, stops: ReadonlyArray<number | null>): MotionShape {
  return { key, pl, stops };
}

export interface MotionStore {
  setShape(shape: MotionShape): void;
  /** wire shape keys referenced by tracks that aren't loaded yet */
  missingShapes(): string[];
  /** force a track onto another shape (TripLayer's drawn route); null clears. A track not
   *  ingested yet takes it when it appears (TripLayer's effect runs before the poll's ingest). */
  overrideShape(trackId: string, key: string | null): void;
  /** feed one /api/vehicles poll; recvMs on the local clock, serverNowMs = server epoch ms at send */
  ingest(vehicles: readonly MotionInput[], recvMs: number, serverNowMs?: number | null): void;
  /** displayed state at local time nowMs; false = unknown id */
  sample(id: string, nowMs: number, out: MotionSample): boolean;
  /** next sample of these tracks (all when omitted) jumps straight to the target */
  snap(id?: string): void;
  /** views pin their track so it survives the vehicle dropping off the poll */
  pin(id: string, on: boolean): void;
  has(id: string): boolean;
  /** last displayed position (or the fix when never sampled) */
  displayed(id: string): { lat: number; lon: number; heading: number | null } | null;
  /** forget the clock offset (after a device suspend / bfcache restore) */
  resetClock(): void;
  size(): number;
  /** diagnostic snapshot of one track (tests / debugging) */
  inspect(id: string): MotionDebug | null;
}

export interface MotionDebug {
  mode: "route" | "straight" | "static";
  hold: boolean;
  vPred: number;
  speed: number | null;
  atStop: boolean;
  fixS: number | null;
  dispS: number;
  capS: number;
  shape: string | null;
  fixAgeMs: number;
  horizonMs: number;
}

export function createMotionStore(cfgIn: Partial<MotionConfig> = {}): MotionStore {
  const cfg: MotionConfig = { ...DEFAULT_MOTION_CONFIG, ...cfgIn };
  const tracks = new Map<string, Track>();
  const shapes = new Map<string, MotionShape>();
  /** overrides for tracks not ingested yet; cleared with overrideShape(id, null) */
  const pendingOverride = new Map<string, string>();
  /** local − server (ms) */
  let offset: number | null = null;
  const pa: PointAt = { lat: 0, lon: 0, seg: 0 };

  function mapServerMs(serverMs: number, recvMs: number): number {
    const local = serverMs + (offset ?? 0);
    return Math.min(recvMs, Math.max(recvMs - cfg.maxFixAgeMs, local));
  }

  function localMetres(lat0: number, lat: number, lon: number, refLat: number, refLon: number): [number, number] {
    const kx = M_PER_DEG * Math.cos(lat0 * RAD);
    return [(lon - refLon) * kx, (lat - refLat) * M_PER_DEG];
  }

  function shapeFor(tr: Track): MotionShape | null {
    const key = tr.overrideKey ?? tr.wireKey;
    if (!key) return null;
    return shapes.get(key) ?? null;
  }

  /** Re-express the current displayed position in the track's (new) mode. */
  function reanchor(tr: Track): void {
    if (!tr.sampled) return;
    if (tr.mode === "route" && tr.shape) {
      const lo = (tr.fixS ?? 0) - 400;
      const hi = (tr.fixS ?? tr.shape.pl.length) + 400;
      const p = projectOnPolyline(tr.shape.pl, tr.dispLat, tr.dispLon, lo, hi, { hint: tr.fixS ?? undefined });
      // a moderate offset (straight-line extrapolation that cut a corner) slides
      // onto the road via the decaying lateral offset; only a wild one snaps
      if (!p || p.d > cfg.reanchorMaxM) {
        tr.snapNext = true;
        return;
      }
      pointAt(tr.shape.pl, p.s, -1, pa);
      const [e, n] = localMetres(pa.lat, tr.dispLat, tr.dispLon, pa.lat, pa.lon);
      tr.dispS = p.s;
      tr.segHint = pa.seg;
      tr.latE = e;
      tr.latN = n;
    } else {
      tr.latE = 0;
      tr.latN = 0;
    }
  }

  function locateOnShape(tr: Track, v: MotionInput, prevS: number | null, dtS: number): number | null {
    const sh = tr.shape;
    if (!sh) return null;
    if (!tr.overrideKey && v.shape === sh.key && typeof v.dist_m === "number" && Number.isFinite(v.dist_m)) {
      return Math.min(sh.pl.length, Math.max(0, v.dist_m));
    }
    // project the fix ourselves (TripLayer's drawn route), windowed by stops
    let lo = 0;
    let hi = Infinity;
    const seq = v.current_stop_sequence;
    if (seq !== null && seq >= 0 && seq < sh.stops.length) {
      for (let k = seq; k >= 0; k--) {
        const s = sh.stops[k];
        if (s != null) {
          lo = s - 150;
          break;
        }
      }
      for (let k = seq + 1; k < sh.stops.length; k++) {
        const s = sh.stops[k];
        if (s != null) {
          hi = s + 150;
          break;
        }
      }
    }
    const hint = prevS !== null ? prevS + tr.vPred * dtS : undefined;
    let p = projectOnPolyline(sh.pl, v.lat, v.lon, lo, hi, { hint });
    if (!p || p.d > cfg.offRouteM) p = projectOnPolyline(sh.pl, v.lat, v.lon, 0, Infinity, { hint });
    return p && p.d <= cfg.offRouteM ? p.s : null;
  }

  /** Point the track at its (possibly new) shape, re-locate the fix, re-plan
   *  and carry the on-screen position over without a jump. */
  function attachShape(tr: Track): void {
    const sh = shapeFor(tr);
    const wantedKey = tr.overrideKey ?? tr.wireKey;
    // keep the old geometry while a newer revision is still loading
    const next = sh ?? (wantedKey ? tr.shape : null);
    if (next === tr.shape && tr.fixS !== null) return;
    tr.shape = next;
    tr.fixS = next ? locateOnShape(tr, { ...tr.input, lat: tr.fixLat, lon: tr.fixLon }, null, 0) : null;
    tr.mode = next && tr.fixS !== null ? "route" : tr.nextLat !== null && tr.nextLon !== null ? "straight" : "static";
    plan(tr);
    reanchor(tr);
  }

  function plan(tr: Track): void {
    const holdM = tr.isMzk ? cfg.holdMzkM : cfg.holdKbM;
    tr.vPred = tr.speed !== null && tr.speed >= cfg.vMin ? cfg.vBias * tr.speed : 0;
    tr.horizonMs = Math.min(cfg.hMaxMs, Math.max(cfg.hMinMs, tr.gapEma + cfg.hExtraMs));
    if (tr.mode === "route" && tr.shape && tr.fixS !== null) {
      tr.hold = tr.atStop && (tr.lastDisp === null || tr.lastDisp < holdM);
      const st = tr.shape.stops;
      let cap = tr.shape.pl.length;
      // being served: the pole of the stop we're at, if it is still ahead
      const served = tr.atStop && tr.stopSeq !== null ? st[tr.stopSeq] : null;
      if (served != null && served >= tr.fixS - 10) {
        cap = Math.max(tr.fixS, served - Math.min(cfg.stopMarginM, Math.max(0, served - tr.fixS)));
      } else {
        for (let k = 0; k < st.length; k++) {
          const s = st[k];
          if (s != null && s > tr.fixS + cfg.stopPassM) {
            cap = Math.min(cap, s - cfg.stopMarginM);
            break;
          }
        }
      }
      tr.capS = Math.max(tr.fixS, cap);
      return;
    }
    if (tr.mode === "straight" && tr.nextLat !== null && tr.nextLon !== null) {
      tr.hold = tr.atStop;
      const [e, n] = localMetres(tr.fixLat, tr.nextLat, tr.nextLon, tr.fixLat, tr.fixLon);
      const d = Math.hypot(e, n);
      tr.dirE = d > 0 ? e / d : 0;
      tr.dirN = d > 0 ? n / d : 0;
      tr.capDist = Math.max(0, d - cfg.stopMarginM);
      // direction guard: "next stop" behind the actual motion → don't extrapolate
      if ((tr.moveE !== 0 || tr.moveN !== 0) && tr.dirE * tr.moveE + tr.dirN * tr.moveN < Math.cos(100 * RAD)) {
        tr.vPred = 0;
      }
      return;
    }
    tr.hold = true;
    tr.vPred = 0;
  }

  /** No new fix for much longer than the horizon: stop pretending it moves. */
  function isGhost(tr: Track, t: number): boolean {
    return t - tr.fixT > Math.max(2 * tr.horizonMs, cfg.ghostMinMs);
  }

  /** Target displayed along-distance (route) at local time t. */
  function targetS(tr: Track, t: number): number {
    const fixS = tr.fixS ?? 0;
    if (tr.hold || tr.vPred <= 0 || isGhost(tr, t)) return fixS;
    const d = travel(tr.vPred, (t - tr.fixT) / 1000, tr.horizonMs / 1000, cfg.rampFrac);
    return Math.min(tr.capS, fixS + d);
  }

  /** Target displayed position (2D modes) at local time t. */
  function target2d(tr: Track, t: number): [number, number] {
    if (tr.mode !== "straight" || tr.hold || tr.vPred <= 0 || isGhost(tr, t)) return [tr.fixLat, tr.fixLon];
    const d = Math.min(tr.capDist, travel(tr.vPred, (t - tr.fixT) / 1000, tr.horizonMs / 1000, cfg.rampFrac));
    const kx = M_PER_DEG * Math.cos(tr.fixLat * RAD);
    return [tr.fixLat + (tr.dirN * d) / M_PER_DEG, tr.fixLon + (tr.dirE * d) / kx];
  }

  function ingestOne(v: MotionInput, recvMs: number): void {
    let tr = tracks.get(v.id);
    const isNew = !tr;
    if (!tr) {
      tr = {
        id: v.id,
        input: v,
        lastSeen: recvMs,
        pins: 0,
        isMzk: v.operator === "MZK",
        fixLat: v.lat,
        fixLon: v.lon,
        fixAtRaw: null,
        fixT: recvMs,
        fixS: null,
        atStop: v.at_stop,
        stopSeq: v.current_stop_sequence,
        nextLat: v.next_stop_lat,
        nextLon: v.next_stop_lon,
        bearing: v.bearing,
        speed: null,
        lastDisp: null,
        moveE: 0,
        moveN: 0,
        gapEma: 12_000,
        wireKey: null,
        overrideKey: pendingOverride.get(v.id) ?? null,
        shape: null,
        mode: "static",
        hold: true,
        vPred: 0,
        capS: 0,
        horizonMs: cfg.hMinMs,
        dirE: 0,
        dirN: 0,
        capDist: 0,
        sampled: false,
        snapNext: true,
        dispS: 0,
        latE: 0,
        latN: 0,
        dispLat: v.lat,
        dispLon: v.lon,
        heading: v.bearing,
        lastSampleT: recvMs,
        aheadSince: null,
        moving: false,
        segHint: -1,
      };
      tracks.set(v.id, tr);
      pendingOverride.delete(v.id);
    }
    tr.input = v;
    tr.lastSeen = recvMs;
    tr.atStop = v.at_stop;
    tr.stopSeq = v.current_stop_sequence;
    tr.nextLat = v.next_stop_lat;
    tr.nextLon = v.next_stop_lon;
    if (v.bearing !== null) tr.bearing = v.bearing;
    tr.speed = typeof v.speed === "number" && Number.isFinite(v.speed) ? v.speed : null;

    const fixAt = typeof v.fix_at === "number" && Number.isFinite(v.fix_at) ? v.fix_at : null;
    const moved = segMeters(tr.fixLat, tr.fixLon, v.lat, v.lon);
    const distinct = isNew
      ? true
      : fixAt !== null && tr.fixAtRaw !== null
        ? Math.abs(fixAt - tr.fixAtRaw) >= 0.05
        : moved > cfg.fixEpsM;

    // shape: wanted key may not be loaded yet — keep the old one until it is
    const prevShape = tr.shape;
    tr.wireKey = v.shape ?? null;
    const wanted = shapeFor(tr);
    const wantedKey = tr.overrideKey ?? tr.wireKey;
    if (wanted) tr.shape = wanted;
    else if (!wantedKey) tr.shape = null;
    const shapeChanged = tr.shape !== prevShape;

    if (distinct) {
      const newFixT = fixAt !== null ? mapServerMs(fixAt * 1000, recvMs) : recvMs;
      if (!isNew) {
        const gap = newFixT - tr.fixT;
        if (gap > 0) tr.gapEma += 0.3 * (Math.min(60_000, Math.max(3_000, gap)) - tr.gapEma);
        tr.lastDisp = moved;
        if (moved >= 20) {
          const [e, n] = localMetres(tr.fixLat, v.lat, v.lon, tr.fixLat, tr.fixLon);
          tr.moveE = e / moved;
          tr.moveN = n / moved;
        }
      }
      const prevS = shapeChanged ? null : tr.fixS;
      const dtS = Math.max(0, (newFixT - tr.fixT) / 1000);
      tr.fixLat = v.lat;
      tr.fixLon = v.lon;
      tr.fixAtRaw = fixAt;
      tr.fixT = newFixT;
      tr.fixS = locateOnShape(tr, v, prevS, dtS);
    } else if (shapeChanged || (tr.shape && tr.fixS === null)) {
      tr.fixS = locateOnShape(tr, v, null, 0);
    }

    const prevMode = tr.mode;
    tr.mode =
      tr.shape && tr.fixS !== null
        ? "route"
        : tr.nextLat !== null && tr.nextLon !== null
          ? "straight"
          : "static";
    plan(tr);
    if (tr.mode !== prevMode || shapeChanged) reanchor(tr);

    // big disagreement with what's on screen → snap rather than race/rewind
    if (tr.sampled && !tr.snapNext) {
      if (tr.mode === "route") {
        const e = targetS(tr, recvMs) - tr.dispS;
        if (e > cfg.snapBehindM || -e > cfg.snapAheadM) tr.snapNext = true;
      } else {
        const [la, lo] = target2d(tr, recvMs);
        if (segMeters(la, lo, tr.dispLat, tr.dispLon) > cfg.snap2dM) tr.snapNext = true;
      }
    }
  }

  function writeOut(tr: Track, lat: number, lon: number, out: MotionSample): void {
    tr.dispLat = lat;
    tr.dispLon = lon;
    out.lat = lat;
    out.lon = lon;
    out.heading = tr.heading;
    out.moving = tr.moving;
  }

  function steerHeading(tr: Track, target: number | null, dt: number): void {
    if (target === null) return;
    if (tr.heading === null) {
      tr.heading = target;
      return;
    }
    const k = 1 - Math.exp(-dt / cfg.headTauMs);
    tr.heading = (((tr.heading + wrap180(target - tr.heading) * k) % 360) + 360) % 360;
  }

  return {
    setShape(shape) {
      shapes.set(shape.key, shape);
      for (const tr of tracks.values()) {
        if ((tr.overrideKey ?? tr.wireKey) === shape.key && tr.shape !== shape) attachShape(tr);
      }
    },
    missingShapes() {
      const miss = new Set<string>();
      for (const tr of tracks.values()) {
        if (tr.wireKey && !tr.overrideKey && !shapes.has(tr.wireKey)) miss.add(tr.wireKey);
      }
      return [...miss];
    },
    overrideShape(trackId, key) {
      const tr = tracks.get(trackId);
      if (!tr) {
        if (key === null) pendingOverride.delete(trackId);
        else pendingOverride.set(trackId, key);
        return;
      }
      if (tr.overrideKey === key) return;
      tr.overrideKey = key;
      // drop the old geometry: the override (or the wire shape) replaces it
      tr.shape = null;
      tr.fixS = null;
      attachShape(tr);
    },
    ingest(vehicles, recvMs, serverNowMs) {
      if (typeof serverNowMs === "number" && Number.isFinite(serverNowMs)) {
        const sample = recvMs - serverNowMs;
        offset = offset === null || Math.abs(sample - offset) > 1000 ? sample : offset + 0.3 * (sample - offset);
      }
      for (const v of vehicles) {
        if (!v || typeof v.id !== "string" || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
        ingestOne(v, recvMs);
      }
      for (const [id, tr] of tracks) {
        if (tr.pins <= 0 && recvMs - tr.lastSeen > cfg.goneMs) tracks.delete(id);
      }
      // shapes no track uses any more
      if (shapes.size > 300) {
        const used = new Set<string>();
        for (const tr of tracks.values()) {
          if (tr.shape) used.add(tr.shape.key);
          if (tr.wireKey) used.add(tr.wireKey);
          if (tr.overrideKey) used.add(tr.overrideKey);
        }
        for (const k of pendingOverride.values()) used.add(k);
        for (const k of shapes.keys()) if (!used.has(k)) shapes.delete(k);
      }
    },
    sample(id, t, out) {
      const tr = tracks.get(id);
      if (!tr) return false;
      if (tr.sampled && t <= tr.lastSampleT) {
        writeOut(tr, tr.dispLat, tr.dispLon, out);
        return true;
      }
      const dt = tr.sampled ? t - tr.lastSampleT : 0;
      const snap = !tr.sampled || tr.snapNext || dt > cfg.maxSampleGapMs;
      tr.lastSampleT = t;
      tr.sampled = true;
      tr.snapNext = false;
      const prevLat = tr.dispLat;
      const prevLon = tr.dispLon;

      if (tr.mode === "route" && tr.shape) {
        const sh = tr.shape;
        const sT = targetS(tr, t);
        if (snap) {
          tr.dispS = sT;
          tr.latE = 0;
          tr.latN = 0;
          tr.aheadSince = null;
        } else {
          const dtS = dt / 1000;
          const e = sT - tr.dispS;
          if (isGhost(tr, t)) {
            // no news for long: settle back onto the last real fix
            tr.dispS += e * (1 - Math.exp(-dt / 2000));
          } else if (e >= 0) {
            tr.aheadSince = null;
            const u = Math.min(tr.vPred + e / cfg.catchupTauS, cfg.catchupMaxMult * tr.vPred + cfg.catchupMaxAdd);
            tr.dispS = Math.min(sT, tr.dispS + u * dtS);
          } else {
            tr.aheadSince ??= t;
            if (t - tr.aheadSince > cfg.aheadStallMs && -e > 25) {
              // stuck ahead of the truth for long (e.g. a long red light): ease back
              tr.dispS += e * (1 - Math.exp(-dt / 3000));
            } else {
              const u = tr.vPred * Math.min(1, Math.max(0, 1 + e / cfg.aheadFadeM));
              tr.dispS += u * dtS;
            }
          }
          const k = Math.exp(-dt / cfg.latTauMs);
          tr.latE *= k;
          tr.latN *= k;
        }
        tr.dispS = Math.min(sh.pl.length, Math.max(0, tr.dispS));
        pointAt(sh.pl, tr.dispS, tr.segHint, pa);
        tr.segHint = pa.seg;
        const kx = M_PER_DEG * Math.cos(pa.lat * RAD);
        const lat = pa.lat + tr.latN / M_PER_DEG;
        const lon = pa.lon + tr.latE / kx;
        const step = segMeters(prevLat, prevLon, lat, lon);
        tr.moving = !snap && dt > 0 && (step / dt) * 1000 > 0.5;
        if (tr.moving || tr.heading === null) steerHeading(tr, tangentBearing(sh.pl, tr.dispS), snap ? 1e9 : dt);
        writeOut(tr, lat, lon, out);
        return true;
      }

      // 2D modes: chase the target point
      const [tLat, tLon] = target2d(tr, t);
      let lat = tLat;
      let lon = tLon;
      if (!snap) {
        const [e, n] = localMetres(tr.dispLat, tLat, tLon, tr.dispLat, tr.dispLon);
        const back = tr.mode === "straight" ? -(e * tr.dirE + n * tr.dirN) : 0;
        const k = 1 - Math.exp(-dt / cfg.followTauMs);
        if (back > 0 && back <= 15 && !isGhost(tr, t)) {
          // target fell slightly behind the displayed point: wait instead of reversing
          lat = tr.dispLat;
          lon = tr.dispLon;
        } else {
          lat = tr.dispLat + (tLat - tr.dispLat) * k;
          lon = tr.dispLon + (tLon - tr.dispLon) * k;
        }
      }
      const step = segMeters(prevLat, prevLon, lat, lon);
      tr.moving = !snap && dt > 0 && (step / dt) * 1000 > 0.5;
      if (tr.moving && step > 0.05) {
        const kx = Math.cos(lat * RAD);
        const h = Math.atan2((lon - prevLon) * kx, lat - prevLat) / RAD;
        steerHeading(tr, (h + 360) % 360, dt);
      } else if (tr.heading === null && tr.bearing !== null) {
        tr.heading = tr.bearing;
      }
      writeOut(tr, lat, lon, out);
      return true;
    },
    snap(id) {
      if (id !== undefined) {
        const tr = tracks.get(id);
        if (tr) tr.snapNext = true;
        return;
      }
      for (const tr of tracks.values()) tr.snapNext = true;
    },
    pin(id, on) {
      const tr = tracks.get(id);
      if (tr) tr.pins = Math.max(0, tr.pins + (on ? 1 : -1));
    },
    has(id) {
      return tracks.has(id);
    },
    displayed(id) {
      const tr = tracks.get(id);
      if (!tr) return null;
      return tr.sampled
        ? { lat: tr.dispLat, lon: tr.dispLon, heading: tr.heading }
        : { lat: tr.fixLat, lon: tr.fixLon, heading: tr.bearing };
    },
    resetClock() {
      offset = null;
    },
    inspect(id) {
      const tr = tracks.get(id);
      if (!tr) return null;
      return {
        mode: tr.mode,
        hold: tr.hold,
        vPred: tr.vPred,
        speed: tr.speed,
        atStop: tr.atStop,
        fixS: tr.fixS,
        dispS: tr.dispS,
        capS: tr.capS,
        shape: tr.shape?.key ?? null,
        fixAgeMs: tr.lastSampleT - tr.fixT,
        horizonMs: tr.horizonMs,
      };
    },
    size() {
      return tracks.size;
    },
  };
}
