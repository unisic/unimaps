"use client";

import { Fragment, memo, useState, type CSSProperties, type ReactNode } from "react";
import BottomSheet from "@/components/BottomSheet";
import { ArrowsLeftRightIcon, CaretDownIcon, PersonSimpleWalkIcon } from "@/components/icons";
import { BackIcon, CloseIcon, IconButton, LineBadge } from "@/components/ui";
import { displayStopName, przystanekPlural } from "@/lib/client/format";
import type { ConnectionLeg, ConnectionLegStop, JourneyView as JourneyViewState } from "@/lib/client/types";

interface Props {
  journey: JourneyViewState;
  desktop: boolean;
  onClose: () => void;
  onBackToSearch: () => void;
  onSelectLeg: (legIdx: number | null) => void;
  onFocusStop: (lat: number, lon: number) => void;
}

const TAB = "tap inline-flex h-9 shrink-0 items-center gap-2 rounded-full text-[13px] font-medium";
const tabTone = (on: boolean) =>
  on ? "bg-primary-dim text-primary" : "bg-white/6 text-text-mute hover:bg-white/10 hover:text-text";

/** a timeline row; the columns (time, rail, text) line up with TripView's */
const ROW = "flex w-full items-stretch gap-3 rounded-xl text-left transition-colors enabled:hover:bg-white/5 enabled:active:bg-white/8";
const TIME = "w-12 shrink-0 self-center pl-1 text-right tabular-nums";

/** one half of the rail: a ride in its line colour, the dotted walk, the wait at one stop, or nothing */
type Seg = { color: string } | "walk" | "wait" | null;

/** the walk's dots; the map draws the same ones with a dashArray */
const WALK_DOTS: CSSProperties = {
  backgroundImage: "radial-gradient(circle, var(--color-text-mute) 1.5px, transparent 2px)",
  backgroundSize: "6px 7px",
  backgroundRepeat: "repeat-y",
  backgroundPosition: "center top",
};

function Half({ seg, bottom }: { seg: Seg; bottom?: boolean }) {
  if (!seg) return null;
  const at = `absolute left-1/2 h-1/2 -translate-x-1/2 ${bottom ? "bottom-0" : "top-0"}`;
  if (seg === "walk") return <span className={`w-1.5 ${at}`} style={WALK_DOTS} />;
  if (seg === "wait") return <span className={`w-0.5 bg-white/12 ${at}`} />;
  return <span className={`w-1.5 ${at}`} style={{ background: seg.color }} />;
}

