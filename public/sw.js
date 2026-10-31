/**
 * Service worker for PWA installability + offline app shell.
 *
 * Strategy:
 *  - /api/* is NEVER cached — live vehicle and stop data must not be served stale (the page keeps
 *    its own offline copies in "kb-offline", which activate leaves alone);
 *  - cross-origin requests (map tiles, OSRM) pass through untouched;
 *  - pre-caches app shell and icons on install for immediate offline readiness;
 *  - hashed build assets (/assets) are cache-first;
 *  - non-hashed icons / manifest are stale-while-revalidate (a changed file
 *    reaches installed PWAs on the next load);
 *  - navigations are network-first, cached per path ("/", "/brygady") with
 *    the "/" shell as the last offline fallback.
 */
// PwaRegister registers /sw.js?v=<build id>: every deploy is a new SW (update toast) whose
// activate drops the previous deploy's cache, so hashed chunks never pile up
const CACHE = "kb-shell-" + (new URL(self.location.href).searchParams.get("v") || "v2");
const SHELL = "/";

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
];

/* Pre-cache the app shell and core assets on install */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.allSettled(
        PRECACHE_URLS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: "no-cache" });
            if (resp.ok) await cache.put(url, resp);
          } catch {
            // Ignore transient network errors during install
          }
        }),
      );
    })(),
  );
});

/* No skipWaiting on install: a new SW waits until the page approves it via the
 * SKIP_WAITING message (PwaRegister's update toast). Auto-activating would swap
 * hashed /assets chunks under a running SPA and break lazy chunk loads. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// a departure alert pushed by the server (lib/push-alerts.ts) while no page is open
self.addEventListener("push", (event) => {
  let m = null;
  try {
    m = event.data && event.data.json();
  } catch {
    return;
  }
  if (!m || typeof m.title !== "string") return;
  event.waitUntil(
    self.registration.showNotification(m.title, { body: m.body, tag: m.tag, icon: "/icon-192.png", data: { url: m.url } }),
  );
});

// an alert notification (lib/client/alerts.ts) opens its stop: in the app's open tab, else a new one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window" });
      const tab = tabs.find((c) => new URL(c.url).pathname === "/");
      if (!tab) return self.clients.openWindow(url.href);
      await tab.focus();
      return tab.navigate(url.href);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // kb-offline is the page's own store (lib/client/offline.ts), not a deploy's shell
      await Promise.all(keys.filter((k) => k !== CACHE && k !== "kb-offline").map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // immutable build assets: cache-first
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      })(),
    );
    return;
  }

  // icons / manifest keep their URL across deploys: serve the cached copy, refresh it behind
  if (/\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        const fresh = fetch(req).then((resp) => {
          if (resp.ok) return cache.put(req, resp.clone()).then(() => resp);
          return resp;
        });
        if (!hit) return fresh;
        event.waitUntil(fresh.catch(() => {}));
        return hit;
      })(),
    );
    return;
  }

  // page navigations: network-first, cached shell offline
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const resp = await fetch(req);
          if (resp.ok) cache.put(url.pathname, resp.clone());
          return resp;
        } catch {
          const hit = (await cache.match(url.pathname)) ?? (await cache.match(SHELL));
          return hit ?? Response.error();
        }
      })(),
    );
  }
});
