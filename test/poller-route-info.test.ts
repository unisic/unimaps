/**
 * LivePoller.attachRouteInfo end to end: the real line-120 loop capture goes through
 * ingestTripExecution (the same path a polled trip execution takes) with a stored road shape, and the
 * resulting dist_m must stay on the right leg even when upstream's vehicle_trip_index freezes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

import type { KbApi } from "../lib/kb-api";
import { LivePoller } from "../lib/poller";
import type { ShapeGeometry } from "../lib/shape-store";
import { decodePolyline, preparePolyline, projectStopsAlong, type LatLng } from "../lib/shared/polyline";
import { stopsAtChainage } from "../lib/shared/trip-progress";
import type { Stop } from "../lib/types";

interface Snap { t: number; lat: number; lon: number; vti: number; ndi: number; at: boolean }
interface Fixture { polyline: string; stops: Array<{ i: number; id: string; name: string; lat: number; lon: number; sched: string }>; snapshots: Snap[] }
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "line120-loop-capture.json"), "utf8")) as Fixture;

const N = fx.stops.length;
const pl = preparePolyline(decodePolyline(fx.polyline, 6))!;
const stopPts: LatLng[] = fx.stops.map((s) => [s.lat, s.lon]);
const along = projectStopsAlong(pl, stopPts);
const geometry: ShapeGeometry = { pl, stops: along, rev: "abc123", src: "osrm" };

const stops: Stop[] = fx.stops.map((s) => ({
  urlId: s.id,
  internalId: Number(s.id),
  name: s.name,
  lon: s.lon,
  lat: s.lat,
  onlyDisembarking: false,
  isStation: false,
  showPlatforms: false,
  stopId: s.id,
}));
const times = fx.stops.map((s) => ({ stop_name: s.name, designator: Number(s.id), place_id: s.id, departure_time: s.sched, index: s.i }));

async function makePoller(): Promise<LivePoller> {
  const api = { fetchRevision: async () => "1", fetchStops: async () => stops } as unknown as KbApi;
  const poller = new LivePoller(api, {
    shapes: {
      touchKb: () => {},
      geometry: () => geometry,
    },
  });
  await poller.loadStops();
  return poller;
}

/** replay every snapshot through the poller; `freezeAt` = upstream's index sticks there once the bus reaches it */
async function replay(freezeAt: number | null, every = 1): Promise<string[]> {
  const poller = await makePoller();
  const eid = "4263:739891:0";
  const bad: string[] = [];
  for (const [k, s] of fx.snapshots.entries()) {
    if (k % every !== 0) continue; // a sparse poller: long gaps between the fixes it sees
    const frozen = freezeAt !== null && s.vti >= freezeAt;
    const vti = frozen ? freezeAt : s.vti;
    const at = frozen ? false : s.at;
    const ndi = frozen ? freezeAt + 1 : s.ndi;
    mock.timers.setTime(s.t);
    const pos = poller.ingestTripExecution(eid, {
      trip: { times, line: { name: "120" }, direction: "SZCZYRK SALMOPOL (SOLISKO)" },
      vehicle: { lat: s.lat, lon: s.lon },
      vehicle_trip_index: vti,
      next_departure_index: ndi,
      at_stop: at,
      estimates: [{ to_go: 0, arrival_abs: "23:00" }],
    });
    assert.ok(pos, "ingested");
    assert.ok(pos.distM != null, "the fix is on the stored shape");
    const r = stopsAtChainage(along, pos.distM, { vti, atStop: at });
    const exp = s.at ? { index: s.vti, at: true } : { index: Math.min(s.vti + 1, N - 1), at: false };
    if (!r || !(r.index === exp.index || (exp.at && r.index === exp.index + 1))) {
      bad.push(`${new Date(s.t).toISOString()} upstream ${s.vti}${s.at ? "@" : ""} (sent ${vti}) -> ${r?.index}`);
    }
  }
  return bad;
}

describe("LivePoller.attachRouteInfo — dist_m through the Szczyrk Biła loop (real capture)", () => {
  mock.timers.enable({ apis: ["Date"], now: fx.snapshots[0].t });
  after(() => mock.timers.reset());

  it("upstream right: dist_m maps to upstream's stop at every snapshot", async () => {
    assert.deepEqual(await replay(null), []);
  });

  for (const K of [19, 20, 21, 22]) {
    it(`upstream index frozen at ${K}: dist_m stays on the return leg`, async () => {
      assert.deepEqual(await replay(K), []);
    });
  }

  it("a slow poller (a fix every ~48 s = 600 m of road): the forward window widens with the gap, frozen index at 22", async () => {
    assert.deepEqual(await replay(22, 8), []);
    assert.deepEqual(await replay(null, 8), []);
  });
});
