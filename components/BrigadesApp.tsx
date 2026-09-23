"use client";

import { memo, Suspense, useDeferredValue, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useFleet,
  useVehicleDetail,
  type FleetSummaryItem,
  type FleetVehicleDetail,
  type VehicleCourseRecord,
} from "@/lib/client/fleet";

/* ==========================================================================
   BESPOKE SVG ICONS & GLYPHS (Zero Emoji Slop)
   ========================================================================== */

function BusIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M3 10h18M8 4v6M12 4v6M16 4v6" />
      <circle cx="7" cy="16" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="17" cy="16" r="1.5" fill="currentColor" stroke="none" />
      <path d="M5 19v2M19 19v2" />
    </svg>
  );
}

function BackArrowIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function CompassIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" />
    </svg>
  );
}

function MapPinIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CheckIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
      <line x1="9" y1="3" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="21" />
    </svg>
  );
}

/* Vehicle Technical Feature Glyphs */

function HydrogenGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66 4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66 4.24-4.24" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

function ElectricGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HybridGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
    </svg>
  );
}

function DieselGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 22V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
      <path d="M13 10h4a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9l-3-3" />
      <path d="M6 8h5M3 22h10" />
    </svg>
  );
}

function MegaGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="6" width="8" height="10" rx="1.5" />
      <rect x="14" y="6" width="8" height="10" rx="1.5" />
      <path d="M10 8l2 2-2 2 2 2" />
      <circle cx="5" cy="17" r="1.5" fill="currentColor" />
      <circle cx="19" cy="17" r="1.5" fill="currentColor" />
    </svg>
  );
}

function AcGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      <line x1="4.93" y1="19.07" x2="19.07" y2="4.93" />
    </svg>
  );
}

function LowFloorGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="5" r="2" />
      <path d="M9 7v6l4 2 2 5M11 13h5" />
      <path d="M6 19a4 4 0 1 0 8 0" />
    </svg>
  );
}

function TicketGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}

/* ==========================================================================
   DISPATCH BADGES & STATUS TOKENS
   ========================================================================== */

function OperatorBadge({ operator }: { operator: "MZK" | "KB" }) {
  const isMzk = operator === "MZK";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase leading-none shadow-sm ${
        isMzk ? "bg-blue-600 text-white" : "bg-[#a6192e] text-white"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={isMzk ? "/mzk-logo.svg" : "/brand.svg"}
        alt=""
        className="h-2.5 w-auto filter brightness-0 invert"
        aria-hidden
      />
      {operator}
    </span>
  );
}

function PropulsionBadge({ fuelType, lengthCategory }: { fuelType: string; lengthCategory?: string }) {
  const isMega = lengthCategory === "MEGA";

  if (fuelType === "hydrogen") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-300 border border-cyan-500/25">
        <HydrogenIcon /> H₂ Wodór
      </span>
    );
  }
  if (fuelType === "electric") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300 border border-emerald-500/25">
        <ElectricIcon /> 100% EV
      </span>
    );
  }
  if (fuelType === "hybrid") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-teal-500/10 px-2 py-0.5 text-[11px] font-semibold text-teal-300 border border-teal-500/25">
        <HybridIcon /> Hybryda
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-2 py-0.5 text-[11px] font-medium text-text-mute border border-hairline">
      <DieselIcon /> Diesel
      {isMega && <strong className="text-amber-300 ml-1 font-bold">MEGA</strong>}
    </span>
  );
}

function DelayBadge({ delaySec }: { delaySec?: number | null }) {
  if (delaySec == null) return null;
  const mins = Math.round(delaySec / 60);

  if (mins <= -1) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-cyan-500/15 px-2 py-0.5 text-[11px] font-semibold text-cyan-300 border border-cyan-500/25 tabular-nums">
        {Math.abs(mins)} min przed czasem
      </span>
    );
  }
  if (mins <= 2) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300 border border-emerald-500/25">
        O czasie
      </span>
    );
  }
  if (mins <= 5) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-300 border border-amber-500/25 tabular-nums">
        +{mins} min opóźnienia
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-300 border border-rose-500/25 tabular-nums">
      +{mins} min opóźnienia
    </span>
  );
}

