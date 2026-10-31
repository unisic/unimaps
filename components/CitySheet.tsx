"use client";

import { memo, useContext } from "react";

import BottomSheet from "@/components/BottomSheet";
import { OTHERS_HINT, OtherCities } from "@/components/CityChooser";
import { MapTrifoldIcon } from "@/components/icons";
import { CloseIcon, IconButton } from "@/components/ui";
import { CityContext, saveCity, type City } from "@/lib/client/city";

/* a full navigation: every store, poll and cache of the page is keyed to one city */
export function switchCity(next: City): void {
  saveCity(next);
  window.location.assign(next === "bb" ? "/" : `/?city=${next}`);
}

/** "Inne miasto": the searchable list of every city but BB and GZM, which sit in the menu itself. */
function CitySheet({ desktop, onClose }: { desktop: boolean; onClose: () => void }) {
  const city = useContext(CityContext);
  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          <MapTrifoldIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Inne miasto</h2>
          <p className="mt-0.5 text-[12px] text-text-faint">{OTHERS_HINT}</p>
        </div>
        <IconButton label="Zamknij wybór miasta" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
    </header>
  );

  return (
    <BottomSheet desktop={desktop} onClose={onClose} ariaLabel="Inne miasto" header={header} initialSnap="full">
      <div
        className="kb-scroll h-full overflow-y-auto px-4 animate-fade"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)",
        }}
      >
        <OtherCities current={city} onPick={switchCity} />
      </div>
    </BottomSheet>
  );
}

export default memo(CitySheet);
