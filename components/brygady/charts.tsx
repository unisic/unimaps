"use client";

import { memo, useCallback, useId, useMemo, useState } from "react";
import { classifyDelay, type DelayClass, type FleetTimelinePoint, type VehicleCourseRecord } from "@/lib/shared/fleet";
import {
  clockFromSecs,
  DELAY_FILL,
  DELAY_LABEL,
  DELAY_ORDER,
  DELAY_RANGE,
  fmtDelay,
  HatchPattern,
  SERIES_FILL,
  SURFACE,
  Swatch,
  TRACK_FILL,
  useElementWidth,
} from "./common";

const GRID = "rgba(255,255,255,0.07)";
const AXIS = "rgba(255,255,255,0.18)";
const TICK_TEXT = "#838d96";
const WAITING_HATCH = "#838d96";
const CANCELLED_HATCH = "#ff8a80";

function niceCeil(v: number): { max: number; step: number } {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200]) {
    if (v / step <= 4) return { max: Math.max(step, Math.ceil(v / step) * step), step };
  }
  const step = 10 ** Math.ceil(Math.log10(v / 4));
  return { max: Math.ceil(v / step) * step, step };
}

/** Hour tick step so labels keep ≥ 48 px apart. */
function hourStep(pxPerHour: number): number {
  for (const h of [1, 2, 3, 4, 6]) if (pxPerHour * h >= 48) return h;
  return 12;
}

const measured = (p: FleetTimelinePoint) => p.early + p.onTime + p.late + p.veryLate;

/* ── fleet punctuality through the day (stacked area) ────────────────────── */

type TimelineMode = "count" | "share";

const TL_H = 230;
const TL_M = { l: 36, r: 10, t: 12, b: 24 };

