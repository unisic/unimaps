import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { infeasible, loadOracleNet, oracleProfile, polesOf, type OracleNet } from "./support/connection-oracle";

// lib/config.ts reads env at module load and node --test runs every file in its own process
const GTFS = path.join(process.cwd(), "test", "fixtures", "gtfs");
const MZK = path.join(process.cwd(), "test", "fixtures", "mzk-timetable.v1.json");
process.env.KB_GTFS_DIR = GTFS;
process.env.KB_MZK_TIMETABLE_FILE = MZK;

let router: typeof import("../lib/router");
const DATE = "2026-09-30";
let net: OracleNet;

before(async () => {
  router = await import("../lib/router");
  net = loadOracleNet(GTFS, MZK, DATE);
});

function check(from: string, to: string, after: number, limit: number): void {
  const res = router.findConnections({ from, to, fromIds: [from], toIds: [to], date: DATE, afterSecs: after, limit });
  const origins = polesOf(net, [from], router.cleanText);
  const targets = polesOf(net, [to], router.cleanText);
  for (const it of res) assert.equal(infeasible(net, it, origins, targets, after), null, `${from} -> ${to} ${it.departureTime}`);
  assert.deepEqual(
    res.map((it) => ({ dep: it.departureSecs, arr: it.arrivalSecs, transfers: it.transfersCount })),
    oracleProfile(net, origins, targets, after, limit),
    `${from} -> ${to} after ${after}`,
  );
}

describe("findConnections against a brute-force profile", () => {
  it("matches on the corridors of the router tests (direct, transfers, walking, across midnight)", () => {
    check("10000", "21141", 10 * 3600, 5);
    check("10431", "21141", 8 * 3600, 5);
    check("21031", "40000", 11 * 3600, 5);
    check("25461", "40000", 15 * 3600, 5);
    check("10000", "40000", 22 * 3600 + 30 * 60, 5);
  });

  it("matches a KB -> MZK journey with a walk between operators", () => {
    check("22191", "mzk:456", 21 * 3600, 3);
  });

  it("matches on 12 seeded random pairs of stops", () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const kb = net.ids.filter((id) => !id.startsWith("mzk:"));
    for (let i = 0; i < 12; i++) check(kb[rnd(kb.length)], kb[rnd(kb.length)], 4 * 3600 + rnd(18) * 3600, 5);
  });
});
