"use client";

import { memo, useEffect, useMemo, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { CaretRightIcon, MapPinIcon, PersonSimpleWalkIcon } from "@/components/icons";
import type { GeoStatus } from "@/components/hooks";
import { CloseIcon, ErrorState, IconButton, LineBadge, LiveMark, SkeletonRows } from "@/components/ui";
import { fetchJSON, isWarming } from "@/lib/client/api";
import { cityOfId, GZM_LOADING } from "@/lib/client/city";
import { delayClass, displayStopName } from "@/lib/client/format";
import { formatDistance, formatWalk, nearestStops } from "@/lib/client/geo";
import { createLivePoll } from "@/lib/client/live-poll";
import type { DepartureRow, DeparturesResponse, Stop, Vehicle } from "@/lib/client/types";
import { indexVehicles, rowVehicle } from "@/lib/client/vehicleIndex";
import { etaLabel, resolveTiming, sortBoard, uniqueKeys } from "@/lib/shared/departures";

const NEAR_STOPS = 3;
const ROWS_PER_STOP = 3;

interface Props {
  desktop: boolean;
  stops: Stop[];
  /** null until the first fix (opened from the palette before locating) */
  pos: { lat: number; lon: number } | null;
  geoStatus: GeoStatus;
  /** an address from search instead of the user's position: `pos` is its point */
  place?: { name: string; detail: string } | null;
  vehicles?: Vehicle[];
  onSelectStop: (s: Stop) => void;
  onClose: () => void;
}

/** designator -> its live rows, or null when that one board failed */
type Boards = Map<string, DepartureRow[] | null>;

/** The few stops closest to the user with their next departures, one tap from the full stop sheet.
 *  Mounted only while open, like StopView. */
function NearbyView({ desktop, stops, pos, geoStatus, place, vehicles, onSelectStop, onClose }: Props) {
  const near = useMemo(() => (pos ? nearestStops(stops, pos, NEAR_STOPS) : []), [stops, pos]);
  /* the poll restarts only when the SET of nearby stops changes, not on every GPS fix */
  const key = near.map((n) => n.s.designator).sort().join("\n");
  const [boards, setBoards] = useState<Boards | null>(null);
  /* "warming": the server is still loading the GZM data (503); the poll keeps retrying */
  const [err, setErr] = useState<false | "error" | "warming">(false);
  const [attempt, setAttempt] = useState(0);
  const [nowTs, setNowTs] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (!key) return;
    const designators = key.split("\n");
    let skew = 0;
    let have = false;
    const poll = createLivePoll<Boards>({
      load: async (signal) => {
        const res = await Promise.allSettled(
          designators.map((d) =>
            fetchJSON<DeparturesResponse>(`/api/stop/${encodeURIComponent(d)}/departures`, { cache: "no-store", signal }),
          ),
        );
        const out: Boards = new Map();
        res.forEach((r, i) => {
          out.set(designators[i], r.status === "fulfilled" ? (r.value.rows ?? []) : null);
          if (r.status === "fulfilled" && typeof r.value.server_ts === "number") {
            skew = r.value.server_ts - Date.now() / 1000;
          }
        });
        // every leg failed: a poll failure (backoff), not three "brak danych"
        if (res.every((r) => r.status === "rejected")) throw (res[0] as PromiseRejectedResult).reason;
        return out;
      },
      onOk: (b) => {
        have = true;
        setBoards(b);
        setErr(false);
        setNowTs(Date.now() / 1000 + skew);
      },
      onFail: (e) => {
        if (!have) setErr(cityOfId(designators[0]) !== "bb" && isWarming(e) ? "warming" : "error");
      },
      isVisible: () => !document.hidden,
    });
    poll.start();
    const kick = () => poll.kick();
    document.addEventListener("visibilitychange", kick);
    const id = setInterval(() => {
      setNowTs(Date.now() / 1000 + skew);
      poll.tick();
    }, 5000);
    return () => {
      poll.stop();
      clearInterval(id);
      document.removeEventListener("visibilitychange", kick);
    };
  }, [key, attempt]);

  const vix = useMemo(() => indexVehicles(vehicles), [vehicles]);

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          {place ? <MapPinIcon /> : <PersonSimpleWalkIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">
            {place ? place.name : "W pobliżu"}
          </h2>
          <p className="mt-0.5 truncate text-[12px] text-text-faint">
            {place?.detail ? `${place.detail} · najbliższe przystanki` : "Najbliższe przystanki i odjazdy"}
          </p>
        </div>
        <IconButton label="Zamknij" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
    </header>
  );

  return (
    <BottomSheet desktop={desktop} onClose={onClose} ariaLabel="Odjazdy w pobliżu" header={header}>
      <div
        className="kb-scroll h-full overflow-y-auto pb-4 animate-fade"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        {!pos ? (
          <p className="px-6 py-10 text-center text-[13.5px] text-text-faint">
            {geoStatus === "locating"
              ? "Ustalam lokalizację…"
              : geoStatus === "idle"
                ? "Lokalizacja wyłączona."
                : "Brak dostępu do lokalizacji. Włącz ją w ustawieniach przeglądarki."}
          </p>
        ) : near.length === 0 ? (
          <SkeletonRows />
        ) : err && !boards ? (
          <ErrorState
            message={err === "warming" ? GZM_LOADING : undefined}
            onRetry={() => {
              setErr(false);
              setAttempt((a) => a + 1);
            }}
          />
        ) : (
          near.map(({ s, dist }) => {
            const rows = boards?.get(s.designator);
            const items =
              rows == null
                ? []
                : sortBoard(
                    rows.map((row) => ({ row, timing: resolveTiming(row, rowVehicle(row, vix)) })),
                    nowTs,
                  ).slice(0, ROWS_PER_STOP);
            const keys = uniqueKeys(items.map((it) => it.row));
            return (
              <section key={s.id} className="px-2 pt-2">
                <button
                  type="button"
                  onClick={() => onSelectStop(s)}
                  className="tap flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-tint/5 active:bg-tint/8"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-semibold text-text">
                      {displayStopName(s.name)}
                      {s.symbol && <span className="ml-1.5 font-normal text-text-faint">{s.symbol}</span>}
                    </p>
                    <p className="mt-0.5 text-[12px] tabular-nums text-text-faint">
                      {formatDistance(dist)}, {formatWalk(dist)}
                    </p>
                  </div>
                  <CaretRightIcon className="shrink-0 text-text-faint" aria-hidden />
                </button>
                {rows === undefined ? (
                  <SkeletonRows />
                ) : rows === null ? (
                  <p className="px-2 pb-2 text-[12.5px] text-text-faint">Brak danych z tego przystanku</p>
                ) : items.length === 0 ? (
                  <p className="px-2 pb-2 text-[12.5px] text-text-faint">Brak odjazdów w najbliższym czasie</p>
                ) : (
                  <ul>
                    {items.map(({ row, timing }, i) => {
                      const line = row.line_name || row.symbol || "?";
                      const dest = row.direction || rowVehicle(row, vix)?.headsign;
                      const est = timing.estimated && !timing.canceled;
                      return (
                        <li key={keys[i]}>
                          <button
                            type="button"
                            onClick={() => onSelectStop(s)}
                            className="tap flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-tint/5 active:bg-tint/8"
                          >
                            <LineBadge line={line} operator={row.operator} />
                            <p className="min-w-0 flex-1 truncate text-[13.5px] text-text">
                              {dest ? displayStopName(dest) : `Linia ${line}`}
                            </p>
                            <p
                              className={`flex shrink-0 items-center gap-1 text-[14px] font-semibold tabular-nums ${
                                timing.canceled
                                  ? "text-text-faint line-through"
                                  : est
                                    ? delayClass(timing.delaySec)
                                    : "text-text"
                              }`}
                            >
                              {est && <LiveMark />}
                              {etaLabel(timing, nowTs, row.time ?? "")}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(NearbyView);
