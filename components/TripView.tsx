"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useNow } from "@/components/hooks";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ArrowsHorizontalIcon,
  DropIcon,
  LeafIcon,
  LightningIcon,
  SnowflakeIcon,
  TicketIcon,
  WheelchairIcon,
} from "@/components/icons";
import { BackIcon, CloseIcon, ErrorState, IconButton, LineBadge, ShareButton } from "@/components/ui";
import {
  computeEta,
  delayClass,
  delayTxt,
  detectLoopStops,
  displayStopName,
  formatPlatform,
  formatPrzezLoop,
  hhmmFromSecs,
  isBusStation,
  isMzk,
  notStartedEta,
  operatorColor,
  secsFromHHMM,
  tripTimeMatchesStop,
} from "@/lib/client/format";
import { findActiveStop, type ActiveStopResult } from "@/lib/client/geo";
import type { LatLng, Stop, TripView as TripViewState, Vehicle, VehicleFeatures } from "@/lib/client/types";
import { progressFromVehicle, stopAlongFor } from "@/lib/shared/trip-progress";

interface Props {
  trip: TripViewState;
  desktop: boolean;
  /** vehicle the trip was opened from (extra header context), if any */
  vehMeta: Vehicle | null;
  /** fresh live poll for this trip's vehicle (matched by exec id) — advances the
   *  highlighted stop, the "pojazd na" line and the header delay in real time */
  liveVeh: Vehicle | null;
  /** present when the trip was opened from a stop panel — returns to it */
  onBack: (() => void) | null;
  onClose: () => void;
  onFocusStop: (s: Stop) => void;
  onRetry: () => void;
  initialSnap?: "peek" | "half" | "full";
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-text-faint border-t-text align-[-1px]"
      aria-hidden
    />
  );
}

/* the features rendered as chips below (ecoVehicle has none, so it must not open an empty row) */
const SHOWN_FEATURES = [
  "electric",
  "hydrogen",
  "hybrid",
  "airCondition",
  "lowFloor",
  "longVehicle",
  "ticketMachine",
] as const satisfies readonly (keyof VehicleFeatures)[];

/** Neutral vehicle-feature chip: a fact about the bus, so no colour of its own. */
function Feature({ icon, label, title }: { icon: React.ReactNode; label: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/6 px-2 py-0.5 text-text-mute" title={title}>
      <span className="text-[12px]">{icon}</span>
      {label}
    </span>
  );
}

function TimelineSkeleton() {
  return (
    <div aria-hidden className="px-5 pt-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-3">
          <div className="skeleton h-3.5 w-10" />
          <div className="skeleton h-3 w-3 rounded-full" />
          <div className="skeleton h-3.5 flex-1" />
        </div>
      ))}
    </div>
  );
}

