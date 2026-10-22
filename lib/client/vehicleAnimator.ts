"use client";

/**
 * Per-map animator — the ONLY writer of live-vehicle marker positions and
 * heading arrows (fleet markers from VehicleLayer, the tracked bus from
 * TripLayer). Drives the pure motion engine (vehicleMotion.ts) from a
 * requestAnimationFrame loop, outside React: MapApp re-renders every poll, so
 * per-frame state there would re-render the whole tree.
 *
 *  - smooth motion on: sample the engine, write markers whose rounded pixel
 *    changed; fleet at a zoom-scaled rate (~4 Hz at city zoom), the tracked
 *    bus every frame; off-screen fleet markers are sampled ~1 Hz, not written.
 *  - off ("Płynny ruch pojazdów" switched off): passthrough — raw fixes are
 *    written on each poll and the CSS glide (globals.css) animates them.
 *  - pauses during zoom animations (Leaflet places markers itself) — a frame
 *    gate, never a sticky flag — and while the tab is hidden.
 *
 * CLIENT-ONLY: imports leaflet; reach it only from ssr:false trees.
 */
import L from "leaflet";
import { preparePolyline, projectStopsAlong, type LatLng } from "../shared/polyline";
import { fleetIntervalMs, metersPerPixel, unwrapDeg, zoomGateOpen } from "./motionSchedule";
import { getShape, onShape, requestShapes } from "./shapes";
import { getSmoothMotion, subscribeSmoothMotion } from "./smoothMotion";
import type { Vehicle } from "./types";
import { createMotionStore, makeMotionShape, type MotionSample, type MotionStore } from "./vehicleMotion";

/** Fleet shapes are fetched only when zoomed in enough for road vs straight to show. */
const SHAPE_MIN_ZOOM = 13;
const OUTSIDE_SAMPLE_MS = 1000;
const HEADING_STEP_DEG = 2;
const MAX_FLEET_INTERVAL = 500;

interface View {
  trackId: string;
  marker: L.Marker;
  kind: "fleet" | "tracked";
  arrowEl: HTMLElement | null;
  /** last written (unwrapped) arrow angle */
  arrowDeg: number | null;
  px: number;
  py: number;
  epoch: number;
  lastSampleT: number;
  outside: boolean;
  /** track id currently pinned in the store for this view */
  pinned: string | null;
}

export interface VehiclesClock {
  recvPerf: number;
  serverMs: number | null;
}

export class VehicleAnimator {
  readonly store: MotionStore = createMotionStore();
  private readonly map: L.Map;
  private views = new Map<string, View>();
  private trackedCount = 0;
  private raw = new Map<string, Vehicle>();
  private headingSeen = new Set<string>();
  private enabled: boolean;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFleet = -Infinity;
  private baseInterval = 250;
  private costFactor = 1;
  private costEma = 0;
  private lastZoomEvt = -Infinity;
  private epoch = 0;
  /* padded viewport (writes) and shape-demand box, as plain numbers */
  private vb = { s: -90, w: -180, n: 90, e: 180 };
  private sb = { s: -90, w: -180, n: 90, e: 180 };
  private lastMoveRecalc = 0;
  private readonly out: MotionSample = { lat: 0, lon: 0, heading: null, moving: false };
  private offs: Array<() => void> = [];
  private disposed = false;
  private frameErrorLogged = false;

