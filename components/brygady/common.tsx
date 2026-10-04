"use client";

import { useEffect, useState } from "react";
import { classifyDelay, type DelayClass, type FleetFuelType, type FleetLengthCategory, type VehicleFeatures } from "@/lib/shared/fleet";

/* ── punctuality palette (charts) ────────────────────────────────────────────
 * Diverging around a neutral midpoint, following the map's semantics (violet = early,
 * orange = late). Checked with the dataviz palette validator on --color-surface:
 * adjacent CVD ΔE ≥ 10.9, normal vision ≥ 15.3. The gray midpoint is deliberately low
 * chroma/contrast, so every chart that uses it also labels it (legend + values/table).
 */
export const DELAY_FILL: Record<DelayClass, string> = {
  early: "#9085e9",
  onTime: "#545b64",
  late: "#a65c1c",
  veryLate: "#f0703c",
};

export const DELAY_ORDER: readonly DelayClass[] = ["early", "onTime", "late", "veryLate"];

export const DELAY_LABEL: Record<DelayClass, string> = {
  early: "Przed czasem",
  onTime: "Punktualnie",
  late: "Opóźnione",
  veryLate: "Mocno opóźnione",
};

export const DELAY_RANGE: Record<DelayClass, string> = {
  early: "ponad 1 min wcześniej",
  onTime: "od −1 do +3 min",
  late: "od +3 do +10 min",
  veryLate: "ponad +10 min",
};

/** Status text tokens (readable on every surface) for the same classes. */
export const DELAY_TEXT: Record<DelayClass, string> = {
  early: "text-early",
  onTime: "text-good",
  late: "text-late",
  veryLate: "text-danger",
};

/** One-series bars (magnitude) and their track. */
export const SERIES_FILL = "#3987e5";
export const TRACK_FILL = "#293038";
export const SURFACE = "#16191d";

/** Hatched fill ids are per-SVG; this draws the pattern content. */
export function HatchPattern({ id, color, bg = "transparent" }: { id: string; color: string; bg?: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill={bg} />
      <rect width="2.2" height="6" fill={color} />
    </pattern>
  );
}

/* ── formatting ──────────────────────────────────────────────────────────── */

const nf1 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });

export function fmtInt(n: number): string {
  return nf0.format(n);
}

export function fmtKm(km: number): string {
  return `${km >= 100 ? nf0.format(km) : nf1.format(km)} km`;
}

/** "+1,5 min" / "−0,5 min" / "0 min": one decimal for aggregates (median, mean). */
export function fmtDelayMin(sec: number): string {
  const m = Math.round((sec / 60) * 10) / 10;
  if (m === 0) return "0 min";
  return `${m > 0 ? "+" : "−"}${nf1.format(Math.abs(m))} min`;
}

/** One course's / vehicle's delay: whole minutes, "o czasie" inside ±30 s. */
export function fmtDelay(sec: number): string {
  const m = Math.sign(sec) * Math.round(Math.abs(sec) / 60);
  if (m === 0) return "o czasie";
  return `${m > 0 ? "+" : "−"}${Math.abs(m)} min`;
}

const warsawHHMM = new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
const warsawHHMMSS = new Intl.DateTimeFormat("pl-PL", {
  timeZone: "Europe/Warsaw",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Epoch seconds as agency wall-clock "HH:MM". */
export function clockFromEpoch(sec: number, withSeconds = false): string {
  return (withSeconds ? warsawHHMMSS : warsawHHMM).format(new Date(sec * 1000));
}

/** Agency seconds since midnight as "HH:MM" (wraps past midnight). */
export function clockFromSecs(secs: number): string {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** "przed chwilą" / "5 min temu" / "o 14:05" (older than an hour). */
export function fmtAgo(epochSec: number, nowEpoch: number): string {
  const d = Math.max(0, nowEpoch - epochSec);
  if (d < 90) return "przed chwilą";
  if (d < 3600) return `${Math.round(d / 60)} min temu`;
  return `o ${clockFromEpoch(epochSec)}`;
}

export function pluralPl(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

export const FUEL_LABEL: Record<FleetFuelType, string> = {
  diesel: "Diesel",
  electric: "Elektryczny",
  hydrogen: "Wodorowy",
  hybrid: "Hybrydowy",
};

export const FUEL_LABEL_PLURAL: Record<FleetFuelType, string> = {
  diesel: "Diesel",
  electric: "Elektryczne",
  hydrogen: "Wodorowe",
  hybrid: "Hybrydowe",
};

export const LENGTH_LABEL: Record<FleetLengthCategory, string> = {
  MINI: "Mini (do 9 m)",
  MIDI: "Midi (ok. 10 m)",
  MAXI: "Maxi (12 m)",
  MEGA: "Przegubowy (18 m)",
};

export const LENGTH_LABEL_PLURAL: Record<FleetLengthCategory, string> = {
  MINI: "Mini (do 9 m)",
  MIDI: "Midi (ok. 10 m)",
  MAXI: "Maxi (12 m)",
  MEGA: "Przegubowe (18 m)",
};

export function featureList(f: VehicleFeatures): string[] {
  const out: string[] = [];
  if (f.lowFloor) out.push("Niska podłoga");
  if (f.airCondition) out.push("Klimatyzacja");
  if (f.ticketMachine) out.push("Biletomat");
  if (f.ecoVehicle) out.push("Pojazd ekologiczny");
  return out;
}

/* ── live time ───────────────────────────────────────────────────────────── */

/** Epoch seconds, refreshed every `intervalMs` (the page is client-rendered only). */
export function useEpochNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Width of an element, tracked with ResizeObserver. Pass the setter as a callback ref. */
export function useElementWidth(): [number, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, setEl];
}

/* ── small pieces ────────────────────────────────────────────────────────── */

export function DelayBadge({ sec, size = "sm" }: { sec: number; size?: "sm" | "md" }) {
  const cls = classifyDelay(sec);
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md bg-white/6 font-semibold tabular-nums ${DELAY_TEXT[cls]} ${
        size === "md" ? "px-2 py-1 text-[13px]" : "px-1.5 py-0.5 text-[12px]"
      }`}
      title={`${DELAY_LABEL[cls]} (${DELAY_RANGE[cls]})`}
    >
      {fmtDelay(sec)}
    </span>
  );
}

export function Swatch({ color, hatched = false }: { color: string; hatched?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
      style={
        hatched
          ? { backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 5px)`, boxShadow: `inset 0 0 0 1px ${color}` }
          : { background: color }
      }
    />
  );
}

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  id,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-hairline bg-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-text">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-[12.5px] leading-snug text-text-mute">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* ── icons (inline SVG, currentColor) ────────────────────────────────────── */

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children, strokeWidth = 2 }: IconProps & { children: React.ReactNode; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function BusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4" y="3" width="16" height="15" rx="3" />
      <path d="M4 11h16M8 18v3M16 18v3M8 14.5h.01M16 14.5h.01" />
    </Svg>
  );
}

export function MapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </Svg>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function ArrowUpIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

export function BoltIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </Svg>
  );
}

export function DropIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  );
}

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

/** Propulsion marker for cards and the sheet (diesel shows none). */
export function FuelIcon({ fuel, size = 14 }: { fuel: FleetFuelType; size?: number }) {
  if (fuel === "electric") return <BoltIcon size={size} />;
  if (fuel === "hydrogen") return <DropIcon size={size} />;
  if (fuel === "hybrid") return <BoltIcon size={size} />;
  return null;
}
