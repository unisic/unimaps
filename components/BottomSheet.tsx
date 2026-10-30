"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
const FULL = 0.75;
const HALF = 0.50;
const PEEK = 0.25;

export type Snap = "peek" | "half" | "full";

const SNAP_HEIGHTS: Record<Snap, string> = {
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

const vh = () => (typeof window !== "undefined" ? window.innerHeight : 800);

/** startRef id of a drag begun in the content (touch ids and pointer ids are separate spaces) */
const TOUCH_DRAG = -1;

/** The nearest vertical scroller between a touch target and the sheet content, if any. */
function scrollerOf(el: Element | null, root: Element): Element | null {
  for (; el && el !== root; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

// Apple WWDC 2018 Fluid Interfaces rubber-band formula
function rubberband(overshoot: number, dimension: number, constant = 0.45): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

interface Props {
  onClose: () => void;
  /** md+ — render as a docked left panel instead of a draggable sheet */
  desktop: boolean;
  ariaLabel: string;
  /** mobile snap the sheet opens at (default "half" / 2/4 screen) */
  initialSnap?: Snap;
  /** allow closing via extreme downward swipe from peek (default false) */
  dismissOnDrag?: boolean;
  /** header content — on mobile this is the drag zone */
  header: React.ReactNode;
  children: React.ReactNode;
}

export default function BottomSheet({
  onClose,
  desktop,
  ariaLabel,
  initialSnap = "half",
  dismissOnDrag = false,
  header,
  children,
}: Props) {
  const [snap, setSnap] = useState<Snap>(initialSnap);
  const [isDragging, setIsDragging] = useState(false);
  const [mounted, setMounted] = useState(false);

  const sheetRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const snapRef = useRef<Snap>(initialSnap);

  const startRef = useRef<{
    id: number;
    y: number;
    t: number;
    startH: number;
    target: HTMLElement | null;
  } | null>(null);
  const movesRef = useRef<{ y: number; t: number }[]>([]);
  /** a touch in the content: undecided, driving the sheet, or left to the browser (scroll, tap) */
  const touchRef = useRef<{ x: number; y: number; mode: "pending" | "sheet" | "native" } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a dialog over the sheet (vehicle card) claims its Escape with preventDefault
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* focus restoration. preventScroll: the sheet mounts translated below the viewport, and a plain
     focus() scrolls the overflow-hidden app root by the sheet's height (the whole map jumps up, then
     slides back as the entrance transition shrinks the overflow) */
  useEffect(() => {
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    sheetRef.current?.focus({ preventScroll: true });
    return () => restoreRef.current?.focus?.({ preventScroll: true });
  }, []);

  // Entrance transition on mount
  useEffect(() => {
    if (desktop) return;
    snapRef.current = initialSnap;
    const raf = requestAnimationFrame(() => {
      setMounted(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [desktop, initialSnap]);

  const beginDrag = useCallback((id: number, y: number, t: number, target: HTMLElement | null) => {
    const curH = sheetRef.current?.offsetHeight ?? (HALF * vh());
    if (sheetRef.current) {
      sheetRef.current.style.setProperty("--sheet-height", `${curH}px`);
      sheetRef.current.style.transition = "none";
    }
    startRef.current = { id, y, t, startH: curH, target };
    movesRef.current = [{ y, t }];
    setIsDragging(true);
  }, []);

  const dragTo = useCallback(
    (y: number, now: number) => {
      const st = startRef.current;
      if (!st) return;

      movesRef.current.push({ y, t: now });
      const cutoff = now - 80;
      while (movesRef.current.length > 0 && movesRef.current[0].t < cutoff) {
        movesRef.current.shift();
      }

      const dy = y - st.y;
      // Dragging up (dy < 0) increases height; dragging down (dy > 0) decreases height
      let h = st.startH - dy;
      const v = vh();
      const maxH = FULL * v;
      const minH = PEEK * v;

      if (h > maxH) {
        h = maxH + rubberband(h - maxH, v, 0.4);
      } else if (h < minH) {
        h = minH - rubberband(minH - h, v, 0.4);
      }

      if (sheetRef.current) {
        sheetRef.current.style.setProperty("--sheet-height", `${h}px`);
      }
    },
    [],
  );

  const endDrag = useCallback(
    (y: number, t: number, allowTap: boolean) => {
      const st = startRef.current;
      if (!st) return;
      startRef.current = null;
      setIsDragging(false);

      const moved = Math.abs(y - st.y);
      const elapsed = t - st.t;

      // Quick tap toggle
      if (allowTap && moved < 6 && elapsed < 250) {
        if (!st.target?.closest?.("button,a,input,[role='button']")) {
          let nextSnap: Snap;
          if (snapRef.current === "peek") nextSnap = "half";
          else if (snapRef.current === "half") nextSnap = "full";
          else nextSnap = "half";

          snapRef.current = nextSnap;
          if (sheetRef.current) {
            sheetRef.current.style.removeProperty("--sheet-height");
            sheetRef.current.style.transition = "height 0.35s var(--ease-spring)";
            sheetRef.current.style.height = SNAP_HEIGHTS[nextSnap];
          }
          setSnap(nextSnap);
          return;
        }
        return;
      }

      // Compute release velocity (px/s)
      let releaseVel = 0;
      const moves = movesRef.current;
      if (moves.length >= 2) {
        const first = moves[0];
        const last = moves[moves.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt > 0.008) {
          releaseVel = (last.y - first.y) / dt;
        }
      }

      const curH = sheetRef.current?.offsetHeight ?? (HALF * vh());
      const projectedH = curH - (releaseVel / 1000) * 120;
      const v = vh();

      // Optional explicit swipe-to-dismiss (only if enabled & swiping fast past peek)
      if (dismissOnDrag && projectedH < PEEK * v - 80 && releaseVel > 900) {
        if (sheetRef.current) {
          sheetRef.current.style.removeProperty("--sheet-height");
          sheetRef.current.style.transition = "transform 0.28s ease-in";
          sheetRef.current.style.transform = "translate3d(0, 100%, 0)";
        }
        setTimeout(onClose, 280);
        return;
      }

      let nearest: Snap = "half";
      const fullThreshold = ((FULL + HALF) / 2) * v;
      const halfThreshold = ((HALF + PEEK) / 2) * v;

      if (projectedH >= fullThreshold) {
        nearest = "full";
      } else if (projectedH <= halfThreshold) {
        nearest = "peek";
      } else {
        nearest = "half";
      }

      snapRef.current = nearest;
      if (sheetRef.current) {
        sheetRef.current.style.removeProperty("--sheet-height");
        sheetRef.current.style.transition = "height 0.35s var(--ease-spring)";
        sheetRef.current.style.height = SNAP_HEIGHTS[nearest];
      }
      setSnap(nearest);
    },
    [dismissOnDrag, onClose],
  );

  const cancelDrag = useCallback(() => {
    if (!startRef.current) return;
    startRef.current = null;
    setIsDragging(false);
    if (sheetRef.current) {
      sheetRef.current.style.removeProperty("--sheet-height");
      sheetRef.current.style.transition = "height 0.35s var(--ease-spring)";
      sheetRef.current.style.height = SNAP_HEIGHTS[snapRef.current];
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (desktop) return;
      if (startRef.current != null || !e.isPrimary) return;
      if ((e.target as HTMLElement).closest?.("button,a,input,[role='button']")) return;
      beginDrag(e.pointerId, e.clientY, e.timeStamp, e.target as HTMLElement);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [desktop, beginDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId === startRef.current?.id) dragTo(e.clientY, e.timeStamp);
    },
    [dragTo],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId === startRef.current?.id) endDrag(e.clientY, e.timeStamp, true);
    },
    [endDrag],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId === startRef.current?.id) cancelDrag();
    },
    [cancelDrag],
  );

  /* Pulling the content down while its list is scrolled to the top drags the sheet, so a sheet
     opened at half can be lowered from anywhere to uncover the map. Native listeners: React's
     touchmove is passive and could not stop the browser's own pan/overscroll. */
  useEffect(() => {
    const root = contentRef.current;
    if (desktop || !root) return;
    const onStart = (e: TouchEvent) => {
      if (touchRef.current?.mode === "sheet") return;
      const t = e.touches[0];
      touchRef.current =
        e.touches.length === 1 && startRef.current == null && !(e.target as Element).closest?.("input,textarea,select")
          ? { x: t.clientX, y: t.clientY, mode: "pending" }
          : null;
    };
    const onMove = (e: TouchEvent) => {
      const tr = touchRef.current;
      if (!tr || tr.mode === "native") return;
      const t = e.touches[0];
      if (tr.mode === "pending") {
        const dx = t.clientX - tr.x;
        const dy = t.clientY - tr.y;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        const scroller = scrollerOf(e.target as Element, root);
        if (dy <= Math.abs(dx) || !e.cancelable || (scroller && scroller.scrollTop > 0)) {
          tr.mode = "native";
          return;
        }
        tr.mode = "sheet";
        beginDrag(TOUCH_DRAG, t.clientY, e.timeStamp, null);
      }
      e.preventDefault();
      dragTo(t.clientY, e.timeStamp);
    };
    const onEnd = (e: TouchEvent) => {
      const tr = touchRef.current;
      touchRef.current = null;
      if (tr?.mode !== "sheet" || startRef.current?.id !== TOUCH_DRAG) return;
      // no click on the row the drag started from
      if (e.cancelable) e.preventDefault();
      if (e.type === "touchcancel") cancelDrag();
      else endDrag(e.changedTouches[0].clientY, e.timeStamp, false);
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, [desktop, beginDrag, dragTo, endDrag, cancelDrag]);

  if (desktop) {
    return (
      <section
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-label={ariaLabel}
        className="surface absolute bottom-3 left-3 top-[116px] z-[1001] flex w-[400px] flex-col overflow-hidden rounded-3xl outline-none animate-rise xl:top-3"
      >
        <div className="shrink-0">{header}</div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3 bg-gradient-to-b from-surface to-transparent"
            aria-hidden
          />
          {children}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={sheetRef}
      tabIndex={-1}
      role="dialog"
      aria-label={ariaLabel}
      data-snap={snap}
      className={`surface absolute inset-x-0 bottom-0 z-[1001] flex flex-col overflow-hidden rounded-t-[24px] outline-none ${
        isDragging ? "select-none" : ""
      }`}
      style={{
        height: isDragging ? "var(--sheet-height)" : SNAP_HEIGHTS[snap],
        maxHeight: "calc(min(80dvh, 100dvh - env(safe-area-inset-top, 0px) - 3.5rem))",
        minHeight: SNAP_HEIGHTS["peek"],
        transform: mounted ? "none" : "translate3d(0, 100%, 0)",
        transition: isDragging
          ? "none"
          : "transform 0.35s var(--ease-spring), height 0.35s var(--ease-spring)",
        willChange: isDragging ? "height" : undefined,
        boxShadow: "var(--shadow-sheet)",
      }}
    >
      <div
        className="shrink-0 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ touchAction: "none" }}
      >
        <div className="flex w-full items-center justify-center pb-1.5 pt-2" aria-hidden>
          <div className="h-1 w-9 rounded-full bg-tint/20 transition-colors hover:bg-tint/35 active:bg-tint/45" />
        </div>
        {header}
      </div>
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden" style={{ touchAction: "pan-y" }}>
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3 bg-gradient-to-b from-surface to-transparent"
          aria-hidden
        />
        {children}
      </div>
    </section>
  );
}
