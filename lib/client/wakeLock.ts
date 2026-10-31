/**
 * Screen wake lock shared by the features that watch a moving bus (follow, alight alarm): held while at
 * least one holder is active, re-acquired when the tab comes back (the browser drops it on hide).
 * No-op where the API is missing (Firefox, older Safari).
 */
let holders = 0;
let lock: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  if (lock || holders === 0 || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  try {
    const l = await navigator.wakeLock.request("screen");
    // released by the holders while the request was in flight
    if (holders === 0) return void l.release();
    lock = l;
    l.addEventListener("release", () => {
      if (lock === l) lock = null;
    });
  } catch {
    /* low battery, hidden document, permission policy: the feature works without it */
  }
}

function onVisibility(): void {
  if (document.visibilityState === "visible") void acquire();
}

/** Hold the screen on; the returned release is idempotent. */
export function holdWakeLock(): () => void {
  if (holders++ === 0) document.addEventListener("visibilitychange", onVisibility);
  void acquire();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holders > 0) return;
    document.removeEventListener("visibilitychange", onVisibility);
    void lock?.release();
    lock = null;
  };
}
