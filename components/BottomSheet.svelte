<script lang="ts">
  import { onMount, type Snippet } from "svelte";

  import { FULL, HALF, PEEK, SNAP_HEIGHTS, type Snap } from "@/components/sheet";

  let {
    onClose,
    desktop,
    ariaLabel,
    initialSnap = "half",
    dismissOnDrag = false,
    header,
    children,
  }: {
    onClose: () => void;
    /** md+: render as a docked left panel instead of a draggable sheet */
    desktop: boolean;
    ariaLabel: string;
    /** mobile snap the sheet opens at (default "half" / 2/4 screen) */
    initialSnap?: Snap;
    /** allow closing via extreme downward swipe from peek (default false) */
    dismissOnDrag?: boolean;
    /** header content: on mobile this is the drag zone */
    header: Snippet;
    children: Snippet;
  } = $props();

  const vh = () => window.innerHeight;

  /** start.id of a drag begun in the content (touch ids and pointer ids are separate spaces) */
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

  // svelte-ignore state_referenced_locally
  let snap = $state<Snap>(initialSnap);
  let isDragging = $state(false);
  let mounted = $state(false);

  let sheet = $state<HTMLElement>();
  let content = $state<HTMLDivElement>();

  let start: { id: number; y: number; t: number; startH: number; target: HTMLElement | null } | null = null;
  let moves: { y: number; t: number }[] = [];
  /** a touch in the content: undecided, driving the sheet, or left to the browser (scroll, tap) */
  let touch: { x: number; y: number; mode: "pending" | "sheet" | "native" } | null = null;

  function onKey(e: KeyboardEvent) {
    // a dialog over the sheet (vehicle card) claims its Escape with preventDefault
    if (e.key === "Escape" && !e.defaultPrevented) onClose();
  }

  /* focus restoration. preventScroll: the sheet mounts translated below the viewport, and a plain
     focus() scrolls the overflow-hidden app root by the sheet's height (the whole map jumps up, then
     slides back as the entrance transition shrinks the overflow) */
  onMount(() => {
    const restore = document.activeElement as HTMLElement | null;
    sheet?.focus({ preventScroll: true });
    return () => restore?.focus?.({ preventScroll: true });
  });

  // Entrance transition on mount
  $effect(() => {
    if (desktop) return;
    const raf = requestAnimationFrame(() => (mounted = true));
    return () => cancelAnimationFrame(raf);
  });

  function settle(to: Snap, transition = "height 0.35s var(--ease-spring)") {
    snap = to;
    if (sheet) {
      sheet.style.removeProperty("--sheet-height");
      sheet.style.transition = transition;
      sheet.style.height = SNAP_HEIGHTS[to];
    }
  }

  function beginDrag(id: number, y: number, t: number, target: HTMLElement | null) {
    const curH = sheet?.offsetHeight ?? HALF * vh();
    if (sheet) {
      sheet.style.setProperty("--sheet-height", `${curH}px`);
      sheet.style.transition = "none";
    }
    start = { id, y, t, startH: curH, target };
    moves = [{ y, t }];
    isDragging = true;
  }

  function dragTo(y: number, now: number) {
    const st = start;
    if (!st) return;
    moves.push({ y, t: now });
    const cutoff = now - 80;
    while (moves.length > 0 && moves[0].t < cutoff) moves.shift();

    // Dragging up (dy < 0) increases height; dragging down (dy > 0) decreases height
    let h = st.startH - (y - st.y);
    const v = vh();
    const maxH = FULL * v;
    const minH = PEEK * v;
    if (h > maxH) h = maxH + rubberband(h - maxH, v, 0.4);
    else if (h < minH) h = minH - rubberband(minH - h, v, 0.4);
    sheet?.style.setProperty("--sheet-height", `${h}px`);
  }

  function endDrag(y: number, t: number, allowTap: boolean) {
    const st = start;
    if (!st) return;
    start = null;
    isDragging = false;

    const moved = Math.abs(y - st.y);
    const elapsed = t - st.t;

    // Quick tap toggle
    if (allowTap && moved < 6 && elapsed < 250) {
      if (!st.target?.closest?.("button,a,input,[role='button']")) settle(snap === "peek" ? "half" : snap === "half" ? "full" : "half");
      return;
    }

    // Release velocity (px/s)
    let releaseVel = 0;
    if (moves.length >= 2) {
      const first = moves[0];
      const last = moves[moves.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0.008) releaseVel = (last.y - first.y) / dt;
    }

    const curH = sheet?.offsetHeight ?? HALF * vh();
    const projectedH = curH - (releaseVel / 1000) * 120;
    const v = vh();

    // Optional explicit swipe-to-dismiss (only if enabled & swiping fast past peek)
    if (dismissOnDrag && projectedH < PEEK * v - 80 && releaseVel > 900) {
      if (sheet) {
        sheet.style.removeProperty("--sheet-height");
        sheet.style.transition = "transform 0.28s ease-in";
        sheet.style.transform = "translate3d(0, 100%, 0)";
      }
      setTimeout(onClose, 280);
      return;
    }

    settle(projectedH >= ((FULL + HALF) / 2) * v ? "full" : projectedH <= ((HALF + PEEK) / 2) * v ? "peek" : "half");
  }

  function cancelDrag() {
    if (!start) return;
    start = null;
    isDragging = false;
    settle(snap);
  }

  function onPointerDown(e: PointerEvent) {
    if (start != null || !e.isPrimary) return;
    if ((e.target as HTMLElement).closest?.("button,a,input,[role='button']")) return;
    beginDrag(e.pointerId, e.clientY, e.timeStamp, e.target as HTMLElement);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  /* Pulling the content down while its list is scrolled to the top drags the sheet, so a sheet
     opened at half can be lowered from anywhere to uncover the map. Non-passive touchmove: a passive
     one could not stop the browser's own pan/overscroll. */
  $effect(() => {
    const root = content;
    if (desktop || !root) return;
    const onStart = (e: TouchEvent) => {
      if (touch?.mode === "sheet") return;
      const t = e.touches[0];
      touch =
        e.touches.length === 1 && start == null && !(e.target as Element).closest?.("input,textarea,select")
          ? { x: t.clientX, y: t.clientY, mode: "pending" }
          : null;
    };
    const onMove = (e: TouchEvent) => {
      const tr = touch;
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
      const tr = touch;
      touch = null;
      if (tr?.mode !== "sheet" || start?.id !== TOUCH_DRAG) return;
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
  });
</script>

<svelte:window onkeydown={onKey} />

{#if desktop}
  <!-- ARIA in HTML allows role="dialog" on <section>; openSheetCover() finds the sheet by section[role="dialog"] -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <section
    bind:this={sheet}
    tabindex="-1"
    role="dialog"
    aria-label={ariaLabel}
    class="surface absolute bottom-3 left-3 top-[116px] z-[1001] flex w-[400px] flex-col overflow-hidden rounded-3xl outline-none animate-rise xl:top-3"
  >
    <div class="shrink-0">{@render header()}</div>
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        class="pointer-events-none absolute inset-x-0 top-0 z-10 h-3 bg-gradient-to-b from-surface to-transparent"
        aria-hidden="true"
      ></div>
      {@render children()}
    </div>
  </section>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <section
    bind:this={sheet}
    tabindex="-1"
    role="dialog"
    aria-label={ariaLabel}
    data-snap={snap}
    class="surface absolute inset-x-0 bottom-0 z-[1001] flex flex-col overflow-hidden rounded-t-[24px] outline-none {isDragging
      ? 'select-none'
      : ''}"
    style:height={isDragging ? "var(--sheet-height)" : SNAP_HEIGHTS[snap]}
    style:max-height="calc(min(80dvh, 100dvh - env(safe-area-inset-top, 0px) - 3.5rem))"
    style:min-height={SNAP_HEIGHTS.peek}
    style:transform={mounted ? "none" : "translate3d(0, 100%, 0)"}
    style:transition={isDragging ? "none" : "transform 0.35s var(--ease-spring), height 0.35s var(--ease-spring)"}
    style:will-change={isDragging ? "height" : undefined}
    style:box-shadow="var(--shadow-sheet)"
  >
    <div
      class="shrink-0 cursor-grab select-none active:cursor-grabbing"
      role="presentation"
      onpointerdown={onPointerDown}
      onpointermove={(e) => e.pointerId === start?.id && dragTo(e.clientY, e.timeStamp)}
      onpointerup={(e) => e.pointerId === start?.id && endDrag(e.clientY, e.timeStamp, true)}
      onpointercancel={(e) => e.pointerId === start?.id && cancelDrag()}
      style:touch-action="none"
    >
      <div class="flex w-full items-center justify-center pb-1.5 pt-2" aria-hidden="true">
        <div class="h-1 w-9 rounded-full bg-tint/20 transition-colors hover:bg-tint/35 active:bg-tint/45"></div>
      </div>
      {@render header()}
    </div>
    <div bind:this={content} class="relative min-h-0 flex-1 overflow-hidden" style:touch-action="pan-y">
      <div
        class="pointer-events-none absolute inset-x-0 top-0 z-10 h-3 bg-gradient-to-b from-surface to-transparent"
        aria-hidden="true"
      ></div>
      {@render children()}
    </div>
  </section>
{/if}
