import type { Stop, TripTime, TripView, Vehicle } from "./types";

/**
 * TWO STOP ID SPACES (upstream quirk — crossed on purpose): a trip time's
 * `designator` is the stop's numeric `Stop.id`, and its `place_id` is the
 * stop's URL `Stop.designator`. Never compare them any other way.
 */
export function tripTimeMatchesStop(
  t: Pick<TripTime, "designator" | "place_id">,
  stop: Pick<Stop, "id" | "designator"> & {
    kbId?: string;
    mzkId?: string;
    kbDesignator?: string;
    mzkDesignator?: string;
    symbol?: string;
    mzkSymbol?: string;
    mzkSymbols?: string[];
  },
): boolean {
  if (t.designator != null) {
    const d = String(t.designator);
    if (
      d === String(stop.id) ||
      (stop.kbId && d === String(stop.kbId)) ||
      (stop.mzkId && d === String(stop.mzkId))
    ) {
      return true;
    }
  }
  if (t.place_id) {
    if (
      t.place_id === stop.designator ||
      (stop.kbDesignator && t.place_id === stop.kbDesignator) ||
      (stop.mzkDesignator && t.place_id === stop.mzkDesignator) ||
      (stop.mzkSymbol && t.place_id === `mzk:${stop.mzkSymbol}`) ||
      (stop.mzkSymbol && t.place_id === stop.mzkSymbol) ||
      (stop.symbol && t.place_id === `mzk:${stop.symbol}`) ||
      (stop.symbol && t.place_id === stop.symbol) ||
      (stop.mzkSymbols?.some((sym) => t.place_id === `mzk:${sym}` || t.place_id === sym) ?? false)
    ) {
      return true;
    }
  }
  return false;
}

/** Komunikacja Beskidzka constant brand red. */
export const BRAND = "#dc2626";
export const BRAND_KB = "#dc2626";
export const ACCENT = "#ee7583";
export const COLOR_AT_STOP = "#34a370";
export const COLOR_LATE = "#e58f2a";
export const COLOR_EARLY = "#a86fdd";

/** MZK Bielsko-Biała characteristic brand blue (high-contrast against KB red). */
export const BRAND_MZK = "#2563eb";
export const ACCENT_MZK = "#3b82f6";

/** Check if a line or operator belongs to MZK Bielsko-Biała. */
export function isMzk(operator?: string | null, line?: string | null): boolean {
  if (operator === "MZK") return true;
  if (operator === "KB") return false;
  if (!line || line === "…") return false;
  const s = String(line).trim();
  // KB lines: 100-140
  if (
    s.startsWith("10") ||
    s.startsWith("11") ||
    s.startsWith("12") ||
    s.startsWith("13") ||
    s.startsWith("14")
  ) {
    return false;
  }
  // MZK lines: 1-57, N1, N2, P1, P2
  return s.length <= 2 || s.startsWith("N") || s.startsWith("P");
}

/** Constant brand color: red for KB, characteristic blue for MZK. */
export function operatorColor(operator?: string | null, line?: string | null): string {
  return isMzk(operator, line) ? BRAND_MZK : BRAND_KB;
}

