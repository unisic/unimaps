/**
 * Next.js instrumentation hook — starts the live poller once per Node.js
 * server process at boot.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPoller } = await import("./lib/poller-singleton");
    const { log } = await import("./lib/logger");
    void startPoller().catch((err: unknown) => {
      log.error("rt", `background poller start failed: ${err}`);
    });
    // GZM runs beside the BB pollers, never inside startPoller: its failure must not touch BB
    const { GZM_ENABLED, PUSH_ENABLED } = await import("./lib/config");
    if (GZM_ENABLED) {
      const { startGzm } = await import("./lib/gzm");
      void startGzm().catch((err: unknown) => {
        log.error("gzm", `GZM start failed: ${err}`);
      });
    }
    // alerts persisted before a restart resume firing without waiting for a request
    if (PUSH_ENABLED) (await import("./lib/push-alerts")).getPushAlerts();
    if (PUSH_ENABLED) (await import("./lib/push-news")).getPushNews();
  }
}
