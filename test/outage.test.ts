import assert from "node:assert/strict";
import test from "node:test";

import { outageText } from "@/lib/client/outage";
import type { SourceStatus, StatusBody } from "@/lib/shared/status";

const src = (name: string, state: SourceStatus["state"], blame?: SourceStatus["blame"]): SourceStatus => ({
  name,
  state,
  vehicles: 0,
  age: null,
  ...(blame ? { error: "upstream offline", blame } : {}),
});

const body = (bb: SourceStatus[], krasnik: SourceStatus[] = [src("zbiorkom", "ok")]): StatusBody => ({
  checked_at: 0,
  cities: [
    { city: "bb", name: "Bielsko-Biała", sources: bb },
    { city: "krasnik", name: "Kraśnik", sources: krasnik },
  ],
});

test("names the BB operators down on their side", () => {
  assert.equal(
    outageText(body([src("KB", "ok"), src("MZK", "down", "upstream")]), "bb", "KB + MZK"),
    "MZK: brak danych na żywo, awaria po stronie przewoźnika.",
  );
});

test("a zbiorkom city is named by its agency", () => {
  assert.equal(
    outageText(body([], [src("zbiorkom", "down", "upstream")]), "krasnik", "MPK Kraśnik"),
    "MPK Kraśnik: brak danych na żywo, awaria po stronie źródła danych.",
  );
});

test("says nothing for an outage of ours, an empty night, SDIP or another city", () => {
  assert.equal(outageText(body([src("MZK", "down", "ours")]), "bb", ""), null);
  assert.equal(outageText(body([src("MZK", "empty")]), "bb", ""), null);
  assert.equal(outageText(body([], [src("SDIP", "down", "upstream")]), "krasnik", ""), null);
  assert.equal(outageText(body([src("MZK", "down", "upstream")]), "krasnik", ""), null);
});
