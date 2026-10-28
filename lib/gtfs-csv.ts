/**
 * Tiny CSV helpers shared by the GTFS-file readers (stop-directions, lines, router, gzm-feed).
 * The built feed is plain RFC-4180 with CRLF line endings.
 */

/** Minimal RFC-4180 line parser (handles quoted fields with embedded commas). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Column index by header name, or -1. */
export function col(header: string[], name: string): number {
  return header.indexOf(name);
}

/** Split on CR, LF or CRLF so a trailing '\r' never sticks to the last column
 *  (the built GTFS files are CRLF). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** stop_times pickup/drop-off bits, one byte per call (GZM trips; the router honours NO_PICKUP / NO_DROP_OFF) */
export const NO_PICKUP = 1;
export const NO_DROP_OFF = 2;
export const PICKUP_ON_REQUEST = 4;
export const DROP_OFF_ON_REQUEST = 8;

/** GTFS pickup_type / drop_off_type -> bits ("1" none, "2"/"3" on request). */
export function pickupFlags(pickup: string | undefined, drop: string | undefined): number {
  let f = 0;
  if (pickup === "1") f |= NO_PICKUP;
  else if (pickup === "2" || pickup === "3") f |= PICKUP_ON_REQUEST;
  if (drop === "1") f |= NO_DROP_OFF;
  else if (drop === "2" || drop === "3") f |= DROP_OFF_ON_REQUEST;
  return f;
}
