import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  arrivedSecs,
  BRAND,
  BRAND_KB,
  BRAND_MZK,
  computeEta,
  countdown,
  delayStatus,
  delayTxt,
  detectLoopStops,
  displayStopName,
  formatPlatform,
  formatPrzezLoop,
  hhmmFromSecs,
  hslColor,
  isBusStation,
  isMzk,
  normalizeText,
  notStartedEta,
  operatorColor,
  przystanekPlural,
  secsFromHHMM,
  wozPlural,
} from "../lib/client/format";
import type { TripTime, TripView } from "../lib/client/types";

describe("secsFromHHMM / hhmmFromSecs", () => {
  it("parses HH:MM and HH:MM:SS", () => {
    assert.equal(secsFromHHMM("05:30"), 19800);
    assert.equal(secsFromHHMM("5:30:45"), 19845);
    assert.equal(secsFromHHMM(""), null);
    assert.equal(secsFromHHMM(null), null);
    assert.equal(secsFromHHMM("ab:cd"), null);
  });

  it("formats with a %24 wrap for post-midnight seconds", () => {
    assert.equal(hhmmFromSecs(19800), "05:30");
    assert.equal(hhmmFromSecs(90000), "01:00"); // 25:00 -> 01:00
    assert.equal(hhmmFromSecs(0), "00:00");
    assert.equal(hhmmFromSecs(null), "");
  });
});

describe("delayTxt", () => {
  it("renders ±30 s as mirror images (symmetric rounding)", () => {
    assert.equal(delayTxt(30), "+1 min");
    assert.equal(delayTxt(-30), "-1 min");
    assert.equal(delayTxt(29), "o czasie");
    assert.equal(delayTxt(-29), "o czasie");
    assert.equal(delayTxt(0), "o czasie");
    assert.equal(delayTxt(90), "+2 min");
    assert.equal(delayTxt(null), "");
  });
});

describe("countdown", () => {
  it("counts down in minutes, 'teraz' at or past due", () => {
    assert.equal(countdown(null, 0), "");
    assert.equal(countdown(400, 100), "5 min");
    assert.equal(countdown(100, 400), "teraz");
    assert.equal(countdown(100, 100), "teraz");
  });

  it("falls back to the absolute time beyond an hour", () => {
    assert.equal(countdown(19800, 19800 - 2 * 3600), "05:30");
  });

  it("rolls a large negative delta forward across midnight", () => {
    // departure 00:10 seen at 23:53 is in 17 min, not 24 h ago
    assert.equal(countdown(600, 86000), "17 min");
  });
});

describe("displayStopName", () => {
  it("title-cases ALL-CAPS names, keeping dotted abbreviations", () => {
    assert.equal(displayStopName("BIELSKO-BIAŁA D.A."), "Bielsko-Biała D.A.");
  });

  it("keeps vowelless acronyms and roman numerals uppercase", () => {
    assert.equal(displayStopName("SZCZYRK ZML"), "Szczyrk ZML");
    assert.equal(displayStopName("CZECHOWICE-DZ. KOŚCIÓŁ ŚW. BARBARY"), "Czechowice-Dz. Kościół Św. Barbary");
    assert.equal(displayStopName("OSIEDLE II"), "Osiedle II");
  });

  it("passes empty through", () => {
    assert.equal(displayStopName(""), "");
  });
});

describe("wozPlural", () => {
  it("follows Polish plural rules", () => {
    assert.equal(wozPlural(1), "wóz");
    assert.equal(wozPlural(2), "wozy");
    assert.equal(wozPlural(4), "wozy");
    assert.equal(wozPlural(5), "wozów");
    assert.equal(wozPlural(12), "wozów");
    assert.equal(wozPlural(14), "wozów");
    assert.equal(wozPlural(22), "wozy");
    assert.equal(wozPlural(25), "wozów");
    assert.equal(wozPlural(122), "wozy");
  });
});

describe("normalizeText", () => {
  it("strips Polish diacritics including ł (which NFD misses)", () => {
    assert.equal(normalizeText("Łódź"), "lodz");
    assert.equal(normalizeText("Żywiec"), "zywiec");
    assert.equal(normalizeText("SZCZYRK"), "szczyrk");
  });
});

