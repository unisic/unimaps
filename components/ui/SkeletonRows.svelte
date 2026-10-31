<script lang="ts"></script>

<!-- Placeholder rows shaped like the departure / timetable rows they precede. -->
<div aria-hidden="true" class="px-4 pt-1">
  {#each { length: 6 }, i (i)}
    <div class="flex items-center gap-3 py-3">
      <div class="skeleton h-7 w-9 rounded-lg"></div>
      <div class="flex-1 space-y-2">
        <div class="skeleton h-3 w-3/4"></div>
        <div class="skeleton h-2.5 w-1/2"></div>
      </div>
      <div class="skeleton h-5 w-12"></div>
    </div>
  {/each}
</div>
