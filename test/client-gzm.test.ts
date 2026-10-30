import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { tripAlertKey } from "../lib/client/alerts";
import { getTrip, HttpError, isWarming, tripWarming } from "../lib/client/api";
import { CITY, cityOfId, cityUrl, resolveCity, withCity } from "../lib/client/city";
import { DENSE_FLEET, fleetMarkers, PILL_MIN_ZOOM } from "../lib/client/fleetMarkers";
import { arrivedSecs, BRAND_GZM, BRAND_KB, BRAND_MZK, isMzk, operatorColor } from "../lib/client/format";
import { loadDay } from "../lib/client/timetable";
import { buildSearch, EMPTY_URL_STATE, parseUrlState, savedLinesKey } from "../lib/client/urlState";
import { gzmRowKey } from "../lib/shared/departures";

describe("GZM brand", () => {
  it("never classifies a GZM line as MZK, whatever its name", () => {
    assert.equal(isMzk("GZM", "1"), false);
    assert.equal(isMzk("GZM", "N1"), false);
    assert.equal(isMzk("GZM", "13W"), false);
  });

  it("colours GZM amber and leaves KB / MZK unchanged", () => {
    assert.equal(operatorColor("GZM", "1"), BRAND_GZM);
    assert.equal(operatorColor("MZK", "1"), BRAND_MZK);
    assert.equal(operatorColor("KB", "120"), BRAND_KB);
    assert.equal(operatorColor(undefined, "13"), BRAND_MZK);
  });
});

describe("fleet markers", () => {
  const box = { s: 49.5, w: 19, n: 50.5, e: 19.1 };
  const fleet = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, lat: 49 + (i % 3), lon: 19.05 }));

  it("keeps every pill of a BB-sized fleet at any zoom", () => {
    const small = fleet(DENSE_FLEET);
    for (const zoom of [9, 12, 16]) assert.deepEqual(fleetMarkers(small, zoom, box), { dots: false, list: small });
  });

  it("draws a dense fleet as dots zoomed out and as pills in the box zoomed in", () => {
    const big = fleet(DENSE_FLEET + 2);
    assert.deepEqual(fleetMarkers(big, PILL_MIN_ZOOM - 0.5, box), { dots: true, list: big });
    const near = fleetMarkers(big, PILL_MIN_ZOOM, box);
    assert.equal(near.dots, false);
    assert.deepEqual(new Set(near.list.map((v) => v.lat)), new Set([50]));
    assert.equal(near.list.length, 84);
  });
});

describe("city resolution", () => {
  it("lets the URL decide first: city=gzm or a gzm: id means GZM", () => {
    assert.equal(resolveCity("?city=gzm", "bb"), "gzm");
    assert.equal(resolveCity("?stop=gzm%3A123", null), "gzm");
    assert.equal(resolveCity("?exec=gzm:1_234", "bb"), "gzm");
    assert.equal(resolveCity("?trip=gzm:abc", "bb"), "gzm");
  });

  it("reads any other app param as an old BB deep link, whatever is stored", () => {
    assert.equal(resolveCity("?stop=1234", "gzm"), "bb");
    assert.equal(resolveCity("?exec=mzk:1:2", "gzm"), "bb");
    assert.equal(resolveCity("?lines=120", "gzm"), "bb");
    assert.equal(resolveCity("?map=49.8,19.0,13", "gzm"), "bb");
  });

  it("falls back to the stored choice, and to the picker (null) without a valid one", () => {
    assert.equal(resolveCity("", "gzm"), "gzm");
    assert.equal(resolveCity("?utm=x", "bb"), "bb");
    assert.equal(resolveCity("", null), null);
    assert.equal(resolveCity("", "krk"), null);
    assert.equal(resolveCity("", "krakow"), "krakow");
    assert.equal(resolveCity("?city=warsaw", "bb"), "warsaw");
    assert.equal(resolveCity("?stop=warsaw%3Aabc", null), "warsaw");
    assert.equal(cityUrl("/api/stops", "krakow"), "/api/stops?city=krakow");
    assert.equal(withCity("?stop=x", "krakow"), "?stop=x&city=krakow");
  });

  it("tells the city of an id", () => {
    assert.equal(cityOfId("gzm:1_234"), "gzm");
    assert.equal(cityOfId("mzk:1:2"), "bb");
    assert.equal(cityOfId("1234"), "bb");
    assert.equal(cityOfId(1234), "bb");
    assert.equal(cityOfId(null), "bb");
    assert.equal(cityOfId(undefined), "bb");
  });
});

