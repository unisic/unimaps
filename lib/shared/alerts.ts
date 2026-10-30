/**
 * "Powiadom mnie" rules shared by the page watcher (lib/client/alerts.ts) and the server's web push
 * (lib/push-alerts.ts): one decision, one message, so the two never disagree about a departure.
 */
import { minutesUntil, resolveTiming, rowKey, type TimingRow } from "@/lib/shared/departures";

export interface Alert {
  /** rowKey of the departure: stable across refetches (KB exec + visit, MZK course + order) */
  key: string;
  designator: string;
  stopName: string;
  line: string;
  dest: string;
  leadMin: number;
  /** epoch s after which the alert is dropped unfired (plan + 30 min) */
  until: number;
}

export const ALERT_LEADS = [3, 5, 10] as const;
/** per city: both cities share one stored list */
export const MAX_ALERTS = 3;

export type AlertAction = { act: "wait" | "cancelled" | "expired" } | { act: "fire"; mins: number };

/**
 * What one board refresh means for an alert. The ETA is the board's own (`resolveTiming` without a
 * vehicle). ponytail: StopView may refine an MZK row with the live bus's delay; the watchers skip
 * that, so one can fire up to that correction early or late.
 */
export function alertAction(a: Alert, rows: readonly TimingRow[], nowTs: number): AlertAction {
  if (nowTs > a.until) return { act: "expired" };
  const row = rows.find((r) => rowKey(r) === a.key);
  // not on the board (truncated, or gone): keep waiting until `until`
  if (!row) return { act: "wait" };
  const t = resolveTiming(row, null);
  if (t.canceled) return { act: "cancelled" };
  const mins = minutesUntil(t, nowTs);
  // set with less time left than the lead: fires on the first board, with the real minutes
  return mins <= a.leadMin ? { act: "fire", mins } : { act: "wait" };
}

/** The notification an action shows; null = nothing to show (waiting, expired). */
export function alertMessage(a: Alert, r: AlertAction): { title: string; body: string; tag: string; url: string } | null {
  if (r.act !== "fire" && r.act !== "cancelled") return null;
  const title = r.act === "fire" ? `${a.line} ${r.mins > 0 ? `za ${r.mins} min` : "odjeżdża"}` : `${a.line}: kurs odwołany`;
  return { title, body: `${a.dest}, przystanek ${a.stopName}`, tag: a.key, url: `/?stop=${encodeURIComponent(a.designator)}` };
}
