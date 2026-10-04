/**
 * Departure-board timing: ONE canonical ETA per row, used for BOTH the countdown
 * the rider reads and the order the rows are listed in.
 *
 * Isomorphic and pure (no DOM / Node imports, relative imports only — node:test
 * loads it directly). The route (server) uses it to normalise the two operators'
 * rows into absolute epoch seconds; StopView (client) uses it to refine the
 * server's estimate with the live vehicle delay, sort, filter and label.
 *
 * Why it exists — the two operators speak different "time dialects":
 *   KB  rows: RELATIVE strings ("8 min", "< 1 min" = floor of the exact remaining
 *             time to the planned/estimated departure; far-off departures are printed
 *             as a wall-clock "HH:MM" — live-confirmed: time = static_time = "04:05"
 *             for a departure 3 h 56 min away — see parseClockNear), `time: null`
 *             + `at_stop: true` while the bus stands at the stop (no static_time /
 *             time_diff then), and `time_diff` in WHOLE MINUTES, NOT seconds.
 *   MZK rows: absolute instants (scheduledDeparture / realDeparture, epoch ms)
 *             and, per vehicle, a delay in SECONDS from /api/vehicles.
 * The old route sorted on "HH:MM => seconds-of-day" / "N min => now + N min" while
 * the client displayed plan + vehicle delay, so the order and the numbers on
 * screen disagreed (midnight wrap, stop- vs vehicle-level estimate, unit slip,
 * `time: null` => sorted last). Everything here works in epoch seconds, so a
 * midnight (or DST) wrap cannot exist, and `compareBoardItems` ranks by the very
 * minute the countdown prints.
 */

export type Operator = "KB" | "MZK";

/** Wire fields the server adds to every row (epoch SECONDS, delays in SECONDS). */
export interface TimingFields {
  /** scheduled departure; null when it cannot be derived */
  plan_ts: number | null;
  /** the operator's own estimate for THIS stop visit; null when it has none */
  eta_ts: number | null;
  /** the operator's own delay for this stop visit (eta - plan); null when unknown */
  delay_sec: number | null;
}

/** What the timing logic reads off a wire row (superset of both operators' rows). */
export interface TimingRow extends Partial<TimingFields> {
  operator?: Operator;
  line_name?: string;
  symbol?: string;
  trip_execution_id?: string;
  trip_id?: number | string;
  /** KB: visit index on the trip; MZK: orderInCourse */
  trip_index?: number;
  /** server-built stable React key */
  row_key?: string;
  time?: string | null;
  static_time?: string | null;
  /** legacy: KB = MINUTES, MZK = seconds. Never read by the canonical logic. */
  time_diff?: number;
  is_estimated?: boolean;
  at_stop?: boolean;
  canceled?: boolean;
  /** MZK: the course has not begun — eta_ts is the earliest possible instant, never a measured delay */
  not_started?: boolean;
}

/**
 * KB prints whole minutes by FLOOR (static_time = floor((planned - now)/60), and
 * `time` is `to_go` = floor of an exact estimate: it ticks at arbitrary seconds,
 * unlike static_time which ticks on the wall-clock minute). The unbiased
 * estimate of "N min" is therefore N min + 30 s; we use +29 s so that
 * round((N*60 + 29)/60) === N — the countdown shows exactly the number KB
 * printed at fetch time and then ticks down once a minute from there.
 */
export const KB_REL_BIAS_SEC = 29;

/**
 * A row whose estimated departure is more than this many seconds in the past
 * is no longer an upcoming departure. 60 s > the 30 s refetch period, so a row
 * anchored at its fetch time can never blink out and back in between two
 * refetches.
 */
export const GONE_AFTER_SEC = 60;
/** …and the leash for a bus that is standing at the stop (see isGone). */
export const GONE_AFTER_AT_STOP_SEC = 300;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* ------------------------------------------------------------------ parsing */

/**
 * KB's relative strings → whole minutes. "5 min" → 5, "< 1 min" / "<1 min" → 0,
 * German "5 Min." → 5. Anything else ("23:12", "", null, "1 h 5 min") → null.
 */
export function parseRelMinutes(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (/^<\s*1\s*min/i.test(t)) return 0;
  const m = /^(\d{1,3})\s*min/i.exec(t);
  return m ? Number(m[1]) : null;
}

