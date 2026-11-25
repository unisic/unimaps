import type { City } from "@/lib/client/city";
import type { StatusBody } from "@/lib/shared/status";

/* the sources a rider's map depends on; SDIP only refines GZM positions zbiorkom already gives */
const PRIMARY = new Set(["KB", "MZK", "zbiorkom"]);

/** The notice for the page's city when its live data is down on the source's side (`blame: "upstream"`), else
 *  null. An outage of ours is the team's to fix, not the rider's to read about. */
export function outageText(body: StatusBody, city: City, agency: string): string | null {
  const down = body.cities
    .find((c) => c.city === city)
    ?.sources.filter((s) => s.state === "down" && s.blame === "upstream" && PRIMARY.has(s.name));
  if (!down?.length) return null;
  return city === "bb"
    ? `${down.map((s) => s.name).join(" i ")}: brak danych na żywo, awaria po stronie przewoźnika.`
    : `${agency}: brak danych na żywo, awaria po stronie źródła danych.`;
}