/** Deterministic per-line color: h = (h*31 + charCode) % 360, s 58%, l 46%. */
export function hslColor(s: string | null | undefined): string {
  if (!s) return BRAND;
  const str = String(s);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h},58%,46%)`;
}

/** Vehicle marker color: constant operator color (KB red, MZK characteristic blue). */
export function vehColor(v: Pick<Vehicle, "at_stop" | "delay" | "line"> & { operator?: string }): string {
  return operatorColor(v.operator, v.line);
}

export function secsFromHHMM(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const p = hhmm.split(":").map(Number);
  if (p.length < 2 || p.some((n) => Number.isNaN(n))) return null;
  return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
}

export function hhmmFromSecs(s: number | null | undefined): string {
  if (s == null) return "";
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const AGENCY_TZ = "Europe/Warsaw";
let timeFmt: Intl.DateTimeFormat | null = null;
let dateFmt: Intl.DateTimeFormat | null = null;

/** Seconds since midnight in Europe/Warsaw — all schedule strings are agency
 *  wall-clock, so the device-local clock must not leak into the math. */
export function nowSecs(): number {
  try {
    timeFmt ??= new Intl.DateTimeFormat("en-GB", {
      timeZone: AGENCY_TZ,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = timeFmt.formatToParts(new Date());
    let h = 0;
    let m = 0;
    let s = 0;
    for (const p of parts) {
      if (p.type === "hour") h = Number(p.value) % 24;
      else if (p.type === "minute") m = Number(p.value);
      else if (p.type === "second") s = Number(p.value);
    }
    return h * 3600 + m * 60 + s;
  } catch {
    const n = new Date();
    return n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds();
  }
}

/** "o czasie" / "+X min" / "-X min" */
export function delayTxt(td: number | null | undefined): string {
  if (td == null) return "";
  // round the magnitude symmetrically so ±30 s render as mirror images
  // (plain Math.round rounds -0.5 to 0, making a 30 s-early bus read "o czasie")
  const m = Math.sign(td) * Math.round(Math.abs(td) / 60);
  if (m === 0) return "o czasie";
  return (m > 0 ? "+" : "") + m + " min";
}

/** Tailwind text-color class for a delay in seconds. */
export function delayClass(td: number | null | undefined): string {
  if (td == null) return "text-text-mute";
  if (td > 60) return "text-late";
  if (td < -60) return "text-early";
  return "text-good";
}

/** Countdown label for a departure at `secs` (seconds since midnight). */
export function countdown(secs: number | null, now: number): string {
  if (secs == null) return "";
  let delta = secs - now;
  // a departure upstream lists as 00:xx while `now` is still before midnight is
  // next-day, not ~24 h in the past — roll a large negative delta forward a day
  if (delta < -43200) delta += 86400;
  const mins = Math.round(delta / 60);
  if (mins <= 0) return "teraz";
  if (mins < 60) return `${mins} min`;
  return hhmmFromSecs(secs);
}

/**
 * Upstream stop names arrive ALL-CAPS ("BIELSKO-BIAŁA D.A.") — render them in
 * title case ("Bielsko-Biała D.A."). Display-only: search/matching runs on the
 * raw names. Kept uppercase: dotted abbreviations (D.A. — single letters),
 * vowelless acronyms (ZML, PKP) and roman numerals (II, IV).
 */
export function displayStopName(raw: string): string {
  if (!raw) return raw;
  return raw.toLocaleLowerCase("pl-PL").replace(/\p{L}+/gu, (w) => {
    if (w.length === 1) return w.toLocaleUpperCase("pl-PL"); // "d.a." → "D.A."
    if (!/[aeiouyąęó]/.test(w)) return w.toLocaleUpperCase("pl-PL"); // ZML, PKP
    if (w.length <= 4 && /^[ixv]+$/.test(w)) return w.toLocaleUpperCase("pl-PL"); // II, IV
    return w.charAt(0).toLocaleUpperCase("pl-PL") + w.slice(1);
  });
}

/** Polish plural of "wóz": 1 wóz, 2–4 wozy, 5+ wozów (22 wozy, 12 wozów…). */
export function wozPlural(n: number): string {
  if (n === 1) return "wóz";
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? "wozy" : "wozów";
}

/** Diacritics-insensitive lowercase (handles Polish ł which NFD misses). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function formatScan(lastScan: number | null | undefined, scanCount: number | null | undefined): string {
  if (!lastScan) return "—";
  const t = new Date(lastScan * 1000).toLocaleTimeString("pl-PL", {
    timeZone: AGENCY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return scanCount ? `${t} (#${scanCount})` : t;
}