/** the rail column; `node` is a stop on it (big = where you board or alight) */
function Rail({ top, bottom, node, children }: { top: Seg; bottom: Seg; node?: { color: string; big: boolean }; children?: ReactNode }) {
  return (
    <span className="relative w-6 shrink-0 self-stretch" aria-hidden>
      <Half seg={top} />
      <Half seg={bottom} bottom />
      {node && (
        <span
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${node.big ? "h-2.5 w-2.5" : "h-1.5 w-1.5"}`}
          style={{ background: "var(--color-surface)", boxShadow: `0 0 0 ${node.big ? 3 : 2}px ${node.color}` }}
        />
      )}
      {children}
    </span>
  );
}

/** what joins leg `i` to the one before it */
const joinOf = (legs: ConnectionLeg[], i: number): Seg =>
  i <= 0 || i >= legs.length ? null : (legs[i].walkMins ?? 0) > 0 ? "walk" : "wait";

function JourneyView({ journey, desktop, onClose, onBackToSearch, onSelectLeg, onFocusStop }: Props) {
  const [expandedLegs, setExpandedLegs] = useState<Record<number, boolean>>({});

  const toggleLegExpand = (lIdx: number) => {
    setExpandedLegs((prev) => ({ ...prev, [lIdx]: !prev[lIdx] }));
  };

  const itinerary = journey.itinerary;
  const legs = itinerary.legs;
  const fromTitle = legs[0]?.fromStopName || "Początek";
  const toTitle = legs[legs.length - 1]?.toStopName || "Koniec";
  const selectedLegIdx = journey.selectedLegIdx;
  const dimmed = (...legIdx: number[]) =>
    selectedLegIdx !== null && !legIdx.includes(selectedLegIdx) ? "opacity-50" : "";

  const n = itinerary.transfersCount;
  const facts = [
    `${itinerary.totalDurationMins} min`,
    n ? `${n} ${n === 1 ? "przesiadka" : "przesiadki"}` : "bez przesiadek",
    itinerary.walkMinutes ? `${itinerary.walkMinutes} min pieszo` : "",
    itinerary.dayLabel ?? "",
  ].filter(Boolean);

  const stopRow = (st: ConnectionLegStop | undefined, name: string, time: string, rail: ReactNode, major: boolean) => (
    <button
      type="button"
      disabled={!st?.lat || !st.lon}
      onClick={() => st?.lat && st.lon && onFocusStop(st.lat, st.lon)}
      className={ROW}
    >
      <span className={`${TIME} ${major ? "text-[13px] font-semibold text-text" : "text-[12px] text-text-faint"}`}>{time}</span>
      {rail}
      <span
        className={`min-w-0 flex-1 self-center truncate pr-2 ${
          major ? "py-3 text-[13.5px] font-medium text-text" : "py-2 text-[12.5px] text-text-mute"
        }`}
      >
        {displayStopName(name)}
      </span>
    </button>
  );

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-2">
        <IconButton onClick={onBackToSearch} label="Wróć do wyników wyszukiwania">
          <BackIcon />
        </IconButton>
        <div className="min-w-0 flex-1 pl-0.5">
          <h2 className="truncate text-[16px] font-semibold leading-tight tracking-tight text-text">
            {displayStopName(fromTitle)} → {displayStopName(toTitle)}
          </h2>
          <p className="mt-1 text-[12px] leading-snug text-text-mute">
            <span className="whitespace-nowrap font-semibold tabular-nums text-text">
              {itinerary.departureTime} – {itinerary.arrivalTime}
            </span>
            {itinerary.arrivesNextDay && (
              <span className="font-medium text-late" title="Przyjazd następnego dnia">
                {" "}
                +1 d.
              </span>
            )}
            {/* a line break falls between facts, never inside "5 min pieszo" */}
            {facts.map((f) => (
              <Fragment key={f}>
                {"\u00a0· "}
                <span className="whitespace-nowrap tabular-nums">{f}</span>
              </Fragment>
            ))}
          </p>
        </div>
        <IconButton onClick={onClose} label="Zamknij widok trasy">
          <CloseIcon />
        </IconButton>
      </div>

      {legs.length > 1 && (
        <div className="-mx-4 mt-3 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
          <button
            type="button"
            onClick={() => onSelectLeg(null)}
            aria-pressed={selectedLegIdx === null}
            className={`${TAB} px-3.5 ${tabTone(selectedLegIdx === null)}`}
          >
            Cała trasa
          </button>
          {legs.map((leg, lIdx) => (
            <button
              key={lIdx}
              type="button"
              onClick={() => onSelectLeg(lIdx)}
              aria-pressed={selectedLegIdx === lIdx}
              aria-label={`Odcinek ${lIdx + 1}: linia ${leg.line}, ${leg.durationMins} min`}
              className={`${TAB} pl-1 pr-3 ${tabTone(selectedLegIdx === lIdx)}`}
            >
              <LineBadge line={leg.line} operator={leg.operator} />
              <span className="tabular-nums">{leg.durationMins} min</span>
            </button>
          ))}
        </div>
      )}
    </header>
  );

  return (
    <BottomSheet
      desktop={desktop}
      onClose={onClose}
      ariaLabel={`Trasa połączenia ${fromTitle} do ${toTitle}`}
      initialSnap="half"
      header={header}
    >
      <div className="kb-scroll h-full overflow-y-auto">
        <ol className="px-4 pt-1" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}>
          {legs.map((leg, lIdx) => {
            const ride: Seg = { color: journey.legs[lIdx].lineColor };
            const node = { color: ride.color, big: true };
            const join = joinOf(legs, lIdx);
            const stops = leg.stops ?? [];
            const mids = stops.slice(1, -1);
            const open = !!expandedLegs[lIdx];
            const fade = `transition-opacity duration-200 ${dimmed(lIdx)}`;
            const walk = leg.walkMins ?? 0;
            const prev = legs[lIdx - 1];
            const gap = prev ? Math.max(1, Math.round((leg.departureSecs - prev.arrivalSecs) / 60)) : 0;

            return (
              <Fragment key={lIdx}>
                {/* transfer: the walk on dots, a wait at one stop on a thin line */}
                {prev && (
                  <li className={`transition-opacity duration-200 ${dimmed(lIdx - 1, lIdx)}`}>
                    <div className="flex items-stretch gap-3">
                      <span className="w-12 shrink-0" />
                      <Rail top={join} bottom={join}>
                        <span
                          className={`absolute left-1/2 top-1/2 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-surface-2 text-[13px] ${
                            walk ? "text-text" : "text-late"
                          }`}
                        >
                          {walk ? <PersonSimpleWalkIcon /> : <ArrowsLeftRightIcon />}
                        </span>
                      </Rail>
                      <span className="min-w-0 flex-1 self-center py-3.5 text-[12px] text-text-mute">
                        <span className="block text-[13px] font-medium text-text">
                          {walk ? `${walk} min pieszo` : `Przesiadka ${gap} min`}
                        </span>
                        <span className="block tabular-nums">{walk ? `Przesiadka ${gap} min` : "Ten sam przystanek"}</span>
                      </span>
                    </div>
                  </li>
                )}

                <li className={fade}>
                  {stopRow(stops[0], leg.fromStopName, leg.departureTime, <Rail top={join} bottom={ride} node={node} />, true)}
                </li>

                <li className={fade}>
                  <button
                    type="button"
                    disabled={!mids.length}
                    onClick={() => toggleLegExpand(lIdx)}
                    aria-expanded={mids.length ? open : undefined}
                    className={ROW}
                  >
                    <span className="w-12 shrink-0" />
                    <Rail top={ride} bottom={ride} />
                    <span className="min-w-0 flex-1 self-center py-2.5 pr-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <LineBadge line={leg.line} operator={leg.operator} />
                        <span className="truncate text-[13px] font-medium text-text">{displayStopName(leg.headsign)}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-1 text-[12px] text-text-mute">
                        <span className="tabular-nums">{leg.durationMins} min</span>
                        {mids.length > 0 && (
                          <>
                            <span>
                              · {mids.length} {przystanekPlural(mids.length)} po drodze
                            </span>
                            <CaretDownIcon
                              className={`text-[12px] text-text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                            />
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                </li>

                {open &&
                  mids.map((st, sIdx) => (
                    <li key={`${sIdx}-${st.stopId}`} className={`${fade} animate-fade`}>
                      {stopRow(
                        st,
                        st.stopName,
                        st.arrivalTime || st.departureTime,
                        <Rail top={ride} bottom={ride} node={{ color: ride.color, big: false }} />,
                        false,
                      )}
                    </li>
                  ))}

                <li className={fade}>
                  {stopRow(
                    stops[stops.length - 1],
                    leg.toStopName,
                    leg.arrivalTime,
                    <Rail top={ride} bottom={joinOf(legs, lIdx + 1)} node={node} />,
                    true,
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </div>
    </BottomSheet>
  );
}

export default memo(JourneyView);