function TripView({
  trip,
  desktop,
  vehMeta,
  liveVeh,
  onBack,
  onClose,
  onFocusStop,
  onRetry,
  initialSnap = "half",
}: Props) {
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  /* last-known live fix — when the vehicle drops off the 5 s feed mid-view
     (finished/stale/pruned) keep the freshest progress instead of regressing
     to the opening snapshot; reset whenever a different trip is shown
     (setState-during-render is the sanctioned way to adjust state on prop change) */
  const [lastLiveHeld, setLastLiveHeld] = useState<{ gen: number; veh: Vehicle | null; vti: number | null }>({
    gen: trip.gen,
    veh: null,
    vti: null,
  });
  let lastLive = lastLiveHeld;
  if (lastLive.gen !== trip.gen) {
    lastLive = { gen: trip.gen, veh: null, vti: null };
    setLastLiveHeld(lastLive);
  }
  if (liveVeh && lastLive.veh !== liveVeh) {
    lastLive = {
      gen: trip.gen,
      veh: liveVeh,
      vti: liveVeh.geo_seq ?? liveVeh.current_stop_sequence ?? lastLive.vti,
    };
    setLastLiveHeld(lastLive);
  }

  const currentVeh = liveVeh ?? lastLive.veh ?? vehMeta;
  const tripOp = currentVeh?.operator ?? trip.operator;
  const isMzkTrip = isMzk(tripOp, trip.line);
  const lineColor = operatorColor(tripOp, trip.line === "…" ? null : trip.line);
  const loading = trip.status === "loading";
  const failed = trip.status === "error";

  const hasLiveCoords =
    (currentVeh != null && Number.isFinite(currentVeh.lat) && Number.isFinite(currentVeh.lon)) ||
    (trip.vehicle != null && Number.isFinite(trip.vehicle.lat) && Number.isFinite(trip.vehicle.lon));
  const isLiveWithLoc = trip.isLive && hasLiveCoords;
  /* MZK bus waiting at the first stop of a course that has not begun: OnTime's delay
     and per-stop times are a placeholder (now - scheduled start) — show the schedule,
     "czeka na odjazd" and never a delay (lib/mzk-state.ts) */
  const notStarted = isLiveWithLoc && currentVeh?.not_started === true;

  /* prefer the live poll's current stop over the snapshot; geo_seq (GPS, sent only while upstream's index is
     stale) beats current_stop_sequence — a stale hint puts a bus on the OUTBOUND leg of a loop */
  const liveVti = liveVeh?.geo_seq ?? liveVeh?.current_stop_sequence ?? lastLive.vti;

  /** schedule index → resolved physical stop (for fly-to on tap and coordinate lookup) */
  const stopByIndex = useMemo(() => {
    const m = new Map<number, Stop>();
    for (const r of trip.stops) m.set(r.t.index, r.s);
    return m;
  }, [trip.stops]);

  /** along-route metres of every stop on the drawn road shape — the same projection the server stores,
   *  so the vehicle's `dist_m` can be read against it. Only when the drawn shape IS the server shape
   *  the vehicle reports (trip.shapeId === liveVeh.shape, checked below); KB only (MZK's index and
   *  odometer come straight from the operator). */
  const stopAlong = useMemo(() => {
    if (isMzkTrip || !trip.shapeId || !trip.routed) return null;
    const refs = trip.rawTimes.map((t): LatLng | null => {
      const s = stopByIndex.get(t.index);
      return s ? [s.lat, s.lon] : null;
    });
    return stopAlongFor(trip.routed, refs);
  }, [isMzkTrip, trip.shapeId, trip.routed, trip.rawTimes, stopByIndex]);

  /* Dynamically determine the active stop index (current stop the bus is at/approaching) */
  const activeStop: ActiveStopResult = (() => {
    const times = trip.rawTimes;
    if (!times.length) return { index: 0, isAtStop: false };

    if (isLiveWithLoc && trip.stops.length > 0) {
      const v = liveVeh ?? trip.vehicle;
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
        // the server tracks the vehicle with continuity (twin stops of an out-and-back, a frozen upstream
        // index): its along-route distance says WHERE on the route the bus is, whatever upstream's index says
        const sp = progressFromVehicle(stopAlong, trip.shapeId, liveVeh, liveVti ?? trip.vti);
        if (sp) return { index: sp.index, isAtStop: sp.at, progress: sp.progress };
        return findActiveStop(
          times.map((t) => {
            const s = stopByIndex.get(t.index);
            return s ? { lat: s.lat, lon: s.lon } : null;
          }),
          {
            lat: v.lat,
            lon: v.lon,
            at_stop: liveVeh?.at_stop,
            current_stop_sequence: liveVti ?? trip.vti,
          },
          liveVti ?? trip.vti,
        );
      }
    }

    // Scheduled / no live GPS fix -> calculate from Europe/Warsaw schedule time
    for (let i = 0; i < times.length; i++) {
      const sched = secsFromHHMM(times[i].departure_time);
      if (sched != null && sched > now) {
        if (i === 0) return { index: 0, isAtStop: true, progress: 0 };
        const prevSched = secsFromHHMM(times[i - 1].departure_time);
        const progress =
          prevSched != null ? Math.min(1, Math.max(0, (now - prevSched) / (sched - prevSched))) : 0;
        return { index: i - 1, isAtStop: false, progress };
      }
    }
    // All scheduled times in the past -> course completed
    return { index: times.length - 1, isAtStop: true, progress: 1 };
  })();

  const vti = activeStop.index;
  const isAtStop = activeStop.isAtStop;
  const activeProgress = Math.max(0, Math.min(1, activeStop.progress ?? (isAtStop ? 1 : 0.5)));
  const headerDelay = notStarted
    ? null
    : (currentVeh?.delay ?? trip.rawTimes[vti ?? -1]?.estimate?.time_diff ?? null);
  const direction = trip.direction || vehMeta?.headsign;
  const loopStops = useMemo(() => detectLoopStops(trip.rawTimes), [trip.rawTimes]);
  const eta = loading || failed
    ? ""
    : notStarted
      ? notStartedEta(trip, now)
      : computeEta(trip, now, vti, isAtStop, headerDelay);

  const scrollTargetIdx = useMemo(() => {
    if (vti == null) return -1;
    if (trip.stop) {
      const tappedIdx = trip.rawTimes.findIndex((t) => tripTimeMatchesStop(t, trip.stop!));
      if (tappedIdx >= 0) return tappedIdx;
    }
    return vti;
  }, [trip.rawTimes, trip.stop, vti]);

  useEffect(() => {
    if (!scrollRef.current || !currentRef.current) return;
    currentRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollTargetIdx]);

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-start gap-2.5">
        {onBack && (
          <IconButton label="Wróć do przystanku" onClick={onBack}>
            <BackIcon />
          </IconButton>
        )}
        <LineBadge line={trip.line} operator={isMzkTrip ? "MZK" : "KB"} big />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-semibold leading-tight tracking-tight text-text">
            {loading ? "Wczytywanie…" : direction ? displayStopName(direction) : `Linia ${trip.line}`}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-text-mute">
            {isLiveWithLoc && notStarted ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-late">
                <span className="h-1.5 w-1.5 rounded-full bg-late" aria-hidden />
                Czeka na odjazd
              </span>
            ) : isLiveWithLoc ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-good">
                <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" aria-hidden />
                Na żywo
              </span>
            ) : (
              <span className="text-text-faint">Rozkładowy</span>
            )}
            {isLiveWithLoc && headerDelay != null && (
              <span className={`font-semibold tabular-nums ${delayClass(headerDelay)}`}>
                {delayTxt(headerDelay)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${isMzkTrip ? "bg-mzk" : "bg-kb"}`} aria-hidden />
              {isMzkTrip ? "MZK Bielsko-Biała" : "Komunikacja Beskidzka"}
            </span>
            {trip.status === "routing" && (
              <span className="inline-flex items-center gap-1.5 text-text-faint">
                <Spinner /> wyznaczanie trasy…
              </span>
            )}
          </div>
          {(isMzkTrip && currentVeh?.side_number) ||
          SHOWN_FEATURES.some((k) => currentVeh?.features?.[k]) ||
          trip.note ||
          loopStops.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
              {isMzkTrip && currentVeh?.side_number && (
                <a
                  href={`/brygady?tabor=${encodeURIComponent(currentVeh.side_number)}`}
                  title="Zobacz kartę pojazdu i dzisiejsze kursy"
                  className="tap group inline-flex items-center gap-1 rounded-full bg-white/8 px-2 py-0.5 font-medium text-text hover:bg-white/12"
                >
                  <span className="tabular-nums">#{currentVeh.side_number}</span>
                  {currentVeh.model ? <span className="font-normal text-text-mute">· {currentVeh.model}</span> : null}
                  <span className="ml-0.5 inline-flex items-center gap-0.5 text-primary">
                    Karta pojazdu
                    <ArrowRightIcon className="text-[10px] transition-transform duration-200 group-hover:translate-x-0.5" />
                  </span>
                </a>
              )}
              {currentVeh?.features?.electric && <Feature icon={<LightningIcon weight="fill" />} label="Elektryczny" />}
              {currentVeh?.features?.hydrogen && <Feature icon={<DropIcon weight="fill" />} label="Wodorowy" />}
              {currentVeh?.features?.hybrid && <Feature icon={<LeafIcon weight="fill" />} label="Hybryda" />}
              {currentVeh?.features?.airCondition && (
                <Feature icon={<SnowflakeIcon />} label="Klima" title="Klimatyzacja" />
              )}
              {currentVeh?.features?.lowFloor && <Feature icon={<WheelchairIcon />} label="Niska podłoga" />}
              {currentVeh?.features?.longVehicle && (
                <Feature icon={<ArrowsHorizontalIcon />} label="Przegubowy" title="Pojazd przegubowy, 18 m" />
              )}
              {currentVeh?.features?.ticketMachine && (
                <Feature icon={<TicketIcon />} label="Biletomat" title="Biletomat na pokładzie" />
              )}
              {trip.note && (
                <span className="rounded-full bg-late/10 px-2 py-0.5 font-medium text-late">{trip.note}</span>
              )}
              {loopStops.length > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-white/6 px-2 py-0.5 text-text"
                  title={`Kurs realizowany przez pętlę: ${loopStops.map(displayStopName).join(", ")}`}
                >
                  <ArrowsClockwiseIcon className="text-[12px] text-text-mute" />
                  przez {loopStops.map((s) => formatPrzezLoop(displayStopName(s))).join(", ")}
                </span>
              )}
            </div>
          ) : null}
        </div>
        {!loading && (
          <ShareButton title={`Linia ${trip.line}${direction ? ` → ${displayStopName(direction)}` : ""}`} />
        )}
        <IconButton label="Zamknij trasę" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {eta && (
        <p className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-[12.5px] tabular-nums text-text-mute" aria-live="polite">
          {eta}
        </p>
      )}
    </header>
  );

  return (
    <BottomSheet
      desktop={desktop}
      onClose={onClose}
      ariaLabel={`Trasa linii ${trip.line}`}
      /* opens at half (2/4) screen so route & map vehicle are both visible; swipe up to 3/4 or down to peek */
      initialSnap={initialSnap}
      header={header}
    >
      <div ref={scrollRef} className="kb-scroll h-full overflow-y-auto">
        {failed ? (
          <ErrorState onRetry={onRetry} />
        ) : loading ? (
          <TimelineSkeleton />
        ) : (
          <ol className="px-4 pt-1" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
            {trip.rawTimes.map((t, idx) => {
              const isCurrent = vti != null && idx === vti;
              const passed = vti != null && idx < vti;
              const isTransit = !isAtStop && vti != null && vti > 0;
              const isPrevStop = isTransit && idx === vti - 1;
              const isNextStop = isTransit && idx === vti;
              const diff = notStarted ? null : (t.estimate?.time_diff ?? null);
              const effectiveDiff = diff ?? (isLiveWithLoc && !passed ? headerDelay : null);
              const planned = secsFromHHMM(t.departure_time);
              const est = isLiveWithLoc && effectiveDiff != null && planned != null;
              const shown = est ? hhmmFromSecs((planned as number) + (effectiveDiff as number)) : t.departure_time;
              const bigDiff = est && Math.abs(effectiveDiff as number) > 60;
              const selected = !!trip.stop && tripTimeMatchesStop(t, trip.stop);
              const coord = stopByIndex.get(t.index);
              const first = idx === 0;
              const last = idx === trip.rawTimes.length - 1;
              return (
                <li key={`${t.index}-${idx}`} ref={idx === scrollTargetIdx ? currentRef : undefined}>
                  <button
                    type="button"
                    disabled={!coord}
                    onClick={() => coord && onFocusStop(coord)}
                    className={`flex w-full items-stretch gap-3 rounded-xl text-left transition-colors ${
                      coord ? "hover:bg-white/5 active:bg-white/8" : ""
                    } ${selected ? "bg-primary-dim" : ""}`}
                  >
                    {/* time */}
                    <span
                      className={`w-12 shrink-0 self-center pl-1 text-right text-[13px] font-semibold tabular-nums ${
                        passed ? "text-text-faint" : est ? delayClass(effectiveDiff) : "text-text"
                      }`}
                    >
                      {shown}
                    </span>

                    {/* timeline node */}
                    <span className="relative w-5 shrink-0 self-stretch" aria-hidden>
                      {/* top half line (from top of row to center node) */}
                      {!first && (
                        <span
                          className="absolute left-1/2 top-0 h-1/2 w-[3px] -translate-x-1/2"
                          style={{ background: idx <= vti ? "rgba(255,255,255,0.18)" : lineColor }}
                        />
                      )}
                      {/* descending line overlay on approaching stop (when vehicle enters second half of segment) */}
                      {isNextStop && activeProgress > 0.5 && (
                        <span
                          className="pointer-events-none absolute left-1/2 top-0 w-[3px] -translate-x-1/2 rounded-full transition-[height] duration-700 ease-out-soft"
                          style={{
                            height: `${Math.min(50, (activeProgress - 0.5) * 100)}%`,
                            background: lineColor,
                          }}
                        />
                      )}
                      {/* vehicle marker moving down approaching stop */}
                      {isNextStop && activeProgress > 0.5 && (
                        <span
                          className="pointer-events-none absolute left-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-sm transition-[top] duration-700 ease-out-soft"
                          style={{ top: `${(activeProgress - 0.5) * 100}%`, background: lineColor }}
                        />
                      )}

                      {/* bottom half line (from center node to bottom of row) */}
                      {!last && (
                        <span
                          className="absolute bottom-0 left-1/2 h-1/2 w-[3px] -translate-x-1/2"
                          style={{ background: idx < vti ? "rgba(255,255,255,0.18)" : lineColor }}
                        />
                      )}
                      {/* descending line overlay on previous stop (vehicle descending in first half of segment) */}
                      {isPrevStop && (
                        <span
                          className="pointer-events-none absolute left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-[height] duration-700 ease-out-soft"
                          style={{
                            top: "50%",
                            height: `${Math.min(50, activeProgress * 100)}%`,
                            background: lineColor,
                          }}
                        />
                      )}
                      {/* vehicle marker moving down previous stop */}
                      {isPrevStop && activeProgress <= 0.5 && (
                        <span
                          className="pointer-events-none absolute left-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-sm transition-[top] duration-700 ease-out-soft"
                          style={{ top: `${50 + activeProgress * 100}%`, background: lineColor }}
                        />
                      )}

                      {/* stop center node */}
                      {isCurrent ? (
                        isAtStop ? (
                          <span
                            className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-sm"
                            style={{ background: lineColor }}
                          />
                        ) : (
                          <span
                            className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                            style={{ borderColor: lineColor, background: "var(--color-surface)" }}
                          />
                        )
                      ) : (
                        <span
                          className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                          style={{
                            borderColor: passed ? "rgba(255,255,255,0.25)" : lineColor,
                            background: passed ? "transparent" : "var(--color-surface)",
                          }}
                        />
                      )}
                    </span>

                    {/* name */}
                    <span className="min-w-0 flex-1 self-center py-3">
                      <span
                        className={`block truncate text-[13.5px] ${
                          isCurrent
                            ? "font-semibold text-text"
                            : passed
                              ? "text-text-faint"
                              : selected
                                ? "font-semibold text-text"
                                : "font-medium text-text"
                        }`}
                      >
                        {displayStopName(t.stop_name)}
                      </span>
                      {(() => {
                        const plat = formatPlatform(t.platform, isBusStation(t.stop_name, coord));
                        if (!plat && !bigDiff) return null;
                        return (
                          <span className="mt-0.5 block text-[12px] text-text-faint">
                            {bigDiff ? <s className="tabular-nums">plan {t.departure_time}</s> : null}
                            {bigDiff && plat ? " · " : ""}
                            {plat}
                          </span>
                        );
                      })()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(TripView);