let wallFmt: Intl.DateTimeFormat | null = null;
function wallParts(ts: number): Record<string, string> {
  wallFmt ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of wallFmt.formatToParts(new Date(ts * 1000))) p[x.type] = x.value;
  return p;
}

/** Warsaw wall clock at `ts` (epoch s): minutes east of UTC and minute-of-day. */
function warsawWall(ts: number): { off: number; mod: number } {
  const p = wallParts(ts);
  const h = Number(p.hour) % 24;
  const mi = Number(p.minute);
  const wallMs = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, mi);
  return { off: Math.round((wallMs - Math.floor(ts / 60) * 60000) / 60000), mod: h * 60 + mi };
}

/**
 * A wall-clock "HH:MM" (Europe/Warsaw) → the epoch second of its nearest occurrence in
 * [anchor - 2 h, anchor + 22 h). KB prints far-off departures that way (the board only lists
 * the next ~4 h, so the window is unambiguous; seen live: `time` = `static_time` = "04:05" at 00:09) —
 * the poller's `rowDepartureSecs` parity port already treats "HH:MM" as absolute and "N min" as relative. DST-exact: wall-clock minutes are
 * not elapsed minutes across the 02:00/03:00 transitions, the offset difference corrects it.
 * Anything else → null.
 */
export function parseClockNear(s: unknown, anchorTs: number): number | null {
  if (typeof s !== "string") return null;
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const a = warsawWall(anchorTs);
  const delta = ((((h * 60 + mi - a.mod + 120) % 1440) + 1440) % 1440) - 120;
  const guess = Math.floor(anchorTs / 60) * 60 + delta * 60;
  return guess - (warsawWall(guess).off - a.off) * 60;
}

/* --------------------------------------------------- server-side normalising */

export interface RowFlags {
  at_stop: boolean;
  canceled: boolean;
}

/**
 * KB row → absolute timing. `anchorTs` = the moment upstream computed the
 * relative strings (its `timestamp`, else our receive time), epoch seconds.
 *  - at_stop (time === null): the bus is standing there → ETA = anchor.
 *  - delay_sec: `time_diff` is whole MINUTES upstream → ×60 (only when estimated).
 *  - plan_ts: the planned DEPARTURE (== trip.times[idx].departure_time): exact from an HH:MM
 *    static_time, derived from a relative one with N >= 1 (see below), else null.
 */
export function kbTiming(
  row: Pick<TimingRow, "time" | "static_time" | "time_diff" | "is_estimated" | "at_stop" | "canceled">,
  anchorTs: number,
): TimingFields & RowFlags {
  const atStop = row.at_stop === true;
  const relEta = atStop ? 0 : parseRelMinutes(row.time);
  // far-off departures are printed as a wall-clock "HH:MM" instead of "N min" (see parseClockNear)
  const eta_ts = atStop
    ? anchorTs
    : relEta != null
      ? anchorTs + relEta * 60 + KB_REL_BIAS_SEC
      : parseClockNear(row.time, anchorTs);
  // planned DEPARTURE: an HH:MM static_time is exact; a relative one is N = floor((plan - now)/60), so
  // plan = the next minute boundary at or after anchor + N min (verified: 194/194 captured rows, 146/147 in
  // the full scan, vs trip.times[idx].departure_time). N = 0 ("< 1 min") also saturates for a plan already
  // in the past (late bus), so it yields no plan.
  const nStatic = parseRelMinutes(row.static_time);
  const plan_ts =
    parseClockNear(row.static_time, anchorTs) ?? (nStatic != null && nStatic >= 1 ? Math.ceil((anchorTs + nStatic * 60) / 60) * 60 : null);
  const td = finite(row.time_diff);
  return {
    plan_ts,
    eta_ts,
    delay_sec: row.is_estimated === true && td != null ? Math.round(td * 60) : null,
    at_stop: atStop,
    canceled: row.canceled === true,
  };
}

/** The slice of an OnTime getRealtime departure the normaliser reads. */
export interface MzkDepLike {
  scheduledDeparture: number; // ms
  realDeparture: number; // ms
  lack: boolean;
  /** informational only — see mzkTiming */
  onStopPoint?: boolean;
}

