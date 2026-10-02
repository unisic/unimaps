import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, beforeEach } from "node:test";
import "./support/tmp-output"; // first: redirects KB_OUTPUT_DIR before lib/config is evaluated
import { MZK_STOP_DIRS_FILE as DIRS_FILE } from "../lib/config";
import { MzkPoller } from "../lib/mzk-poller";
import type { MzkApi, MzkRunningVehicle, MzkStopPoint } from "../lib/mzk-api";


const sp = (symbol: string, lat: number, lon: number, id = Number(symbol)): MzkStopPoint => ({
  id, longitude: lon, latitude: lat, symbol, name: `Stop ${symbol}`, street: null, city: null, distance: null, virtual: false, onRequest: false, gettingOut: false,
});
class FakeApi {
  stopsCalls = 0;
  stopsReply: MzkStopPoint[] = [];
  stopsFail = false;
  running: Partial<MzkRunningVehicle>[] = [];
  async fetchStops() { this.stopsCalls++; if (this.stopsFail) throw new Error("boom"); return this.stopsReply; }
  async fetchLines() { return []; }
  async fetchVehicles() { return []; }
  async fetchRunningVehicles() { return this.running as MzkRunningVehicle[]; }
}
const veh = (variant: number, symbols: string[]): Partial<MzkRunningVehicle> => ({
  lineName: "1", courseLoid: variant * 10, vehicleId: "100", variantLoid: variant, latitude: 49.8, longitude: 19.0, angle: 0, delaySec: 0,
  orderInCourse: 0, reachedMeters: 0, stopPoints: symbols.map((symbol, i) => ({ symbol, name: symbol, orderNo: i, street: null, distance: i * 100, scheduledDeparture: 0, plannedDeparture: 0 })),
});
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("MzkPoller stop-list lifecycle (patched)", () => {
  beforeEach(() => { try { fs.unlinkSync(DIRS_FILE); } catch { /* none */ } });

  it("an empty upstream list never wipes a good one", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    assert.equal(await p.loadStops(), true);
    assert.equal(p.stops.length, 2);
    api.stopsReply = [];
    assert.equal(await p.loadStops(), false);
    assert.equal(p.stops.length, 2);
    assert.equal(p.stopsBySymbol.size, 2);
  });

  it("a reload swaps stops and stopsBySymbol together and stamps stopsLoadedAt", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    const before = p.stopsBySymbol;
    api.stopsReply = [sp("1", 49.80, 19.0), sp("265", 49.827, 19.036)];
    await p.loadStops();
    assert.notEqual(p.stopsBySymbol, before); // new Map, not mutated in place
    assert.equal(p.stopsBySymbol.get("265")?.name, "Stop 265");
    assert.ok(p.stopsLoadedAt > 0);
  });

  it("a running course that references an unknown symbol triggers ONE reload, throttled to 10 min", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    const calls0 = api.stopsCalls;
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0), sp("265", 49.82, 19.0)]; // upstream re-versioned: new stop
    api.running = [veh(1, ["1", "265", "2"]), veh(2, ["00", "1", "2"])]; // "00" (depot) must not count
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1);
    assert.equal(p.stopsBySymbol.has("265"), true);
    await p.pollOnce(); // still unknown? no — but even if it were, the 10-min throttle holds
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1);
  });

  it("depot-only unknown symbol ('00') never triggers a reload", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    const calls0 = api.stopsCalls;
    api.running = [veh(5, ["00", "1", "2"])];
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0);
  });

  it("a day-old list is reloaded; a failed reload keeps the list and backs off 30 min", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    p.stopsLoadedAt = Date.now() / 1000 - 90_000; // > 86 400 s
    api.stopsFail = true;
    api.running = [veh(7, ["1", "2"])];
    const calls0 = api.stopsCalls;
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1);
    assert.equal(p.stops.length, 2); // kept
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1); // backed off
  });

  it("learns stop directions from running courses and persists them", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("A", 49.80, 19.0), sp("B", 49.81, 19.0), sp("C", 49.82, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    api.running = [veh(9, ["A", "B", "C"])];
    await p.pollOnce();
    assert.deepEqual(p.stopDirs.dirs().get("B"), [0]);
    assert.equal(fs.existsSync(DIRS_FILE), true);
    const saved = JSON.parse(fs.readFileSync(DIRS_FILE, "utf8"));
    assert.equal(saved.v, 2);
    assert.deepEqual(saved.variants, [9]);
    fs.unlinkSync(DIRS_FILE);
  });

  it("a symbol that stays unknown after a reload does not trigger another one; a NEW unknown symbol does (after the throttle)", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    const priv = p as unknown as { stopsReloadAttemptAt: number };
    const calls0 = api.stopsCalls;
    api.running = [veh(1, ["1", "TECH", "2"])]; // TECH is never in getStops
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1); // first sighting: one reload, TECH stays unknown
    priv.stopsReloadAttemptAt = 0; // pretend the 10 min throttle passed
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1); // same unknown symbol: handled, no reload loop
    api.running = [veh(1, ["1", "TECH", "NEW", "2"])];
    priv.stopsReloadAttemptAt = 0;
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 2); // a genuinely new unknown symbol retriggers
  });

  it("a failed reload forgets what it tried, so the unknown symbol is retried after the throttle", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    const priv = p as unknown as { stopsReloadAttemptAt: number };
    const calls0 = api.stopsCalls;
    api.stopsFail = true;
    api.running = [veh(1, ["1", "NEW", "2"])];
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 1);
    priv.stopsReloadAttemptAt = 0;
    api.stopsFail = false;
    api.stopsReply = [sp("1", 49.80, 19.0), sp("2", 49.81, 19.0), sp("NEW", 49.82, 19.0)];
    await p.pollOnce();
    await settle();
    assert.equal(api.stopsCalls, calls0 + 2);
    assert.equal(p.stopsBySymbol.has("NEW"), true);
  });

  it("a reload in which a learned stop moved resets the learned directions", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("A", 49.80, 19.0), sp("B", 49.81, 19.0), sp("C", 49.82, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    api.running = [veh(9, ["A", "B", "C"])];
    await p.pollOnce();
    assert.equal(p.stopDirs.dirs().has("B"), true);
    api.stopsReply = [sp("A", 49.80, 19.0), sp("B", 49.8115, 19.0), sp("C", 49.82, 19.0)]; // B re-surveyed 165 m north
    await p.loadStops();
    assert.equal(p.stopDirs.size, 0);
  });

  it("a second learned variant within a minute is saved by the trailing flush", async () => {
    const api = new FakeApi();
    api.stopsReply = [sp("A", 49.80, 19.0), sp("B", 49.81, 19.0), sp("C", 49.82, 19.0)];
    const p = new MzkPoller(api as unknown as MzkApi);
    await p.loadStops();
    api.running = [veh(9, ["A", "B", "C"])];
    await p.pollOnce();
    assert.deepEqual(JSON.parse(fs.readFileSync(DIRS_FILE, "utf8")).variants, [9]);
    api.running = [veh(9, ["A", "B", "C"]), veh(10, ["C", "B", "A"])];
    await p.pollOnce();
    assert.deepEqual(JSON.parse(fs.readFileSync(DIRS_FILE, "utf8")).variants, [9]); // debounced
    p.flushStopDirs();
    assert.deepEqual(JSON.parse(fs.readFileSync(DIRS_FILE, "utf8")).variants.sort(), [10, 9]);
    fs.unlinkSync(DIRS_FILE);
  });
});
