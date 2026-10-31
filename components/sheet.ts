/**
 * Mobile snap points (fraction of viewport visible from bottom):
 * - full: 3/4 (0.75) — reveals the timeline while keeping the top 25% of the screen
 *   open to the live map and tracked bus.
 * - half: 2/4 (0.50) — balanced half-and-half split between sheet details and map.
 * - peek: 1/4 (0.25) — compact docked bottom bar showing line pill, destination,
 *   delay, and live status without hiding the map.
 *
 * Pulling the sheet down docks it at `peek` ("przyczepianie się na dole") so the
 * line/trip remains active and pinned. To close the sheet, the user taps ✕ or Esc.
 */
export const FULL = 0.75;
export const HALF = 0.5;
export const PEEK = 0.25;

export type Snap = "peek" | "half" | "full";

export const SNAP_HEIGHTS: Record<Snap, string> = {
  full: `${FULL * 100}dvh`,
  half: `${HALF * 100}dvh`,
  peek: `${PEEK * 100}dvh`,
};

/** Viewport fraction a mobile sheet covers at each snap. */
export const SNAP_COVER: Record<Snap, number> = { full: FULL, half: HALF, peek: PEEK };

/** What the open sheet covers once it settles (its snap, never a mid-transition height):
 *  a viewport fraction on mobile, 1 for the docked desktop panel, 0 when none is open. */
export function openSheetCover(): number {
  const el = document.querySelector<HTMLElement>('section[role="dialog"]');
  if (!el) return 0;
  const snap = el.dataset.snap as Snap | undefined;
  return snap ? SNAP_COVER[snap] : 1;
}