/**
 * MZK getRealtime row → absolute timing. `lack` (no vehicle assigned) and a
 * missing realDeparture mean "scheduled only": eta_ts stays null and the client
 * falls back to plan_ts. `passed` is deliberately ignored: the flag flips right
 * around realDeparture (observed 23 s BEFORE it on one row, 15 s AFTER on
 * another) and the official MZK portal ignores it too — it removes a row by its
 * own clock rule, which is what `isGone` does here.
 */
export function mzkTiming(d: MzkDepLike): TimingFields & RowFlags {
  const planMs = finite(d.scheduledDeparture);
  const realMs = finite(d.realDeparture);
  const hasReal = !d.lack && realMs != null && realMs > 0;
  const plan_ts = planMs != null && planMs > 0 ? planMs / 1000 : null;
  const eta_ts = hasReal ? realMs / 1000 : null;
  return {
    plan_ts,
    eta_ts,
    delay_sec: plan_ts != null && eta_ts != null ? Math.round(eta_ts - plan_ts) : null,
    // NOT `d.onStopPoint`: OnTime sets it for a bus that merely WAITS at its first stop for its
    // scheduled departure (measured: 38 of 108 such rows were 2-10 min away). Only KB's `at_stop`
    // (time null) means "leaving now"; an MZK bus at its stop simply counts down ("teraz" at 0).
    at_stop: false,
    canceled: false,
  };
}

