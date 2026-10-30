"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Toast from "@/components/Toast";
// attaches the beforeinstallprompt listener with the root bundle, before the map chunk mounts
import "@/lib/client/install";

const UPDATE_CHECK_MS = 60 * 60_000;

/**
 * Registers the service worker (production only — dev HMR and a SW cache fight
 * each other) and drives the update flow: a freshly installed SW *waits*
 * (sw.js no longer auto-skipWaiting), we show a toast, and only after the user
 * accepts do we message SKIP_WAITING and reload on controllerchange.
 */
export default function PwaRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  /* reload only after an explicit accept: clients.claim() fires controllerchange
     on the very first install too — an unconditional reload would refresh every
     first-time visitor */
  const acceptedRef = useRef(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const onControllerChange = (): void => {
      if (!acceptedRef.current || refreshingRef.current) return;
      refreshingRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let reg: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    const onVisibility = (): void => {
      // a standalone PWA rarely navigates, so the browser's built-in update
      // check may never run — poke it when the tab returns after a while
      if (document.hidden || !reg) return;
      if (Date.now() - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = Date.now();
      reg.update().catch(() => {
        /* offline — try again next time */
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

    navigator.serviceWorker
      .register(`/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID ?? ""}`)
      .then((r) => {
        reg = r;
        // an update downloaded on a previous visit is already waiting
        if (r.waiting && navigator.serviceWorker.controller) setWaiting(r.waiting);
        r.addEventListener("updatefound", () => {
          const sw = r.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            // "installed" with an active controller = a new version is waiting;
            // without a controller it's the very first install (nothing to swap)
            if (sw.state === "installed" && navigator.serviceWorker.controller) setWaiting(r.waiting);
          });
        });
      })
      .catch(() => {
        /* unsupported / blocked — the app works fine without it */
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const accept = useCallback(() => {
    if (!waiting) return;
    acceptedRef.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    setWaiting(null);
  }, [waiting]);

  const dismiss = useCallback(() => setWaiting(null), []);

  if (!waiting) return null;
  return <Toast text="Dostępna nowa wersja aplikacji" actionLabel="Odśwież" onAction={accept} onClose={dismiss} />;
}
