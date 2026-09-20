import type { WireStop } from "./types";

export type FormattedStop = WireStop;

const CITY_PREFIX_REGEX =
  /^(?:BIELSKO-BIAŁA|BIELSKO BIAŁA|CZECHOWICE-DZIEDZICE|BYSTRA|WILKOWICE|KOZY|JASIENICA|JAWORZE|SZCZYRK|PORĄBKA|BESTWINA)\s+/i;

/**
 * Normalizes a stop name for fuzzy cross-operator matching:
 * - strips known city/municipality prefixes (KB stops include "BIELSKO-BIAŁA", MZK stops don't)
 * - normalizes station suffixes ("D.A.", "DWORZEC AUTOBUSOWY")
 * - strips punctuation and whitespace
 */
export function cleanStopName(name: string): string {
  let n = name.toUpperCase().trim();
  n = n.replace(CITY_PREFIX_REGEX, "");
  n = n.replace(/(?:^|\s+)(?:D\.A\.?|DWORZEC\s+AUTOBUSOWY)$/i, " DWORZEC");
  n = n.replace(/[^A-Z0-9ĄĆĘŁŃÓŚŹŻ]/gi, "");
  return n;
}

/** Planar distance approximation in meters between two coordinates. */
export function stopDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dlat = (lat2 - lat1) * 111139;
  const dlon =
    (lon2 - lon1) * 111139 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dlat, dlon);
}

/** Global lookup registry for finding merged stop pairings by any designator or id. */
const registryByDesignator = new Map<string, FormattedStop>();

export function registerMergedStops(stops: FormattedStop[]): void {
  registryByDesignator.clear();
  for (const s of stops) {
    if (s.designator) registryByDesignator.set(s.designator, s);
    if (s.id) registryByDesignator.set(s.id, s);
    if (s.kbDesignator) registryByDesignator.set(s.kbDesignator, s);
    if (s.mzkDesignator) registryByDesignator.set(s.mzkDesignator, s);
    if (s.kbId) registryByDesignator.set(s.kbId, s);
    if (s.mzkId) registryByDesignator.set(s.mzkId, s);
    if (s.mzkSymbol) {
      registryByDesignator.set(s.mzkSymbol, s);
      registryByDesignator.set(`mzk:${s.mzkSymbol}`, s);
    }
    if (s.symbol) {
      registryByDesignator.set(s.symbol, s);
      registryByDesignator.set(`mzk:${s.symbol}`, s);
    }
  }
}

export function getMergedStop(designatorOrId: string): FormattedStop | undefined {
  return registryByDesignator.get(designatorOrId);
}

/**
 * Merges KB stops and MZK stops that represent the same physical bus stop.
 * Matches based on geographic proximity (<= 40m) or name similarity + proximity (<= 120m).
 */
export function mergeStops(
  kbStops: FormattedStop[],
  mzkStops: FormattedStop[],
): FormattedStop[] {
  const matchedMzkSymbols = new Set<string>();
  const matchedKbIds = new Set<string>();

  const kbWithClean = kbStops.map((k) => ({
    stop: k,
    clean: cleanStopName(k.name),
  }));

  const mzkWithClean = mzkStops.map((m) => ({
    stop: m,
    clean: cleanStopName(m.name),
  }));

  const merged: FormattedStop[] = [];

  // Find best 1-to-1 matches for each MZK stop
  for (const { stop: m, clean: mClean } of mzkWithClean) {
    let bestKb: FormattedStop | null = null;
    let minDistance = Infinity;

    for (const { stop: k, clean: kClean } of kbWithClean) {
      if (matchedKbIds.has(k.id)) continue;
      const d = stopDistanceMeters(m.lat, m.lon, k.lat, k.lon);

      // Condition 1: Very close physical distance (<= 35m)
      // Condition 2: Close distance (<= 120m) AND matching normalized names
      const nameMatches =
        mClean.length > 2 &&
        kClean.length > 2 &&
        (mClean === kClean || mClean.includes(kClean) || kClean.includes(mClean));

      if (d <= 35 || (d <= 120 && nameMatches)) {
        if (d < minDistance) {
          minDistance = d;
          bestKb = k;
        }
      }
    }

    if (bestKb) {
      matchedKbIds.add(bestKb.id);
      if (m.symbol) matchedMzkSymbols.add(m.symbol);
      matchedMzkSymbols.add(m.id);

      // Combine directions if available
      const dirsSet = new Set<number>();
      for (const d of bestKb.dirs ?? []) dirsSet.add(d);
      for (const d of m.dirs ?? []) dirsSet.add(d);
      const dirs = dirsSet.size > 0 ? Array.from(dirsSet) : undefined;

      // Merged stop combining both KB and MZK identities
      const mergedStop: FormattedStop = {
        id: bestKb.id,
        designator: bestKb.designator,
        name: bestKb.name,
        lat: bestKb.lat,
        lon: bestKb.lon,
        operator: "BOTH",
        operators: ["KB", "MZK"],
        kbId: bestKb.id,
        mzkId: m.id,
        kbDesignator: bestKb.designator,
        mzkDesignator: m.designator,
        mzkSymbol: m.symbol,
        symbol: m.symbol,
        dirs,
        isStation: Boolean(bestKb.isStation || m.isStation),
        showPlatforms: bestKb.showPlatforms,
        onRequest: Boolean(bestKb.onRequest || m.onRequest),
        gettingOut: Boolean(bestKb.gettingOut || m.gettingOut),
      };
      merged.push(mergedStop);
    }
  }

  // Add unmatched KB stops
  for (const k of kbStops) {
    if (!matchedKbIds.has(k.id)) {
      merged.push({
        ...k,
        operator: "KB",
        operators: ["KB"],
        kbId: k.id,
        kbDesignator: k.designator,
      });
    }
  }

  // Add unmatched MZK stops
  for (const m of mzkStops) {
    const sym = m.symbol ?? m.id;
    if (!matchedMzkSymbols.has(sym) && !matchedMzkSymbols.has(m.id)) {
      merged.push({
        ...m,
        operator: "MZK",
        operators: ["MZK"],
        mzkId: m.id,
        mzkDesignator: m.designator,
        mzkSymbol: m.symbol,
      });
    }
  }

  registerMergedStops(merged);
  return merged;
}
