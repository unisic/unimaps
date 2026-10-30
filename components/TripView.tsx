"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { useNow } from "@/components/hooks";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ArrowsHorizontalIcon,
  BellIcon,
  BusIcon,
  CardsIcon,
  CrosshairIcon,
  DotsThreeVerticalIcon,
  DropIcon,
  LeafIcon,
  LightningIcon,
  SnowflakeIcon,
  TicketIcon,
  WheelchairIcon,
} from "@/components/icons";
import { BackIcon, CloseIcon, ErrorState, IconButton, LineBadge, ShareButton } from "@/components/ui";
import {
  ALERT_LEADS,
  MAX_ALERTS,
  addAlert,
  alertUntil,
  removeAlert,
  tripAlertKey,
  useAlerts,
} from "@/lib/client/alerts";
import {
  computeEta,
  countdown,
  delayClass,
  delayStatus,
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
import { cityOfId } from "@/lib/client/city";
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
  /** fly the map to the vehicle (`id` = its fleet track, whose drawn position wins over the raw fix) */
  onLocate: (v: { id: string | null; lat: number; lon: number }) => void;
  onRetry: () => void;
  /** open the MZK vehicle card over the map (closing it returns to this trip) */
  onOpenVehicleCard: (side: string) => void;
  onShowToast: (text: string) => void;
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

/** Neutral vehicle-feature chip: a fact about the bus, so no colour of its own. */
/* the features rendered as chips in the menu (ecoVehicle has none, so it must not open an empty row) */
const SHOWN_FEATURES = [
  "electric",
  "hydrogen",
  "hybrid",
  "airCondition",
  "lowFloor",
  "longVehicle",
  "ticketMachine",
] as const satisfies readonly (keyof VehicleFeatures)[];

function Feature({ icon, label, title }: { icon: React.ReactNode; label: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-tint/6 px-2 py-0.5 text-text-mute" title={title}>
      <span className="text-[12px]">{icon}</span>
      {label}
    </span>
  );
}

/** % of a half-row rail the vehicle has covered; `x` = stop units travelled into that half */
const railFill = (x: number) => Math.max(0, Math.min(100, x * 200));
/** the travelled rail: opaque (it covers the line-coloured rail underneath) */
const RAIL_DONE = "color-mix(in srgb, #fff 16%, var(--color-surface))";
/** seconds-of-day difference folded into ±12 h (a post-midnight time against a pre-midnight one) */
const wrapDay = (d: number) => (d > 43200 ? d - 86400 : d < -43200 ? d + 86400 : d);

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
  onLocate,
  onRetry,
  onOpenVehicleCard,
  onShowToast,
  initialSnap = "half",
}: Props) {
  const now = useNow();
  const alerts = useAlerts();
  const alertByKey = useMemo(() => new Map(alerts.map((a) => [a.key, a])), [alerts]);
  /** alert key of the stop row whose 3/5/10 min picker is open */
  const [alertMenu, setAlertMenu] = useState<string | null>(null);
  /* the ⋮ menu's anchor (viewport px) while it is open */
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
  const tripOp =
    currentVeh?.operator ??
    trip.operator ??
    (cityOfId(trip.execId) === "gzm" || cityOfId(trip.tripId) === "gzm" ? "GZM" : undefined);
  const isMzkTrip = isMzk(tripOp, trip.line);
  const isGzmTrip = tripOp === "GZM";
  /* fleet card key: MZK side number; GZM `<op>_<fleet>` from the vehicle id (side_number is the bare fleet label) */
  const vehId = currentVeh?.id ?? trip.execId;
  const cardSide = isGzmTrip
    ? (vehId?.startsWith("gzm:") ? vehId.slice(4) : null)
    : isMzkTrip ? (currentVeh?.side_number ?? null) : null;
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

    // Scheduled / no live GPS fix -> calculate from Europe/Warsaw schedule time.
    // A course across midnight: its times run on past 86400 (00:05 after 23:52) and "now" is
    // placed on the course's side of midnight (±12 h around its first stop).
    let carry = 0;
    let last: number | null = null;
    const schedU: Array<number | null> = [];
    for (const t of times) {
      const s = secsFromHHMM(t.departure_time);
      if (s != null) {
        if (last != null && s + carry < last - 43200) carry += 86400;
        last = s + carry;
      }
      schedU.push(s == null ? null : last);
    }
    const first = schedU.find((s) => s != null) ?? null;
    const nowU = carry > 0 && first != null ? first + wrapDay(now - first) : now;
    for (let i = 0; i < times.length; i++) {
      const sched = schedU[i];
      if (sched != null && sched > nowU) {
        if (i === 0) return { index: 0, isAtStop: true, progress: 0 };
        const prevSched = schedU[i - 1];
        const progress =
          prevSched != null ? Math.min(1, Math.max(0, (nowU - prevSched) / (sched - prevSched))) : 0;
        return { index: i, isAtStop: false, progress };
      }
    }
    // All scheduled times in the past -> course completed
    return { index: times.length - 1, isAtStop: true, progress: 1 };
  })();

  const vti = activeStop.index;
  const isAtStop = activeStop.isAtStop;
  const activeProgress = Math.max(0, Math.min(1, activeStop.progress ?? (isAtStop ? 1 : 0.5)));
  /* the vehicle on the rail in stop units: k = at stop k, k + p = between stops k and k + 1 */
  const railPos = Math.min(trip.rawTimes.length - 1, Math.max(-0.5, isAtStop ? vti : vti - 1 + activeProgress));
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

  /* centre the row inside the list only: scrollIntoView also scrolls every ancestor, including the
     overflow-hidden app root while the sheet is still sliding in */
  useEffect(() => {
    const box = scrollRef.current;
    const row = currentRef.current;
    if (!box || !row) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + r.top - b.top - (box.clientHeight - r.height) / 2, behavior: "smooth" });
  }, [scrollTargetIdx]);

  /* close the menu on a tap outside it, on resize, and on Escape before the sheet's own Escape closes the trip */
  useEffect(() => {
    if (!menuAt) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !menuBtnRef.current?.contains(t)) setMenuAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenuAt(null);
      menuBtnRef.current?.focus();
    };
    const onResize = () => setMenuAt(null);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menuAt]);

  const toggleMenu = () => {
    const r = menuBtnRef.current?.getBoundingClientRect();
    setMenuAt((open) => (open || !r ? null : { top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right) }));
  };

  const feats = currentVeh?.features;
  const locateFix =
    currentVeh && Number.isFinite(currentVeh.lat) && Number.isFinite(currentVeh.lon) ? currentVeh : trip.vehicle;
  const hasDetails = !loading && !failed;

  /* runs from a tap, so the permission prompt is allowed (browsers drop it without a user gesture) */
  const pickAlert = async (key: string, stop: Stop, planned: number, leadMin: number) => {
    setAlertMenu(null);
    if (typeof Notification === "undefined") return onShowToast("Ta przeglądarka nie obsługuje powiadomień.");
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (perm !== "granted") return onShowToast("Powiadomienia są zablokowane. Włącz je w ustawieniach przeglądarki.");
    const ok = addAlert({
      key,
      designator: stop.designator,
      stopName: displayStopName(stop.name),
      line: trip.line,
      dest: direction ? displayStopName(direction) : `Linia ${trip.line}`,
      leadMin,
      until: alertUntil(planned),
    });
    onShowToast(
      ok
        ? `Powiadomię ${leadMin} min przed odjazdem linii ${trip.line}.`
        : `Najwyżej ${MAX_ALERTS} powiadomienia naraz. Wyłącz któreś dzwonkiem.`,
    );
  };

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-2">
        {onBack && (
          <IconButton label="Wróć do przystanku" onClick={onBack}>
            <BackIcon />
          </IconButton>
        )}
        <LineBadge line={trip.line} operator={isGzmTrip ? "GZM" : isMzkTrip ? "MZK" : "KB"} big />
        <div className="min-w-0 flex-1 pl-0.5">
          <h2 className="truncate text-[16px] font-semibold leading-tight tracking-tight text-text">
            {loading ? "Wczytywanie…" : direction ? displayStopName(direction) : `Linia ${trip.line}`}
          </h2>
          <div className="mt-1 flex items-center gap-x-2 text-[12px] text-text-mute">
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
            {trip.status === "routing" && <Spinner />}
          </div>
        </div>
        {isLiveWithLoc && locateFix && (
          <IconButton
            label="Pokaż pojazd na mapie"
            onClick={() => onLocate({ id: currentVeh?.id ?? trip.execId, lat: locateFix.lat, lon: locateFix.lon })}
          >
            <CrosshairIcon />
          </IconButton>
        )}
        {hasDetails && (
          <button
            ref={menuBtnRef}
            type="button"
            aria-label="Szczegóły kursu"
            aria-haspopup="true"
            aria-expanded={menuAt != null}
            onClick={toggleMenu}
            className={`tap grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] md:h-9 md:w-9 ${
              menuAt ? "bg-tint/10 text-text" : "text-text-mute hover:bg-tint/8 hover:text-text"
            }`}
          >
            <DotsThreeVerticalIcon weight="bold" />
          </button>
        )}
        <IconButton label="Zamknij trasę" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {hasDetails && menuAt && (
        /* fixed: the sheet's overflow-hidden would clip it at the peek height. Its pointerdown must not reach
           the header's drag zone */
        <div
          ref={menuRef}
          onPointerDown={(e) => e.stopPropagation()}
          className="surface fixed z-20 w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-[20px] p-2 text-[13.5px] animate-drop"
          style={{ top: menuAt.top, right: menuAt.right, maxHeight: `calc(100dvh - ${menuAt.top + 12}px)` }}
        >
          <div className="flex items-center gap-2 pl-3">
            <span
              className={`h-2 w-2 rounded-full ${isGzmTrip ? "bg-gzm" : isMzkTrip ? "bg-mzk" : "bg-kb"}`}
              aria-hidden
            />
            <span className="flex-1 text-[12px] font-medium text-text-faint">
              {isGzmTrip ? "Metropolia GZM" : isMzkTrip ? "MZK Bielsko-Biała" : "Komunikacja Beskidzka"}
            </span>
            <ShareButton title={`Linia ${trip.line}${direction ? ` → ${displayStopName(direction)}` : ""}`} />
          </div>
          {cardSide && (
            <a
              href={`/brygady?${isGzmTrip ? "city=gzm&" : ""}tabor=${encodeURIComponent(cardSide)}`}
              onClick={(e) => {
                // a modified click still opens the fleet page in a new tab
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                setMenuAt(null);
                onOpenVehicleCard(cardSide);
              }}
              className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-text transition-colors hover:bg-tint/5"
            >
              <CardsIcon className="text-[17px] text-text-mute" />
              <span className="min-w-0 flex-1">
                <span className="block">Karta pojazdu</span>
                <span className="block truncate text-[12px] tabular-nums text-text-mute">
                  #{currentVeh?.side_number ?? cardSide}
                  {currentVeh?.model ? ` · ${currentVeh.model}` : ""}
                </span>
              </span>
              <ArrowRightIcon className="text-[14px] text-text-faint transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          )}
          {loopStops.length > 0 && (
            <p
              className="flex items-center gap-3 px-3 py-2.5 text-text"
              title={`Kurs realizowany przez pętlę: ${loopStops.map(displayStopName).join(", ")}`}
            >
              <ArrowsClockwiseIcon className="text-[17px] text-text-mute" />
              <span className="min-w-0 flex-1">
                przez {loopStops.map((l) => formatPrzezLoop(displayStopName(l))).join(", ")}
              </span>
            </p>
          )}
          {feats && SHOWN_FEATURES.some((k) => feats[k]) && (
            <div className="mt-1 flex flex-wrap gap-1.5 border-t border-hairline px-3 pb-1.5 pt-3 text-[11.5px]">
              {feats.electric && <Feature icon={<LightningIcon weight="fill" />} label="Elektryczny" />}
              {feats.hydrogen && <Feature icon={<DropIcon weight="fill" />} label="Wodorowy" />}
              {feats.hybrid && <Feature icon={<LeafIcon weight="fill" />} label="Hybryda" />}
              {feats.airCondition && <Feature icon={<SnowflakeIcon />} label="Klima" title="Klimatyzacja" />}
              {feats.lowFloor && <Feature icon={<WheelchairIcon />} label="Niska podłoga" />}
              {feats.longVehicle && (
                <Feature icon={<ArrowsHorizontalIcon />} label="Przegubowy" title="Pojazd przegubowy, 18 m" />
              )}
              {feats.ticketMachine && <Feature icon={<TicketIcon />} label="Biletomat" title="Biletomat na pokładzie" />}
            </div>
          )}
        </div>
      )}
      {trip.note && (
        <p className="mt-2.5 inline-block rounded-full bg-late/10 px-2.5 py-0.5 text-[11.5px] font-medium text-late">
          {trip.note}
        </p>
      )}
      {eta && (
        <p className="mt-2.5 rounded-xl bg-tint/5 px-3 py-2 text-[12.5px] tabular-nums text-text-mute" aria-live="polite">
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
          <ErrorState onRetry={onRetry} message={trip.errorMsg} />
        ) : loading ? (
          <TimelineSkeleton />
        ) : trip.rawTimes.length === 0 ? (
          <p className="px-5 pb-6 pt-2 text-[13px] text-text-mute">
            {isLiveWithLoc
              ? "Przewoźnik nie podaje teraz kursu tego pojazdu: skończył kursy na dziś, jedzie do zajezdni albo ma przerwę. Pozycja na mapie jest na żywo."
              : "Brak przystanków tego kursu."}
          </p>
        ) : (
          <ol className="px-4 pt-1" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
            {trip.rawTimes.map((t, idx) => {
              const isCurrent = idx === vti;
              const passed = idx < vti;
              const planned = secsFromHHMM(t.departure_time);
              /* passed: the recorded arrival; ahead: the live forecast (the stop's own estimate, else the bus's delay) */
              const forecast = notStarted ? null : (t.estimate?.time_diff ?? headerDelay);
              const actual =
                !isLiveWithLoc || notStarted || planned == null
                  ? null
                  : passed
                    ? (trip.arrived?.[idx] ?? null)
                    : forecast != null
                      ? planned + forecast
                      : null;
              const rowDiff = actual != null && planned != null ? wrapDay(actual - planned) : null;
              const bigDiff = rowDiff != null && Math.abs(rowDiff) > 60;
              let left = actual != null && !passed ? actual - now : Infinity;
              if (left < -43200) left += 86400;
              const soon = left < 3600 ? countdown(actual, now) : "";
              const coord = stopByIndex.get(t.index);
              const plat = formatPlatform(t.platform, isBusStation(t.stop_name, coord));
              const status = passed && rowDiff != null ? delayStatus(rowDiff) : "";
              const selected = !!trip.stop && tripTimeMatchesStop(t, trip.stop);
              const first = idx === 0;
              const last = idx === trip.rawTimes.length - 1;
              /* the bell sits only on the stop the trip was opened from: the board there is what the alert watches.
                 Not on the last stop: a loop ending where it started arrives there, it never departs */
              const ak = selected && trip.execId ? tripAlertKey(trip.execId, t.index, trip.tripId || currentVeh?.trip_id) : null;
              const al = ak ? alertByKey.get(ak) : undefined;
              const canAlert = al != null || (ak != null && !passed && !last && planned != null);
              return (
                <li key={`${t.index}-${idx}`} ref={idx === scrollTargetIdx ? currentRef : undefined}>
                  <div className={`flex items-center rounded-xl ${selected ? "bg-primary-dim" : ""}`}>
                  <button
                    type="button"
                    disabled={!coord}
                    onClick={() => coord && onFocusStop(coord)}
                    className={`flex min-w-0 flex-1 items-stretch gap-3 rounded-xl text-left transition-colors ${
                      coord ? "hover:bg-tint/5 active:bg-tint/8" : ""
                    }`}
                  >
                    {/* time: the plan struck through above the actual one when they differ */}
                    <span className="w-12 shrink-0 self-center pl-1 text-right tabular-nums">
                      {bigDiff && (
                        <s className="block text-[11px] leading-tight text-text-faint">{t.departure_time}</s>
                      )}
                      <span
                        className={`block text-[13px] font-semibold ${
                          rowDiff != null ? delayClass(rowDiff) : passed ? "text-text-faint" : "text-text"
                        } ${passed && rowDiff != null ? "opacity-75" : ""}`}
                      >
                        {actual != null ? hhmmFromSecs(actual) : t.departure_time}
                      </span>
                    </span>

                    {/* rail: the travelled part muted, the rest in the line colour; the live bus rides on it */}
                    <span className="relative w-6 shrink-0 self-stretch" aria-hidden>
                      {!first && (
                        <span className="absolute left-1/2 top-0 h-1/2 w-1.5 -translate-x-1/2" style={{ background: lineColor }}>
                          <span
                            className="absolute inset-x-0 top-0 transition-[height] duration-700 ease-out-soft"
                            style={{ height: `${railFill(railPos - idx + 0.5)}%`, background: RAIL_DONE }}
                          />
                        </span>
                      )}
                      {!last && (
                        <span className="absolute bottom-0 left-1/2 h-1/2 w-1.5 -translate-x-1/2" style={{ background: lineColor }}>
                          <span
                            className="absolute inset-x-0 top-0 transition-[height] duration-700 ease-out-soft"
                            style={{ height: `${railFill(railPos - idx)}%`, background: RAIL_DONE }}
                          />
                        </span>
                      )}
                      <span
                        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                          first || last ? "h-2.5 w-2.5" : "h-1.5 w-1.5"
                        }`}
                        style={{
                          background: "var(--color-surface)",
                          boxShadow: `0 0 0 ${first || last ? 3 : 2}px ${passed ? RAIL_DONE : lineColor}`,
                        }}
                      />
                      {isLiveWithLoc && Math.round(railPos) === idx && (
                        <span
                          className="absolute left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[14px] text-white transition-[top] duration-700 ease-out-soft"
                          style={{
                            top: `${50 + (railPos - idx) * 100}%`,
                            background: lineColor,
                            boxShadow: "0 0 0 3px var(--color-surface)",
                          }}
                        >
                          <BusIcon weight="fill" />
                        </span>
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
                      {(status || plat) && (
                        <span className="mt-0.5 block truncate text-[12px] text-text-faint">
                          {status && <span className={rowDiff != null ? delayClass(rowDiff) : ""}>{status}</span>}
                          {status && plat ? " · " : ""}
                          {plat}
                        </span>
                      )}
                    </span>
                    {soon && (
                      <span className="shrink-0 self-center pr-2 text-[12.5px] font-semibold tabular-nums text-text">
                        {soon}
                      </span>
                    )}
                  </button>
                  {canAlert && ak && (
                    <button
                      type="button"
                      aria-label={al ? `Wyłącz powiadomienie ${al.leadMin} min przed` : "Powiadom przed odjazdem"}
                      aria-expanded={al ? undefined : alertMenu === ak}
                      onClick={() => (al ? removeAlert(ak) : setAlertMenu((m) => (m === ak ? null : ak)))}
                      className={`tap grid h-11 w-10 shrink-0 place-items-center rounded-xl text-[17px] hover:bg-tint/5 ${
                        al ? "text-primary" : "text-text-mute hover:text-text"
                      }`}
                    >
                      <BellIcon weight={al ? "fill" : "bold"} aria-hidden />
                    </button>
                  )}
                  </div>
                  {ak && !al && alertMenu === ak && trip.stop && planned != null && (
                    /* aligned with the stop names, the rail runs on beside it */
                    <div className="flex items-stretch gap-3">
                      <span className="w-12 shrink-0" aria-hidden />
                      <span className="relative w-6 shrink-0" aria-hidden>
                        {!last && (
                          <span className="absolute inset-y-0 left-1/2 w-1.5 -translate-x-1/2" style={{ background: lineColor }} />
                        )}
                      </span>
                      <div
                        role="group"
                        aria-label="Powiadom przed odjazdem"
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-2 py-2 text-[12px]"
                      >
                        {ALERT_LEADS.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => trip.stop && void pickAlert(ak, trip.stop, planned, m)}
                            className="tap min-h-8 rounded-full bg-tint/8 px-3 font-medium text-text hover:bg-tint/12"
                          >
                            {m} min przed
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
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
