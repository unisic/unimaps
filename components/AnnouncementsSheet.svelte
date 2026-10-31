<script lang="ts">
  import { onMount } from "svelte";

  import BottomSheet from "@/components/BottomSheet.svelte";
  import Icon from "@/components/Icon.svelte";
  import { MegaphoneSimpleIcon, XIcon } from "@/components/icon-paths";
  import EmptyState from "@/components/ui/EmptyState.svelte";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import IconButton from "@/components/ui/IconButton.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import SwitchRow from "@/components/ui/SwitchRow.svelte";
  import { newsPushOn, setNewsPush } from "@/lib/client/alerts";
  import { announcementsOf, refreshAnnouncementsIfStale } from "@/lib/client/announcements";
  import { getPageCity } from "@/lib/client/city";

  /** Carrier service announcements (delays, detours). Mounted only while open,
   *  like StopView/TripView. */
  let { desktop, onClose }: { desktop: boolean; onClose: () => void } = $props();

  const city = getPageCity();
  const ann = announcementsOf(city);
  const status = $derived(ann.status);
  let push = $state(newsPushOn(city));
  let pushHint = $state<string | null>(null);

  onMount(() => {
    refreshAnnouncementsIfStale();
  });
  /* clear the unread dot once the current set is actually on screen */
  $effect(() => {
    if (status === "ready") ann.markSeen();
  });

  async function togglePush(): Promise<void> {
    const on = !push;
    push = on;
    pushHint = null;
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    const ok = await setNewsPush(city, on);
    if (on && !ok) {
      push = false;
      pushHint =
        typeof Notification !== "undefined" && Notification.permission === "denied"
          ? "Powiadomienia są zablokowane w ustawieniach przeglądarki."
          : "Powiadomienia push nie działają w tej przeglądarce (na iPhonie dodaj aplikację do ekranu początkowego).";
    }
  }
</script>

<BottomSheet {desktop} {onClose} ariaLabel="Utrudnienia w ruchu">
  {#snippet header()}
    <header class="px-4 pb-3 pt-2 md:pt-4">
      <div class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          <Icon icon={MegaphoneSimpleIcon} />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Utrudnienia</h2>
          <p class="mt-0.5 text-[12px] text-text-faint">
            {city === "gzm" ? "Komunikaty ZTM (transportgzm.pl)" : "Komunikaty przewoźnika"}
          </p>
        </div>
        <IconButton label="Zamknij komunikaty" onClick={onClose}>
          <Icon icon={XIcon} />
        </IconButton>
      </div>
    </header>
  {/snippet}
  <div
    class="kb-scroll h-full overflow-y-auto px-4 animate-fade"
    style:padding-bottom="calc(env(safe-area-inset-bottom, 0px) + 1.25rem)"
  >
    <div class="mb-3 rounded-xl bg-tint/4">
      <SwitchRow
        checked={push}
        onToggle={() => void togglePush()}
        label="Powiadamiaj o utrudnieniach"
        hint={pushHint ?? "Powiadomienie o nowym komunikacie, także przy zamkniętej aplikacji."}
      />
    </div>
    {#if status === "error"}
      <ErrorState onRetry={ann.refresh} />
    {:else if status === "ready" && ann.items.length === 0}
      <EmptyState text="Brak komunikatów o utrudnieniach." />
    {:else if status === "ready"}
      <ul class="stagger space-y-2">
        {#each ann.items as a (`${a.id}-${a.rev}`)}
          <li class="rounded-xl bg-tint/4 px-4 py-3.5">
            <!-- upstream marks headlines with markdown **bold**; the odd split parts are the bold runs -->
            <p class="max-w-[65ch] whitespace-pre-line text-[13.5px] leading-relaxed text-text">{#each a.content_markdown.split(/\*\*([\s\S]+?)\*\*/) as part, i (i)}{#if i % 2}<strong class="font-semibold">{part}</strong>{:else}{part}{/if}{/each}</p>
            {#if a.url}
              <a
                href={a.url}
                target="_blank"
                rel="noopener"
                class="mt-2 inline-block text-[13px] font-medium text-primary hover:underline"
              >
                Pełna treść
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <SkeletonRows />
    {/if}
  </div>
</BottomSheet>
