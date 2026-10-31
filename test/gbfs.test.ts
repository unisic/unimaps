import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeGbfs } from "../lib/gbfs";

const info = {
  data: {
    stations: [
      { station_id: "1", name: "27210", lat: 50.1141, lon: 19.0066, rental_uris: { web: "https://nxtb.it/p/1" } },
      { station_id: "2", name: "27211", lat: 50.2, lon: 19.1 },
      { station_id: "3", name: "bad", lat: "x", lon: 19 },
      { station_id: "4", name: "closed", lat: 50.3, lon: 19.2 },
      { station_id: "5", name: "nostatus", lat: 50.3, lon: 19.2 },
    ],
  },
};
const status = {
  data: {
    stations: [
      { station_id: "1", num_bikes_available: 6, num_docks_available: 0, is_installed: true, is_renting: true },
      { station_id: "2", num_bikes_available: -1, is_installed: true, is_renting: true },
      { station_id: "3", num_bikes_available: 1, is_installed: true, is_renting: true },
      { station_id: "4", num_bikes_available: 2, is_installed: true, is_renting: false },
    ],
  },
};

describe("mergeGbfs", () => {
  it("joins information with status; drops bad coordinates, closed and status-less stations", () => {
    assert.deepEqual(mergeGbfs(info, status), [
      { id: "1", name: "27210", lat: 50.1141, lon: 19.0066, bikes: 6, docks: 0, url: "https://nxtb.it/p/1" },
      { id: "2", name: "27211", lat: 50.2, lon: 19.1, bikes: 0, docks: 0, url: null },
    ]);
  });
  it("tolerates garbage documents", () => {
    assert.deepEqual(mergeGbfs(null, {}), []);
    assert.deepEqual(mergeGbfs({ data: { stations: "x" } }, { data: {} }), []);
  });
});