export const PunctualityTimeline = memo(function PunctualityTimeline({
  points,
  slotSecs,
  fleetName = "MZK",
}: {
  points: FleetTimelinePoint[];
  slotSecs: number;
  /** the operator in the chart's accessible title */
  fleetName?: string;
}) {
  const [width, setRef] = useElementWidth();
  const [mode, setMode] = useState<TimelineMode>("count");
  const [hover, setHover] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const titleId = useId();

  const geo = useMemo(() => {
    if (width <= 0 || points.length === 0) return null;
    const innerW = Math.max(10, width - TL_M.l - TL_M.r);
    const innerH = TL_H - TL_M.t - TL_M.b;
    const first = points[0].t;
    const last = points[points.length - 1].t + slotSecs;
    let x0 = Math.floor(first / 3600) * 3600;
    const x1 = Math.min(86400, Math.ceil(last / 3600) * 3600);
    if (x1 - x0 < 3 * 3600) x0 = Math.max(0, x1 - 3 * 3600);
    const sx = (t: number) => TL_M.l + ((t - x0) / (x1 - x0)) * innerW;
    const yScale = mode === "share" ? { max: 100, step: 25 } : niceCeil(Math.max(1, ...points.map(measured)));
    const sy = (v: number) => TL_M.t + innerH - (v / yScale.max) * innerH;

    const values = (p: FleetTimelinePoint): number[] => {
      const raw = DELAY_ORDER.map((k) => p[k]);
      if (mode === "count") return raw;
      const m = measured(p);
      return raw.map((v) => (m > 0 ? (v / m) * 100 : 0));
    };

    // contiguous runs; a missing slot (night, server down) is a gap, never interpolated
    const runs: FleetTimelinePoint[][] = [];
    let run: FleetTimelinePoint[] = [];
    for (const p of points) {
      const prev = run[run.length - 1];
      const usable = mode === "count" || measured(p) > 0;
      if (!usable || (prev && p.t - prev.t > slotSecs * 1.5)) {
        if (run.length) runs.push(run);
        run = [];
      }
      if (usable) run.push(p);
    }
    if (run.length) runs.push(run);

    const layers: { key: DelayClass; d: string; edge: string }[] = [];
    DELAY_ORDER.forEach((key, k) => {
      let d = "";
      let edge = "";
      for (const r of runs) {
        // samples sit mid-slot; a lone sample is drawn as one slot wide
        const xs = r.length === 1 ? [r[0].t, r[0].t + slotSecs] : r.map((p) => p.t + slotSecs / 2);
        const pts = r.length === 1 ? [r[0], r[0]] : r;
        const top = pts.map((p) => values(p).slice(0, k + 1).reduce((a, b) => a + b, 0));
        const bot = pts.map((p) => values(p).slice(0, k).reduce((a, b) => a + b, 0));
        const fwd = xs.map((t, i) => `${sx(t).toFixed(1)},${sy(top[i]).toFixed(1)}`);
        const back = xs.map((t, i) => `${sx(t).toFixed(1)},${sy(bot[i]).toFixed(1)}`).reverse();
        d += `M${fwd.join("L")}L${back.join("L")}Z`;
        if (k < DELAY_ORDER.length - 1) edge += `M${fwd.join("L")}`;
      }
      layers.push({ key, d, edge });
    });

    const yTicks: number[] = [];
    for (let v = 0; v <= yScale.max + 1e-9; v += yScale.step) yTicks.push(v);
    const pxPerHour = innerW / ((x1 - x0) / 3600);
    const hs = hourStep(pxPerHour);
    const xTicks: number[] = [];
    for (let t = Math.ceil(x0 / (hs * 3600)) * hs * 3600; t <= x1; t += hs * 3600) xTicks.push(t);

    return { innerW, innerH, x0, x1, sx, sy, layers, yTicks, xTicks, unit: mode === "share" ? "%" : "" };
  }, [points, slotSecs, width, mode]);

  const pick = useCallback(
    (clientX: number, target: Element) => {
      if (!geo) return;
      const rect = target.getBoundingClientRect();
      const t = geo.x0 + ((clientX - rect.left - TL_M.l) / geo.innerW) * (geo.x1 - geo.x0);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(points[i].t + slotSecs / 2 - t);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      setHover(best >= 0 && bestD <= slotSecs ? best : null);
    },
    [geo, points, slotSecs],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (points.length === 0) return;
    const cur = hover ?? points.length - 1;
    let next: number | null = cur;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(points.length - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setKeyboard(true);
    setHover(next);
  };

  const hp = hover !== null ? points[hover] : null;
  const hx = hp && geo ? geo.sx(hp.t + slotSecs / 2) : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <DelayLegend />
        <div role="group" aria-label="Skala wykresu" className="flex rounded-lg bg-surface-2 p-0.5 text-[12px] font-medium">
          {(
            [
              ["count", "Liczba pojazdów"],
              ["share", "Udział %"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-8 rounded-md px-2.5 transition-colors ${
                mode === m ? "bg-surface-3 text-text" : "text-text-mute hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div ref={setRef} className="relative w-full select-none" style={{ height: TL_H }}>
        {geo ? (
          <svg
            width={width}
            height={TL_H}
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setKeyboard(true)}
            onBlur={() => {
              setKeyboard(false);
              setHover(null);
            }}
            className="block rounded-lg"
            style={{ touchAction: "pan-y" }}
          >
            <title id={titleId}>
              {mode === "count"
                ? `Pojazdy ${fleetName} w trasie według punktualności, w ciągu dnia. Strzałki przesuwają kursor.`
                : `Udział pojazdów ${fleetName} według punktualności, w ciągu dnia. Strzałki przesuwają kursor.`}
            </title>
            {geo.yTicks.map((v) => (
              <g key={v}>
                <line x1={TL_M.l} x2={TL_M.l + geo.innerW} y1={geo.sy(v)} y2={geo.sy(v)} stroke={v === 0 ? AXIS : GRID} />
                <text x={TL_M.l - 6} y={geo.sy(v)} dy="0.32em" textAnchor="end" fontSize="11" fill={TICK_TEXT} className="tabular-nums">
                  {v}
                  {geo.unit}
                </text>
              </g>
            ))}
            {geo.xTicks.map((t) => (
              <text key={t} x={geo.sx(t)} y={TL_H - 6} textAnchor={t >= geo.x1 ? "end" : "middle"} fontSize="11" fill={TICK_TEXT} className="tabular-nums">
                {clockFromSecs(t)}
              </text>
            ))}
            {geo.layers.map((l) => (
              <path key={l.key} d={l.d} fill={DELAY_FILL[l.key]} />
            ))}
            {geo.layers.map((l) => (l.edge ? <path key={`e-${l.key}`} d={l.edge} fill="none" stroke={SURFACE} strokeWidth={1.5} strokeLinejoin="round" /> : null))}
            {hp ? (
              <line x1={hx} x2={hx} y1={TL_M.t} y2={TL_M.t + geo.innerH} stroke="#e8eaed" strokeWidth={1} strokeDasharray="3 3" />
            ) : null}
            <rect
              x={TL_M.l}
              y={TL_M.t}
              width={geo.innerW}
              height={geo.innerH}
              fill="transparent"
              onPointerMove={(e) => {
                setKeyboard(false);
                pick(e.clientX, e.currentTarget.ownerSVGElement ?? e.currentTarget);
              }}
              onPointerDown={(e) => pick(e.clientX, e.currentTarget.ownerSVGElement ?? e.currentTarget)}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        ) : (
          <div className="skeleton h-full w-full" />
        )}
        {hp && geo ? (
          <div
            className="pointer-events-none absolute top-2 w-[13.5rem] rounded-xl border border-hairline bg-surface-2 p-3 text-[12px] shadow-[var(--shadow-float)]"
            style={{ left: hx > width / 2 ? Math.max(0, hx - 12 - 216) : Math.min(width - 216, hx + 12) }}
            aria-live={keyboard ? "polite" : undefined}
          >
            <TimelineTooltip p={hp} slotSecs={slotSecs} />
          </div>
        ) : null}
      </div>

      <TimelineTable points={points} />
    </div>
  );
});

function TimelineTooltip({ p, slotSecs }: { p: FleetTimelinePoint; slotSecs: number }) {
  const m = measured(p);
  return (
    <>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-semibold text-text tabular-nums">
          {clockFromSecs(p.t)}–{clockFromSecs(p.t + slotSecs)}
        </span>
        <span className="text-text-mute tabular-nums">{m + p.waiting} w trasie</span>
      </div>
      <ul className="space-y-1">
        {[...DELAY_ORDER].reverse().map((k) => (
          <li key={k} className="flex items-center gap-2">
            <Swatch color={DELAY_FILL[k]} />
            <span className="flex-1 text-text-mute">{DELAY_LABEL[k]}</span>
            <span className="font-semibold text-text tabular-nums">{p[k]}</span>
            <span className="w-9 text-right text-text-mute tabular-nums">{m > 0 ? `${Math.round((p[k] / m) * 100)}%` : "–"}</span>
          </li>
        ))}
        {p.waiting > 0 ? (
          <li className="flex items-center gap-2 border-t border-hairline pt-1">
            <Swatch color={WAITING_HATCH} hatched />
            <span className="flex-1 text-text-mute">Czeka na odjazd</span>
            <span className="font-semibold text-text tabular-nums">{p.waiting}</span>
            <span className="w-9" />
          </li>
        ) : null}
      </ul>
    </>
  );
}

export function DelayLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-text-mute">
      {DELAY_ORDER.map((k) => (
        <li key={k} className="flex items-center gap-1.5" title={DELAY_RANGE[k]}>
          <Swatch color={DELAY_FILL[k]} />
          <span>{DELAY_LABEL[k]}</span>
          <span className="hidden text-text-faint sm:inline">({DELAY_RANGE[k]})</span>
        </li>
      ))}
    </ul>
  );
}

/** The same data, hour by hour, for readers who do not hover (and screen readers). */
function TimelineTable({ points }: { points: FleetTimelinePoint[] }) {
  const rows = useMemo(() => {
    const byHour = new Map<number, { n: number; total: number; m: number; early: number; onTime: number; late: number }>();
    for (const p of points) {
      const h = Math.floor(p.t / 3600);
      const r = byHour.get(h) ?? { n: 0, total: 0, m: 0, early: 0, onTime: 0, late: 0 };
      const m = measured(p);
      r.n++;
      r.total += m + p.waiting;
      r.m += m;
      r.early += p.early;
      r.onTime += p.onTime;
      r.late += p.late + p.veryLate;
      byHour.set(h, r);
    }
    return [...byHour.entries()].sort((a, b) => b[0] - a[0]);
  }, [points]);
  if (rows.length === 0) return null;
  const pct = (v: number, m: number) => (m > 0 ? `${Math.round((v / m) * 100)}%` : "–");
  return (
    <details className="group mt-3">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-[12.5px] font-medium text-text-mute hover:text-text [&::-webkit-details-marker]:hidden">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className="transition-transform group-open:rotate-90">
          <path d="m9 6 6 6-6 6" />
        </svg>
        Tabela godzinowa
      </summary>
      <div className="kb-scroll mt-2 max-h-72 overflow-auto rounded-lg border border-hairline">
        <table className="w-full text-left text-[12.5px] tabular-nums">
          <thead className="sticky top-0 bg-surface-2 text-text-mute">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Godzina</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">W trasie (śr.)</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Punktualnie</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Opóźnione</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Przed czasem</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([h, r]) => (
              <tr key={h} className="border-t border-hairline">
                <th scope="row" className="px-3 py-1.5 font-medium text-text">
                  {clockFromSecs(h * 3600)}–{clockFromSecs((h + 1) * 3600)}
                </th>
                <td className="px-3 py-1.5 text-right text-text">{Math.round(r.total / r.n)}</td>
                <td className="px-3 py-1.5 text-right text-text">{pct(r.onTime, r.m)}</td>
                <td className="px-3 py-1.5 text-right text-text">{pct(r.late, r.m)}</td>
                <td className="px-3 py-1.5 text-right text-text">{pct(r.early, r.m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ── horizontal bar list (direct-labelled, no tooltip needed) ────────────── */

export interface BarRow {
  key: string;
  label: React.ReactNode;
  /** bar length */
  value: number;
  /** filled share of the bar (the rest is drawn as `restColor`); omit for a single segment */
  part?: number;
  color?: string;
  valueText: React.ReactNode;
  title?: string;
  onClick?: () => void;
  ariaLabel?: string;
}

export function BarList({
  rows,
  max,
  restColor = TRACK_FILL,
  labelClassName = "w-28 sm:w-40",
}: {
  rows: BarRow[];
  max?: number;
  restColor?: string;
  labelClassName?: string;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => {
        const w = top > 0 ? (r.value / top) * 100 : 0;
        const partW = r.part !== undefined && r.value > 0 ? (r.part / r.value) * 100 : 100;
        const color = r.color ?? SERIES_FILL;
        const body = (
          <>
            <span className={`flex min-w-0 shrink-0 flex-col text-left text-[12.5px] text-text-mute ${labelClassName}`}>
              {typeof r.label === "string" ? <span className="truncate">{r.label}</span> : r.label}
            </span>
            <span className="relative flex h-3.5 flex-1 items-center" aria-hidden>
              <span className="flex h-full overflow-hidden rounded-r" style={{ width: `${Math.max(w, r.value > 0 ? 1 : 0)}%` }}>
                {r.part === undefined ? (
                  <span className="h-full w-full" style={{ background: color }} />
                ) : (
                  <>
                    {r.part > 0 ? <span className="h-full" style={{ width: `${partW}%`, background: color }} /> : null}
                    {r.part < r.value ? (
                      <span
                        className="h-full flex-1"
                        style={{ background: restColor, marginLeft: r.part > 0 ? 2 : 0 }}
                      />
                    ) : null}
                  </>
                )}
              </span>
            </span>
            <span className="min-w-[4.5rem] shrink-0 text-right text-[12.5px] text-text tabular-nums">{r.valueText}</span>
          </>
        );
        return (
          <li key={r.key}>
            {r.onClick ? (
              <button
                type="button"
                onClick={r.onClick}
                title={r.title}
                aria-label={r.ariaLabel}
                className="flex min-h-8 w-full items-center gap-3 rounded-lg px-1.5 transition-colors hover:bg-white/5"
              >
                {body}
              </button>
            ) : (
              <div className="flex min-h-8 items-center gap-3 px-1.5" title={r.title} aria-label={r.ariaLabel}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TwoPartLegend({ partLabel, restLabel }: { partLabel: string; restLabel: string }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-mute">
      <li className="flex items-center gap-1.5">
        <Swatch color={SERIES_FILL} />
        {partLabel}
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch color={TRACK_FILL} />
        {restLabel}
      </li>
    </ul>
  );
}

/* ── one vehicle's day (Gantt strip) ─────────────────────────────────────── */

export interface GanttCourse {
  course: VehicleCourseRecord;
  live: boolean;
  notStarted?: boolean;
}

const GT_H = 64;
/** End of a course on the chart axis: a course across midnight ends past 86400 (the server wraps it to 00:xx). */
const ganttEnd = ({ course: c }: GanttCourse) => Math.max(c.endSecs < c.startSecs ? c.endSecs + 86400 : c.endSecs, c.startSecs + 60);
const GT_BAR_Y = 20;
const GT_BAR_H = 20;

export const CourseGantt = memo(function CourseGantt({
  courses,
  nowSecs,
  onSelect,
}: {
  courses: GanttCourse[];
  nowSecs: number;
  onSelect?: (courseId: string) => void;
}) {
  const [width, setRef] = useElementWidth();
  const [hover, setHover] = useState<string | null>(null);
  const uid = useId().replace(/:/g, "");

  const geo = useMemo(() => {
    if (width <= 0 || courses.length === 0) return null;
    const starts = courses.map((c) => c.course.startSecs);
    const ends = courses.map(ganttEnd);
    let x0 = Math.floor(Math.min(...starts) / 3600) * 3600;
    const x1 = Math.min(86400 + 3 * 3600, Math.ceil(Math.max(...ends, nowSecs) / 3600) * 3600);
    if (x1 - x0 < 2 * 3600) x0 = Math.max(0, x1 - 2 * 3600);
    const innerW = Math.max(10, width - 8);
    const sx = (t: number) => 4 + ((t - x0) / (x1 - x0)) * innerW;
    const hs = hourStep(innerW / ((x1 - x0) / 3600));
    const ticks: number[] = [];
    for (let t = Math.ceil(x0 / (hs * 3600)) * hs * 3600; t <= x1; t += hs * 3600) ticks.push(t);

    const sorted = [...courses].sort((a, b) => a.course.startSecs - b.course.startSecs);
    let labelEnd = -Infinity;
    const bars = sorted.map((c) => {
      const xa = sx(c.course.startSecs);
      const xb = Math.max(xa + 3, sx(ganttEnd(c)));
      const cx = (xa + xb) / 2;
      const label = c.course.lineName;
      const lw = label.length * 7 + 4;
      const showLabel = cx - lw / 2 > labelEnd + 2;
      if (showLabel) labelEnd = cx + lw / 2;
      return { c, xa, xb, cx, showLabel };
    });
    // after midnight "now" sits on the axis past 86400 when a course runs there
    const nowT = nowSecs < x0 && nowSecs + 86400 <= x1 ? nowSecs + 86400 : nowSecs;
    return { sx, ticks, bars, x0, x1, nowT };
  }, [courses, width, nowSecs]);

  const hovered = geo?.bars.find((b) => b.c.course.id === hover) ?? null;

  return (
    <div ref={setRef} className="relative w-full select-none" style={{ height: GT_H }}>
      {geo ? (
        <svg width={width} height={GT_H} aria-hidden className="block overflow-visible">
          <defs>
            <HatchPattern id={`${uid}-x`} color={CANCELLED_HATCH} bg="rgba(255,138,128,0.12)" />
            <HatchPattern id={`${uid}-w`} color={WAITING_HATCH} bg="rgba(131,141,150,0.12)" />
          </defs>
          <line x1={4} x2={width - 4} y1={GT_BAR_Y + GT_BAR_H / 2} y2={GT_BAR_Y + GT_BAR_H / 2} stroke={GRID} strokeWidth={2} />
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={geo.sx(t)} x2={geo.sx(t)} y1={GT_BAR_Y - 4} y2={GT_BAR_Y + GT_BAR_H + 4} stroke={GRID} />
              <text x={geo.sx(t)} y={GT_H - 4} textAnchor="middle" fontSize="11" fill={TICK_TEXT} className="tabular-nums">
                {clockFromSecs(t)}
              </text>
            </g>
          ))}
          {geo.bars.map(({ c, xa, xb, cx, showLabel }) => {
            const cancelled = c.course.status === "cancelled";
            const fill = cancelled
              ? `url(#${uid}-x)`
              : c.notStarted
                ? `url(#${uid}-w)`
                : DELAY_FILL[classifyDelay(c.course.delaySec)];
            return (
              <g key={c.course.id}>
                {showLabel ? (
                  <text x={cx} y={GT_BAR_Y - 7} textAnchor="middle" fontSize="11" fontWeight={600} fill="#9aa0a6">
                    {c.course.lineName}
                  </text>
                ) : null}
                <rect
                  x={xa}
                  y={GT_BAR_Y}
                  width={xb - xa}
                  height={GT_BAR_H}
                  rx={3}
                  fill={fill}
                  stroke={c.live ? "#e8eaed" : SURFACE}
                  strokeWidth={c.live ? 1.5 : 2}
                />
              </g>
            );
          })}
          {geo.nowT >= geo.x0 && geo.nowT <= geo.x1 ? (
            <line
              x1={geo.sx(geo.nowT)}
              x2={geo.sx(geo.nowT)}
              y1={GT_BAR_Y - 6}
              y2={GT_BAR_Y + GT_BAR_H + 6}
              stroke="#ee7583"
              strokeWidth={2}
              strokeLinecap="round"
            />
          ) : null}
        </svg>
      ) : (
        <div className="skeleton h-full w-full" />
      )}
      {/* hit targets: taller than the bars, real buttons (keyboard + screen readers) */}
      {geo?.bars.map(({ c, xa, xb }) => (
        <button
          key={c.course.id}
          type="button"
          className="absolute rounded-md focus-visible:outline-2"
          style={{ left: xa - 2, width: Math.max(14, xb - xa + 4), top: GT_BAR_Y - 6, height: GT_BAR_H + 12 }}
          aria-label={ganttLabel(c)}
          onPointerEnter={() => setHover(c.course.id)}
          onPointerLeave={() => setHover((h) => (h === c.course.id ? null : h))}
          onFocus={() => setHover(c.course.id)}
          onBlur={() => setHover((h) => (h === c.course.id ? null : h))}
          onClick={() => onSelect?.(c.course.id)}
        />
      ))}
      {hovered ? (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[16rem] rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-text shadow-[var(--shadow-float)]"
          style={{ left: Math.min(Math.max(0, hovered.cx - 100), Math.max(0, width - 220)) }}
        >
          {ganttLabel(hovered.c)}
        </div>
      ) : null}
    </div>
  );
});

function ganttLabel(c: GanttCourse): string {
  const k = c.course;
  const state =
    k.status === "cancelled"
      ? "przerwany"
      : c.notStarted
        ? "czeka na odjazd"
        : c.live
          ? `w trakcie, ${fmtDelay(k.delaySec)}`
          : fmtDelay(k.delaySec);
  return `Linia ${k.lineName}, ${k.startTime}–${k.endTime}, ${k.firstStopName} → ${k.lastStopName} (${state})`;
}

/** Legend for the Gantt strip (classes + cancelled + waiting + now). */
export function GanttLegend({ showWaiting }: { showWaiting: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-text-mute">
      {DELAY_ORDER.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <Swatch color={DELAY_FILL[k]} />
          {DELAY_LABEL[k]}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <Swatch color={CANCELLED_HATCH} hatched />
        Przerwany
      </li>
      {showWaiting ? (
        <li className="flex items-center gap-1.5">
          <Swatch color={WAITING_HATCH} hatched />
          Czeka na odjazd
        </li>
      ) : null}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3 w-0.5 rounded bg-primary" />
        Teraz
      </li>
    </ul>
  );
}

/* ── delay per course (columns around zero) ──────────────────────────────── */

const CD_H = 160;
const CD_M = { l: 40, r: 8, t: 18, b: 24 };

/** A column with a 4 px rounded data end, square on the zero baseline. */
function columnPath(x: number, w: number, yBase: number, yEnd: number): string {
  const h = Math.abs(yEnd - yBase);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return "";
  if (yEnd < yBase) {
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

function fmtMinTick(v: number): string {
  if (v === 0) return "0";
  return `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
}

export interface DelayColumn {
  id: string;
  label: string; // "HH:MM"
  lineName: string;
  delaySec: number;
  live: boolean;
  title: string;
}

/** Delay of each measured course of one vehicle, in driving order. */
export const CourseDelayColumns = memo(function CourseDelayColumns({ columns }: { columns: DelayColumn[] }) {
  const [width, setRef] = useElementWidth();
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();

  const geo = useMemo(() => {
    if (width <= 0 || columns.length === 0) return null;
    const innerW = Math.max(10, width - CD_M.l - CD_M.r);
    const innerH = CD_H - CD_M.t - CD_M.b;
    const mins = columns.map((c) => c.delaySec / 60);
    const hi = Math.max(0, ...mins);
    const lo = Math.min(0, ...mins);
    const { step } = niceCeil(Math.max(1, hi, -lo));
    let top = Math.ceil(hi / step) * step;
    const bottom = Math.floor(lo / step) * step;
    if (top === bottom) top = step;
    const sy = (v: number) => CD_M.t + ((top - v) / (top - bottom)) * innerH;
    const slot = innerW / columns.length;
    const barW = Math.min(24, Math.max(4, slot * 0.6));
    const ticks: number[] = [];
    for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(v);
    const every = Math.max(1, Math.ceil(40 / slot));
    // direct labels only where they stay readable: all of them for a short day, else the extremes
    const iMax = mins.indexOf(Math.max(...mins));
    const iMin = mins.indexOf(Math.min(...mins));
    const labelled = new Set(columns.length <= 12 && slot >= 28 ? columns.map((_, i) => i) : [iMax, iMin]);
    return { innerW, innerH, sy, slot, barW, ticks, every, mins, labelled };
  }, [columns, width]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = hover ?? columns.length - 1;
    let next: number | null = cur;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(columns.length - 1, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = columns.length - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setHover(next);
  };

  const hc = hover !== null ? columns[hover] : null;
  const hx = geo && hover !== null ? CD_M.l + geo.slot * (hover + 0.5) : 0;

  return (
    <div ref={setRef} className="relative w-full select-none" style={{ height: CD_H }}>
      {geo ? (
        <svg
          width={width}
          height={CD_H}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
          className="block rounded-lg"
          style={{ touchAction: "pan-y" }}
        >
          <title id={titleId}>Opóźnienie na kolejnych kursach w minutach. Strzałki przesuwają wybór.</title>
          {geo.ticks.map((v) => (
            <g key={v}>
              <line x1={CD_M.l} x2={CD_M.l + geo.innerW} y1={geo.sy(v)} y2={geo.sy(v)} stroke={v === 0 ? AXIS : GRID} />
              <text x={CD_M.l - 6} y={geo.sy(v)} dy="0.32em" textAnchor="end" fontSize="11" fill={TICK_TEXT} className="tabular-nums">
                {fmtMinTick(v)}
              </text>
            </g>
          ))}
          <text x={CD_M.l - 6} y={CD_M.t - 8} textAnchor="end" fontSize="10.5" fill={TICK_TEXT}>
            min
          </text>
          {columns.map((c, i) => {
            const x = CD_M.l + geo.slot * i + (geo.slot - geo.barW) / 2;
            const v = geo.mins[i];
            const y0 = geo.sy(0);
            const y1 = geo.sy(v);
            const d = columnPath(x, geo.barW, y0, y1);
            return (
              <g key={c.id}>
                {hover === i ? <rect x={CD_M.l + geo.slot * i} y={CD_M.t} width={geo.slot} height={geo.innerH} fill="rgba(255,255,255,0.05)" /> : null}
                {d ? (
                  <path d={d} fill={DELAY_FILL[classifyDelay(c.delaySec)]} stroke={c.live ? "#e8eaed" : "none"} strokeWidth={c.live ? 1.5 : 0} />
                ) : (
                  <line x1={x} x2={x + geo.barW} y1={y0} y2={y0} stroke={DELAY_FILL.onTime} strokeWidth={2} />
                )}
                {geo.labelled.has(i) ? (
                  <text
                    x={x + geo.barW / 2}
                    y={v >= 0 ? Math.min(y1, y0) - 4 : Math.max(y1, y0) + 12}
                    textAnchor="middle"
                    fontSize="10.5"
                    fontWeight={600}
                    fill="#9aa0a6"
                    className="tabular-nums"
                  >
                    {fmtMinTick(Math.round(v))}
                  </text>
                ) : null}
                {i % geo.every === 0 ? (
                  <text x={x + geo.barW / 2} y={CD_H - 6} textAnchor="middle" fontSize="10.5" fill={TICK_TEXT} className="tabular-nums">
                    {c.label}
                  </text>
                ) : null}
                <rect
                  x={CD_M.l + geo.slot * i}
                  y={CD_M.t}
                  width={geo.slot}
                  height={geo.innerH + CD_M.b}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerDown={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                />
              </g>
            );
          })}
        </svg>
      ) : (
        <div className="skeleton h-full w-full" />
      )}
      {hc && geo ? (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max max-w-[15rem] rounded-lg border border-hairline bg-surface-2 px-2.5 py-1.5 text-[12px] text-text shadow-[var(--shadow-float)]"
          style={hx > width / 2 ? { right: Math.max(0, width - hx + 12) } : { left: hx + 12 }}
        >
          {hc.title}
        </div>
      ) : null}
    </div>
  );
});