describe("city URLs: BB stays byte-identical", () => {
  it("withCity leaves BB untouched and marks GZM once", () => {
    assert.equal(withCity("", "bb"), "");
    assert.equal(withCity("?stop=1234&map=49.8,19.0,13", "bb"), "?stop=1234&map=49.8,19.0,13");
    assert.equal(withCity("", "gzm"), "?city=gzm");
    assert.equal(withCity("?stop=gzm%3A1", "gzm"), "?stop=gzm%3A1&city=gzm");
    assert.equal(withCity("?city=gzm&stop=gzm%3A1", "gzm"), "?city=gzm&stop=gzm%3A1");
  });

  it("round-trips a GZM deep link through the URL codec", () => {
    const search = withCity(buildSearch({ ...EMPTY_URL_STATE, stop: "gzm:123" }), "gzm");
    assert.equal(parseUrlState(search).stop, "gzm:123");
    assert.equal(resolveCity(search, null), "gzm");
  });

  it("cityUrl adds the API param only for GZM", () => {
    assert.equal(cityUrl("/api/vehicles", "bb"), "/api/vehicles");
    assert.equal(cityUrl("/api/vehicles", "gzm"), "/api/vehicles?city=gzm");
    assert.equal(cityUrl("/api/stops?x=1", "gzm"), "/api/stops?x=1&city=gzm");
  });

  it("keeps the BB line filter key and gives GZM its own", () => {
    assert.equal(savedLinesKey(), "kb:lineFilter");
    assert.equal(savedLinesKey("bb"), "kb:lineFilter");
    assert.equal(savedLinesKey("gzm"), "kb:lineFilter:gzm");
  });

  it("polls GZM vehicles every 5 s and BB every 4 s", () => {
    assert.equal(CITY.gzm.vehiclesRefreshMs, 5000);
    assert.equal(CITY.bb.vehiclesRefreshMs, 4000);
  });
});

describe("GZM trip alerts", () => {
  it("key on the raw static trip id and the stop_sequence, never on the vehicle", () => {
    assert.equal(tripAlertKey("gzm:1_234", 7, "gzm:T42"), gzmRowKey("T42", 7));
    assert.equal(tripAlertKey("gzm:1_234", 7, "T42"), "gzm:T42#7");
    assert.equal(tripAlertKey("gzm:9_999", 7, "gzm:T42"), tripAlertKey("gzm:1_234", 7, "gzm:T42"));
  });

  it("cannot be keyed without a trip id", () => {
    assert.equal(tripAlertKey("gzm:1_234", 7), null);
    assert.equal(tripAlertKey("gzm:1_234", 7, null), null);
    assert.equal(tripAlertKey("gzm:1_234", 7, ""), null);
  });

  it("leave the KB and MZK keys unchanged", () => {
    assert.equal(tripAlertKey("mzk:55:300", 3, "mzk:55:9"), "mzk:55#3");
    assert.equal(tripAlertKey("e1", 4, "999"), "e1#4");
  });
});

describe("GZM recorded arrivals", () => {
  it("reads the server's arrival log; estimates (upcoming stops only) are never a passed stop's time", () => {
    const trip = {
      operator: "GZM" as const,
      times: [
        { departure_time: "10:00", estimate: { time_diff: 60 } },
        { departure_time: "10:05", estimate: { time_diff: 120 } },
        { departure_time: "10:10", estimate: { time_diff: 0 } },
      ],
    } as unknown as Parameters<typeof arrivedSecs>[0]["trip"];
    // 2026-07-06 10:01 and 10:07 Warsaw (UTC+2)
    const e = Date.UTC(2026, 6, 6, 8, 1) / 1000;
    assert.deepEqual(arrivedSecs({ trip, arrived: [e, e + 360], vehicle_trip_index: 2 }), [36_060, 36_420]);
    assert.equal(arrivedSecs({ trip, vehicle_trip_index: 2 }), null);
  });
});

describe("GZM data still loading (503)", () => {
  const realFetch = globalThis.fetch;
  const answer = (status: number, body: unknown = {}) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is told apart from other HTTP failures", () => {
    assert.equal(isWarming(new HttpError(503, "/api/stops?city=gzm")), true);
    assert.equal(isWarming(new HttpError(502, "/api/stops")), false);
    assert.equal(isWarming(new HttpError(404, "/api/stop/gzm:x/departures")), false);
    assert.equal(isWarming(new Error("network")), false);
    assert.equal(isWarming(null), false);
  });

  it("marks a trip as loading, never caches the failure and clears the mark on the next answer", async () => {
    answer(503, { error: "Data is loading" });
    assert.equal(await getTrip("gzm:warm1"), null);
    assert.equal(tripWarming("gzm:warm1"), true);
    answer(200, { times: [{ departure_time: "10:00" }] });
    const tr = await getTrip("gzm:warm1");
    assert.equal(tr?.times?.length, 1);
    assert.equal(tripWarming("gzm:warm1"), false);
  });

  it("does not mark a plain failure as loading", async () => {
    answer(502);
    assert.equal(await getTrip("gzm:warm2"), null);
    assert.equal(tripWarming("gzm:warm2"), false);
  });

  it("flags a GZM timetable day as loading, a BB one never", async () => {
    answer(503, { error: "Data is loading" });
    const ctl = new AbortController();
    assert.deepEqual(await loadDay("gzm:warm3", "2026-10-28", ctl.signal, () => {}), { status: "error", warming: true });
    assert.deepEqual(await loadDay("1234", "2026-10-28", ctl.signal, () => {}), { status: "error" });
  });
});
