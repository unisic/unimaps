/**
 * GZM static feed: streamed zip parse (dates, flags, stop headsigns, brigade chains, shapes), the GTFS service-day
 * origin across both DST switches, the refresh schedule and the capped download.
 */
import "./support/tmp-output"; // first: KB_OUTPUT_DIR (stored road matches) -> a throw-away dir
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { strToU8, zipSync } from "fflate";

import { NO_DROP_OFF, NO_PICKUP, PICKUP_ON_REQUEST } from "../lib/gtfs-csv";
import { downloadGzmZip, gzmRefreshDue, parseGzmZip, serviceDayBase, warsawClock, type GzmFeed } from "../lib/gzm-feed";
import { focusShapeMatch, matchedPoints, rawKey, requestShapeMatch } from "../lib/gzm-match";
import { encodePolyline, type LatLng } from "../lib/shared/polyline";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kb-gzm-feed-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const FILES: Record<string, string> = {
  "routes.txt": [
    "route_id,agency_id,route_short_name,route_long_name,route_type",
    '1n,1,1N,"Katowice, Plac Wolności - Sosnowiec",3',
    "T6,1,,Tramwaj,0",
  ].join("\r\n"),
  // nested member: the parser keys on the basename
  "feed/stops.txt": [
    "stop_id,stop_name,stop_lat,stop_lon,location_type",
    'a,"Katowice, Rynek 01",50.2590,19.0220,0',
    "b,Plac Wolności 02,50.2600,19.0100,",
    "c,Sosnowiec Dworzec 03,50.2770,19.1300,0",
    "st,Parent station,50.2700,19.1300,1",
    "z,Zero,0,0,0",
    "u,Unused,50.3000,19.2000,0",
  ].join("\n"),
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id,brigade",
    "1n,s1,t1,Sosnowiec,0,sh1,101",
    "1n,s1,t2,Katowice,1,,101",
    "1n,s1,t0,Sosnowiec,0,sh1,101",
    "T6,m1,t3,Plac,0,,7",
    "1n,s1,t4,Single,0,,",
  ].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type",
    "t1,08:00:00,08:00:00,a,1,,0,1",
    "t1,08:05:00,08:06:00,b,2,Sosnowiec przez Rynek,3,0",
    "t1,08:15:00,08:15:00,c,3,,1,0",
    "t0,07:00:00,07:00:00,a,1,,,",
    "t0,07:10:00,07:10:00,c,2,,,",
    "t2,09:10:00,09:10:00,a,2,Katowice Rynek,,",
    "t2,09:00:00,09:00:00,c,1,Katowice,,",
    "t3,25:10:00,25:10:00,b,1,,,",
    "t3,25:20:00,25:20:00,a,2,,,",
    "t4,10:00:00,10:00:00,a,1,,,",
  ].join("\n"),
  "shapes.txt": [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
    "sh1,50.2600,19.0100,2",
    "sh1,50.2590,19.0220,1",
    "sh1,50.2770,19.1300,3",
  ].join("\n"),
  "calendar.txt": [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "s1,1,1,1,1,1,0,0,20261026,20261101",
  ].join("\n"),
  "calendar_dates.txt": ["service_id,date,exception_type", "s1,20261028,2", "s1,20261031,1", "m1,20261028,1"].join("\n"),
  "feed_info.txt": [
    "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version",
    "ZTM,https://example.invalid,pl,20261028,20261031,1793153448968",
  ].join("\n"),
};

function writeZip(name: string, files: Record<string, string>): string {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  return file;
}

let feedP: Promise<GzmFeed> | null = null;
const feed = (): Promise<GzmFeed> => (feedP ??= parseGzmZip(writeZip("gtfs.zip", FILES)));