describe("detectLoopStops", () => {
  const t = (names: string[]) => names.map((stop_name) => ({ stop_name }));

  it("returns [] for short trips and round trips (first == last)", () => {
    assert.deepEqual(detectLoopStops(t(["A", "B", "C"])), []);
    assert.deepEqual(detectLoopStops(t(["A", "B", "C", "B", "A"])), []);
  });

  it("names the apex stop of a pocket spur", () => {
    assert.deepEqual(detectLoopStops(t(["A", "B", "S", "B", "C"])), ["S"]);
  });

  it("identifies Szczyrk Biła as the loop destination for line 120", () => {
    const stops = [
      "Szczyrk Centrum",
      "Szczyrk Beskidek",
      "Szczyrk Pod Stromą",
      "Szczyrk Przedszkole",
      "Szczyrk Biła",
      "Szczyrk Beskid Arena",
      "Szczyrk Przedszkole",
      "Szczyrk Pod Stromą",
      "Szczyrk Beskidek",
      "Szczyrk Nowy Kościół",
    ];
    assert.deepEqual(detectLoopStops(t(stops)), ["Szczyrk Biła"]);
  });

  it("rejects long backtracks (>14 doubled stops)", () => {
    assert.deepEqual(detectLoopStops(t(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "A"])), []);
  });
});

describe("formatPrzezLoop", () => {
  it("declines Biła to Biłą in accusative", () => {
    assert.equal(formatPrzezLoop("Szczyrk Biła"), "Szczyrk Biłą");
  });

  it("declines Pętla to Pętlę", () => {
    assert.equal(formatPrzezLoop("Bystra Pętla"), "Bystra Pętlę");
    assert.equal(formatPrzezLoop("Międzybrodzie Żywieckie Pętla"), "Międzybrodzie Żywieckie Pętlę");
    assert.equal(formatPrzezLoop("Międzyrzecze Dolne Strefa Pętla"), "Międzyrzecze Dolne Strefa Pętlę");
  });

  it("passes other names through", () => {
    assert.equal(formatPrzezLoop("Szczyrk Centrum"), "Szczyrk Centrum");
    assert.equal(formatPrzezLoop("Czaniec Zagłębocze"), "Czaniec Zagłębocze");
    assert.equal(formatPrzezLoop("Jaworze Górne"), "Jaworze Górne");
    assert.equal(formatPrzezLoop("Kaniów Krzyż"), "Kaniów Krzyż");
    assert.equal(formatPrzezLoop(""), "");
  });
});

describe("hslColor", () => {
  it("is deterministic and falls back to brand red", () => {
    assert.equal(hslColor("120"), hslColor("120"));
    assert.match(hslColor("120"), /^hsl\(\d+,58%,46%\)$/);
    assert.equal(hslColor(null), BRAND);
    assert.equal(hslColor(""), BRAND);
  });
});

describe("isMzk & operatorColor", () => {
  it("distinguishes MZK lines and operators from KB", () => {
    assert.equal(isMzk("MZK", "1"), true);
    assert.equal(isMzk("MZK", "120"), true);
    assert.equal(isMzk("KB", "1"), false);
    assert.equal(isMzk(null, "1"), true);
    assert.equal(isMzk(null, "17"), true);
    assert.equal(isMzk(null, "N1"), true);
    assert.equal(isMzk(null, "120"), false);
    assert.equal(isMzk(null, "102"), false);
  });

  it("returns constant red for KB and characteristic blue for MZK", () => {
    assert.equal(operatorColor("KB"), BRAND_KB);
    assert.equal(operatorColor(null, "120"), BRAND_KB);
    assert.equal(operatorColor("MZK"), BRAND_MZK);
    assert.equal(operatorColor(null, "17"), BRAND_MZK);
    assert.equal(BRAND_KB, "#dc2626");
    assert.equal(BRAND_MZK, "#2563eb");
  });
});

describe("computeEta", () => {
  const stop = { id: "123", designator: "P:9", name: "TESTOWA", lat: 0, lon: 0 };
  const time = (over: Partial<TripTime>): TripTime => ({
    stop_name: "TESTOWA",
    departure_time: "10:00",
    index: 0,
    ...over,
  });
  const view = (over: Partial<TripView>): TripView => ({
    gen: 1,
    isLive: true,
    status: "ready",
    note: null,
    line: "120",
    direction: "SZCZYRK",
    rawTimes: [],
    stops: [],
    vehicle: null,
    vti: null,
    stop: null,
    routed: null,
    execId: null,
    ...over,
  });

  it("live: estimated arrival + delay + minutes-away (matched by designator -> Stop.id)", () => {
    const trip = view({
      stop,
      rawTimes: [time({ designator: 123, estimate: { time_diff: 120 } })],
    });
    assert.equal(computeEta(trip, 36000), "na Testowa: 10:02 (+2 min) · za 2 min");
  });

  it("matches by place_id -> Stop.designator when designator is absent", () => {
    const trip = view({
      stop,
      rawTimes: [time({ place_id: "P:9" })],
    });
    assert.equal(computeEta(trip, 36000), "na Testowa: 10:00 · za 0 min");
  });

  it("uses liveDelay fallback when time estimate is absent", () => {
    const trip = view({
      stop,
      rawTimes: [time({ designator: 123 })],
    });
    assert.equal(computeEta(trip, 36000, null, false, 480), "na Testowa: 10:08 (+8 min) · za 8 min");
  });

  it("static: planned arrival only", () => {
    const trip = view({ isLive: false, stop, rawTimes: [time({ designator: 123 })] });
    assert.equal(computeEta(trip, 36000), "planowany przyjazd 10:00");
  });

  it("on a doubled-stop spur prefers the visit the vehicle has not passed", () => {
    const trip = view({
      stop,
      vti: 2,
      rawTimes: [
        time({ designator: 123, departure_time: "10:00" }),
        time({ stop_name: "INNY", departure_time: "10:10" }),
        time({ stop_name: "INNY2", departure_time: "10:20" }),
        time({ designator: 123, departure_time: "10:30" }),
      ],
    });
    assert.equal(computeEta(trip, 37800), "na Testowa: 10:30 · za 0 min");
  });

  it("falls back to the vehicle's current stop when nothing matches", () => {
    const trip = view({
      vti: 1,
      rawTimes: [time({}), time({ stop_name: "DRUGA" })],
    });
    assert.equal(computeEta(trip, 0), "pojazd na: Druga");
  });
});

