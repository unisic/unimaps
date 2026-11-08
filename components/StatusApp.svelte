<script lang="ts">
  import { onMount } from "svelte";

  import { fmtInt, pluralPl } from "@/components/brygady/common";
  import ErrorState from "@/components/ui/ErrorState.svelte";
  import SkeletonRows from "@/components/ui/SkeletonRows.svelte";
  import type { SourceState, SourceStatus, StatusBody } from "@/lib/shared/status";
  import { fetchJSON } from "@/lib/client/api";

  // the server sweeps at most every 2 min, a faster poll would only re-read its memo
  const REFRESH_MS = 120_000;

  let data = $state.raw<StatusBody | null>(null);
  let failed = $state(false);
  let loading = $state(false);
  let ctrl: AbortController | null = null;

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    ctrl = new AbortController();
    try {
      data = await fetchJSON<StatusBody>("/api/status", { signal: ctrl.signal, cache: "no-store" });
      failed = false;
    } catch (err) {
      // a failed refresh keeps the list on screen: the timestamp shows how old it is
      if (!(err instanceof DOMException && err.name === "AbortError")) failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden && data && Date.now() / 1000 - data.checked_at > REFRESH_MS / 1000) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ctrl?.abort();
    };
  });

  const DOT: Record<SourceState, string> = { ok: "bg-good", empty: "bg-text-faint", down: "bg-danger" };
  const LABEL: Record<SourceState, string> = { ok: "działa", empty: "brak pojazdów", down: "nie odpowiada" };

  /** the worst source decides the city's dot */
  const cityState = (sources: SourceStatus[]): SourceState =>
    sources.some((s) => s.state === "down") ? "down" : sources.some((s) => s.state === "ok") ? "ok" : "empty";

  const ago = (sec: number): string => (sec < 90 ? `${sec} s temu` : `${Math.round(sec / 60)} min temu`);

  function detail(s: SourceStatus): string {
    if (s.state === "down") return s.error ?? "";
    const parts = s.state === "ok" ? [`${fmtInt(s.vehicles)} ${pluralPl(s.vehicles, "pojazd", "pojazdy", "pojazdów")}`] : [];
    if (s.age != null) parts.push(ago(s.age));
    return parts.join(", ");
  }

  const checked = $derived(
    data ? new Date(data.checked_at * 1000).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "",
  );
  const downCount = $derived(data ? data.cities.filter((c) => cityState(c.sources) === "down").length : 0);
</script>

<main class="min-h-dvh bg-bg px-4 pb-16 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] text-text">
  <div class="mx-auto max-w-[680px]">
    <a href="/" class="text-[13px] text-text-mute hover:text-text">Wróć do mapy</a>
    <h1 class="mt-4 text-[24px] font-semibold tracking-tight">Status danych na żywo</h1>
    <p class="mt-3 text-[14.5px] leading-relaxed text-text-mute">
      Czy pozycje pojazdów docierają teraz od przewoźników i z zbiorkom. Brak pojazdów w nocy jest normalny.
    </p>

    {#if data}
      <p class="mt-6 text-[13px] text-text-mute" aria-live="polite">
        Sprawdzono o {checked}{#if downCount > 0}, <span class="text-danger"
            >{downCount} {pluralPl(downCount, "miasto nie odpowiada", "miasta nie odpowiadają", "miast nie odpowiada")}</span
          >{/if}{#if failed}, <span class="text-danger">odświeżenie nie powiodło się</span>{/if}
      </p>
      <ul class="mt-3 divide-y divide-hairline border-y border-hairline">
        {#each data.cities as c (c.city)}
          {@const state = cityState(c.sources)}
          <li class="flex items-start gap-3 py-3">
            <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full {DOT[state]}" aria-hidden="true"></span>
            <div class="min-w-0 flex-1">
              <a href={c.city === "bb" ? "/" : `/?city=${c.city}`} class="text-[15px] font-medium hover:underline">{c.name}</a>
              <span class="sr-only">: {LABEL[state]}</span>
              {#each c.sources as s (s.name)}
                {@const d = detail(s)}
                <p class="text-[13px] text-text-mute">
                  {s.name}: <span class={s.state === "down" ? "text-danger" : ""}>{LABEL[s.state]}</span>{#if d}, {d}{/if}
                </p>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
    {:else if failed}
      <ErrorState onRetry={load} message="Nie udało się sprawdzić statusu." />
    {:else}
      <div class="-mx-4 mt-6"><SkeletonRows /></div>
    {/if}
  </div>
</main>
