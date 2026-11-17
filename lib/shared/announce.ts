import { gzmStopKey } from "./gzm-stop-key";

/** The file key of a stop's recorded announcement (`/api/announce/s-<key>`): the name without its post number,
 *  folded to [a-z0-9]. Isomorphic: the page asks by it, scripts/import-announcements.ts names the files by it. */
export function announceKey(name: string): string {
  return gzmStopKey(name)
    .normalize("NFC")
    .replace(/[łŁ]/g, "l") // ł has no decomposition, NFKD leaves it
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 94);
}

/** The trip.times indexes already announced: "Następny przystanek" + name (`next`), the name repeated (`name`);
 *  -1 = none (the switch was just turned on). */
export interface Announced {
  next: number;
  name: number;
}

/** What to say about `vti` (the stop served while `atStop`, else the one approached) now: "next" once the vehicle
 *  has left the previous stop, then "name" (the repeat) once it is `near` (within the radius) or at it. Each once
 *  per stop and never one behind the last, so a fix jittering across the radius stays silent; null = nothing. */
export function stopToAnnounce(done: Announced, vti: number, atStop: boolean, near: boolean): "next" | "name" | null {
  if (!atStop && vti > done.next) return "next";
  return (atStop || near) && vti > done.name ? "name" : null;
}