describe("isBusStation", () => {
  it("detects D.A. and Dworzec Autobusowy in stop names", () => {
    assert.equal(isBusStation("BIELSKO-BIAŁA D.A."), true);
    assert.equal(isBusStation("Andrychów D.A."), true);
    assert.equal(isBusStation("Kęty Dworzec Autobusowy"), true);
  });

  it("recognizes showPlatforms flag on stop object", () => {
    assert.equal(isBusStation("Zwykły Przystanek", { showPlatforms: true }), true);
  });

  it("returns false for regular bus stops even if isStation flag was set on raw stop", () => {
    assert.equal(isBusStation("Bielsko-Biała Warszawska Dworzec"), false);
    assert.equal(isBusStation("Kozy Centrum"), false);
    assert.equal(isBusStation("Szczyrk Skrzyczne"), false);
    assert.equal(isBusStation("Bestwina Centrum", { isStation: true }), false);
    assert.equal(isBusStation("Szczyrk Biła", { isStation: true }), false);
  });
});

describe("formatPlatform", () => {
  it("formats stanowisko for bus stations", () => {
    assert.equal(formatPlatform("3", true), "stanowisko 3");
    assert.equal(formatPlatform(2, true), "stanowisko 2");
  });

  it("returns empty string for non-stations or missing platform", () => {
    assert.equal(formatPlatform("3", false), "");
    assert.equal(formatPlatform(null, true), "");
    assert.equal(formatPlatform(undefined, true), "");
  });
});

describe("przystanekPlural", () => {
  it("follows Polish plural rules for stops", () => {
    assert.equal(przystanekPlural(1), "przystanek");
    assert.equal(przystanekPlural(2), "przystanki");
    assert.equal(przystanekPlural(4), "przystanki");
    assert.equal(przystanekPlural(5), "przystanków");
    assert.equal(przystanekPlural(11), "przystanków");
    assert.equal(przystanekPlural(14), "przystanków");
    assert.equal(przystanekPlural(22), "przystanki");
    assert.equal(przystanekPlural(25), "przystanków");
  });
});

describe("24h time and Polish date formatting", () => {
  it("nowHHMM formats strictly in 24h HH:MM", async () => {
    const { nowHHMM } = await import("../lib/client/format");
    const t = nowHHMM();
    assert.match(t, /^([01]\d|2[0-3]):[0-5]\d$/);
  });

  it("addMinutesToHHMM wraps around 24 hours cleanly", async () => {
    const { addMinutesToHHMM } = await import("../lib/client/format");
    assert.equal(addMinutesToHHMM("14:30", 15), "14:45");
    assert.equal(addMinutesToHHMM("14:30", 45), "15:15");
    assert.equal(addMinutesToHHMM("23:45", 30), "00:15");
    assert.equal(addMinutesToHHMM("00:15", -30), "23:45");
    assert.equal(addMinutesToHHMM("08:00", 60), "09:00");
  });

  it("offsetDateISO offsets YYYY-MM-DD by days", async () => {
    const { offsetDateISO } = await import("../lib/client/format");
    assert.equal(offsetDateISO("2026-09-13", 1), "2026-09-14");
    assert.equal(offsetDateISO("2026-09-13", 2), "2026-09-15");
    assert.equal(offsetDateISO("2026-09-30", 1), "2026-10-01");
    assert.equal(offsetDateISO("2026-09-14", -1), "2026-09-13");
  });

  it("formatDayLabel returns Dziś, Jutro, Pojutrze or short Polish date", async () => {
    const { formatDayLabel } = await import("../lib/client/format");
    const refToday = "2026-09-13";
    assert.equal(formatDayLabel("2026-09-13", refToday), "Dziś");
    assert.equal(formatDayLabel("2026-09-14", refToday), "Jutro");
    assert.equal(formatDayLabel("2026-09-15", refToday), "Pojutrze");
    const other = formatDayLabel("2026-09-16", refToday);
    assert.ok(other.length > 0);
  });

  it("formatDayFull returns full Polish description", async () => {
    const { formatDayFull } = await import("../lib/client/format");
    const full = formatDayFull("2026-09-15");
    assert.ok(full.includes("15"));
    assert.ok(full.includes("września"));
  });
});

