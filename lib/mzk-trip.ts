/**
 * Resolution of MZK trips, courses, and high-precision route shapes.
 */
import { getMzkApi, getMzkPoller } from "./poller-singleton";

const variantShapeCache = new Map<number, [number, number][]>();

export async function getVariantShape(variantId: number): Promise<[number, number][] | null> {
  if (variantShapeCache.has(variantId)) {
    return variantShapeCache.get(variantId)!;
  }
  try {
    const api = getMzkApi();
    const tc = (await api.fetchTheoreticalCourse(variantId)) as {
      segments?: Array<{
        nodes?: Array<{
          latitude: number;
          longitude: number;
        }>;
      }>;
    };
    if (tc?.segments?.length) {
      const shape: [number, number][] = [];
      for (const seg of tc.segments) {
        if (seg.nodes) {
          for (const node of seg.nodes) {
            if (Number.isFinite(node.latitude) && Number.isFinite(node.longitude)) {
              shape.push([node.latitude, node.longitude]);
            }
          }
        }
      }
      if (shape.length >= 2) {
        variantShapeCache.set(variantId, shape);
        return shape;
      }
    }
  } catch {
    /* fallback to OSRM */
  }
  return null;
}

function formatHHMM(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-GB", {
    timeZone: "Europe/Warsaw",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function resolveMzkTrip(identifier: string): Promise<Record<string, unknown> | null> {
  const cleanId = String(identifier).replace(/^mzk:/, "");
  const parts = cleanId.split(":");
  const courseIdStr = parts[0];
  const cid = parseInt(courseIdStr, 10);
  let vehicleId = parts.length > 1 ? parts[1] : undefined;
  let explicitVariantId: number | undefined;

  const mzkPoller = getMzkPoller();
  if (vehicleId && !mzkPoller.staticVehicles.has(vehicleId) && parseInt(vehicleId, 10) > 1000) {
    explicitVariantId = parseInt(vehicleId, 10);
    vehicleId = parts[2];
  }

  const cached =
    (vehicleId ? mzkPoller.runningVehiclesMap.get(`mzk:${courseIdStr}:${vehicleId}`) : null) ||
    mzkPoller.runningVehiclesMap.get(courseIdStr) ||
    mzkPoller.runningVehiclesMap.get(identifier);

  if (cached && cached.stopPoints?.length) {
    const times = cached.stopPoints.map((sp, idx) => {
      const schedMs = sp.scheduledDeparture || Date.now();
      const plannedMs = sp.plannedDeparture || schedMs;
      const diff = Math.round((plannedMs - schedMs) / 1000);
      return {
        stop_name: sp.name,
        designator: null,
        place_id: `mzk:${sp.symbol}`,
        departure_time: formatHHMM(schedMs),
        index: idx,
        platform: null,
        estimate: { time_diff: diff },
      };
    });

    let shape: [number, number][] | null = null;
    if (cached.variantLoid) {
      shape = await getVariantShape(cached.variantLoid);
    }

    const pos =
      (cached.vehicleId ? mzkPoller.positions.get(`mzk:${cached.courseLoid}:${cached.vehicleId}`) : null) ||
      (cached.vehicleId ? mzkPoller.lastPositionsByVehicle.get(cached.vehicleId) : null) ||
      mzkPoller.positions.get(identifier);

    return {
      trip: {
        times,
        direction: cached.direction || cached.optionalDirection || "",
        line: { name: cached.lineName },
        lineName: cached.lineName,
        operator: "MZK",
      },
      vehicle: {
        lat: cached.latitude,
        lon: cached.longitude,
        ...(pos?.bearing != null ? { bearing: pos.bearing } : {}),
      },
      vehicle_trip_index: cached.orderInCourse ?? 0,
      shape,
    };
  }

  // If not active in running vehicles, fetch realCourse
  if (Number.isFinite(cid)) {
    const mzkApi = getMzkApi();
    const rcData = (await mzkApi.fetchRealCourse(cid)) as {
      realCourse?: {
        lineName?: string | null;
        variantLoid?: number | null;
        stoppings?: Array<{
          stopPointName: string;
          stopPointSymbol: string;
          scheduledDepartureSec: number;
          estimatedDeparture?: number | null;
          orderInCourse: number;
        }>;
      };
    };
    const rc = rcData?.realCourse;
    if (rc?.stoppings?.length) {
      const cachedMeta = mzkPoller.courseMetaMap.get(cid);
      const lineName = rc.lineName || cachedMeta?.lineName || "";
      const variantId = rc.variantLoid || explicitVariantId || cachedMeta?.variantId;
      const direction =
        cachedMeta?.direction ||
        rc.stoppings[rc.stoppings.length - 1]?.stopPointName ||
        "";

      const times = rc.stoppings.map((s, idx) => {
        const h = Math.floor(s.scheduledDepartureSec / 3600) % 24;
        const m = Math.floor((s.scheduledDepartureSec % 3600) / 60);
        const depTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        let diff = 0;
        if (s.estimatedDeparture) {
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Warsaw",
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).formatToParts(new Date(s.estimatedDeparture));
          const eh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
          const em = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
          const es = Number(parts.find((p) => p.type === "second")?.value ?? 0);
          const estSecs = eh * 3600 + em * 60 + es;
          diff = estSecs - (s.scheduledDepartureSec % 86400);
          if (diff < -43200) diff += 86400;
          else if (diff > 43200) diff -= 86400;
        }
        return {
          stop_name: s.stopPointName,
          designator: null,
          place_id: `mzk:${s.stopPointSymbol}`,
          departure_time: depTime,
          index: idx,
          platform: null,
          estimate: { time_diff: diff },
        };
      });

      let shape: [number, number][] | null = null;
      if (variantId) {
        shape = await getVariantShape(variantId);
      }

      return {
        trip: {
          times,
          direction,
          line: { name: lineName },
          lineName,
          operator: "MZK",
        },
        vehicle: null,
        vehicle_trip_index: 0,
        shape,
      };
    }
  }

  return null;
}
