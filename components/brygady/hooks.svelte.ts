/** Rune helpers of the /brygady page. Call them while a component initialises. */

/** Epoch seconds, refreshed every `intervalMs` (the page is client-rendered only). */
export function useEpochNow(intervalMs = 30_000): { readonly current: number } {
  let now = $state(Math.floor(Date.now() / 1000));
  $effect(() => {
    const id = setInterval(() => (now = Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  });
  return {
    get current() {
      return now;
    },
  };
}

/** Width of an element, tracked with ResizeObserver. Attach `observe` to the element: `{@attach w.observe}`. */
export function useElementWidth(): { readonly width: number; observe: (el: HTMLElement) => () => void } {
  let width = $state(0);
  return {
    get width() {
      return width;
    },
    observe(el) {
      const ro = new ResizeObserver((entries) => {
        width = Math.round(entries[0]?.contentRect.width ?? 0);
      });
      ro.observe(el);
      return () => ro.disconnect();
    },
  };
}
