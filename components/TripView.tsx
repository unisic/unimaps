"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useNow } from "@/components/hooks";
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
  operatorColor,
  secsFromHHMM,
  tripTimeMatchesStop,
} from "@/lib/client/format";
import { findActiveStop, type ActiveStopResult } from "@/lib/client/geo";
import type { Stop, TripView as TripViewState, Vehicle } from "@/lib/client/types";

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
      vti: liveVeh.current_stop_sequence ?? lastLive.vti,
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

  /* prefer the live poll's current stop over the snapshot */
  const liveVti = liveVeh?.current_stop_sequence ?? lastLive.vti;

  /** schedule index → resolved physical stop (for fly-to on tap and coordinate lookup) */
  const stopByIndex = useMemo(() => {
    const m = new Map<number, Stop>();
    for (const r of trip.stops) m.set(r.t.index, r.s);
    return m;
  }, [trip.stops]);

  /* Dynamically determine the active stop index (current stop the bus is at/approaching) */
  const activeStop: ActiveStopResult = (() => {
    const times = trip.rawTimes;
    if (!times.length) return { index: 0, isAtStop: false };

    if (isLiveWithLoc && trip.stops.length > 0) {
      const v = liveVeh ?? trip.vehicle;
      if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
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
  const headerDelay =
    currentVeh?.delay ??
    trip.rawTimes[vti ?? -1]?.estimate?.time_diff ??
    null;
  const direction = trip.direction || vehMeta?.headsign;
  const loopStops = useMemo(() => detectLoopStops(trip.rawTimes), [trip.rawTimes]);
  const eta = loading || failed ? "" : computeEta(trip, now, vti, isAtStop, headerDelay);

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
          <h2 className="truncate text-[15px] font-bold leading-tight text-text">
            {loading ? "Wczytywanie…" : direction ? displayStopName(direction) : "—"}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {isLiveWithLoc ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-good/10 px-2 py-0.5 font-semibold text-good">
                <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" aria-hidden />
                NA ŻYWO
              </span>
            ) : (
              <span className="rounded-full bg-white/6 px-2 py-0.5 font-semibold text-text-mute">
                ROZKŁADOWY
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold text-white ${
                isMzkTrip ? "bg-blue-600 shadow-sm" : "bg-red-600 shadow-sm"
              }`}
            >
              {isMzkTrip && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src="/mzk-logo.svg" alt="" className="h-3 w-auto filter brightness-0 invert" />
              )}
              {!isMzkTrip && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src="/brand.svg" alt="" className="h-2.5 w-auto filter brightness-0 invert" />
              )}
              {isMzkTrip ? "MZK Bielsko-Biała" : "Komunikacja Beskidzka"}
            </span>
            {currentVeh?.side_number && (
              <a
                href={`/brygady?tabor=${currentVeh.side_number}`}
                title="Zobacz kartę brygady i historię kursów"
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-0.5 font-semibold text-text hover:bg-white/20 transition-colors cursor-pointer border border-white/10"
              >
                <span>#{currentVeh.side_number}</span>
                {currentVeh.model ? <span className="text-text-mute font-normal">· {currentVeh.model}</span> : null}
                <span className="text-[10px] text-primary font-bold ml-0.5">&rarr; Karta brygady</span>
              </a>
            )}
            {isLiveWithLoc && headerDelay != null && (
              <span className={`font-semibold tabular-nums ${delayClass(headerDelay)}`}>
                {delayTxt(headerDelay)}
              </span>
            )}
            {currentVeh?.features?.electric && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-300 border border-emerald-500/20 text-[10px]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                100% EV
              </span>
            )}
            {currentVeh?.features?.hydrogen && (
              <span className="inline-flex items-center gap-1 rounded-md bg-cyan-500/10 px-2 py-0.5 font-medium text-cyan-300 border border-cyan-500/20 text-[10px]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" fill="currentColor" /><path d="M12 2v6m0 8v6M2 12h6m8 0h6" /></svg>
                H₂ Wodór
              </span>
            )}
            {currentVeh?.features?.hybrid && (
              <span className="inline-flex items-center gap-1 rounded-md bg-teal-500/10 px-2 py-0.5 font-medium text-teal-300 border border-teal-500/20 text-[10px]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" /></svg>
                Hybryda
              </span>
            )}
            {currentVeh?.features?.airCondition && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-2 py-0.5 font-medium text-text-mute border border-hairline text-[10px]" title="Klimatyzacja">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="12" y1="2" x2="12" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /><line x1="4.93" y1="19.07" x2="19.07" y2="4.93" /></svg>
                Klima
              </span>
            )}
            {currentVeh?.features?.lowFloor && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-2 py-0.5 font-medium text-text-mute border border-hairline text-[10px]" title="Niska podłoga">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="9" cy="5" r="2" /><path d="M9 7v6l4 2 2 5M11 13h5" /><path d="M6 19a4 4 0 1 0 8 0" /></svg>
                Niska podłoga
              </span>
            )}
            {currentVeh?.features?.longVehicle && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300 border border-amber-500/20 text-[10px]" title="Pojazd przegubowy">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="2" y="6" width="8" height="10" rx="1.5" /><rect x="14" y="6" width="8" height="10" rx="1.5" /><path d="M10 8l2 2-2 2 2 2" /></svg>
                MEGA (18m)
              </span>
            )}
            {currentVeh?.features?.ticketMachine && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-2 py-0.5 font-medium text-text-mute border border-hairline text-[10px]" title="Biletomat na pokładzie">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /></svg>
                Biletomat
              </span>
            )}
            {trip.note && (
              <span className="rounded-full bg-late/10 px-2 py-0.5 font-semibold text-late">
                {trip.note}
              </span>
            )}
            {loopStops.length > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-primary-dim px-2 py-0.5 font-semibold text-primary"
                title={`Kurs realizowany przez pętlę: ${loopStops.map(displayStopName).join(", ")}`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17 3l4 4-4 4" />
                  <path d="M21 7H8a4 4 0 0 0 0 8h1" />
                  <path d="M7 21l-4-4 4-4" />
                  <path d="M3 17h13" />
                </svg>
                przez {loopStops.map((s) => formatPrzezLoop(displayStopName(s))).join(", ")}
              </span>
            )}
            {trip.status === "routing" && (
              <span className="inline-flex items-center gap-1.5 text-text-faint">
                <Spinner /> wyznaczanie trasy…
              </span>
            )}
          </div>
        </div>
        {!loading && (
          <ShareButton title={`Linia ${trip.line}${direction ? ` → ${displayStopName(direction)}` : ""}`} />
        )}
        <IconButton label="Zamknij trasę" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {eta && (
        <p className="mt-2.5 rounded-xl bg-white/4 px-3 py-2 text-[12px] tabular-nums text-text-mute" aria-live="polite">
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
              const diff = t.estimate?.time_diff ?? null;
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
                    className={`flex w-full items-stretch gap-3 rounded-2xl text-left transition-colors ${
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
                          className="pointer-events-none absolute left-1/2 top-0 w-[3px] -translate-x-1/2 rounded-full transition-all duration-700 ease-out"
                          style={{
                            height: `${Math.min(50, (activeProgress - 0.5) * 100)}%`,
                            background: lineColor,
                            boxShadow: `0 0 6px ${lineColor}99`,
                          }}
                        />
                      )}
                      {/* vehicle marker moving down approaching stop */}
                      {isNextStop && activeProgress > 0.5 && (
                        <span
                          className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-all duration-700 ease-out"
                          style={{
                            top: `${(activeProgress - 0.5) * 100}%`,
                          }}
                        >
                          <span
                            className="absolute h-5 w-5 animate-ping rounded-full opacity-30"
                            style={{ background: lineColor }}
                          />
                          <span
                            className="relative h-4 w-4 animate-pulse-dot rounded-full border-[2.5px] border-white shadow-md"
                            style={{
                              background: lineColor,
                              boxShadow: `0 0 8px ${lineColor}aa`,
                            }}
                          />
                        </span>
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
                          className="pointer-events-none absolute left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-all duration-700 ease-out"
                          style={{
                            top: "50%",
                            height: `${Math.min(50, activeProgress * 100)}%`,
                            background: lineColor,
                            boxShadow: `0 0 6px ${lineColor}99`,
                          }}
                        />
                      )}
                      {/* vehicle marker moving down previous stop */}
                      {isPrevStop && activeProgress <= 0.5 && (
                        <span
                          className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-all duration-700 ease-out"
                          style={{
                            top: `${50 + activeProgress * 100}%`,
                          }}
                        >
                          <span
                            className="absolute h-5 w-5 animate-ping rounded-full opacity-30"
                            style={{ background: lineColor }}
                          />
                          <span
                            className="relative h-4 w-4 animate-pulse-dot rounded-full border-[2.5px] border-white shadow-md"
                            style={{
                              background: lineColor,
                              boxShadow: `0 0 8px ${lineColor}aa`,
                            }}
                          />
                        </span>
                      )}

                      {/* stop center node */}
                      {isCurrent ? (
                        isAtStop ? (
                          <span
                            className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-pulse-dot rounded-full border-[3px] border-white shadow-md"
                            style={{ background: lineColor, boxShadow: `0 0 10px ${lineColor}99` }}
                          />
                        ) : (
                          <span
                            className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                            style={{
                              borderColor: lineColor,
                              background: "var(--color-surface)",
                              boxShadow: `0 0 8px ${lineColor}55`,
                            }}
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
                            ? "font-bold text-text"
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
                          <span className="mt-0.5 block text-[11px] text-text-faint">
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