/** Destination of a KB row: upstream's top-level `directions` map is keyed by `direction_id`. */
export function pickDirection(
  row: { direction?: unknown; direction_id?: unknown },
  directions: unknown,
): string | undefined {
  if (typeof row.direction === "string" && row.direction) return row.direction;
  if (directions && typeof directions === "object" && row.direction_id != null) {
    const key = String(row.direction_id);
    if (Object.prototype.hasOwnProperty.call(directions, key)) {
      const v = (directions as Record<string, unknown>)[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return undefined;
}

/** Stable per-row key that survives refetches (no vehicle id: it appears once a bus is assigned). */
export function mzkRowKey(courseId: number | string, orderInCourse: number | null | undefined): string {
  return `mzk:${courseId}#${orderInCourse ?? ""}`;
}
export function kbRowKey(tripExecutionId: unknown, tripIndex: unknown): string {
  return `${tripExecutionId ?? ""}#${tripIndex ?? ""}`;
}

/**
 * The moment KB's relative strings refer to: the board's own `timestamp` (epoch s)
 * when it is plausible (clock-skew guard), else our receive time.
 */
export function kbAnchorTs(boardTimestamp: unknown, localTs: number): number {
  return typeof boardTimestamp === "number" && Number.isFinite(boardTimestamp) && Math.abs(boardTimestamp - localTs) < 120
    ? boardTimestamp
    : localTs;
}

/** Upstream KB row, loosely typed (only what the normaliser reads). */
export interface KbUpstreamRow {
  trip_execution_id?: string;
  trip_index?: number;
  time?: string | null;
  static_time?: string | null;
  time_diff?: number;
  is_estimated?: boolean;
  at_stop?: boolean;
  canceled?: boolean;
  direction?: string;
  direction_id?: number | string;
  [key: string]: unknown;
}

/**
 * One KB board row → wire row: absolute ETA/delay, resolved destination, stable
 * key. Everything upstream sent stays untouched (legacy fields included).
 */
export function enrichKbRow<R extends KbUpstreamRow>(row: R, directions: unknown, anchorTs: number) {
  const t = kbTiming(row, anchorTs);
  return {
    ...row,
    operator: "KB" as const,
    // rows only carry direction_id; the destination lives in the board's top-level `directions` map
    direction: pickDirection(row, directions),
    plan_ts: t.plan_ts,
    eta_ts: t.eta_ts,
    delay_sec: t.delay_sec,
    at_stop: t.at_stop,
    canceled: t.canceled,
    row_key: kbRowKey(row.trip_execution_id, row.trip_index),
  };
}

/** The fields the route adds to an MZK row (on top of its legacy HH:MM fields). */
export function mzkWireFields(d: MzkDepLike & { courseId: number | string; orderInCourse?: number | null }) {
  const t = mzkTiming(d);
  return {
    plan_ts: t.plan_ts,
    eta_ts: t.eta_ts,
    delay_sec: t.delay_sec,
    at_stop: t.at_stop,
    canceled: t.canceled,
    trip_index: d.orderInCourse ?? undefined,
    row_key: mzkRowKey(d.courseId, d.orderInCourse),
  };
}

/* ----------------------------------------------------- client-side resolving */

/** The only live-vehicle field the resolver needs (Vehicle.delay, SECONDS). */
export interface VehDelay {
  delay: number | null;
  /** MZK bus waiting for its departure: its delay is a placeholder (never a delay source) */
  not_started?: boolean;
}

export type TimingSource =
  /** MZK: scheduled + the live vehicle-level delay (4 s fresh) */
  | "vehicle"
  /** MZK: the operator's stop-level estimate (getRealtime realDeparture) */
  | "stop"
  /** KB: the board's own `time` (what the official KB site prints) */
  | "board"
  /** nothing live: scheduled time only */
  | "schedule"
  /** MZK: the course has not begun — earliest possible time, no delay */
  | "waiting"
  | "none";

export interface Timing {
  /** THE canonical expected departure, epoch seconds; null = unknown */
  etaTs: number | null;
  planTs: number | null;
  /** delay in SECONDS for the label (null = unknown) */
  delaySec: number | null;
  /** false → the figure is only the timetable ("rozkładowo") */
  estimated: boolean;
  atStop: boolean;
  canceled: boolean;
  source: TimingSource;
}

/**
 * The canonical ETA of one row. ASSUMPTION (issue 6 owns the "not departed yet"
 * delay semantics): an MZK row whose vehicle matches by exec id keeps being
 * refined with the vehicle's CURRENT delay — exactly what the list showed before
 * — falling back to the operator's stop-level estimate, then to the timetable.
 * Whatever issue 6 decides (e.g. ignoring the delay of a bus that has not left
 * its first stop) belongs in this one function: label and order follow it.
 * KB rows keep the board's own `time` (no override: row-level, same snapshot as
 * the number printed next to it); the vehicle delay only labels an at_stop row,
 * which carries no time_diff.
 */
export function resolveTiming(row: TimingRow, veh: VehDelay | null | undefined): Timing {
  const atStop = row.at_stop === true;
  const canceled = row.canceled === true;
  const planTs = finite(row.plan_ts);
  const rowEta = finite(row.eta_ts);
  const rowDelay = finite(row.delay_sec);
  const vehDelay = veh ? finite(veh.delay) : null;

  // a course that has not begun has NO delay from ANY source (vehicle, stop-level estimate, board):
  // OnTime's number is a placeholder equal to the time since the scheduled start
  if (!canceled && (row.not_started === true || veh?.not_started === true)) {
    const eta = rowEta ?? planTs;
    return { etaTs: eta, planTs, delaySec: null, estimated: false, atStop: false, canceled, source: "waiting" };
  }

  if (row.operator === "MZK" && !canceled && vehDelay != null && planTs != null) {
    return { etaTs: planTs + vehDelay, planTs, delaySec: vehDelay, estimated: true, atStop, canceled, source: "vehicle" };
  }
  if (rowEta != null) {
    const kb = row.operator === "KB";
    let delaySec = rowDelay;
    if (delaySec == null) {
      if (kb) delaySec = atStop ? vehDelay : null; // a KB eta/plan pair is not a delay (both are minute-rounded)
      else delaySec = planTs != null ? Math.round(rowEta - planTs) : null;
    }
    return {
      etaTs: rowEta,
      planTs,
      delaySec,
      estimated: kb ? row.is_estimated === true || atStop : true,
      atStop,
      canceled,
      source: kb ? "board" : "stop",
    };
  }
  if (planTs != null) {
    return { etaTs: planTs, planTs, delaySec: null, estimated: false, atStop, canceled, source: "schedule" };
  }
  return { etaTs: null, planTs: null, delaySec: null, estimated: false, atStop, canceled, source: "none" };
}

/** Whole minutes until departure exactly as the countdown prints them (≥ 0); Infinity when unknown. */
export function minutesUntil(t: Pick<Timing, "etaTs" | "atStop">, nowTs: number): number {
  if (t.atStop) return 0;
  if (t.etaTs == null) return Infinity;
  return Math.max(0, Math.round((t.etaTs - nowTs) / 60));
}

/**
 * True once the departure is over: hide the row. A bus that is physically
 * standing at the stop (at_stop) keeps its row much longer than a plain
 * estimate — it is still there — but not forever if refetches keep failing.
 */
export function isGone(t: Pick<Timing, "etaTs" | "atStop">, nowTs: number): boolean {
  if (t.etaTs == null) return false;
  return t.etaTs < nowTs - (t.atStop ? GONE_AFTER_AT_STOP_SEC : GONE_AFTER_SEC);
}

let clockFmt: Intl.DateTimeFormat | null = null;
/** "HH:MM" of an epoch instant on the agency's wall clock (Europe/Warsaw, 24 h). */
export function hhmm(epochSec: number): string {
  clockFmt ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = clockFmt.formatToParts(new Date(epochSec * 1000));
  const h = (parts.find((p) => p.type === "hour")?.value ?? "00").replace("24", "00");
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h.padStart(2, "0")}:${m}`;
}

/** Whole minutes of a delay as the label prints them: half away from zero, so ±30 s read as mirror images. */
export function delayMinutes(sec: number): number {
  return Math.sign(sec) * Math.round(Math.abs(sec) / 60);
}

/**
 * "HH:MM" of a row's ETA, rounded like the countdown and the delay label (`hhmm` alone truncates:
 * plan 18:40 + 150 s printed 18:42 next to "+3 min"). Counted from the plan when there is one, so
 * the printed plan + the printed delay is exactly the printed time.
 */
export function etaClock(t: Pick<Timing, "etaTs" | "planTs">): string {
  if (t.etaTs == null) return "";
  if (t.planTs == null) return hhmm(Math.round(t.etaTs / 60) * 60);
  return hhmm(t.planTs + delayMinutes(t.etaTs - t.planTs) * 60);
}

/**
 * The big text of a row. canceled → "odwołany"; standing at the stop → "odjeżdża"
 * (the official KB wording); timetable-only → the clock time; else the countdown
 * "teraz" / "N min" / (≥ 1 h) the clock time of the estimate. `fallback` is shown
 * when the ETA is unknown (the raw upstream string).
 */
export function etaLabel(t: Timing, nowTs: number, fallback = ""): string {
  if (t.canceled) return "odwołany";
  if (t.atStop) return "odjeżdża";
  if (t.etaTs == null) return fallback;
  if (t.source === "schedule") return etaClock(t);
  const mins = minutesUntil(t, nowTs); // THE minute the order is ranked by — one definition, no drift
  if (mins <= 0) return "teraz";
  if (mins < 60) return `${mins} min`;
  return etaClock(t);
}

/* ------------------------------------------------------------------ ordering */

export interface BoardItem<R extends TimingRow = TimingRow> {
  row: R;
  timing: Timing;
}

/** Stable React key of a row — identical across refetches while the departure exists. */
export function rowKey(row: TimingRow): string {
  if (row.row_key) return row.row_key;
  const base = row.trip_execution_id || (row.trip_id != null ? String(row.trip_id) : "");
  return `${base}#${row.trip_index ?? ""}#${row.static_time ?? ""}`;
}

const lineOf = (row: TimingRow) => String(row.line_name ?? row.symbol ?? "");

let lineCollator: Intl.Collator | null = null;
const compareLines = (a: string, b: string): number => {
  lineCollator ??= new Intl.Collator("pl", { numeric: true });
  return lineCollator.compare(a, b);
};

/**
 * Nearest departure first, "as the rider sees it":
 *   1. cancelled departures last,
 *   2. by the countdown MINUTE that is printed (unknown ETA last),
 *   3. inside a minute: a bus standing at the stop first, then by line number
 *      (natural order — the official MZK portal ranks by minute, then line name)
 *      — never by raw seconds, so GPS jitter cannot swap two rows that both read
 *      "5 min" on every poll,
 *   4. then planned time, then the row key (total order → deterministic).
 */
export function compareBoardItems(a: BoardItem, b: BoardItem, nowTs: number): number {
  if (a.timing.canceled !== b.timing.canceled) return a.timing.canceled ? 1 : -1;
  const ma = minutesUntil(a.timing, nowTs);
  const mb = minutesUntil(b.timing, nowTs);
  if (ma !== mb) return ma < mb ? -1 : 1;
  if (a.timing.atStop !== b.timing.atStop) return a.timing.atStop ? -1 : 1;
  const l = compareLines(lineOf(a.row), lineOf(b.row));
  if (l !== 0) return l;
  const pa = a.timing.planTs;
  const pb = b.timing.planTs;
  if (pa !== pb) {
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  }
  const ka = rowKey(a.row);
  const kb = rowKey(b.row);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Drop departed rows, then sort. Returns a new array. */
export function sortBoard<T extends BoardItem>(items: readonly T[], nowTs: number): T[] {
  return items.filter((it) => !isGone(it.timing, nowTs)).sort((a, b) => compareBoardItems(a, b, nowTs));
}

/**
 * Unique React keys for a rendered list: `rowKey`, with a `~n` suffix on the 2nd+
 * occurrence of the same key (a loop visiting one stop twice with equal indexes
 * would otherwise collide).
 */
export function uniqueKeys(rows: readonly TimingRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = rowKey(r);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n === 0 ? k : `${k}~${n}`;
  });
}

/**
 * Server-side pre-sort (best effort, no live vehicles known there): same order a
 * client without vehicle data would compute. Clients re-sort after enrichment.
 */
export function preSortRows<R extends TimingRow>(rows: readonly R[], nowTs: number): R[] {
  const items = rows.map((row) => ({ row, timing: resolveTiming(row, null) }));
  return items.sort((a, b) => compareBoardItems(a, b, nowTs)).map((it) => it.row);
}

/* -------------------------------------------- timetable around the board */

/**
 * Epoch second of the wall-clock time `secsOfDay` on `dateISO` ("YYYY-MM-DD") in
 * Europe/Warsaw: the timetable's seconds-of-day placed on the absolute time line
 * the board uses. ≥ 86400 rolls into the next day. null for a malformed date.
 */
export function warsawDayTs(dateISO: string, secsOfDay: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m || !Number.isFinite(secsOfDay)) return null;
  // the wall clock read as if it were UTC, then shifted by the Warsaw offset in force at that instant
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000 + secsOfDay;
  const first = naive - warsawWall(naive).off * 60;
  return naive - warsawWall(first).off * 60;
}

