/**
 * Offline copies of what the page already fetched (the stop list, favourite stops' timetables) in the
 * Cache API under "kb-offline", a name the service worker's activate keeps across deploys. The SW
 * itself still never caches /api/*: the page decides what is worth keeping, as resolved data.
 * Every call is best effort: no Cache API (plain http, old browser) or a failed write only means
 * nothing is saved, never an error in the caller.
 */
export const OFFLINE_CACHE = "kb-offline";
const PREFIX = "/offline/";

function open(): Promise<Cache> | null {
  return typeof caches === "undefined" ? null : caches.open(OFFLINE_CACHE);
}

export async function saveOffline(key: string, data: unknown): Promise<void> {
  try {
    const c = await open();
    await c?.put(PREFIX + key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }));
  } catch {
    /* quota / storage blocked */
  }
}

export async function loadOffline<T>(key: string): Promise<T | null> {
  try {
    const hit = await (await open())?.match(PREFIX + key);
    return hit ? ((await hit.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Drop every saved entry whose key `keep` rejects (unfavourited stops, past days). */
export async function pruneOffline(keep: (key: string) => boolean): Promise<void> {
  try {
    const c = await open();
    if (!c) return;
    for (const req of await c.keys()) {
      const key = new URL(req.url).pathname.slice(PREFIX.length);
      if (!keep(key)) await c.delete(req);
    }
  } catch {
    /* storage blocked */
  }
}
