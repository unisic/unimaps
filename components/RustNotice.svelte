<script lang="ts">
  /** One-time note that the server now runs on Rust. Ferris: public domain (CC0), rustacean.net.
   *  Marked seen when shown, so a reload never brings it back; blocked storage = never shown (it could not stay
   *  dismissed). Not rendered at all once seen: a hidden <img> still downloads. */
  const KEY = "kb:rustNotice";

  const show = (() => {
    try {
      if (localStorage.getItem(KEY)) return false;
      localStorage.setItem(KEY, "1");
      return true;
    } catch {
      return false;
    }
  })();

  let dialog = $state<HTMLDialogElement>();

  $effect(() => dialog?.showModal());
</script>

{#if show}
  <dialog
    bind:this={dialog}
    aria-labelledby="rust-notice-title"
    class="surface m-auto w-[min(360px,calc(100vw-32px))] rounded-[20px] p-0 text-text backdrop:bg-black/55 motion-safe:animate-pop"
    onclick={(e) => {
      if (e.target === dialog) dialog.close();
    }}
  >
    <div class="flex flex-col items-center px-5 pb-5 pt-4 text-center">
      <img src="/ferris.svg" alt="Ferris, krab, maskotka języka Rust" width="180" height="120" draggable="false" />
      <h2 id="rust-notice-title" class="mt-2 text-[17px] font-semibold tracking-tight">
        Unimaps działa teraz na Ruście
      </h2>
      <p class="mt-2 text-[13px] text-text-mute">
        Przepisaliśmy serwer mapy z Node.js na Rust. Mapa działa jak dotąd, a serwer zużywa ponad dwa razy mniej
        pamięci.
      </p>
      <button
        type="button"
        onclick={() => dialog?.close()}
        class="mt-4 min-h-10 rounded-full bg-brand px-5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hi"
      >
        Zamknij
      </button>
    </div>
  </dialog>
{/if}
