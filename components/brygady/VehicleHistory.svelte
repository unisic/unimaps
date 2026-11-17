<script lang="ts">
  import type { Snippet } from "svelte";

  import LineBadge from "@/components/ui/LineBadge.svelte";
  import { cityOfSide, isNotFound } from "@/lib/client/fleet";
  import { useVehicleHistory } from "@/lib/client/fleet.svelte";
  import { compareLineNames, type FleetHistoryDay, type FleetVehicleDetail } from "@/lib/shared/fleet";

  import Block from "./Block.svelte";
  import { clockFromSecs, fmtDay, fmtDelayMin, fmtKm, MORE_BUTTON, pluralPl, SERIES_FILL } from "./common";
  import DelayBadge from "./DelayBadge.svelte";
  import { CHEVRON_DOWN } from "./icons";
  import Svg from "./Svg.svelte";

  /** "Dzień po dniu" lists this many days, the newest, until asked for the rest: MZK keeps 28 */
  const DAYS_HEAD = 7;
  /** "Linie w ostatnich dniach" draws this many lines and names this many more in one sentence */
  const LINES_HEAD = 8;
  const LINES_NAMED = 12;

  /** The vehicle's past days from /api/fleet/<side>/history: which courses it ran, day by day.
   *  `tile` is the card's own figure tile (label, value, note). */
  let {
    side,
    operator,
    tile,
  }: { side: string; operator: FleetVehicleDetail["operator"]; tile: Snippet<[label: string, value: string, note: string]> } = $props();

  const uid = $props.id();
  // svelte-ignore state_referenced_locally
  const history = useVehicleHistory(() => side, cityOfSide(side));
  const days = $derived(history.data?.days ?? []);
  let open = $state.raw<ReadonlySet<string>>(new Set());
  let allDays = $state(false);
  const courses = $derived(days.reduce((n, d) => n + d.courses.length, 0));
  /** "07.11" of "2026-11-07" */
  const shortDay = (date: string) => `${date.slice(8)}.${date.slice(5, 7)}`;

  function toggle(date: string) {
    const next = new Set(open);
    if (next.has(date)) next.delete(date);
    else next.add(date);
    open = next;
  }

  /** courses per line over every day held, most first */
  const lineCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const d of days) for (const c of d.courses) m.set(c.lineName, (m.get(c.lineName) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || compareLineNames(a[0], b[0]));
  });
  const restLines = $derived.by(() => {
    const rest = lineCounts.slice(LINES_HEAD);
    const named = rest.slice(0, LINES_NAMED).map(([line, n]) => `${line} (${n})`);
    return rest.length > LINES_NAMED ? `${named.join(", ")} i ${rest.length - LINES_NAMED} innych` : named.join(", ");
  });

  function daySummary(d: FleetHistoryDay) {
    let km = 0;
    let cancelled = 0;
    let delay = 0;
    let measured = 0;
    const lines: string[] = [];
    for (const c of d.courses) {
      km += c.drivenMeters / 1000;
      if (c.status === "cancelled") cancelled++;
      else {
        delay += c.delaySec;
        measured++;
      }
      if (!lines.includes(c.lineName)) lines.push(c.lineName);
    }
    return { km, cancelled, avgDelay: measured > 0 ? delay / measured : null, lines };
  }
</script>

