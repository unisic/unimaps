/**
 * Tiny in-memory per-IP token bucket for the upstream-forwarding routes, so the
 * open passthrough can't be turned into a flood/amplifier against the upstream
 * API. Limits are deliberately generous — the app's own bursts (e.g. a stop's
 * timetable fanning out one /api/trip per departure) pass; only sustained abuse
 * is throttled. In-memory is fine here: the server is a single long-lived Node
 * process (it owns the poller singleton), not a swarm of serverless instances.
 */
import * as config from "./config";

const CAP = 600; // burst capacity per IP (accommodates 300+ departure timetable fan-outs)
const REFILL_PER_SEC = 40; // sustained requests/sec per IP once the burst is spent
const MAX_KEY_LEN = 64; // headers are client-controlled; don't key on arbitrary blobs
const MAX_BUCKETS = 10_000; // hard cap so spoofed keys can't grow the map unbounded
const SWEEP_EVERY_MS = 10_000; // a full-map idle sweep at most this often, not on every request of a flood

interface Bucket {
  tokens: number;
  last: number;
}
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweepIdle(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [k, v] of buckets) if (now - v.last > 60_000) buckets.delete(k);
}

// Global backstop across ALL clients: even when per-IP keys are spoofed
// (direct exposure, forged X-Forwarded-For), total upstream throughput stays
// bounded. Burst capacity keeps the same 8:1 ratio as the per-IP bucket.
const GLOBAL_REFILL_PER_SEC = config.RATE_LIMIT_GLOBAL;
const GLOBAL_CAP = GLOBAL_REFILL_PER_SEC * 8;
const globalBucket: Bucket = { tokens: GLOBAL_CAP, last: Date.now() };

// Event-loop time for synchronous searches (`/api/connections`: RAPTOR on the loop every poller and request
// shares), process-wide in milliseconds: a GZM search costs 40-150 ms, the per-IP buckets do not bound a flood
// from many IPs, and a measured charge makes a memo hit near free and a bigger city cost more. A GZM flood of 24
// searches/s left the loop's worst lag at 173 ms with it and 617 ms without (2026-11-05).
// ponytail: a fixed share of the one event loop; run the search in worker_threads to lift it
const SEARCH_MS_PER_SEC = 250;
const SEARCH_CAP_MS = 200;
// The same loop time also comes out of the client's own bucket, one token per 2.5 ms: at 40 tokens/s one IP
// holds at most 100 ms/s of the 250, so a single client inside its request limit cannot lock everyone out.
const SEARCH_MS_PER_TOKEN = 2.5;
const searchBucket: Bucket = { tokens: SEARCH_CAP_MS, last: Date.now() };

function refill(b: Bucket, now: number, cap: number, perSec: number): void {
  // a wall clock stepped back must not drain a bucket
  b.tokens = Math.min(cap, b.tokens + (Math.max(0, now - b.last) / 1000) * perSec);
  b.last = now;
}

/**
 * Best-effort client IP: the LAST X-Forwarded-For entry. Behind one trusted
 * proxy that is the proxy-set peer whether it appends (adds the socket IP
 * last) or overwrites (leaves exactly one entry); exposed directly, Next
 * stamps the header from the socket only when the client sent none. A direct
 * client that supplies its own XFF forges every entry — the first entry is
 * never safer, which is why there is no "trusted proxy" mode. Per-IP keying
 * is best-effort by nature here; the global bucket bounds total abuse.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    return parts[parts.length - 1]!.trim() || "local";
  }
  return req.headers.get("x-real-ip") || "local";
}

/**
 * true = allowed; false = over the limit (caller should return 429). `cost` = upstream fetches the
 * request will make (a batch route charges one per id), so one token never buys a fan-out.
 */
export function allowRequest(ip: string, cost = 1): boolean {
  const now = Date.now();
  const key = ip.slice(0, MAX_KEY_LEN);
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) {
      sweepIdle(now);
      // still full: evict oldest-inserted entries (cheap via Map iteration order)
      while (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    b = { tokens: CAP, last: now };
    buckets.set(key, b);
  } else {
    refill(b, now, CAP, REFILL_PER_SEC);
  }
  refill(globalBucket, now, GLOBAL_CAP, GLOBAL_REFILL_PER_SEC);
  // opportunistic sweep so idle IPs don't accumulate in a long-lived process
  if (buckets.size > 5000) sweepIdle(now);
  if (b.tokens < cost || globalBucket.tokens < cost) return false;
  b.tokens -= cost;
  globalBucket.tokens -= cost;
  return true;
}

/** true = a synchronous search may run now: the process-wide loop-time budget is not overdrawn. */
export function allowSearch(): boolean {
  refill(searchBucket, Date.now(), SEARCH_CAP_MS, SEARCH_MS_PER_SEC);
  return searchBucket.tokens > 0;
}

/**
 * Charge the event-loop time a search took to the process-wide budget and to `ip`'s bucket; a long search may
 * overdraw either, later ones wait the debt out.
 */
export function chargeSearch(ip: string, ms: number): void {
  refill(searchBucket, Date.now(), SEARCH_CAP_MS, SEARCH_MS_PER_SEC);
  searchBucket.tokens -= ms;
  const b = buckets.get(ip.slice(0, MAX_KEY_LEN));
  if (b) b.tokens -= ms / SEARCH_MS_PER_TOKEN;
}

/** 429 response with a Retry-After hint. */
export function tooManyRequests(): Response {
  return Response.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": "5" } },
  );
}