function HydrogenIcon() {
  return <HydrogenGlyph />;
}
function ElectricIcon() {
  return <ElectricGlyph />;
}
function HybridIcon() {
  return <HybridGlyph />;
}
function DieselIcon() {
  return <DieselGlyph />;
}

/* ==========================================================================
   MAIN BRIGADES APP COMPONENT
   ========================================================================== */

function BrigadesAppContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Selected vehicle side number from URL (?tabor=233)
  const selectedSideNumber = searchParams.get("tabor");

  // Filters state
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "depot">("all");
  const [propulsionFilter, setPropulsionFilter] = useState<string>("all");
  const [lineFilter, setLineFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [clockStr, setClockStr] = useState<string>("");

  useEffect(() => {
    const update = () => {
      setClockStr(
        new Date().toLocaleTimeString("pl-PL", {
          timeZone: "Europe/Warsaw",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const deferredQuery = useDeferredValue(searchQuery);

  const { data: fleetData, isValidating } = useFleet({
    status: statusFilter,
    propulsion: propulsionFilter,
    line: lineFilter,
    q: deferredQuery,
  });

  const { data: selectedVehicleData } = useVehicleDetail(selectedSideNumber);

  // Background body scroll locking when modal is open
  useEffect(() => {
    if (selectedSideNumber) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [selectedSideNumber]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3200);
  };

  const handleSelectVehicle = (sideNumber: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tabor", sideNumber);
    router.push(`/brygady?${params.toString()}`);
  };

  const handleCloseVehicle = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tabor");
    const qs = params.toString();
    router.push(`/brygady${qs ? `?${qs}` : ""}`);
  };

  const copyShareLink = (sideNumber: string) => {
    if (typeof window !== "undefined") {
      const url = `${window.location.origin}/brygady?tabor=${sideNumber}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast(`Skopiowano bezpośredni link do wozu #${sideNumber}!`);
      });
    }
  };

  const stats = fleetData?.stats;
  const vehicles = fleetData?.vehicles ?? [];

  return (
    <div className="min-h-dvh w-full bg-bg text-text flex flex-col selection:bg-brand/30 pb-16">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-xl bg-surface-3 px-4 py-2.5 text-sm font-semibold text-text shadow-2xl border border-white/15 animate-drop flex items-center gap-2">
          <span className="text-emerald-400">
            <CheckIcon className="w-4 h-4" />
          </span>
          {toastMessage}
        </div>
      )}

      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/95 backdrop-blur-md px-4 py-3 sm:px-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/6 px-3 py-1.5 text-xs font-semibold text-text hover:bg-white/10 active:scale-95 transition-all shrink-0 border border-hairline"
              title="Powrót do mapy na żywo"
            >
              <BackArrowIcon />
              <span>Mapa na żywo</span>
            </Link>
            <div className="h-4 w-px bg-white/10 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight truncate text-text">
                  Brygady i Tabor
                </h1>
                <span className="hidden md:inline-flex items-center gap-1 rounded-full bg-good/15 px-2 py-0.5 text-[10px] font-bold text-good uppercase tracking-wider border border-good/20">
                  <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" />
                  Dyspozytornia Live
                </span>
              </div>
              <p className="text-[11px] text-text-mute truncate">
                MZK Bielsko-Biała &middot; Monitoring taboru, karty drogowe i obiegi brygad
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isValidating && (
              <span className="text-[11px] text-text-faint flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full border border-text-mute border-t-text animate-spin" />
                <span className="hidden sm:inline">Odświeżam…</span>
              </span>
            )}
            <div
              className="rounded-full bg-surface-2 px-3 py-1 text-xs font-mono text-text-mute border border-hairline tabular-nums"
              title="Aktualny czas (Europe/Warsaw)"
            >
              {clockStr || "—"}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 space-y-6">
        {/* Operations Telemetry Banner (Zero AI Slop) */}
        {stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {/* Active Fleet Tile */}
            <div className="surface rounded-2xl p-4 flex flex-col justify-between border border-hairline">
              <div className="flex items-center justify-between text-text-mute">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-faint">W trasie (Live)</span>
                <span className="flex items-center gap-1 text-[10px] font-bold text-good">
                  <span className="h-2 w-2 rounded-full bg-good animate-pulse-dot" />
                  Aktywne
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="text-2xl sm:text-3xl font-mono font-bold text-text tabular-nums">
                  {stats.activeCount}
                </span>
                <span className="text-xs text-text-faint">/ {stats.totalFleet} wozów</span>
              </div>
              <div className="mt-2.5 h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-good rounded-full transition-all duration-500"
                  style={{ width: `${(stats.activeCount / Math.max(1, stats.totalFleet)) * 100}%` }}
                />
              </div>
            </div>

            {/* Punctuality Tile */}
            <div className="surface rounded-2xl p-4 flex flex-col justify-between border border-hairline">
              <div className="flex items-center justify-between text-text-mute">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-faint">Punktualność</span>
                <ClockIcon className="w-3.5 h-3.5 text-text-faint" />
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="text-2xl sm:text-3xl font-mono font-bold text-text tabular-nums">
                  {stats.onTimePercentage}%
                </span>
                <span className="text-xs text-emerald-400 font-medium">o czasie</span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                Średnie odchylenie:{" "}
                <strong className="text-text font-semibold">
                  {stats.averageDelaySec > 0 ? `+${Math.round(stats.averageDelaySec / 60)} min` : "w normie"}
                </strong>
              </p>
            </div>

            {/* Zero-Emission Fleet Tile */}
            <div className="surface rounded-2xl p-4 flex flex-col justify-between border border-hairline">
              <div className="flex items-center justify-between text-text-mute">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-faint">Flota bezemisyjna</span>
                <div className="flex items-center gap-1 text-cyan-300">
                  <HydrogenGlyph />
                  <ElectricGlyph />
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="text-2xl sm:text-3xl font-mono font-bold text-cyan-300 tabular-nums">
                  {stats.hydrogenCount + stats.electricCount}
                </span>
                <span className="text-xs text-text-faint">
                  ({stats.hydrogenCount} H₂ &middot; {stats.electricCount} EV)
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">
                Hybrydy: <strong className="text-text">{stats.hybridCount}</strong> &middot; MEGA: <strong className="text-text">{stats.megaCount}</strong>
              </p>
            </div>

            {/* Depot Status Tile */}
            <div className="surface rounded-2xl p-4 flex flex-col justify-between border border-hairline">
              <div className="flex items-center justify-between text-text-mute">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-faint">W zajezdni / przerwa</span>
                <BusIcon className="w-3.5 h-3.5 text-text-faint" />
              </div>
              <div className="mt-2.5 flex items-baseline gap-2">
                <span className="text-2xl sm:text-3xl font-mono font-bold text-text-mute tabular-nums">
                  {stats.depotCount}
                </span>
                <span className="text-xs text-text-faint">wozów</span>
              </div>
              <p className="mt-1 text-[11px] text-text-faint">Zajezdnia MZK ul. Długa 50</p>
            </div>
          </div>
        )}

        {/* Filter Controls & Search */}
        <div className="surface rounded-2xl p-4 border border-hairline space-y-3.5">
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-3.5 flex items-center pointer-events-none text-text-faint">
                <SearchIcon />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Szukaj po numerze (#256), linii (50), modelu (Solaris), kierunku…"
                className="w-full rounded-xl bg-surface-2 pl-9 pr-9 py-2.5 text-sm text-text placeholder-text-faint border border-hairline focus:border-brand focus:outline-none transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute inset-y-0 right-3 flex items-center text-text-mute hover:text-text"
                  aria-label="Wyczyść wyszukiwanie"
                >
                  <CloseIcon />
                </button>
              )}
            </div>

            {/* Status Segment Toggle */}
            <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1 border border-hairline shrink-0 overflow-x-auto">
              {[
                { id: "all", label: "Wszystkie" },
                { id: "active", label: "W trasie" },
                { id: "depot", label: "W zajezdni" },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setStatusFilter(t.id as "all" | "active" | "depot")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    statusFilter === t.id
                      ? "bg-brand text-on-brand shadow-sm"
                      : "text-text-mute hover:text-text hover:bg-white/5"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Propulsion and Equipment Filters */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-hairline text-xs">
            <span className="text-[11px] font-semibold text-text-faint mr-1">Napęd i tabor:</span>
            {[
              { id: "all", label: "Wszystkie", icon: null },
              { id: "hydrogen", label: "H₂ Wodór", icon: <HydrogenGlyph /> },
              { id: "electric", label: "100% EV", icon: <ElectricGlyph /> },
              { id: "hybrid", label: "Hybryda", icon: <HybridGlyph /> },
              { id: "mega", label: "MEGA (18m)", icon: <MegaGlyph /> },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPropulsionFilter(p.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all ${
                  propulsionFilter === p.id
                    ? "bg-white/15 text-text font-bold border border-white/20 shadow-sm"
                    : "bg-surface-2 text-text-mute hover:text-text hover:bg-white/5 border border-hairline"
                }`}
              >
                {p.icon}
                <span>{p.label}</span>
              </button>
            ))}

            {/* Line Filter Row */}
            {stats && stats.activeLines.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5 overflow-x-auto max-w-full py-1">
                <span className="text-[11px] font-semibold text-text-faint shrink-0">Linia:</span>
                <button
                  type="button"
                  onClick={() => setLineFilter("all")}
                  className={`rounded-md px-2 py-0.5 text-xs font-bold transition-all shrink-0 ${
                    lineFilter === "all" ? "bg-blue-600 text-white" : "bg-surface-2 text-text-mute hover:text-text border border-hairline"
                  }`}
                >
                  Wszystkie
                </button>
                {stats.activeLines.map((ln) => (
                  <button
                    key={ln}
                    type="button"
                    onClick={() => setLineFilter(ln === lineFilter ? "all" : ln)}
                    className={`rounded-md px-2 py-0.5 text-xs font-bold transition-all shrink-0 ${
                      lineFilter === ln ? "bg-blue-600 text-white shadow-sm" : "bg-surface-2 text-text-mute hover:text-text border border-hairline"
                    }`}
                  >
                    {ln}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Vehicles Section & Grid */}
        <section>
          <div className="flex items-center justify-between mb-3.5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-text-faint">
              Flota i karty brygad ({vehicles.length})
            </h2>
            <span className="text-xs text-text-faint">Wybierz pojazd, aby otworzyć kartę drogową</span>
          </div>

          {vehicles.length === 0 ? (
            <div className="surface rounded-2xl p-12 text-center border border-hairline">
              <p className="text-base text-text-mute font-medium">Brak pojazdów spełniających wybrane filtry.</p>
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("all");
                  setPropulsionFilter("all");
                  setLineFilter("all");
                  setSearchQuery("");
                }}
                className="mt-3.5 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-on-brand hover:bg-brand-hi transition-colors"
              >
                Wyczyść wszystkie filtry
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4">
              {vehicles.map((veh) => (
                <VehicleCard
                  key={veh.sideNumber}
                  vehicle={veh}
                  onClick={() => handleSelectVehicle(veh.sideNumber)}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Vehicle Brigade Detail Modal */}
      {selectedSideNumber && (
        <VehicleDetailModal
          sideNumber={selectedSideNumber}
          data={selectedVehicleData?.vehicle}
          onClose={handleCloseVehicle}
          onShare={() => copyShareLink(selectedSideNumber)}
        />
      )}
    </div>
  );
}

/* ==========================================================================
   VEHICLE SUMMARY CARD (Optimized & Accessible)
   ========================================================================== */

const VehicleCard = memo(function VehicleCard({
  vehicle,
  onClick,
}: {
  vehicle: FleetSummaryItem;
  onClick: () => void;
}) {
  const isActive = vehicle.status === "active";

  return (
    <article
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`surface rounded-2xl p-4 border transition-all cursor-pointer text-left flex flex-col justify-between hover:border-white/20 hover:shadow-float active:scale-[0.99] ${
        isActive ? "border-hairline bg-surface" : "border-hairline/60 bg-surface/50 opacity-80 hover:opacity-100"
      }`}
    >
      <div>
        {/* Header row: Side number, Operator, Status */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-bold text-text tabular-nums tracking-tight">
              #{vehicle.sideNumber}
            </span>
            <OperatorBadge operator={vehicle.operator} />
            <span className="rounded bg-white/6 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-text-mute border border-hairline">
              {vehicle.brigadeId}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {isActive ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-good/15 px-2 py-0.5 text-[10px] font-bold text-good border border-good/20">
                <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-good" />
                W trasie
              </span>
            ) : (
              <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] font-medium text-text-faint border border-hairline">
                W zajezdni
              </span>
            )}
          </div>
        </div>

        {/* Model and features */}
        <div className="mt-2.5 flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-text truncate">{vehicle.model}</span>
          <PropulsionBadge fuelType={vehicle.fuelType} lengthCategory={vehicle.lengthCategory} />
        </div>

        {/* In-service vs Depot telemetry */}
        <div className="mt-3.5 pt-3 border-t border-hairline/60">
          {isActive ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="grid h-6 min-w-6 px-1.5 place-items-center rounded bg-blue-600 text-xs font-bold text-white shrink-0 shadow-sm">
                    {vehicle.lineName}
                  </span>
                  <span className="truncate text-sm font-semibold text-text">
                    &rarr; {vehicle.direction}
                  </span>
                </div>
                <DelayBadge delaySec={vehicle.delaySec} />
              </div>

              {vehicle.currentStopName && (
                <div className="text-xs text-text-mute truncate flex items-center gap-1.5">
                  <MapPinIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="truncate">{vehicle.currentStopName}</span>
                </div>
              )}

              {/* Course Progression */}
              {vehicle.progressPct != null && (
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between text-[10px] text-text-faint font-mono">
                    <span>Postęp kursu</span>
                    <span>{vehicle.progressPct}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(4, vehicle.progressPct)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-2 text-xs text-text-faint space-y-1">
              <p>Zajezdnia MZK Bielsko-Biała (ul. Długa 50)</p>
              <p className="text-[11px] text-text-mute">
                Zrealizowane kursy dzisiaj:{" "}
                <strong className="text-text font-semibold">{vehicle.coursesCountToday}</strong>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Footer trigger */}
      <div className="mt-4 pt-2.5 border-t border-hairline/40 flex items-center justify-between text-xs text-text-mute">
        <span>Kursy dzisiaj: <strong className="text-text font-semibold">{vehicle.coursesCountToday}</strong></span>
        <span className="text-primary hover:underline font-semibold flex items-center gap-1">
          Karta drogowa &rarr;
        </span>
      </div>
    </article>
  );
});

/* ==========================================================================
   VEHICLE DETAIL MODAL & DUTY DISPATCH TIMELINE
   ========================================================================== */

function VehicleDetailModal({
  sideNumber,
  data,
  onClose,
  onShare,
}: {
  sideNumber: string;
  data?: FleetVehicleDetail;
  onClose: () => void;
  onShare: () => void;
}) {
  const [expandedCourseId, setExpandedCourseId] = useState<string | null>(null);

  // Sort completed courses from newest to oldest
  const sortedTodayCourses = useMemo(() => {
    if (!data?.todayCourses) return [];
    return [...data.todayCourses].sort((a, b) => {
      const startA = a.startSecs ?? 0;
      const startB = b.startSecs ?? 0;
      if (startB !== startA) return startB - startA;
      const endA = a.endSecs ?? 0;
      const endB = b.endSecs ?? 0;
      if (endB !== endA) return endB - endA;
      return (b.startTime || "").localeCompare(a.startTime || "");
    });
  }, [data?.todayCourses]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleCourseExpand = (id: string) => {
    setExpandedCourseId((prev) => (prev === id ? null : id));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/75 backdrop-blur-sm animate-fade"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl border border-white/10 overflow-hidden animate-rise">
        {/* Modal Header */}
        <header className="p-4 sm:p-6 border-b border-hairline bg-surface-2 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-2xl sm:text-3xl font-bold text-text tabular-nums">
                #{sideNumber}
              </span>
              {data && <OperatorBadge operator={data.operator} />}
              {data && (
                <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-xs font-bold text-text border border-hairline">
                  {data.brigade.label}
                </span>
              )}
              {data?.status === "active" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-good/20 px-2.5 py-0.5 text-xs font-bold text-good border border-good/25">
                  <span className="h-2 w-2 rounded-full bg-good animate-pulse-dot" />
                  W TRASIE
                </span>
              ) : (
                <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-text-faint border border-hairline">
                  W ZAJEZDNI
                </span>
              )}
            </div>

            <h2 className="mt-1.5 text-sm sm:text-base font-semibold text-text truncate">
              {data?.model ?? `Pojazd #${sideNumber}`}
            </h2>
            <p className="text-xs text-text-mute">
              {data?.producer} &middot; Rocznik {data?.year ?? "—"} &middot; {data?.lengthCategory} &middot; Napęd: {data?.fuelType}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onShare}
              title="Kopiuj link do wozu"
              className="p-2 rounded-xl bg-white/6 hover:bg-white/10 text-text transition-colors border border-hairline"
              aria-label="Kopiuj link"
            >
              <ShareIcon />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-xl bg-white/6 hover:bg-white/10 text-text transition-colors border border-hairline"
              aria-label="Zamknij"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        {/* Modal Scrollable Body with custom scrollbar */}
        <div className="flex-1 overflow-y-auto kb-scroll p-4 sm:p-6 space-y-6">
          {!data ? (
            <div className="py-12 text-center text-text-mute">
              <span className="inline-block h-6 w-6 border-2 border-text-faint border-t-text rounded-full animate-spin mb-2" />
              <p className="text-xs font-medium">Wczytuję dane taborowe pojazdu…</p>
            </div>
          ) : (
            <>
              {/* SECTION: Live Telemetry & Predicted Next Course */}
              <div className="rounded-2xl bg-surface-2 p-4 sm:p-5 border border-white/10 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CompassIcon className="w-5 h-5 text-blue-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-text">
                      Lokalizacja i Predykcja Obiegu
                    </h3>
                  </div>
                  {data.currentCourse && (
                    <Link
                      href={`/?exec=mzk:${data.currentCourse.courseLoid}:${sideNumber}`}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 transition-colors inline-flex items-center gap-1.5 shadow-sm"
                    >
                      <MapIcon />
                      <span>Śledź na mapie na żywo</span>
                    </Link>
                  )}
                </div>

                {data.currentCourse ? (
                  <div className="space-y-4">
                    {/* Live Course Route Summary */}
                    <div className="surface rounded-xl p-3.5 border border-hairline space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="grid h-7 min-w-7 px-1.5 place-items-center rounded-lg bg-blue-600 font-bold text-sm text-white shadow-sm">
                            {data.currentCourse.lineName}
                          </span>
                          <span className="text-sm sm:text-base font-bold text-text truncate">
                            &rarr; {data.currentCourse.direction}
                          </span>
                        </div>
                        <DelayBadge delaySec={data.currentCourse.delaySec} />
                      </div>

                      {/* Stops progression */}
                      <div className="pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg bg-surface-3 p-2.5 border border-hairline">
                          <span className="text-[10px] text-text-faint uppercase font-bold tracking-wider">Obecny przystanek:</span>
                          <p className="font-semibold text-text truncate mt-0.5">
                            {data.currentCourse.currentStopName}
                          </p>
                        </div>
                        <div className="rounded-lg bg-surface-3 p-2.5 border border-hairline">
                          <span className="text-[10px] text-text-faint uppercase font-bold tracking-wider">Następny przystanek:</span>
                          <p className="font-semibold text-text truncate mt-0.5">
                            {data.currentCourse.nextStopName ?? "Koniec trasy"}
                          </p>
                        </div>
                      </div>

                      {/* Visual Route Progress */}
                      <div className="pt-1.5">
                        <div className="flex justify-between text-[11px] text-text-mute mb-1">
                          <span>
                            Odjazd: <strong>{data.currentCourse.startTime}</strong> ({data.currentCourse.firstStopName})
                          </span>
                          <span>
                            Przyjazd: <strong>{data.currentCourse.endTime}</strong> ({data.currentCourse.lastStopName})
                          </span>
                        </div>
                        <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-300"
                            style={{ width: `${Math.max(5, data.currentCourse.progressPct)}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Predicted Next Course */}
                    {data.predictedNextCourse && (
                      <div className="rounded-xl bg-surface-3 p-4 border border-hairline space-y-2">
                        <div className="flex items-center gap-2 text-blue-300 font-bold text-xs uppercase tracking-wider">
                          <CompassIcon className="w-4 h-4" />
                          <span>Przewidywany kolejny kurs (Gdzie pojedzie dalej)</span>
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="rounded bg-blue-600 px-2 py-0.5 font-bold text-xs text-white">
                                Linia {data.predictedNextCourse.lineName}
                              </span>
                              <span className="text-sm font-bold text-text">
                                &rarr; {data.predictedNextCourse.direction}
                              </span>
                            </div>
                            <p className="text-xs text-text-mute mt-1">
                              Odjazd z: <strong>{data.predictedNextCourse.fromStopName}</strong> o{" "}
                              <strong className="text-text font-mono text-sm">
                                {data.predictedNextCourse.departureTime}
                              </strong>{" "}
                              (przerwa wyrównawcza: ~{data.predictedNextCourse.pauseMinutes} min)
                            </p>
                          </div>

                          <div className="text-left sm:text-right shrink-0">
                            <span className="inline-block rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 border border-emerald-500/25">
                              {data.predictedNextCourse.probabilityLabel}
                            </span>
                            <p className="text-[10px] text-text-faint mt-0.5">
                              {data.predictedNextCourse.reason}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="surface rounded-xl p-4 text-xs text-text-mute space-y-2 border border-hairline">
                    <p className="text-sm font-semibold text-text">
                      {data.status === "depot"
                        ? "Pojazd przebywa w zajezdni MZK (ul. Długa 50) lub ma przerwę między zmianami."
                        : "Pojazd ma przerwę na pętli przed kolejnym kursem."}
                    </p>
                    <p className="text-text-faint">
                      {data.lastKnownLocation?.name ?? "Brak aktualnego kursu."}
                    </p>
                    <p className="text-xs text-text-mute">
                      Przewidywane ponowne wyjście na linię: w kolejnym planie brygadowym.
                    </p>
                  </div>
                )}
              </div>

              {/* SECTION: Daily Courses Timeline */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-text-faint">
                      Karta drogowa &middot; Kursy dzisiaj ({data.todayCourses.length + (data.currentCourse ? 1 : 0)})
                    </h3>
                    <span className="text-[10px] text-text-faint font-medium bg-surface-2 px-1.5 py-0.5 rounded border border-hairline">
                      od najnowszego
                    </span>
                  </div>
                  <span className="text-xs text-text-faint">
                    Przebieg: <strong className="text-text">{data.stats.estimatedKmToday} km</strong> &middot; Punktualność: <strong className="text-text">{data.stats.punctualityPct}%</strong>
                  </span>
                </div>

                <div className="space-y-2.5">
                  {/* Current Course (newest - in progress) */}
                  {data.currentCourse && (
                    <CourseItemRow
                      course={data.currentCourse}
                      isCurrent
                      expanded={expandedCourseId === data.currentCourse.id}
                      onToggle={() => toggleCourseExpand(data.currentCourse!.id)}
                    />
                  )}

                  {/* Completed Courses (sorted from newest to oldest) */}
                  {sortedTodayCourses.map((c) => (
                    <CourseItemRow
                      key={c.id}
                      course={c}
                      expanded={expandedCourseId === c.id}
                      onToggle={() => toggleCourseExpand(c.id)}
                    />
                  ))}
                </div>
              </div>

              {/* SECTION: Technical Equipment */}
              <div className="surface rounded-2xl p-4 border border-hairline space-y-3 text-xs">
                <h4 className="font-bold uppercase tracking-wider text-text-faint text-[11px]">
                  Specyfikacja techniczna i wyposażenie
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-text">
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-hairline flex items-center gap-2">
                    <span className="text-text-faint"><AcGlyph /></span>
                    <div>
                      <span className="text-[10px] text-text-faint block">Klimatyzacja</span>
                      <span className="font-semibold">{data.features.airCondition ? "Obecna" : "Brak"}</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-hairline flex items-center gap-2">
                    <span className="text-text-faint"><LowFloorGlyph /></span>
                    <div>
                      <span className="text-[10px] text-text-faint block">Niska podłoga</span>
                      <span className="font-semibold">{data.features.lowFloor ? "100% niska" : "Standard"}</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-hairline flex items-center gap-2">
                    <span className="text-text-faint"><TicketGlyph /></span>
                    <div>
                      <span className="text-[10px] text-text-faint block">Biletomat</span>
                      <span className="font-semibold">{data.features.ticketMachine ? "Płatność kartą" : "Brak"}</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-2.5 border border-hairline flex items-center gap-2">
                    <span className="text-text-faint"><BusIcon className="w-3.5 h-3.5" /></span>
                    <div>
                      <span className="text-[10px] text-text-faint block">Klasa taboru</span>
                      <span className="font-semibold">{data.lengthCategory}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   EXPANDABLE COURSE ITEM ROW
   ========================================================================== */

function CourseItemRow({
  course,
  isCurrent = false,
  expanded = false,
  onToggle,
}: {
  course: VehicleCourseRecord;
  isCurrent?: boolean;
  expanded?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`surface rounded-xl border transition-all overflow-hidden ${
        isCurrent
          ? "border-blue-500/50 bg-blue-950/20 shadow-md"
          : "border-hairline bg-surface hover:border-white/15"
      }`}
    >
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="p-3 sm:p-4 flex items-center justify-between gap-3 cursor-pointer select-none"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-xs sm:text-sm font-bold text-text tabular-nums shrink-0">
            {course.startTime} &ndash; {course.endTime}
          </span>
          <span className="grid h-6 min-w-6 px-1.5 place-items-center rounded bg-blue-600 text-xs font-bold text-white shrink-0">
            {course.lineName}
          </span>
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-semibold text-text truncate">
              {course.firstStopName} &rarr; {course.lastStopName}
            </p>
            <p className="text-[11px] text-text-mute truncate">
              {course.stopsCount} przystanków &middot; {Math.round(Math.max(15, (course.endSecs - course.startSecs) / 60))} min
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isCurrent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-good/20 px-2 py-0.5 text-[10px] font-bold text-good border border-good/25">
              <span className="h-1.5 w-1.5 rounded-full bg-good animate-pulse-dot" />
              W TRAKCIE
            </span>
          ) : (
            <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] font-medium text-text-faint border border-hairline">
              Zakończony
            </span>
          )}
          <DelayBadge delaySec={course.delaySec} />
          <div className="text-text-mute hover:text-text p-1">
            <ChevronDownIcon open={expanded} />
          </div>
        </div>
      </div>

      {/* Expandable stop-by-stop schedule table */}
      {expanded && course.stops && course.stops.length > 0 && (
        <div className="p-3 sm:p-4 bg-surface-2/60 border-t border-hairline space-y-1.5 animate-fade">
          <p className="text-[11px] font-bold uppercase tracking-wider text-text-faint mb-2">
            Przebieg trasy (przystanek po przystanku):
          </p>
          <div className="max-h-60 overflow-y-auto kb-scroll pr-1 space-y-1 text-xs">
            {course.stops.map((st, i) => {
              const isCourseDone = !isCurrent || course.status === "completed";
              const isPassed = isCourseDone || st.status === "passed";
              const isCur = !isCourseDone && st.status === "current";
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between py-1.5 px-2.5 rounded-lg ${
                    isCur
                      ? "bg-blue-600/20 font-bold text-white border border-blue-500/30"
                      : isPassed
                      ? "text-text-mute"
                      : "text-text"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[11px] text-text-faint w-5 text-right">{i + 1}.</span>
                    <span className="truncate">{st.name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] tabular-nums">
                    <span className="text-text-mute">{st.scheduledTime}</span>
                    {st.plannedTime && st.plannedTime !== st.scheduledTime && (
                      <span className="text-amber-400 font-semibold">{st.plannedTime}</span>
                    )}
                    {isPassed && <CheckIcon className="w-3.5 h-3.5 text-good" />}
                    {isCur && (
                      <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse-dot" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BrigadesApp() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh bg-bg text-text flex items-center justify-center">
          <div className="text-center space-y-3">
            <span className="inline-block h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            <p className="text-sm font-medium text-text-mute">Wczytywanie taboru i brygad…</p>
          </div>
        </div>
      }
    >
      <BrigadesAppContent />
    </Suspense>
  );
}
