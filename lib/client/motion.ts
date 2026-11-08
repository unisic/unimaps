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

/** A CSS cubic-bezier(x1, y1, x2, y2) timing function. Newton from u = t converges without bisection
 *  while x'(u) stays well above 0: ≥ 1/3 for easeSpring, ≥ 0.56 for easeFly. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bez = (u: number, a: number, b: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = bez(u, x1, x2) - t;
      if (Math.abs(err) < 1e-7) break;
      const dx = 3 * x1 * (1 - u) ** 2 + 6 * (x2 - x1) * u * (1 - u) + 3 * (1 - x2) * u * u;
      u = Math.min(1, Math.max(0, u - err / dx));
    }
    return bez(u, y1, y2);
  };
}

/** The design system's `--ease-spring`, cubic-bezier(0.32, 0.72, 0, 1), as a JS timing
 *  function: the camera glides on the same curve as the sheet it opens with. */
export const easeSpring = cubicBezier(0.32, 0.72, 0, 1);

/** CSS `ease`, cubic-bezier(0.25, 0.1, 0.25, 1): the fly to a bus starts gently and settles in slowly. */
export const easeFly = cubicBezier(0.25, 0.1, 0.25, 1);

/** Lowest zoom of a fly from zoom `z0` to `z1` across `dist` px (at `z0`) on a map whose shorter side
 *  is `side` px: at least a level out, and far enough that both ends fit in half that side at once. */
export function flyDip(z0: number, z1: number, dist: number, side: number): number {
  return Math.min(Math.min(z0, z1) - 1, z0 - Math.log2(Math.max(dist, 1) / (side / 2)));
}

/** The fly at eased progress `s`: [share of the pan done, zoom]. The zoom runs a parabola through `dip`
 *  half way, the pan a smoothstep behind it, so the map backs out, crosses mostly while out, settles in. */
export function flyAt(s: number, z0: number, z1: number, dip: number): [number, number] {
  return [s * s * (3 - 2 * s), z0 + (z1 - z0) * s - 4 * ((z0 + z1) / 2 - dip) * s * (1 - s)];
}

/** Glide length in seconds: 0.3 s for a nudge, +0.1 s per screen travelled and +0.05 s per
 *  zoom level, capped at 0.6 s — quick enough to follow a tap, long enough to read as motion. */
export function glideSeconds(screens: number, dz: number): number {
  return Math.min(0.6, 0.3 + 0.1 * screens + 0.05 * Math.abs(dz));
}