/** "YYYY-MM-DD" of an epoch instant on the agency's wall clock (Europe/Warsaw). */
export function warsawDateISO(epochSec: number): string {
  const p = wallParts(epochSec);
  return `${p.year}-${p.month}-${p.day}`;
}

/** A timetable departure placed on the absolute time line. */
export interface SchedDeparture {
  trip_id: number | string;
  operator?: Operator;
  planTs: number;
}

/** A static KB trip id repeats every day: a live row hides the timetable visit of the SAME day only. */
const SAME_VISIT_SEC = 12 * 3600;

/**
 * Trip identity shared by timetable rows, board rows and live vehicles: an MZK
 * course without its variant ("mzk:<course>"; the variant is not always known on
 * both sides), a KB static trip id as is.
 */
export function schedTripKey(tripId: number | string): string {
  const s = String(tripId);
  if (!s.startsWith("mzk:")) return s;
  const end = s.indexOf(":", 4);
  return end < 0 ? s : s.slice(0, end);
}

/** The timetable trip a live vehicle serves, as a `schedTripKey`; null = unknown (KB bus not yet seen on any board). */
export function vehicleTripKey(v: { operator?: Operator; trip_id?: string; sched_trip_id?: string }): string | null {
  if (v.operator === "MZK") return v.trip_id ? `mzk:${v.trip_id}` : null;
  return v.sched_trip_id || null;
}

