"use client";

/** Pill under the TopBar showing the active line filter — which lines are on
 *  and how many vehicles survive the filter. Tapping the body reopens the
 *  palette (to tweak lines), the X clears the filter. */
import { memo } from "react";
import { XIcon } from "@/components/icons";
import { LineBadge } from "@/components/ui";
import { wozPlural } from "@/lib/client/format";

interface Props {
  lines: string[];
  visibleCount: number;
  onClear: () => void;
  onOpenPalette: () => void;
}

function LineFilterChip({ lines, visibleCount, onClear, onOpenPalette }: Props) {
  return (
    <div className="absolute left-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem+56px)] z-[1001] max-w-[calc(100vw-24px)] md:left-1/2 md:-translate-x-1/2 animate-drop">
      <div className="surface flex items-center gap-1 rounded-full py-1 pl-1.5 pr-1">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Zmień filtr linii"
          className="tap flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 hover:bg-white/5"
        >
          <span className="flex min-w-0 items-center gap-1 overflow-hidden">
            {lines.map((l) => (
              <LineBadge key={l} line={l} />
            ))}
          </span>
          <span className="shrink-0 pr-1 text-[12px] tabular-nums text-text-mute">
            {visibleCount} {wozPlural(visibleCount)}
          </span>
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Wyczyść filtr linii"
          className="tap grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] text-text-mute hover:bg-white/8 hover:text-text"
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

export default memo(LineFilterChip);
