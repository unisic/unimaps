/**
 * Poll-loop controller for live boards (framework-free, dependency-injected so
 * it is testable with a fake clock). The React hook is a thin wrapper:
 *
 *   const p = createLivePoll({ load, onOk, onFail, isVisible: () => !document.hidden });
 *   p.start();  // on mount / tab becomes "live"
 *   p.kick();   // visibilitychange / pageshow / focus / online
 *   p.tick();   // the existing 5 s UI tick = watchdog
 *   p.stop();   // on unmount / tab leaves "live"  (aborts in-flight)
 *
 * Guarantees (each pinned by test/live-poll.test.ts):
 *  - never two requests in flight (no pile-up when the network is slow);
 *  - the next poll is armed AFTER the previous one settles (setTimeout chain,
 *    not setInterval), 10 s healthy / 20-40-60 s backoff on failures;
 *  - every request has its own timeout (a hung mobile socket cannot wedge the chain);
 *  - a hidden page keeps the chain armed but does not fetch; becoming visible
 *    catches up immediately if the data is >= 5 s old;
 *  - the watchdog re-arms a chain whose timer was lost (OS throttling / freeze);
 *  - stop() aborts the in-flight request and a late response is ignored.
 */
/* ---- cadence / timeouts ---- */
export const LIVE_POLL_MS = 10_000;
/** Backoff ceiling after consecutive failures (data older than LIVE_STALE_MS is flagged anyway; 30 s keeps recovery snappy). */
export const LIVE_POLL_MAX_MS = 30_000;
/** Per-request timeout: a hung mobile socket must not wedge the chain. */
export const LIVE_FETCH_TIMEOUT_MS = 12_000;
/** Age after which the UI must say the data is old. */
export const LIVE_STALE_MS = 45_000;
/** Visibility / online / focus catch-up fires only if the data is at least this old. */
export const LIVE_CATCHUP_MS = 5_000;

/**
 * Delay before the next poll: 10 s while healthy, 20 s then 30 s (cap) after
 * consecutive failures, ±15 % jitter so clients that opened together drift apart.
 */
export function nextPollDelayMs(failures: number, rnd: () => number = Math.random): number {
  const base = failures <= 0 ? LIVE_POLL_MS : Math.min(LIVE_POLL_MAX_MS, LIVE_POLL_MS * 2 ** Math.min(failures, 6));
  const jitter = 1 + (rnd() * 0.3 - 0.15);
  return Math.round(base * jitter);
}

/** Should a visibility / online / focus / pageshow event trigger an immediate refetch? */
export function shouldCatchUp(lastOkMs: number | null, nowMs: number, inflight: boolean, minAgeMs = LIVE_CATCHUP_MS): boolean {
  if (inflight) return false;
  return lastOkMs == null || nowMs - lastOkMs >= minAgeMs;
}

/** Grace after a poll was due before the watchdog calls the timer chain dead. */
export const LIVE_WATCHDOG_GRACE_MS = 5_000;

/**
 * Watchdog (runs on the 5 s UI tick). The poll timer was armed for `dueAtMs`;
 * if that moment is long gone and nothing is in flight, the chain was lost
 * (throttled / frozen / swallowed by the OS) and must be re-armed. Works for
 * any backoff because it compares against the due time, not a fixed cadence.
 */
export function chainLooksDead(
  dueAtMs: number | null,
  nowMs: number,
  inflight: boolean,
  graceMs = LIVE_WATCHDOG_GRACE_MS,
): boolean {
  if (inflight || dueAtMs == null) return false;
  return nowMs > dueAtMs + graceMs;
}


export interface LivePollDeps<T> {
  load: (signal: AbortSignal) => Promise<T>;
  /** a request is about to start (drives the "refreshing" flag) */
  onStart?: () => void;
  onOk: (payload: T, at: number) => void;
  onFail: (err: unknown, at: number) => void;
  now?: () => number;
  isVisible?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  rnd?: () => number;
  timeoutMs?: number;
}

export interface LivePoll {
  start(): void;
  stop(): void;
  /** visibility / pageshow / focus / online: refetch now if the data is old enough */
  kick(): void;
  /** watchdog: call from a ~5 s UI tick */
  tick(): void;
  /** manual retry button: refetch now regardless of age (still never overlaps) */
  refreshNow(): void;
  stats(): { inflight: boolean; failures: number; lastOk: number | null; dueAt: number | null; running: boolean };
}

export function createLivePoll<T>(d: LivePollDeps<T>): LivePoll {
  const now = d.now ?? Date.now;
  const isVisible = d.isVisible ?? (() => true);
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timeoutMs = d.timeoutMs ?? LIVE_FETCH_TIMEOUT_MS;

  let running = false;
  let inflight = false;
  let failures = 0;
  let lastOk: number | null = null;
  let timer: unknown = null;
  let dueAt: number | null = null;
  let ac: AbortController | null = null;

  const disarm = (): void => {
    if (timer != null) clearTimer(timer);
    timer = null;
    dueAt = null;
  };

  const arm = (ms: number): void => {
    disarm();
    dueAt = now() + ms;
    timer = setTimer(() => {
      timer = null;
      void run();
    }, ms);
  };

  async function run(): Promise<void> {
    if (!running || inflight) return;
    if (!isVisible()) {
      arm(LIVE_POLL_MS); // stay armed, don't fetch while nobody is looking
      return;
    }
    disarm();
    inflight = true;
    const ctl = new AbortController();
    ac = ctl;
    const to = setTimer(() => ctl.abort(), timeoutMs);
    d.onStart?.();
    try {
      const payload = await d.load(ctl.signal);
      if (running) {
        failures = 0;
        lastOk = now();
        d.onOk(payload, lastOk);
      }
    } catch (err) {
      if (running) {
        failures++;
        d.onFail(err, now());
      }
    } finally {
      clearTimer(to);
      inflight = false;
      ac = null;
      if (running) arm(nextPollDelayMs(failures, d.rnd));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      void run();
    },
    stop() {
      running = false;
      disarm();
      ac?.abort();
    },
    kick() {
      if (!running || !isVisible()) return;
      if (!shouldCatchUp(lastOk, now(), inflight)) return;
      disarm();
      void run();
    },
    tick() {
      if (running && chainLooksDead(dueAt, now(), inflight)) void run();
    },
    refreshNow() {
      if (!running || inflight) return;
      disarm();
      void run();
    },
    stats: () => ({ inflight, failures, lastOk, dueAt, running }),
  };
}
