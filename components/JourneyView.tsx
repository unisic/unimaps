"use client";

import { memo, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { ArrowLeftIcon, ArrowsLeftRightIcon, CaretDownIcon } from "@/components/icons";
import { BackIcon, CloseIcon, IconButton, LineBadge } from "@/components/ui";
import { displayStopName, hslColor, przystanekPlural } from "@/lib/client/format";
import type { JourneyView as JourneyViewState } from "@/lib/client/types";

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

/** Clickable timeline row (boarding / alighting / intermediate stop). */
const STOP_ROW =
  "-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-white/6";

function JourneyView({
  journey,
  desktop,
  onClose,
  onBackToSearch,
  onSelectLeg,
  onFocusStop,
}: Props) {
  const [expandedLegs, setExpandedLegs] = useState<Record<number, boolean>>({});

  const toggleLegExpand = (lIdx: number) => {
    setExpandedLegs((prev) => ({ ...prev, [lIdx]: !prev[lIdx] }));
  };

  const itinerary = journey.itinerary;
  const legs = itinerary.legs;
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  const fromTitle = firstLeg?.fromStopName || "Początek";
  const toTitle = lastLeg?.toStopName || "Koniec";

  const selectedLegIdx = journey.selectedLegIdx;

  const header = (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-hairline py-2 pl-2 pr-2.5 sm:pl-3">
        <div className="flex min-w-0 items-center gap-1">
          <IconButton onClick={onBackToSearch} label="Wróć do wyników wyszukiwania">
            <BackIcon />
          </IconButton>
          <div className="min-w-0">
            <h2 className="max-w-[220px] truncate text-[15px] font-semibold tracking-tight text-text sm:max-w-[320px]">
              {displayStopName(fromTitle)} → {displayStopName(toTitle)}
            </h2>
            <div className="flex items-center gap-1.5 text-[12px] text-text-mute">
              <span className="font-medium tabular-nums text-text">
                {itinerary.departureTime} – {itinerary.arrivalTime}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{itinerary.totalDurationMins} min</span>
              {itinerary.dayLabel && (
                <>
                  <span aria-hidden>·</span>
                  <span>{itinerary.dayLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <IconButton onClick={onClose} label="Zamknij widok trasy">
          <CloseIcon />
        </IconButton>
      </div>

      {/* Segment Selector Tabs ("Cała trasa" | "1. Linia X" | "2. Linia Y") */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-hairline px-4 py-2 [scrollbar-width:none] sm:px-5">
        <button
          type="button"
          onClick={() => onSelectLeg(null)}
          aria-pressed={selectedLegIdx === null}
          className={`${TAB} px-3.5 ${tabTone(selectedLegIdx === null)}`}
        >
          Cała trasa ({legs.length > 1 ? `${legs.length} linie` : "1 linia"})
        </button>

        {legs.map((leg, lIdx) => (
          <button
            key={`tab-leg-${lIdx}`}
            type="button"
            onClick={() => onSelectLeg(lIdx)}
            aria-pressed={selectedLegIdx === lIdx}
            className={`${TAB} pl-1 pr-3 ${tabTone(selectedLegIdx === lIdx)}`}
          >
            <LineBadge line={leg.line} />
            <span className="tabular-nums">{leg.durationMins} min</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <BottomSheet
      desktop={desktop}
      onClose={onClose}
      ariaLabel={`Trasa połączenia ${fromTitle} do ${toTitle}`}
      initialSnap="half"
      header={header}
    >
      {/* Timeline of legs and transfers */}
      <div
        className="h-full overflow-y-auto px-4 py-3 sm:px-5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        {legs.map((leg, lIdx) => {
          const color = hslColor(leg.line);
          const isExpanded = !!expandedLegs[lIdx];
          const isSelected = selectedLegIdx === null || selectedLegIdx === lIdx;
          const stops = leg.stops ?? [];
          const intermediateStops = stops.slice(1, -1);

          return (
            <div
              key={`leg-card-${lIdx}`}
              className={`transition-opacity duration-200 ${isSelected ? "opacity-100" : "opacity-50"}`}
            >
              {/* Leg header */}
              <div className="rounded-xl bg-white/4 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/8 text-[11px] font-semibold tabular-nums text-text-mute">
                      {lIdx + 1}
                    </span>
                    <LineBadge line={leg.line} />
                    <span className="max-w-[180px] truncate text-[13px] font-medium text-text sm:max-w-[260px]">
                      {displayStopName(leg.headsign)}
                    </span>
                  </div>
                  <span className="shrink-0 text-[12px] tabular-nums text-text-faint">
                    {leg.durationMins} min · {leg.stopsCount} {przystanekPlural(leg.stopsCount)}
                  </span>
                </div>

                {/* Departure & Arrival summary points */}
                <div className="ml-2 mt-3 space-y-1 border-l-2 pl-3" style={{ borderColor: color }}>
                  {/* Boarding stop */}
                  <button
                    type="button"
                    className={STOP_ROW}
                    onClick={() => {
                      const s = stops[0];
                      if (s?.lat && s?.lon) onFocusStop(s.lat, s.lon);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-text">
                        {displayStopName(leg.fromStopName)}
                      </span>
                      <span className="block text-[11px] text-text-faint">Odjazd z przystanku</span>
                    </span>
                    <span className="shrink-0 text-[14px] font-semibold tabular-nums text-text">{leg.departureTime}</span>
                  </button>

                  {/* Expandable intermediate stops list */}
                  {intermediateStops.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={() => toggleLegExpand(lIdx)}
                        aria-expanded={isExpanded}
                        className="flex h-8 items-center gap-1.5 text-[12px] font-medium text-text-mute transition-colors hover:text-text"
                      >
                        <span>
                          {isExpanded
                            ? "Ukryj przystanki pośrednie"
                            : `Pokaż ${intermediateStops.length} ${przystanekPlural(intermediateStops.length)} pośrednich`}
                        </span>
                        <CaretDownIcon
                          className={`text-[12px] text-text-faint transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                        />
                      </button>

                      {isExpanded && (
                        <div className="mb-1 animate-fade">
                          {intermediateStops.map((st, sIdx) => (
                            <button
                              type="button"
                              key={`int-stop-${sIdx}`}
                              onClick={() => {
                                if (st.lat && st.lon) onFocusStop(st.lat, st.lon);
                              }}
                              className={`${STOP_ROW} text-[12px] text-text-mute hover:text-text`}
                            >
                              <span className="truncate">{displayStopName(st.stopName)}</span>
                              <span className="shrink-0 tabular-nums text-text-faint">
                                {st.arrivalTime || st.departureTime}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Alighting stop */}
                  <button
                    type="button"
                    className={STOP_ROW}
                    onClick={() => {
                      const s = stops[stops.length - 1];
                      if (s?.lat && s?.lon) onFocusStop(s.lat, s.lon);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-text">
                        {displayStopName(leg.toStopName)}
                      </span>
                      <span className="block text-[11px] text-text-faint">Przyjazd na przystanek</span>
                    </span>
                    <span className="shrink-0 text-[14px] font-semibold tabular-nums text-text">{leg.arrivalTime}</span>
                  </button>
                </div>
              </div>

              {/* Transfer block if there is a next leg */}
              {lIdx < legs.length - 1 && (
                <div className="my-2 flex items-center gap-3 px-1 py-1.5">
                  {/* late tone = the transfer pin's colour on the map */}
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-late/12 text-[15px] text-late">
                    <ArrowsLeftRightIcon />
                  </span>
                  <div className="min-w-0 flex-1 text-[12px]">
                    <div className="font-medium text-text">
                      Przesiadka na przystanku: {displayStopName(leg.toStopName)}
                    </div>
                    <div className="text-text-mute">
                      Czas na przesiadkę:{" "}
                      <span className="font-medium tabular-nums text-text">
                        {legs[lIdx + 1] ? Math.max(1, Math.round((legs[lIdx + 1].departureSecs - leg.arrivalSecs) / 60)) : itinerary.transferWaitMins ?? 5} min
                      </span>{" "}
                      · kolejny odjazd o <span className="tabular-nums">{legs[lIdx + 1]?.departureTime}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Footer actions */}
        <div className="mt-4 flex flex-col items-center justify-between gap-2 border-t border-hairline pt-4 sm:flex-row">
          <button
            type="button"
            onClick={onBackToSearch}
            className="tap inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-white/8 px-4 text-[13px] font-medium text-text hover:bg-white/12 sm:w-auto"
          >
            <ArrowLeftIcon className="text-[14px]" />
            Wróć do listy połączeń
          </button>
          <button
            type="button"
            onClick={onClose}
            className="tap inline-flex h-10 w-full items-center justify-center rounded-full bg-text px-4 text-[13px] font-medium text-bg hover:bg-white sm:w-auto"
          >
            Zamknij widok trasy
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

export default memo(JourneyView);