describe("notStartedEta", () => {
  const T = (stop_name: string, departure_time: string, index: number, place_id: string): TripTime => ({
    stop_name,
    departure_time,
    index,
    place_id,
  });
  const rawTimes = [
    T("UNIWERSYTET BŁONIA", "15:05", 0, "mzk:321"),
    T("PARTYZANTÓW BELOS", "15:10", 4, "mzk:252"),
    T("BIELSKO-BIAŁA PARTYZANTÓW ANDERSA", "15:12", 5, "mzk:254"),
  ];
  const andersa = { id: "mzk:254", designator: "mzk:254", name: "BIELSKO-BIAŁA PARTYZANTÓW ANDERSA", mzkSymbol: "254" };
  const at = (h: number, m: number) => h * 3600 + m * 60;

  it("replaces the delay/ETA line of a bus that has not begun its course", () => {
    assert.equal(
      notStartedEta({ stop: null, rawTimes }, at(15, 22)),
      "Pojazd jeszcze nie wyruszył · odjazd z Uniwersytet Błonia wg rozkładu 15:05",
    );
    assert.equal(notStartedEta({ stop: null, rawTimes: [] }, 0), "Pojazd jeszcze nie wyruszył");
  });

  it("opened from a stop: the earliest possible arrival, never a delay (screenshot B/C numbers)", () => {
    // 15:22, course scheduled 15:05 and still parked -> Andersa not before 15:12 + 17 min
    const eta = notStartedEta({ stop: andersa as never, rawTimes }, at(15, 22));
    assert.match(eta, /na Bielsko-Biała Partyzantów Andersa: najwcześniej 15:29$/);
    assert.doesNotMatch(eta, /\+\d+ min/);
    // before the scheduled start the schedule stands
    assert.match(notStartedEta({ stop: andersa as never, rawTimes }, at(14, 50)), /najwcześniej 15:12$/);
  });

  it("wraps midnight", () => {
    const night = [T("A", "23:55", 0, "mzk:1"), T("B", "00:03", 1, "mzk:2")];
    const b = { id: "mzk:2", designator: "mzk:2", name: "B", mzkSymbol: "2" };
    assert.match(notStartedEta({ stop: b as never, rawTimes: night }, at(0, 5)), /najwcześniej 00:13$/); // 10 min overstay
    assert.match(notStartedEta({ stop: b as never, rawTimes: night }, at(23, 50)), /najwcześniej 00:03$/); // still early
  });
});

describe("arrivedSecs / delayStatus", () => {
  const t = (departure_time: string, time_diff?: number): TripTime => ({
    stop_name: "X",
    departure_time,
    index: 0,
    ...(time_diff !== undefined ? { estimate: { time_diff } } : {}),
  });

  it("KB: epoch arrivals become Warsaw seconds of day", () => {
    // 2026-10-15 08:04:30 UTC = 10:04:30 CEST
    const e = Date.UTC(2026, 9, 15, 8, 4, 30) / 1000;
    assert.deepEqual(arrivedSecs({ trip: { times: [t("10:00"), t("10:03")] }, arrived: [null, e] }), [null, 36270]);
  });

  it("MZK: only stops before the vehicle's index carry a recorded time", () => {
    const trip = { operator: "MZK" as const, times: [t("10:00", 15), t("10:05", -35), t("10:10", -60)] };
    assert.deepEqual(arrivedSecs({ trip, vehicle_trip_index: 2 }), [36015, 36265, null]);
    assert.equal(arrivedSecs({ trip: { times: trip.times }, vehicle_trip_index: 2 }), null, "KB without a log");
  });

  it("labels on the delayClass threshold", () => {
    assert.equal(delayStatus(60), "Na czas");
    assert.equal(delayStatus(-60), "Na czas");
    assert.equal(delayStatus(240), "Opóźniony 4 min");
    assert.equal(delayStatus(-150), "Przed czasem 3 min");
  });
});