  constructor(map: L.Map) {
    this.map = map;
    this.enabled = getSmoothMotion();
    this.applyClass();
    this.recomputeView();

    const onZoomEvt = (): void => {
      this.lastZoomEvt = performance.now();
    };
    const onZoomEnd = (): void => {
      this.lastZoomEvt = performance.now();
      this.epoch += 1;
      this.recomputeView();
      this.demandShapes();
      this.fullPass();
      this.schedule();
    };
    const onMoveEnd = (): void => {
      this.recomputeView();
      this.demandShapes();
      this.fullPass();
    };
    const onMove = (): void => {
      const now = performance.now();
      if (now - this.lastMoveRecalc > 150) {
        this.lastMoveRecalc = now;
        this.recomputeView();
      }
    };
    map.on("zoomstart zoom zoomanim", onZoomEvt);
    map.on("zoomend viewreset", onZoomEnd);
    map.on("moveend resize", onMoveEnd);
    map.on("move", onMove);
    this.offs.push(() => {
      map.off("zoomstart zoom zoomanim", onZoomEvt);
      map.off("zoomend viewreset", onZoomEnd);
      map.off("moveend resize", onMoveEnd);
      map.off("move", onMove);
    });

    const onVis = (): void => {
      if (document.hidden) this.cancel();
      else this.resume();
    };
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) this.resume();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    this.offs.push(() => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
    });
    this.offs.push(subscribeSmoothMotion(() => this.setEnabled(getSmoothMotion())));
    this.offs.push(onShape((s) => this.store.setShape(makeMotionShape(s.id, s.pl, s.stops))));
    // dev-only handle for poking at the motion state from the console
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __kbAnimator?: VehicleAnimator }).__kbAnimator = this;
    }
  }

  /* ------------------------------------------------------------ data in */

  /** Feed one /api/vehicles poll (all vehicles, regardless of filters). */
  ingest(vehicles: readonly Vehicle[], clock: VehiclesClock | null): void {
    if (this.disposed) return;
    this.raw.clear();
    for (const v of vehicles) {
      this.raw.set(v.id, v);
      if (v.bearing != null) this.headingSeen.add(v.id);
    }
    this.store.ingest(vehicles, clock?.recvPerf ?? performance.now(), clock?.serverMs ?? null);
    // exec ids are unique per trip — forget the ones the engine dropped
    if (this.headingSeen.size > 2 * this.store.size() + 64) {
      for (const id of this.headingSeen) if (!this.store.has(id)) this.headingSeen.delete(id);
    }
    // shapes another vehicle (or an earlier view) already fetched
    for (const key of this.store.missingShapes()) {
      const s = getShape(key);
      if (s) this.store.setShape(makeMotionShape(s.id, s.pl, s.stops));
    }
    this.repin();
    this.demandShapes();
    if (this.enabled) this.schedule();
    else this.passthrough();
  }

  /** The latest raw wire record of a vehicle (null when it left the poll). */
  latest(id: string): Vehicle | null {
    return this.raw.get(id) ?? null;
  }

  /** Has this track ever had a heading? (latched, so icons don't flip arrow on/off) */
  headingKnown(trackId: string): boolean {
    return this.headingSeen.has(trackId);
  }

  /** Where the marker of this track is (or should be) drawn right now. */
  displayed(trackId: string): { lat: number; lon: number; heading: number | null } | null {
    if (this.enabled) {
      const d = this.store.displayed(trackId);
      if (d) return d;
    }
    const v = this.raw.get(trackId);
    return v ? { lat: v.lat, lon: v.lon, heading: v.bearing } : null;
  }

  /** Register the drawn trip route as a shape the tracked track can follow. */
  setTripShape(key: string, pts: readonly LatLng[], stopRefs: ReadonlyArray<LatLng | null>): void {
    const pl = preparePolyline(pts);
    if (!pl) return;
    this.store.setShape(makeMotionShape(key, pl, projectStopsAlong(pl, stopRefs)));
  }

  overrideShape(trackId: string, key: string | null): void {
    this.store.overrideShape(trackId, key);
  }

  /* ------------------------------------------------------------ views */

  addView(viewId: string, trackId: string, marker: L.Marker, kind: "fleet" | "tracked"): void {
    const prev = this.views.get(viewId);
    if (prev) {
      if (prev.marker === marker && prev.trackId === trackId) return;
      this.removeView(viewId);
    }
    const view: View = {
      trackId,
      marker,
      kind,
      arrowEl: null,
      arrowDeg: null,
      px: NaN,
      py: NaN,
      epoch: -1,
      lastSampleT: -Infinity,
      outside: false,
      pinned: null,
    };
    this.views.set(viewId, view);
    if (kind === "tracked") this.trackedCount += 1;
    this.pin(view);
    if (this.enabled) {
      this.renderView(view, performance.now(), true);
      this.schedule();
    } else {
      this.writeRaw(view);
    }
  }

  /** After setIcon(): the arrow element was replaced — re-find it and re-apply the heading. */
  refreshViewDom(viewId: string): void {
    const view = this.views.get(viewId);
    if (!view) return;
    view.arrowEl = null;
    view.arrowDeg = null;
    const d = this.displayed(view.trackId);
    if (d?.heading != null) this.writeArrow(view, d.heading);
  }

  removeView(viewId: string): void {
    const view = this.views.get(viewId);
    if (!view) return;
    this.unpin(view);
    if (view.kind === "tracked") this.trackedCount -= 1;
    this.views.delete(viewId);
    if (this.views.size === 0) this.cancel();
  }

  /* ------------------------------------------------------------ internals */

  private pin(view: View): void {
    if (view.pinned === view.trackId || !this.store.has(view.trackId)) return;
    this.store.pin(view.trackId, true);
    view.pinned = view.trackId;
  }

  private unpin(view: View): void {
    if (view.pinned) this.store.pin(view.pinned, false);
    view.pinned = null;
  }

  /** Tracks that appeared after their view was attached get pinned now. */
  private repin(): void {
    for (const view of this.views.values()) if (view.pinned !== view.trackId) this.pin(view);
  }

  private applyClass(): void {
    this.map.getContainer().classList.toggle("veh-motion", this.enabled && !this.disposed);
  }

  private setEnabled(on: boolean): void {
    if (on === this.enabled || this.disposed) return;
    this.enabled = on;
    if (on) {
      this.applyClass();
      this.store.snap();
      this.epoch += 1;
      this.demandShapes();
      this.fullPass();
      this.schedule();
    } else {
      this.cancel();
      // jump to the raw fixes while transitions are still off, then hand the
      // markers back to the CSS glide
      this.passthrough();
      void this.map.getContainer().offsetWidth;
      this.applyClass();
    }
  }

  private resume(): void {
    if (this.disposed) return;
    this.store.resetClock();
    this.store.snap();
    this.epoch += 1;
    this.recomputeView();
    if (this.enabled) {
      this.fullPass();
      this.schedule();
    }
  }

  private recomputeView(): void {
    const b = this.map.getBounds();
    if (!b.isValid()) return;
    const pad = (p: number) => {
      const pb = b.pad(p);
      return { s: pb.getSouth(), w: pb.getWest(), n: pb.getNorth(), e: pb.getEast() };
    };
    this.vb = pad(0.5);
    this.sb = pad(0.25);
    this.baseInterval = fleetIntervalMs(metersPerPixel(b.getCenter().lat, this.map.getZoom()));
  }

  private get fleetInterval(): number {
    return Math.min(MAX_FLEET_INTERVAL, this.baseInterval * this.costFactor);
  }

  private demandShapes(): void {
    if (!this.enabled || this.map.getZoom() < SHAPE_MIN_ZOOM) return;
    const missing = new Set(this.store.missingShapes());
    if (!missing.size) return;
    const want: string[] = [];
    const sb = this.sb;
    for (const v of this.raw.values()) {
      if (!v.shape || !missing.has(v.shape)) continue;
      if (v.lat >= sb.s && v.lat <= sb.n && v.lon >= sb.w && v.lon <= sb.e) want.push(v.shape);
    }
    for (const view of this.views.values()) {
      if (view.kind !== "tracked") continue;
      const v = this.raw.get(view.trackId);
      if (v?.shape && missing.has(v.shape)) want.push(v.shape);
    }
    if (want.length) requestShapes(want);
  }

  private cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.disposed || !this.enabled || this.raf || this.timer || this.views.size === 0) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.trackedCount > 0 || this.fleetInterval < 100) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    // slow fleet cadence: don't spin rAF at 60 Hz for 4 Hz of work
    const wait = Math.max(0, this.lastFleet + this.fleetInterval - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.raf = requestAnimationFrame(this.tick);
    }, wait);
  }

  private readonly tick = (t: number): void => {
    this.raf = 0;
    if (this.disposed || !this.enabled || document.hidden) return;
    const animatingZoom = (this.map as unknown as { _animatingZoom?: boolean })._animatingZoom === true;
    if (!zoomGateOpen(performance.now(), this.lastZoomEvt, animatingZoom)) {
      this.schedule();
      return;
    }
    try {
      this.frame(t);
    } catch (err) {
      // a bad frame must not stop the loop (or spam the console at 60 Hz)
      if (!this.frameErrorLogged) {
        this.frameErrorLogged = true;
        console.error("vehicle animator frame failed", err);
      }
    }
    this.schedule();
  };

  private frame(t: number): void {
    const doFleet = t - this.lastFleet >= this.fleetInterval - 4;
    const c0 = performance.now();
    let tooltipView: View | null = null;
    for (const view of this.views.values()) {
      if (view.kind === "fleet") {
        if (!doFleet) continue;
        if (view.outside && t - view.lastSampleT < OUTSIDE_SAMPLE_MS) continue;
      }
      // a hovered marker's tooltip re-measures itself on every move — write it last
      // (getTooltip()?.: isTooltipOpen() throws on a marker without a tooltip)
      if (view.marker.getTooltip()?.isOpen()) {
        tooltipView = view;
        continue;
      }
      this.renderView(view, t, false);
    }
    if (tooltipView) this.renderView(tooltipView, t, false);
    if (doFleet) {
      this.lastFleet = t;
      this.costEma = 0.8 * this.costEma + 0.2 * (performance.now() - c0);
      if (this.costEma > 4) this.costFactor = Math.min(this.costFactor * 1.5, MAX_FLEET_INTERVAL / this.baseInterval);
      else if (this.costEma < 1.5) this.costFactor = Math.max(1, this.costFactor / 1.2);
    }
  }

  /** Re-place every view (after zoom/pan/enable/resume). */
  private fullPass(): void {
    if (!this.enabled || this.disposed) return;
    const t = performance.now();
    for (const view of this.views.values()) this.renderView(view, t, false);
  }

  private renderView(view: View, t: number, force: boolean): void {
    const o = this.out;
    if (!this.store.sample(view.trackId, t, o)) return; // unknown track: leave the marker be
    view.lastSampleT = t;
    if (o.heading !== null) this.headingSeen.add(view.trackId);
    const vb = this.vb;
    if (view.kind === "fleet" && !(o.lat >= vb.s && o.lat <= vb.n && o.lon >= vb.w && o.lon <= vb.e)) {
      view.outside = true;
      return;
    }
    view.outside = false;
    const p = this.map.latLngToLayerPoint([o.lat, o.lon]);
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    if (force || px !== view.px || py !== view.py || view.epoch !== this.epoch) {
      view.px = px;
      view.py = py;
      view.epoch = this.epoch;
      view.marker.setLatLng([o.lat, o.lon]);
    }
    if (o.heading !== null) this.writeArrow(view, o.heading);
  }

  /** Smooth-motion off: raw fixes, CSS does the glide. */
  private passthrough(): void {
    for (const view of this.views.values()) this.writeRaw(view);
  }

  private writeRaw(view: View): void {
    const v = this.raw.get(view.trackId);
    if (!v) return;
    const cur = view.marker.getLatLng();
    if (cur.lat !== v.lat || cur.lng !== v.lon) view.marker.setLatLng([v.lat, v.lon]);
    if (v.bearing !== null) this.writeArrow(view, v.bearing);
  }

  private writeArrow(view: View, deg: number): void {
    let el = view.arrowEl;
    if (!el || !el.isConnected) {
      el = view.marker.getElement()?.querySelector<HTMLElement>(".veh-arrow") ?? null;
      view.arrowEl = el;
      // continue from the angle baked into the icon so CSS never spins the long way
      const m = el?.style.transform.match(/rotate\((-?[\d.]+)deg\)/);
      view.arrowDeg = m ? Number(m[1]) : null;
    }
    if (!el) return;
    const next = unwrapDeg(view.arrowDeg, deg);
    if (view.arrowDeg !== null && Math.abs(next - view.arrowDeg) < HEADING_STEP_DEG) return;
    view.arrowDeg = next;
    el.style.transform = `rotate(${next.toFixed(1)}deg)`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    for (const view of this.views.values()) this.unpin(view);
    this.views.clear();
    this.trackedCount = 0;
    this.offs.forEach((off) => off());
    this.offs = [];
    this.disposed = true;
    this.applyClass();
  }
}

/* ------------------------------------------------------------ per-map registry */

const registry = new WeakMap<L.Map, { anim: VehicleAnimator; refs: number }>();

/** Shared animator for this map (ref-counted: StrictMode/HMR-safe). */
export function acquireVehicleAnimator(map: L.Map): VehicleAnimator {
  let e = registry.get(map);
  if (!e) {
    e = { anim: new VehicleAnimator(map), refs: 0 };
    registry.set(map, e);
  }
  e.refs += 1;
  return e.anim;
}

export function releaseVehicleAnimator(map: L.Map): void {
  const e = registry.get(map);
  if (!e) return;
  e.refs -= 1;
  if (e.refs <= 0) {
    e.anim.dispose();
    registry.delete(map);
  }
}

/** The map's animator if one exists (e.g. to fly to a bus's drawn position). */
export function peekVehicleAnimator(map: L.Map): VehicleAnimator | null {
  return registry.get(map)?.anim ?? null;
}
