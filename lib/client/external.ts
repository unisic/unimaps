import { createSubscriber } from "svelte/reactivity";

/**
 * A module store (subscribe + snapshot getter) read from Svelte: reading `.current` inside a template or an
 * effect subscribes for as long as that reader lives, the useSyncExternalStore of runes.
 */
export function external<T>(subscribe: (onChange: () => void) => () => void, get: () => T): { readonly current: T } {
  const track = createSubscriber((update) => subscribe(update));
  return {
    get current() {
      track();
      return get();
    },
  };
}