/** Today's date (YYYY-MM-DD) in Europe/Warsaw — not the device timezone. */
export function todayISO(): string {
  try {
    dateFmt ??= new Intl.DateTimeFormat("en-CA", {
      timeZone: AGENCY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dateFmt.format(new Date());
  } catch {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
}

/**
 * Formats a loop / spur stop name in Polish accusative after "przez",
 * e.g. "Szczyrk Biła" -> "Szczyrk Biłą", "Pętla" -> "Pętlę", "Górka" -> "Górkę".
 */
export function formatPrzezLoop(name: string): string {
  if (!name) return "";
  if (/\bBiła\b/i.test(name)) {
    return name.replace(/\bBiła\b/gi, "Biłą");
  }
  if (/\bPętla\b/i.test(name)) {
    return name.replace(/\bPętla\b/gi, "Pętlę");
  }
  if (/\bGórka\b/i.test(name)) {
    return name.replace(/\bGórka\b/gi, "Górkę");
  }
  return name;
}

/**
 * Detects out-and-back spurs / loops (wjazdy kieszeniowe / pętle), such as
 * line 120's branch to SZCZYRK BIŁA.
 * Identifies the apex / turnaround destination stop of the spur.
 */
export function detectLoopStops(times: Array<{ stop_name: string }>): string[] {
  const n = times.length;
  if (n < 4) return [];
  const first = times[0]?.stop_name;
  const last = times[n - 1]?.stop_name;
  if (first && last && first === last) return [];

  // Count visits to each stop name between terminus stops
  const counts = new Map<string, number>();
  for (let i = 1; i < n - 1; i++) {
    const nm = times[i].stop_name;
    if (nm) counts.set(nm, (counts.get(nm) ?? 0) + 1);
  }

  // Find all indices of doubled stops in mid-route
  const doubledIndices: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const nm = times[i].stop_name;
    if (nm && (counts.get(nm) ?? 0) >= 2) {
      doubledIndices.push(i);
    }
  }

  if (doubledIndices.length === 0) return [];
  const minIdx = doubledIndices[0];
  const maxIdx = doubledIndices[doubledIndices.length - 1];

  // A genuine spur doubles a localized stretch (span <= 14 stops)
  if (maxIdx - minIdx > 14) return [];

  const spurSlice = times.slice(minIdx, maxIdx + 1);
  const spurNames = spurSlice.map((s) => s.stop_name);

  // The apex stops are those visited only ONCE at the turnaround point of the spur
  const spurCounts = new Map<string, number>();
  for (const nm of spurNames) {
    spurCounts.set(nm, (spurCounts.get(nm) ?? 0) + 1);
  }

  const apexStops = spurNames.filter((nm) => spurCounts.get(nm) === 1);
  if (apexStops.length > 0) {
    // Prefer prominent loop designations like "BIŁA" or "PĘTLA"
    const priority = apexStops.find((nm) => /\b(BIŁA|PĘTLA|GÓRKA)\b/i.test(nm));
    if (priority) return [priority];
    return [apexStops[0]];
  }

  // If even the turnaround stop was doubled, pick the center stop of the spur
  const centerIdx = Math.floor(spurSlice.length / 2);
  return [spurSlice[centerIdx].stop_name];
}

/**
 * Trip-header banner for a bus that has not begun its course (it waits at the
 * first stop). Replaces the delay/ETA line: OnTime has no measurement yet, so
 * neither "+N min" nor a per-stop estimate may be shown.
 */
export function notStartedEta(trip: Pick<TripView, "stop" | "rawTimes">, now: number): string {
  const first = trip.rawTimes[0];
  if (!first) return "Pojazd jeszcze nie wyruszył";
  let eta = `Pojazd jeszcze nie wyruszył · odjazd z ${displayStopName(first.stop_name)} wg rozkładu ${first.departure_time}`;
  // the stop the trip was opened from: the earliest possible arrival (the schedule pushed back
  // by however long the bus already overstayed its first departure) — a lower bound, not a forecast
  const stop = trip.stop;
  const st = stop ? trip.rawTimes.find((t, i) => i > 0 && tripTimeMatchesStop(t, stop)) : undefined;
  const sched0 = secsFromHHMM(first.departure_time);
  const schedI = st ? secsFromHHMM(st.departure_time) : null;
  if (stop && st && sched0 != null && schedI != null) {
    let overstay = now - sched0;
    if (overstay > 43200) overstay -= 86400; // first departure is "tomorrow" (post-midnight) while now is before midnight
    else if (overstay < -43200) overstay += 86400;
    eta += ` · na ${stop.name}: najwcześniej ${hhmmFromSecs(schedI + Math.max(0, overstay))}`;
  }
  return eta;
}

/** ETA line for the trip header. */
export function computeEta(
  trip: TripView,
  now: number,
  liveVti?: number | null,
  isAtStop?: boolean,
  liveDelay?: number | null,
): string {
  const { stop, rawTimes, isLive } = trip;
  const vti = liveVti ?? trip.vti;
  let eta = "";
  if (stop) {
    const matches = (t: TripTime) => tripTimeMatchesStop(t, stop);
    // out-and-back spurs visit a stop twice — on a live trip prefer the visit
    // the vehicle has not passed yet, falling back to the plain first match
    const st =
      (isLive && vti != null ? rawTimes.find((t, i) => i >= vti && matches(t)) : undefined) ??
      rawTimes.find(matches);
    if (st) {
      const planned = secsFromHHMM(st.departure_time);
      const est = st.estimate?.time_diff ?? (isLive ? (liveDelay ?? null) : null);
      if (planned != null) {
        const arr = planned + (est ?? 0);
        let delta = arr - now;
        if (delta < -43200) delta += 86400; // post-midnight arrival viewed before midnight
        const mins = Math.round(delta / 60);
        eta = isLive
          ? `na ${stop.name}: ${hhmmFromSecs(arr)}${est != null ? ` (${delayTxt(est)})` : ""}`
          : `planowany przyjazd ${st.departure_time}`;
        if (isLive && mins >= 0) eta += ` · za ${mins} min`;
      }
    }
  }
  if (!eta && isLive && vti != null && rawTimes[vti]) {
    const target = rawTimes[vti];
    eta = isAtStop === false ? `następny: ${target.stop_name}` : `pojazd na: ${target.stop_name}`;
  }
  return eta;
}

/**
 * Checks if a stop is a bus station (dworzec autobusowy), where bays/stands
 * ("stanowiska") are used. Normal bus stops do not use platforms or stands.
 */
export function isBusStation(
  name: string,
  stop?: { isStation?: boolean; showPlatforms?: boolean } | null,
): boolean {
  if (stop?.showPlatforms) return true;
  return /(?:^|[\s(])(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)(?:$|[\s)])/i.test(name);
}

/**
 * Returns "stanowisko X" for bus stations, or an empty string for regular bus stops
 * where platform/stand numbers are not applicable.
 */
export function formatPlatform(
  platform: string | number | null | undefined,
  isStation: boolean,
): string {
  if (!platform || !isStation) return "";
  return `stanowisko ${platform}`;
}

/** Polish pluralization for bus stops: 1 przystanek, 2..4 przystanki, 5+ przystanków. */
export function przystanekPlural(n: number): string {
  const abs = Math.abs(n);
  if (abs === 1) return "przystanek";
  const tens = abs % 100;
  const ones = abs % 10;
  if (tens >= 11 && tens <= 14) return "przystanków";
  if (ones >= 2 && ones <= 4) return "przystanki";
  return "przystanków";
}

/** "HH:MM" in Europe/Warsaw agency timezone — guaranteed 24-hour format (00:00 to 23:59). */
export function nowHHMM(): string {
  const s = nowSecs();
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Adds minutes to a 24-hour "HH:MM" string, wrapping around 24 hours. */
export function addMinutesToHHMM(hhmm: string, deltaMins: number): string {
  const parts = hhmm.split(":").map(Number);
  const curH = parts[0] || 0;
  const curM = parts[1] || 0;
  const totalMins = ((curH * 60 + curM + deltaMins) % 1440 + 1440) % 1440;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Offset an ISO date "YYYY-MM-DD" by `days` days. */
export function offsetDateISO(dateISO: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) return dateISO;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

let dayLabelFmt: Intl.DateTimeFormat | null = null;
let dayFullFmt: Intl.DateTimeFormat | null = null;

/**
 * Returns human-friendly Polish day label for an ISO date:
 * "Dziś", "Jutro", "Pojutrze", or "Wt., 15 wrz".
 */
export function formatDayLabel(dateISO: string, referenceTodayISO?: string): string {
  const today = referenceTodayISO ?? todayISO();
  if (dateISO === today) return "Dziś";
  if (dateISO === offsetDateISO(today, 1)) return "Jutro";
  if (dateISO === offsetDateISO(today, 2)) return "Pojutrze";

  try {
    const [y, mo, da] = dateISO.split("-").map(Number);
    const d = new Date(Date.UTC(y, mo - 1, da, 12, 0, 0));
    dayLabelFmt ??= new Intl.DateTimeFormat("pl-PL", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "Europe/Warsaw",
    });
    const str = dayLabelFmt.format(d);
    return str.charAt(0).toUpperCase() + str.slice(1);
  } catch {
    return dateISO;
  }
}

/** Full Polish date description, e.g. "wtorek, 15 września". */
export function formatDayFull(dateISO: string): string {
  try {
    const [y, mo, da] = dateISO.split("-").map(Number);
    const d = new Date(Date.UTC(y, mo - 1, da, 12, 0, 0));
    dayFullFmt ??= new Intl.DateTimeFormat("pl-PL", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/Warsaw",
    });
    return dayFullFmt.format(d);
  } catch {
    return dateISO;
  }
}
