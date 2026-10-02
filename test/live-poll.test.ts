import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIVE_FETCH_TIMEOUT_MS } from "../lib/client/live-poll";
import { createLivePoll } from "../lib/client/live-poll";

/** Deterministic clock: timers fire in order as `advance` moves time; microtasks are flushed between them. */
class FakeClock {
  t = 1_000_000;
  private id = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.id;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  async flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) if (tm.at <= end && tm.at < nextAt) [nextId, nextAt] = [id, tm.at];
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = tm.at;
      tm.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}

function harness(opts: { visible?: () => boolean; load?: (signal: AbortSignal, n: number) => Promise<string> } = {}) {
  const clock = new FakeClock();
  const calls: Array<{ at: number; signal: AbortSignal }> = [];
  const oks: Array<{ at: number; payload: string }> = [];
  const fails: Array<{ at: number; err: unknown }> = [];
  const starts: number[] = [];
  const poll = createLivePoll<string>({
    onStart: () => starts.push(clock.t),
    load: (signal) => {
      calls.push({ at: clock.t, signal });
      return opts.load ? opts.load(signal, calls.length) : Promise.resolve(`r${calls.length}`);
    },
    onOk: (payload, at) => oks.push({ at, payload }),
    onFail: (err, at) => fails.push({ at, err }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isVisible: opts.visible,
    rnd: () => 0.5, // no jitter
  });
  return { clock, calls, oks, fails, starts, poll };
}

/** start the loop and let the first (synchronous-start) request settle, like a real event loop would */
const boot = async (h: { poll: { start(): void }; clock: FakeClock }): Promise<void> => {
  h.poll.start();
  await h.clock.flush();
};

const abortable = (signal: AbortSignal): Promise<never> =>
  new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));

describe("createLivePoll — cadence", () => {
  it("polls immediately, then every 10 s (4 polls in 35 s)", async () => {
    const h = harness();
    await boot(h);
    await h.clock.flush();
    assert.equal(h.calls.length, 1);
    await h.clock.advance(35_000);
    assert.equal(h.calls.length, 4);
    assert.deepEqual(h.calls.map((c) => c.at - 1_000_000), [0, 10_000, 20_000, 30_000]);
    h.poll.stop();
  });

  it("start() twice does not double the chain", async () => {
    const h = harness();
    await boot(h);
    h.poll.start();
    await h.clock.flush();
    await h.clock.advance(25_000);
    assert.equal(h.calls.length, 3);
    h.poll.stop();
  });
});

describe("createLivePoll — onStart", () => {
  it("fires once per request, right before it is sent", async () => {
    const h = harness();
    await boot(h);
    await h.clock.advance(10_001);
    assert.equal(h.starts.length, 2);
    assert.equal(h.starts.length, h.calls.length);
    h.poll.stop();
  });
});

describe("createLivePoll — no pile-ups", () => {
  it("never overlaps: a slow request delays the next poll instead of stacking another one", async () => {
    let release: (v: string) => void = () => {};
    const h = harness({ load: (_s, n) => (n === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve("ok")) });
    await boot(h);
    await h.clock.advance(9_000); // still the first request in flight
    h.poll.kick(); // visibility catch-up must not start a second one
    h.poll.refreshNow(); // neither must the manual button
    h.poll.tick();
    await h.clock.advance(2_000);
    assert.equal(h.calls.length, 1);
    release("slow");
    await h.clock.flush();
    assert.equal(h.oks.length, 1);
    await h.clock.advance(10_001); // next poll is armed AFTER settle: 10 s later
    assert.equal(h.calls.length, 2);
    h.poll.stop();
  });

  it("a hung request is aborted after the timeout and counts as a failure (backoff 20 s)", async () => {
    const h = harness({ load: (s, n) => (n === 1 ? abortable(s) : Promise.resolve("ok")) });
    await boot(h);
    await h.clock.advance(LIVE_FETCH_TIMEOUT_MS + 1);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.fails.length, 1);
    assert.equal(h.poll.stats().failures, 1);
    const failedAt = h.fails[0].at;
    await h.clock.advance(19_000);
    assert.equal(h.calls.length, 1); // still backing off
    await h.clock.advance(2_000);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].at - failedAt, 20_000);
    h.poll.stop();
  });
});

describe("createLivePoll — failures and recovery", () => {
  it("backs off 20 / 30 / 30 s and resets to 10 s after a success", async () => {
    let failing = true;
    const h = harness({ load: () => (failing ? Promise.reject(new Error("502")) : Promise.resolve("ok")) });
    await boot(h);
    await h.clock.advance(200_000);
    const gaps = h.calls.slice(1).map((c, i) => c.at - h.calls[i].at);
    assert.deepEqual(gaps.slice(0, 4), [20_000, 30_000, 30_000, 30_000]);
    failing = false;
    await h.clock.advance(30_001); // next attempt succeeds
    const n = h.calls.length;
    await h.clock.advance(10_001);
    assert.equal(h.calls.length, n + 1); // back on the 10 s cadence
    assert.equal(h.poll.stats().failures, 0);
    h.poll.stop();
  });
});

describe("createLivePoll — visibility", () => {
  it("hidden page: stays armed but does not fetch; becoming visible catches up at once", async () => {
    let visible = false;
    const h = harness({ visible: () => visible });
    await boot(h);
    await h.clock.advance(60_000);
    assert.equal(h.calls.length, 0);
    visible = true;
    h.poll.kick();
    await h.clock.flush();
    assert.equal(h.calls.length, 1);
    h.poll.stop();
  });

  it("kick() right after a fresh success is ignored (< 5 s old), but not once it is old enough", async () => {
    const h = harness();
    await boot(h);
    await h.clock.advance(1_000);
    h.poll.kick();
    await h.clock.flush();
    assert.equal(h.calls.length, 1);
    await h.clock.advance(5_000);
    h.poll.kick();
    await h.clock.flush();
    assert.equal(h.calls.length, 2);
    h.poll.stop();
  });
});

describe("createLivePoll — watchdog and stop", () => {
  it("re-arms a chain whose timer was lost (OS freeze / throttling), once it is overdue", async () => {
    const h = harness();
    await boot(h);
    await h.clock.advance(1_000);
    h.clock.timers.clear(); // the timer vanished, as after an iOS suspend
    h.clock.t += 60_000; // time passes
    h.poll.tick();
    await h.clock.flush();
    assert.equal(h.calls.length, 2);
    h.poll.stop();
  });

  it("watchdog leaves a healthy chain alone", async () => {
    const h = harness();
    await boot(h);
    await h.clock.advance(4_000);
    h.poll.tick();
    await h.clock.advance(4_000);
    h.poll.tick();
    await h.clock.flush();
    assert.equal(h.calls.length, 1);
    h.poll.stop();
  });

  it("stop() aborts the in-flight request, ignores its late result and arms nothing", async () => {
    let release: (v: string) => void = () => {};
    const h = harness({ load: () => new Promise<string>((r) => (release = r)) });
    await boot(h);
    await h.clock.flush();
    h.poll.stop();
    assert.equal(h.calls[0].signal.aborted, true);
    release("late");
    await h.clock.advance(60_000);
    assert.equal(h.oks.length, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.clock.timers.size, 0);
  });
});
