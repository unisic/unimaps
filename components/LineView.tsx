"use client";

import { memo, useEffect, useMemo, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { chip, CloseIcon, ErrorState, IconButton, LineBadge, SkeletonRows } from "@/components/ui";
import { fetchJSON, isWarming } from "@/lib/client/api";
import { cityUrl, GZM_LOADING, type City } from "@/lib/client/city";
import { displayStopName, nowSecs, todayISO } from "@/lib/client/format";
import type { LineInfo, LineResponse, LineVariant, Stop } from "@/lib/client/types";

interface Props {
  desktop: boolean;
  line: LineInfo;
  city: City;
  /** the map shows only this line's vehicles */
  filterActive: boolean;
  onToggleFilter: (line: string) => void;
  /** a router stop id to the map's stop, null when the list has none */
  resolveStop: (id: string) => Stop | null;
  onSelectStop: (s: Stop) => void;
  /** the pattern on screen, for the map layer (null while loading / on close) */
  onVariant: (v: LineVariant | null) => void;
  onClose: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A variant's chip label; patterns sharing a headsign are told apart by their first stop. */
function variantLabel(v: LineVariant, all: readonly LineVariant[]): string {
  const to = `→ ${displayStopName(v.headsign || v.stops[v.stops.length - 1].name)}`;
  return all.filter((o) => o.headsign === v.headsign).length > 1 ? `${to} (z ${displayStopName(v.stops[0].name)})` : to;
}

/** Departures at one stop as an hour grid; the ones already gone today are dimmed. */
function HourGrid({ mins, nowMin }: { mins: number[]; nowMin: number | null }) {
  const hours = new Map<number, number[]>();
  for (const m of mins) {
    const h = Math.floor(m / 60);
    const list = hours.get(h);
    if (list) list.push(m);
    else hours.set(h, [m]);
  }
  return (
    <dl className="grid grid-cols-[2.25rem_1fr] gap-x-2 gap-y-1 text-[13px] tabular-nums">
      {[...hours].map(([h, list]) => (
        <div key={h} className="contents">
          <dt className="font-semibold text-text">{pad(h % 24)}</dt>
          <dd className="flex flex-wrap gap-x-2.5">
            {list.map((m, i) => (
              <span key={i} className={nowMin != null && m < nowMin ? "text-text-faint" : "text-text"}>
                {pad(m % 60)}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A line's stop patterns for today, each stop's departures one tap away. Mounted only while open. */
function LineView({ desktop, line, city, filterActive, onToggleFilter, resolveStop, onSelectStop, onVariant, onClose }: Props) {
  /* fixed at open: a sheet left open past midnight keeps the day it was showing */
  const [date] = useState(todayISO);
  const [data, setData] = useState<LineResponse | null>(null);
  const [err, setErr] = useState<false | "error" | "warming">(false);
  const [attempt, setAttempt] = useState(0);
  const [variant, setVariant] = useState(0);
  /* expanded stop position in the variant; the first stop's departures show at once */
  const [open, setOpen] = useState<number | null>(0);
  /* Warsaw minute of the day and date, for dimming departures already gone */
  const [[today, clock], setNow] = useState(() => [todayISO(), Math.floor(nowSecs() / 60)] as const);
  useEffect(() => {
    const id = setInterval(() => setNow([todayISO(), Math.floor(nowSecs() / 60)]), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const p = new URLSearchParams({ name: line.name, op: line.operator === "MZK" ? "MZK" : "KB", date });
    fetchJSON<LineResponse>(cityUrl(`/api/line?${p.toString()}`, city), { signal: ctrl.signal })
      .then((r) => {
        setData(r);
        setErr(false);
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setErr(isWarming(e) ? "warming" : "error");
      });
    return () => ctrl.abort();
  }, [line.name, line.operator, city, date, attempt]);

  const v = data?.variants[variant] ?? null;
  useEffect(() => onVariant(v), [v, onVariant]);
  useEffect(() => () => onVariant(null), [onVariant]);
  const nowMin = data && data.date === today ? clock : null;
  const column = useMemo(
    () => (v && open != null ? v.times.map((t) => t[open]).sort((a, b) => a - b) : []),
    [v, open],
  );

  const pickVariant = (i: number) => {
    setVariant(i);
    setOpen(0);
  };

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-3">
        <LineBadge line={line.name} operator={line.operator} big />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Linia {line.name}</h2>
          <p className="mt-0.5 truncate text-[12px] text-text-faint">
            {line.terminus ? `${displayStopName(line.terminus)}, ` : ""}rozkład na dziś
          </p>
        </div>
        <IconButton label="Zamknij" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <div className="kb-scroll mt-3 flex gap-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => onToggleFilter(line.name)}
          aria-pressed={filterActive}
          className={chip(filterActive)}
        >
          Tylko ta linia na mapie
        </button>
        {data &&
          data.variants.length > 1 &&
          data.variants.map((x, i) => (
            <button
              key={i}
              type="button"
              onClick={() => pickVariant(i)}
              aria-pressed={variant === i}
              className={chip(variant === i)}
            >
              {variantLabel(x, data.variants)}
            </button>
          ))}
      </div>
    </header>
  );

  return (
    <BottomSheet desktop={desktop} onClose={onClose} ariaLabel={`Linia ${line.name}`} initialSnap="half" header={header}>
      <div
        className="kb-scroll h-full overflow-y-auto pb-4 animate-fade"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        {err && !data ? (
          <ErrorState
            message={err === "warming" ? GZM_LOADING : undefined}
            onRetry={() => {
              setErr(false);
              setAttempt((a) => a + 1);
            }}
          />
        ) : !data ? (
          <SkeletonRows />
        ) : !v ? (
          <p className="px-6 py-10 text-center text-[13.5px] text-text-faint">Linia nie kursuje dziś według rozkładu.</p>
        ) : (
          <>
            {data.variants.length === 1 && (
              <p className="px-6 pb-1 text-[12.5px] text-text-faint">{variantLabel(v, data.variants)}</p>
            )}
            <ol className="px-2">
              {v.stops.map((s, p) => {
                const first = v.times[0];
                const expanded = open === p;
                const stop = expanded ? resolveStop(s.id) : null;
                return (
                  <li key={`${variant}-${p}`}>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : p)}
                      aria-expanded={expanded}
                      className="tap flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8"
                    >
                      <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-text-faint">
                        {p === 0 ? "start" : `+${first[p] - first[0]} min`}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-[14px] ${expanded ? "font-semibold" : ""} text-text`}>
                        {displayStopName(s.name)}
                      </span>
                      <CaretDownIcon
                        className={`shrink-0 text-text-faint transition-transform ${expanded ? "rotate-180" : ""}`}
                        aria-hidden
                      />
                    </button>
                    {expanded && (
                      <div className="px-4 pb-3 pt-1">
                        {p === v.stops.length - 1 ? (
                          <p className="text-[12.5px] text-text-faint">Przystanek końcowy, przyjazdy:</p>
                        ) : null}
                        <HourGrid mins={column} nowMin={nowMin} />
                        {stop && (
                          <button
                            type="button"
                            onClick={() => onSelectStop(stop)}
                            className="tap mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-primary"
                          >
                            Odjazdy wszystkich linii
                            <CaretRightIcon aria-hidden />
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(LineView);