{#if days.length > 0}
  <dl class="grid grid-cols-2 gap-2">
    {@render tile("Dni z kursami", String(days.length), `od ${shortDay(days[days.length - 1].date)} do ${shortDay(days[0].date)}`)}
    {@render tile("Kursy", String(courses), `na ${lineCounts.length} ${lineCounts.length === 1 ? "linii" : "liniach"}`)}
  </dl>

  <Block title="Linie w ostatnich dniach">
    {#snippet aside()}
      <span class="text-[12px] text-text-mute">kursy</span>
    {/snippet}
    <ul class="flex flex-col gap-2">
      {#each lineCounts.slice(0, LINES_HEAD) as [line, n] (line)}
        <li class="grid grid-cols-[3.25rem_minmax(0,1fr)_4.75rem] items-center gap-2.5">
          <span><LineBadge {line} {operator} /></span>
          <span aria-hidden="true" class="h-2.5 overflow-hidden rounded-full bg-surface-3">
            <span class="block h-full rounded-full" style:width="{(n / lineCounts[0][1]) * 100}%" style:background={SERIES_FILL}></span>
          </span>
          <span class="text-right text-[12.5px] text-text-mute tabular-nums">{n} {pluralPl(n, "kurs", "kursy", "kursów")}</span>
        </li>
      {/each}
    </ul>
    {#if restLines}
      <p class="mt-3 text-[12.5px] leading-[1.45] text-text-mute tabular-nums">Pozostałe: {restLines}.</p>
    {/if}
  </Block>
{/if}

<Block title="Dzień po dniu">
  {#snippet aside()}
    {#if days.length > 1}
      <span class="text-[12px] text-text-mute">najnowsze na górze</span>
    {/if}
  {/snippet}
  {#if history.error && !isNotFound(history.error) && !history.data}
    <p class="text-[13px] text-text-mute">Nie udało się wczytać historii. Spróbujemy ponownie za chwilę.</p>
  {:else if !history.data}
    <p class="text-[13px] text-text-mute">Wczytywanie historii…</p>
  {:else if days.length === 0}
    <p class="text-[13px] text-text-mute">
      {history.data.complete ? "Brak zapisanych kursów z poprzednich dni." : "Wczytywanie zapisanych dni…"}
    </p>
  {:else}
    <ul class="-mx-1 divide-y divide-hairline">
      {#each allDays ? days : days.slice(0, DAYS_HEAD) as d (d.date)}
        {@const s = daySummary(d)}
        {@const isOpen = open.has(d.date)}
        <li>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls="{uid}-{d.date}"
            onclick={() => toggle(d.date)}
            class="flex min-h-12 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-tint/5"
          >
            <span class="w-[4.75rem] shrink-0 text-[12.5px] font-medium text-text sm:w-[5.5rem]">{fmtDay(d.date)}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] text-text">
                {pluralPl(s.lines.length, "linia", "linie", "linii")} {s.lines.join(", ")}
              </span>
              <span class="block text-[11.5px] text-text-faint tabular-nums">
                {[
                  `${d.courses.length} ${pluralPl(d.courses.length, "kurs", "kursy", "kursów")}`,
                  s.km > 0 ? fmtKm(s.km) : null,
                  s.avgDelay !== null ? `śr. ${fmtDelayMin(s.avgDelay)}` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </span>
            {#if s.cancelled > 0}
              <span class="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger tabular-nums">
                {s.cancelled} {pluralPl(s.cancelled, "przerwany", "przerwane", "przerwanych")}
              </span>
            {/if}
            <Svg icon={CHEVRON_DOWN} size={16} class="shrink-0 text-text-faint transition-transform {isOpen ? 'rotate-180' : ''}" />
          </button>
          <ul id="{uid}-{d.date}" hidden={!isOpen} class="pb-2">
            {#if isOpen}
              {#each d.courses as c, i (i)}
                {@const time = `${clockFromSecs(c.startSecs)}–${clockFromSecs(c.endSecs)}`}
                {@const extra = [c.brigade ? `brygada ${c.brigade}` : null, c.status === "cancelled" && c.cancelledAtStopName ? `przerwany: ${c.cancelledAtStopName}` : null]
                  .filter(Boolean)
                  .join(", ")}
                <li class="flex min-h-10 items-center gap-3 px-1 py-1.5">
                  <!-- as in the road card: on a phone the time leads the second line -->
                  <span class="hidden w-[5.5rem] shrink-0 text-[12.5px] text-text-mute tabular-nums sm:block">{time}</span>
                  <LineBadge line={c.lineName} {operator} />
                  <span class="min-w-0 flex-1">
                    <span class="line-clamp-2 text-[13px] text-text">{c.firstStopName} → {c.lastStopName}</span>
                    <span class="block truncate text-[11.5px] text-text-faint tabular-nums">
                      <span class="text-text-mute sm:hidden">{time}{extra ? ", " : ""}</span>{extra}
                    </span>
                  </span>
                  {#if c.status === "cancelled"}
                    <span class="shrink-0 rounded-md bg-danger/12 px-1.5 py-0.5 text-[12px] font-semibold text-danger">Przerwany</span>
                  {:else}
                    <DelayBadge sec={c.delaySec} />
                  {/if}
                </li>
              {/each}
            {/if}
          </ul>
        </li>
      {/each}
    </ul>
    {#if days.length > DAYS_HEAD}
      <button type="button" aria-expanded={allDays} onclick={() => (allDays = !allDays)} class={MORE_BUTTON}>
        {allDays ? `Pokaż tylko ${DAYS_HEAD} ostatnich dni` : `Pokaż wszystkie dni (${days.length})`}
      </button>
    {/if}
    {#if !history.data.complete}
      <p class="mt-2 text-[12px] text-text-faint">Wczytywanie starszych dni…</p>
    {/if}
  {/if}
</Block>
