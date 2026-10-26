"use client";

import { memo } from "react";
import { PersonSimpleWalkIcon } from "@/components/icons";

interface Props {
  onClick: () => void;
}

/** "W pobliżu", third in the LocateButton / RouteButton column; shown only while located. */
function NearbyButton({ onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Odjazdy w pobliżu"
      title="Odjazdy w pobliżu"
      className="surface tap absolute top-[calc(4.5rem+env(safe-area-inset-top,0px)+104px)] right-3 z-[1000] grid h-11 w-11 place-items-center rounded-full text-[20px] text-text-mute hover:text-text md:top-auto md:bottom-[206px]"
    >
      <PersonSimpleWalkIcon />
    </button>
  );
}

export default memo(NearbyButton);