/** The running bus of a timetable departure: its trip's visit nearest to now (the same id tomorrow is ~24 h away). */
export function schedVehicle<V>(s: SchedDeparture, byTrip: ReadonlyMap<string, V>, nowTs: number): V | null {
  if (Math.abs(s.planTs - nowTs) >= SAME_VISIT_SEC) return null;
  return byTrip.get(schedTripKey(s.trip_id)) ?? null;
}

/**
 * Timing of a timetable departure the board does not list but whose bus is on
 * the road: the plan + the vehicle's CURRENT delay (both operators). A course
 * that has not begun keeps its plan without a delay; no usable delay is the
 * timetable again.
 */
export function schedTiming(planTs: number, veh: VehDelay | null | undefined): Timing {
  const base = { planTs, atStop: false, canceled: false };
  if (veh?.not_started) return { ...base, etaTs: planTs, delaySec: null, estimated: false, source: "waiting" };
  const d = veh ? finite(veh.delay) : null;
  if (d == null) return { ...base, etaTs: planTs, delaySec: null, estimated: false, source: "schedule" };
  return { ...base, etaTs: planTs + d, delaySec: d, estimated: true, source: "vehicle" };
}

/**
 * The timetable departures the live board does not show, all ascending by plan:
 * - `earlier`: planned before `nowTs` and gone from the board;
 * - `gaps`: planned inside THAT operator's live window (each upstream cuts its
 *   board differently: MZK ~70 min, KB ~3 h) but missing from it. OnTime lists
 *   only courses with a tracked vehicle, so an MZK board has holes the timetable
 *   fills (KB boards list every planned course; measured 0 holes);
 * - `later`: planned at or after the end of that operator's live window, or from
 *   `nowTs` for an operator with no live row at all.
 * `liveEnd` is the last live row's time (null without live rows).
 */
