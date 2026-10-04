"use client";

import { memo, useEffect } from "react";
import BottomSheet from "@/components/BottomSheet";
import { MegaphoneSimpleIcon } from "@/components/icons";
import { CloseIcon, EmptyState, ErrorState, IconButton, SkeletonRows } from "@/components/ui";
import {
  markAnnouncementsSeen,
  refreshAnnouncements,
  refreshAnnouncementsIfStale,
  useAnnouncements,
} from "@/lib/client/announcements";

interface Props {
  desktop: boolean;
  onClose: () => void;
}

/** Carrier service announcements (delays, detours). Mounted only while open,
 *  like StopView/TripView. */
function AnnouncementsSheet({ desktop, onClose }: Props) {
  const { status, items } = useAnnouncements();

  useEffect(() => {
    refreshAnnouncementsIfStale();
  }, []);
  /* clear the unread dot once the current set is actually on screen */
  useEffect(() => {
    if (status === "ready") markAnnouncementsSeen();
  }, [status]);

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/6 text-[18px] text-text-mute">
          <MegaphoneSimpleIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Utrudnienia</h2>
          <p className="mt-0.5 text-[12px] text-text-faint">Komunikaty przewoźnika</p>
        </div>
        <IconButton label="Zamknij komunikaty" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
    </header>
  );

  return (
    <BottomSheet desktop={desktop} onClose={onClose} ariaLabel="Utrudnienia w ruchu" header={header}>
      <div
        className="kb-scroll h-full overflow-y-auto px-4 animate-fade"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)" }}
      >
        {status === "error" ? (
          <ErrorState onRetry={() => void refreshAnnouncements()} />
        ) : status === "ready" && items.length === 0 ? (
          <EmptyState text="Brak komunikatów o utrudnieniach." />
        ) : status === "ready" ? (
          <ul className="stagger space-y-2">
            {items.map((a) => (
              <li key={`${a.id}-${a.rev}`} className="rounded-xl bg-white/4 px-4 py-3.5">
                <p className="max-w-[65ch] whitespace-pre-line text-[13.5px] leading-relaxed text-text">
                  {a.content_markdown}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <SkeletonRows />
        )}
      </div>
    </BottomSheet>
  );
}

export default memo(AnnouncementsSheet);
