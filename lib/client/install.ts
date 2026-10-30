"use client";

/**
 * "Zainstaluj aplikację": Chromium's deferred `beforeinstallprompt` (Android, desktop) or, on iOS,
 * the Share-sheet instructions. iOS matters most: Safari exposes `Notification` (so "Powiadom mnie"
 * and web push) only to a web app on the Home Screen, so an iPhone in the browser gets no alerts.
 * A module-level store like favorites.ts; the listeners are attached at import time (from PwaRegister,
 * the root bundle) because Chrome fires `beforeinstallprompt` once, soon after load, before the map
 * tree's chunk mounts.
 */
import { useSyncExternalStore } from "react";

export type InstallKind = "prompt" | "ios" | null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** Pure: what the install row offers. `touchPoints` tells iPadOS (a Mac user agent) from a Mac. */
export function installKind(ua: string, standalone: boolean, hasPrompt: boolean, touchPoints = 0): InstallKind {
  if (standalone) return null;
  if (hasPrompt) return "prompt";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return "ios";
  return null;
}

export const IOS_INSTALL_HINT = "Udostępnij, potem „Do ekranu początkowego”";

let deferred: BeforeInstallPromptEvent | null = null;
let snapshot: InstallKind = null;
let computed = false;
const subs = new Set<() => void>();

function isStandalone(): boolean {
  // display_override lists fullscreen / window-controls-overlay / minimal-ui too: anything but "browser"
  return (
    !window.matchMedia("(display-mode: browser)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function compute(): void {
  computed = true;
  const next = installKind(navigator.userAgent, isStandalone(), deferred !== null, navigator.maxTouchPoints);
  if (next === snapshot) return;
  snapshot = next;
  subs.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    compute();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    compute();
  });
}

function getSnapshot(): InstallKind {
  if (!computed) compute();
  return snapshot;
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Outside React (TripView's alert toast). */
export function currentInstallKind(): InstallKind {
  return typeof window === "undefined" ? null : getSnapshot();
}

export function useInstall(): InstallKind {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Opens Chromium's install dialog; the deferred event is single-use, so the row hides at once. */
export async function promptInstall(): Promise<void> {
  const ev = deferred;
  if (!ev) return;
  deferred = null;
  compute();
  try {
    await ev.prompt();
  } catch {
    /* already consumed or not allowed without a gesture: nothing to show */
  }
}