describe("parseGzmZip", () => {
  it("reads feed_info and keeps only served, plain stops with prefixed ids", async () => {
    const f = await feed();
    assert.equal(f.version, "1793153448968");
    assert.equal(f.startDate, "2026-10-28");
    assert.equal(f.endDate, "2026-10-31");
    assert.deepEqual([...f.stops.keys()].sort(), ["gzm:a", "gzm:b", "gzm:c"]);
    assert.equal(f.stops.get("gzm:a")?.name, "Katowice, Rynek 01");
    const body = JSON.parse(f.stopsBody) as { count: number; stops: Array<{ id: string; designator: string; operator: string }> };
    assert.equal(body.count, 3);
    assert.ok(body.stops.every((s) => s.id === s.designator && s.operator === "GZM"));
    assert.match(f.stopsEtag, /^"[A-Za-z0-9_-]{22}"$/);
  });

  it("labels trips by route_short_name, falling back to route_id", async () => {
    const f = await feed();
    assert.equal(f.trips.get("gzm:t1")?.line, "1N");
    assert.equal(f.trips.get("gzm:t3")?.line, "T6");
    assert.deepEqual(
      f.tripsByLine.get("1N")?.map((t) => t.tripId).sort(),
      ["gzm:t0", "gzm:t1", "gzm:t2"],
    );
    assert.equal(f.trips.has("gzm:t4"), false, "a one-stop trip is dropped");
    assert.deepEqual(f.lines.map((l) => l.name), ["1N", "T6"]);
  });

  it("resolves dates from calendar ranges, removals and calendar_dates-only services", async () => {
    const f = await feed();
    assert.deepEqual([...(f.trips.get("gzm:t1")?.dates ?? [])].sort(), ["2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30", "2026-10-31"]);
    assert.deepEqual([...(f.trips.get("gzm:t3")?.dates ?? [])], ["2026-10-28"]);
  });

  it("keeps times past 24 h, pickup flags and stop headsigns in sequence order", async () => {
    const f = await feed();
    const t1 = f.trips.get("gzm:t1")!;
    assert.deepEqual(Array.from(t1.flags), [NO_DROP_OFF, PICKUP_ON_REQUEST, NO_PICKUP]);
    assert.deepEqual(t1.stopHeadsigns, [null, "Sosnowiec przez Rynek", null]);
    assert.deepEqual([t1.stopIds[1], t1.seqs[1], t1.arr[1], t1.dep[1]], ["gzm:b", 2, 8 * 3600 + 300, 8 * 3600 + 360]);

    const t2 = f.trips.get("gzm:t2")!;
    assert.deepEqual(t2.stopIds, ["gzm:c", "gzm:a"], "sorted by stop_sequence");
    assert.deepEqual(t2.stopHeadsigns, [null, "Katowice Rynek"], "a stop headsign equal to the trip's is dropped");

    assert.equal(f.trips.get("gzm:t0")?.stopHeadsigns, null);
    assert.equal(f.trips.get("gzm:t3")?.dep[0], 25 * 3600 + 600);
  });

  it("chains a brigade's trips of one route and service by first departure", async () => {
    const f = await feed();
    const t0 = f.trips.get("gzm:t0")!;
    assert.equal(t0.brigade, "101");
    assert.equal(t0.next?.tripId, "gzm:t1");
    assert.equal(t0.next?.next?.tripId, "gzm:t2");
    assert.equal(f.trips.get("gzm:t2")?.next, null);
    assert.equal(f.trips.get("gzm:t3")?.next, null);
  });

  it("expands a frequencies.txt template into one trip per headway run, end_time exclusive", async () => {
    const f = await parseGzmZip(
      writeZip("freq.zip", {
        ...FILES,
        "trips.txt": `${FILES["trips.txt"]}\nT6,m1,f1,Metro,0,sh1,`,
        "stop_times.txt": `${FILES["stop_times.txt"]}\nf1,05:00:00,05:00:00,a,1\nf1,05:04:00,05:05:00,b,2`,
        "frequencies.txt": [
          "trip_id,start_time,end_time,headway_secs,exact_times",
          "f1,06:00:00,06:30:00,600,0",
          "f1,06:30:00,06:45:00,900,1",
          "f1,07:00:00,08:00:00,0,0",
        ].join("\n"),
      }),
    );
    assert.equal(f.trips.has("gzm:f1"), false);
    const runs = [...f.trips.values()].filter((t) => t.headsign === "Metro");
    assert.deepEqual(
      runs.map((t) => t.tripId),
      ["gzm:f1.21600", "gzm:f1.22200", "gzm:f1.22800", "gzm:f1.23400"],
    );
    assert.deepEqual(
      Array.from(runs[1].dep, (dep, i) => [runs[1].arr[i], dep]),
      [
        [22200, 22200],
        [22440, 22500],
      ],
    );
    assert.equal(f.trips.get("gzm:t1")?.dep[0], 8 * 3600);
  });

  it("serves shapes with rev-stamped wire ids", async () => {
    const f = await feed();
    assert.equal(f.shapes.size, 1);
    const id = f.shapes.wireId("gzm:sh1");
    assert.match(id ?? "", /^gzm:sh1\.[0-9a-f]{6}$/);
    assert.equal(f.shapes.status("gzm:sh1"), "road");
    assert.equal(f.shapes.status("gzm:nope"), "none");
    const g = f.shapes.geometry("gzm:sh1")!;
    assert.equal(g.src, "gtfs");
    assert.equal(g.stops.length, 3, "placed with the first trip's stops");
    assert.ok(g.stops.every((s) => s !== null));

    const hit = f.shapes.lookup([id!]);
    assert.equal(hit.exact, true);
    assert.equal(hit.shapes[id!].src, "gtfs");
    const bare = f.shapes.lookup(["gzm:sh1", "gzm:nope.abcdef"]);
    assert.equal(bare.exact, false);
    assert.deepEqual(bare.missing, ["gzm:nope.abcdef"]);
    assert.equal(bare.shapes["gzm:sh1"].id, id);
    assert.equal(f.shapes.lookup(["gzm:sh1.000000"]).exact, false, "stale rev");
  });

  it("upgrade swaps in a road-matched shape once, under a new wire id", async () => {
    const f = await parseGzmZip(writeZip("upgrade.zip", FILES));
    const raw = f.shapes.unmatched("gzm:sh1")!.rev;
    const poly = f.shapes.unmatched("gzm:sh1")!.poly;
    const refs: Array<[number, number]> = [
      [50.259, 19.022],
      [50.26, 19.01],
      [50.277, 19.13],
    ];
    const road: Array<[number, number]> = [[50.259, 19.022], [50.2597, 19.016], [50.26, 19.01], [50.27, 19.07], [50.277, 19.13]];
    assert.equal(f.shapes.upgrade("gzm:sh1", "000000", road, refs), false, "stale raw rev");
    assert.equal(f.shapes.upgrade("gzm:sh1", raw, road, refs.slice(1)), false, "stops of another trip");
    const before = f.shapes.wireId("gzm:sh1");
    assert.equal(f.shapes.upgrade("gzm:sh1", raw, road, refs), true);
    assert.notEqual(f.shapes.wireId("gzm:sh1"), before);
    assert.equal(f.shapes.geometry("gzm:sh1")!.src, "osrm");
    assert.equal(f.shapes.unmatched("gzm:sh1"), null);
    assert.ok(f.shapes.rawKeys().has(rawKey(poly)), "the raw geometry's key stays known");
    assert.equal(f.shapes.upgrade("gzm:sh1", raw, road, refs), false, "already matched");
    assert.equal(f.shapes.lookup([before!]).exact, false, "the old wire id still resolves, to the new shape");
  });

  it("one OSRM match serves every shape with the same geometry", async () => {
    const twins = {
      ...FILES,
      "trips.txt": FILES["trips.txt"].replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,"),
      "shapes.txt": `${FILES["shapes.txt"]}\nsh2,50.2590,19.0220,1\nsh2,50.2600,19.0100,2\nsh2,50.2770,19.1300,3`,
    };
    const f = await parseGzmZip(writeZip("twins.zip", twins));
    const poly = f.shapes.unmatched("gzm:sh1")!.poly;
    assert.equal(f.shapes.unmatched("gzm:sh2")!.poly, poly);
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    // answers like /match: every trace point is on the road
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      const pts = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map((c): LatLng => {
        const [lon, lat] = c.split(",").map(Number);
        return [lat, lon];
      });
      const body = { code: "Ok", matchings: [{ geometry: encodePolyline(pts), legs: pts.slice(1).map(() => ({ distance: 1 })) }] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const a: [number, number] = [50.259, 19.022];
      const b: [number, number] = [50.26, 19.01];
      const c: [number, number] = [50.277, 19.13];
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh1", [a, b, c]), true);
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh2", [a, c]), true, "joins the running match");
      for (let i = 0; i < 150 && (f.shapes.unmatched("gzm:sh1") || f.shapes.unmatched("gzm:sh2")); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(calls.length, 1);
      assert.equal(f.shapes.geometry("gzm:sh1")!.src, "osrm");
      assert.equal(f.shapes.geometry("gzm:sh2")!.src, "osrm");
      assert.ok(matchedPoints(poly));
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh1", [a, b, c]), false, "nothing left to match");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the part of the route in view is matched first and served before the rest", async () => {
    // 28 points zigzagging 44 m: Douglas-Peucker keeps all, three chunks of 10 on the public host
    const zig = Array.from({ length: 28 }, (_, i) => `sh1,${(50.259 + (i % 2) * 0.0004).toFixed(4)},${(19.022 + i * 0.0015).toFixed(4)},${i + 1}`);
    const f = await parseGzmZip(writeZip("focus.zip", { ...FILES, "shapes.txt": ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", ...zig].join("\n") }));
    const rawId = f.shapes.wireId("gzm:sh1");
    const seen: Array<{ lon: number; src: string | undefined; id: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const pts = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map((c): LatLng => {
        const [lon, lat] = c.split(",").map(Number);
        return [lat, lon];
      });
      seen.push({ lon: pts[0][1], src: f.shapes.geometry("gzm:sh1")?.src, id: f.shapes.wireId("gzm:sh1") });
      const body = { code: "Ok", matchings: [{ geometry: encodePolyline(pts), legs: pts.slice(1).map(() => ({ distance: 1 })) }] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const refs: Array<[number, number]> = [[50.259, 19.022], [50.26, 19.01], [50.277, 19.13]];
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh1", refs), true);
      // the last chunk only (points 22-27); the pick waits for the pace, so this focus counts from the first request
      focusShapeMatch(f.shapes, "gzm:sh1", { s: 50.258, w: 19.054, n: 50.26, e: 19.064 });
      for (let i = 0; i < 300 && f.shapes.unmatched("gzm:sh1"); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(seen.length, 3);
      assert.ok(seen[0].lon > 19.048, "the chunk in view goes first");
      assert.deepEqual(seen.map((x) => x.src), ["gtfs", "partial", "partial"], "published as partial before the rest");
      const partialId = seen[1].id!;
      assert.notEqual(partialId, rawId);
      assert.equal(f.shapes.geometry("gzm:sh1")!.src, "osrm");
      assert.notEqual(f.shapes.wireId("gzm:sh1"), partialId);
      const stale = f.shapes.lookup([partialId]);
      assert.equal(stale.exact, false, "the partial id resolves to the full match");
      assert.equal(stale.shapes[partialId].src, "osrm");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a newly opened route goes before the rest of an older match", async () => {
    // sh1: 28 points zigzagging 44 m, three chunks; sh2: one chunk, far north
    const zig = Array.from({ length: 28 }, (_, i) => `sh1,${(50.239 + (i % 2) * 0.0004).toFixed(4)},${(19.022 + i * 0.0015).toFixed(4)},${i + 1}`);
    const files = {
      ...FILES,
      "trips.txt": FILES["trips.txt"].replace("t0,Sosnowiec,0,sh1,", "t0,Sosnowiec,0,sh2,"),
      "shapes.txt": ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", ...zig, "sh2,50.3000,19.1000,1", "sh2,50.3010,19.1100,2"].join("\n"),
    };
    const f = await parseGzmZip(writeZip("preempt.zip", files));
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const pts = new URL(String(url)).pathname.split("/").at(-1)!.split(";").map((c): LatLng => {
        const [lon, lat] = c.split(",").map(Number);
        return [lat, lon];
      });
      calls.push(pts[0][0] > 50.29 ? "sh2" : "sh1");
      const body = { code: "Ok", matchings: [{ geometry: encodePolyline(pts), legs: pts.slice(1).map(() => ({ distance: 1 })) }] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh1", [[50.239, 19.022], [50.2394, 19.04], [50.2394, 19.0625]]), true);
      for (let i = 0; i < 150 && !calls.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(requestShapeMatch(f.shapes, "gzm:sh2", [[50.3, 19.1], [50.301, 19.11]]), true);
      for (let i = 0; i < 300 && (f.shapes.unmatched("gzm:sh1") || f.shapes.unmatched("gzm:sh2")); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.deepEqual(calls, ["sh1", "sh2", "sh1", "sh1"], "sh2 waits one request, not the whole sh1 match");
      assert.equal(f.shapes.geometry("gzm:sh1")!.src, "osrm");
      assert.equal(f.shapes.geometry("gzm:sh2")!.src, "osrm");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects a zip without trips and a file that is no zip", async () => {
    await assert.rejects(parseGzmZip(writeZip("empty.zip", { "agency.txt": "agency_id\n1" })), /no trips or stops/);
    const junk = path.join(DIR, "junk.zip");
    fs.writeFileSync(junk, "not a zip at all");
    await assert.rejects(parseGzmZip(junk));
  });
});

describe("serviceDayBase", () => {
  const warsaw = (secs: number) => {
    const w = warsawClock(secs * 1000);
    return `${w.date} ${String(Math.floor(w.secs / 3600)).padStart(2, "0")}:${String(Math.floor((w.secs % 3600) / 60)).padStart(2, "0")}`;
  };

  it("is local midnight on a plain day", () => {
    assert.equal(serviceDayBase("2026-10-28"), Date.UTC(2026, 9, 27, 23) / 1000);
  });

  it("is noon minus 12 h on the spring-forward day", () => {
    assert.equal(serviceDayBase("2027-03-28"), Date.UTC(2027, 2, 27, 22) / 1000);
    assert.equal(warsaw(serviceDayBase("2027-03-28") + 8 * 3600), "2027-03-28 08:00", "wall-clock times after the switch hold");
  });

  it("maps 25:10 on the fall-back day to 01:10 the next morning", () => {
    assert.equal(warsaw(serviceDayBase("2026-10-25") + 25 * 3600 + 600), "2026-10-26 01:10");
    assert.equal(warsaw(serviceDayBase("2026-10-25") + 12 * 3600), "2026-10-25 12:00");
  });
});

describe("gzmRefreshDue", () => {
  // 2026-10-28 is CET (UTC+1)
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h - 1, m);

  it("is due without a feed unless a retry is pending", () => {
    assert.equal(gzmRefreshDue({ hasFeed: false, checkedDay: "", retryAt: 0 }, at(2)), true);
    assert.equal(gzmRefreshDue({ hasFeed: false, checkedDay: "", retryAt: at(2, 30) }, at(2)), false);
  });

  it("downloads once per Warsaw day, from 04:00 on", () => {
    const s = { hasFeed: true, checkedDay: "2026-10-27", retryAt: 0 };
    assert.equal(gzmRefreshDue(s, at(3, 59)), false);
    assert.equal(gzmRefreshDue(s, at(4)), true);
    assert.equal(gzmRefreshDue({ ...s, checkedDay: "2026-10-28" }, at(9)), false);
  });
});

describe("downloadGzmZip", () => {
  const target = path.join(DIR, "dl", "gtfs.zip");
  const stream = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    });

  it("returns null on 304 and sends If-Modified-Since", async () => {
    let sent: Headers | null = null;
    const since = new Date(Date.UTC(2026, 9, 27, 3));
    const got = await downloadGzmZip(target, {
      url: "https://example.invalid/gtfs",
      ifModifiedSince: since,
      fetchImpl: async (_u, init) => {
        sent = new Headers(init?.headers);
        return new Response(null, { status: 304 });
      },
    });
    assert.equal(got, null);
    assert.equal(sent!.get("if-modified-since"), since.toUTCString());
    assert.equal(fs.existsSync(`${target}.tmp`), false);
  });

  it("writes the body to <file>.tmp", async () => {
    const got = await downloadGzmZip(target, {
      url: "https://example.invalid/gtfs",
      fetchImpl: async () => new Response(stream([new Uint8Array([1, 2, 3]), new Uint8Array([4])])),
    });
    assert.deepEqual(got, { tmp: `${target}.tmp`, bytes: 4 });
    assert.deepEqual([...fs.readFileSync(`${target}.tmp`)], [1, 2, 3, 4]);
    fs.rmSync(`${target}.tmp`);
  });

  it("refuses an oversized body by header and by stream, leaving no tmp file", async () => {
    await assert.rejects(
      downloadGzmZip(target, {
        url: "https://example.invalid/gtfs",
        maxBytes: 3,
        fetchImpl: async () => new Response("12345", { headers: { "content-length": "5" } }),
      }),
      /size cap/,
    );
    await assert.rejects(
      downloadGzmZip(target, {
        url: "https://example.invalid/gtfs",
        maxBytes: 3,
        fetchImpl: async () => new Response(stream([new Uint8Array(2), new Uint8Array(2)])),
      }),
      /size cap/,
    );
    assert.equal(fs.existsSync(`${target}.tmp`), false);
    await assert.rejects(
      downloadGzmZip(target, { url: "https://example.invalid/gtfs", fetchImpl: async () => new Response("x", { status: 500 }) }),
      /HTTP 500/,
    );
  });
});
