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
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export async function resolveMzkTrip(identifier: string): Promise<Record<string, unknown> | null> {
  const cleanId = identifier.replace(/^mzk:/, "");
  const parts = cleanId.split(":");
  const courseIdStr = parts[0];
  const vehicleId = parts[1];

  const mzkPoller = getMzkPoller();
  const cached =
    mzkPoller.runningVehiclesMap.get(`mzk:${courseIdStr}:${vehicleId || ""}`) ||
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
      },
      vehicle_trip_index: cached.orderInCourse ?? 0,
      shape,
    };
  }

  // If not active in running vehicles, fetch realCourse
  const cid = parseInt(courseIdStr, 10);
  if (Number.isFinite(cid)) {
    const mzkApi = getMzkApi();
    const rcData = (await mzkApi.fetchRealCourse(cid)) as {
      realCourse?: {
        lineName: string;
        variantLoid?: number;
        stoppings?: Array<{
          stopPointName: string;
          stopPointSymbol: string;
          scheduledDepartureSec: number;
          estimatedDeparture?: number;
          orderInCourse: number;
        }>;
      };
    };
    const rc = rcData?.realCourse;
    if (rc?.stoppings?.length) {
      const times = rc.stoppings.map((s, idx) => {
        const h = Math.floor(s.scheduledDepartureSec / 3600);
        const m = Math.floor((s.scheduledDepartureSec % 3600) / 60);
        const depTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        let diff = 0;
        if (s.estimatedDeparture) {
          const estDate = new Date(s.estimatedDeparture);
          const estSecs =
            estDate.getHours() * 3600 +
            estDate.getMinutes() * 60 +
            estDate.getSeconds();
          diff = estSecs - s.scheduledDepartureSec;
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
      if (rc.variantLoid) {
        shape = await getVariantShape(rc.variantLoid);
      }

      return {
        trip: {
          times,
          direction: rc.stoppings[rc.stoppings.length - 1]?.stopPointName || "",
          line: { name: rc.lineName },
          lineName: rc.lineName,
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
