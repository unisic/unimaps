import type { FleetTimelinePoint, VehicleCourseRecord } from "@/lib/shared/fleet";

import { fmtDelay } from "./common";

export const GRID = "rgba(255,255,255,0.07)";
export const AXIS = "rgba(255,255,255,0.18)";
export const TICK_TEXT = "#838d96";
export const WAITING_HATCH = "#838d96";
export const CANCELLED_HATCH = "#f5cc5c";

export function niceCeil(v: number): { max: number; step: number } {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200]) {
    if (v / step <= 4) return { max: Math.max(step, Math.ceil(v / step) * step), step };
  }
  const step = 10 ** Math.ceil(Math.log10(v / 4));
  return { max: Math.ceil(v / step) * step, step };
}

/** Hour tick step so labels keep ≥ 48 px apart. */
export function hourStep(pxPerHour: number): number {
  for (const h of [1, 2, 3, 4, 6]) if (pxPerHour * h >= 48) return h;
  return 12;
}

export const measured = (p: FleetTimelinePoint) => p.early + p.onTime + p.late + p.veryLate;

/* ── horizontal bar list (direct-labelled, no tooltip needed) ────────────── */

export interface BarRow {
  key: string;
  /** a plain label, or a name (`class` on its span) over an optional faint second line */
  label: string | { text: string; class: string; sub?: string };
  /** bar length */
  value: number;
  /** filled share of the bar (the rest is drawn as `restColor`); omit for a single segment */
  part?: number;
  color?: string;
  valueText: string | number;
  title?: string;
  onClick?: () => void;
  ariaLabel?: string;
}

/* ── one vehicle's day (Gantt strip) ─────────────────────────────────────── */

export interface GanttCourse {
  course: VehicleCourseRecord;
  live: boolean;
  notStarted?: boolean;
}

/** End of a course on the chart axis: a course across midnight ends past 86400 (the server wraps it to 00:xx). */
export const ganttEnd = ({ course: c }: GanttCourse) => Math.max(c.endSecs < c.startSecs ? c.endSecs + 86400 : c.endSecs, c.startSecs + 60);

export function ganttLabel(c: GanttCourse): string {
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

/* ── delay per course (columns around zero) ──────────────────────────────── */

/** A column with a 4 px rounded data end, square on the zero baseline. */
export function columnPath(x: number, w: number, yBase: number, yEnd: number): string {
  const h = Math.abs(yEnd - yBase);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return "";
  if (yEnd < yBase) {
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

export function fmtMinTick(v: number): string {
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