export function boardExtension<S extends SchedDeparture>(
  sched: readonly S[],
  live: readonly TimingRow[],
  nowTs: number,
): { earlier: S[]; gaps: S[]; later: S[]; liveEnd: number | null } {
  const liveAt = new Map<string, number[]>();
  const windowEnd = new Map<string, number>();
  let liveEnd: number | null = null;
  for (const r of live) {
    const t = finite(r.plan_ts) ?? finite(r.eta_ts) ?? nowTs;
    if (r.trip_id != null) {
      const k = schedTripKey(r.trip_id);
      const list = liveAt.get(k);
      if (list) list.push(t);
      else liveAt.set(k, [t]);
    }
    const op = r.operator ?? "";
    windowEnd.set(op, Math.max(windowEnd.get(op) ?? t, t));
    liveEnd = Math.max(liveEnd ?? t, t);
  }
  const earlier: S[] = [];
  const gaps: S[] = [];
  const later: S[] = [];
  for (const s of sched) {
    const seen = liveAt.get(schedTripKey(s.trip_id));
    if (seen?.some((t) => Math.abs(t - s.planTs) < SAME_VISIT_SEC)) continue;
    if (s.planTs < nowTs) earlier.push(s);
    else if (s.planTs >= Math.max(nowTs, windowEnd.get(s.operator ?? "") ?? nowTs)) later.push(s);
    else gaps.push(s);
  }
  const byPlan = (a: S, b: S) => a.planTs - b.planTs;
  return { earlier: earlier.sort(byPlan), gaps: gaps.sort(byPlan), later: later.sort(byPlan), liveEnd };
}

/** The board shows timetable departures by itself up to an hour ahead (or to its last live row)... */
export const AUTO_AHEAD_SEC = 3600;
/** ...and further until it holds this many upcoming departures. */
export const AUTO_MIN_ROWS = 6;

/**
 * End (inclusive) of the `later` departures (ascending) the board shows without a
 * tap: everything planned up to `floorTs`, then more until `shown` (rows already
 * on the board) + the added ones reach `minRows`. null = none to add.
 */
export function autoLaterHorizon(
  later: readonly SchedDeparture[],
  shown: number,
  floorTs: number,
  minRows = AUTO_MIN_ROWS,
): number | null {
  let at: number | null = null;
  let n = shown;
  for (const s of later) {
    if (s.planTs > floorTs && n >= minRows) break;
    at = s.planTs;
    n += 1;
  }
  return at;
}

/** Horizon that reveals the next `step` of `later` (ascending) beyond `until`; null when none is left. */
export function nextLaterHorizon(later: readonly SchedDeparture[], until: number | null, step: number): number | null {
  const rest = until == null ? later : later.filter((s) => s.planTs > until);
  return rest.length ? rest[Math.min(step, rest.length) - 1].planTs : null;
}

/** Horizon that reveals the `step` departures of `earlier` (ascending) just before `from`; null when none is left. */
export function nextEarlierHorizon(earlier: readonly SchedDeparture[], from: number | null, step: number): number | null {
  const rest = from == null ? earlier : earlier.filter((s) => s.planTs < from);
  return rest.length ? rest[Math.max(0, rest.length - step)].planTs : null;
}
