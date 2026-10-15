"use client";

/** Reduced-motion helpers for Leaflet's JS-driven pans — the CSS
 *  prefers-reduced-motion reset can't reach flyTo/fitBounds animations.
 *  Deliberately no leaflet import: safe anywhere client-side. */

/** Live check, not cached — the user can toggle the OS setting mid-session. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Pan/zoom options honoring reduced motion — spread into flyTo/fitBounds/setView. */
export function panMotion(
  duration: number,
  easeLinearity = 0.22,
): { animate: boolean; duration: number; easeLinearity: number } {
  return prefersReducedMotion()
    ? { animate: false, duration: 0, easeLinearity }
    : { animate: true, duration, easeLinearity };
}

/** The design system's `--ease-spring`, cubic-bezier(0.32, 0.72, 0, 1), as a JS timing
 *  function: the camera glides on the same curve as the sheet it opens with. */
export function easeSpring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // x(u) = 0.96u(1-u)² + u³ has x'(u) ≥ 1/3, so Newton from u = t converges without bisection
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = 0.96 * u * (1 - u) ** 2 + u ** 3 - t;
    if (Math.abs(err) < 1e-7) break;
    u = Math.min(1, Math.max(0, u - err / (0.96 - 3.84 * u + 5.88 * u * u)));
  }
  return 2.16 * u * (1 - u) ** 2 + 3 * u * u * (1 - u) + u ** 3;
}

/** Glide length in seconds: 0.3 s for a nudge, +0.1 s per screen travelled and +0.05 s per
 *  zoom level, capped at 0.6 s — quick enough to follow a tap, long enough to read as motion. */
export function glideSeconds(screens: number, dz: number): number {
  return Math.min(0.6, 0.3 + 0.1 * screens + 0.05 * Math.abs(dz));
}
