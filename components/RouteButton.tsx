"use client";

import { memo } from "react";
import { PathIcon } from "@/components/icons";

interface Props {
  onClick: () => void;
}

/**
 * Floating button for connection search / journey planning.
 * Matches LocateButton positioning and style.
 */
function RouteButton({ onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Wyszukaj połączenie"
      title="Wyszukaj połączenie"
      className="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px)+52px)] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] text-text-mute hover:text-text md:top-auto md:bottom-[154px]"
    >
      <PathIcon />
    </button>
  );
}

export default memo(RouteButton);
