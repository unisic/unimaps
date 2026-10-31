"use client";

import { memo, useContext, useEffect, useState } from "react";
import BottomSheet from "@/components/BottomSheet";
import { MegaphoneSimpleIcon } from "@/components/icons";
import { CloseIcon, EmptyState, ErrorState, IconButton, SkeletonRows, SwitchRow } from "@/components/ui";
import { newsPushOn, setNewsPush } from "@/lib/client/alerts";
import {
  markAnnouncementsSeen,
  refreshAnnouncements,
  refreshAnnouncementsIfStale,
  useAnnouncements,
} from "@/lib/client/announcements";
import { CityContext } from "@/lib/client/city";

interface Props {
  desktop: boolean;
  onClose: () => void;
}

/** Carrier service announcements (delays, detours). Mounted only while open,
 *  like StopView/TripView. */
function AnnouncementsSheet({ desktop, onClose }: Props) {
  const city = useContext(CityContext);
  const { status, items } = useAnnouncements(city);
  const [push, setPush] = useState(() => newsPushOn(city));
  const [pushHint, setPushHint] = useState<string | null>(null);

  useEffect(() => {
    refreshAnnouncementsIfStale();
  }, []);
  /* clear the unread dot once the current set is actually on screen */
  useEffect(() => {
    if (status === "ready") markAnnouncementsSeen();
  }, [status]);

  const togglePush = async (): Promise<void> => {
    const on = !push;
    setPush(on);
    setPushHint(null);
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    const ok = await setNewsPush(city, on);
    if (on && !ok) {
      setPush(false);
      setPushHint(
        typeof Notification !== "undefined" && Notification.permission === "denied"
          ? "Powiadomienia są zablokowane w ustawieniach przeglądarki."
          : "Powiadomienia push nie działają w tej przeglądarce (na iPhonie dodaj aplikację do ekranu początkowego).",
      );
    }
  };

  const header = (
    <header className="px-4 pb-3 pt-2 md:pt-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint/6 text-[18px] text-text-mute">
          <MegaphoneSimpleIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-text">Utrudnienia</h2>
          <p className="mt-0.5 text-[12px] text-text-faint">
            {city === "gzm" ? "Komunikaty ZTM (transportgzm.pl)" : "Komunikaty przewoźnika"}
          </p>
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
        <div className="mb-3 rounded-xl bg-tint/4">
          <SwitchRow
            checked={push}
            onToggle={() => void togglePush()}
            label="Powiadamiaj o utrudnieniach"
            hint={pushHint ?? "Powiadomienie o nowym komunikacie, także przy zamkniętej aplikacji."}
          />
        </div>
        {status === "error" ? (
          <ErrorState onRetry={() => void refreshAnnouncements()} />
        ) : status === "ready" && items.length === 0 ? (
          <EmptyState text="Brak komunikatów o utrudnieniach." />
        ) : status === "ready" ? (
          <ul className="stagger space-y-2">
            {items.map((a) => (
              <li key={`${a.id}-${a.rev}`} className="rounded-xl bg-tint/4 px-4 py-3.5">
                <p className="max-w-[65ch] whitespace-pre-line text-[13.5px] leading-relaxed text-text">
                  {/* upstream marks headlines with markdown **bold**; the odd split parts are the bold runs */}
                  {a.content_markdown
                    .split(/\*\*([\s\S]+?)\*\*/)
                    .map((part, i) => (i % 2 ? <strong key={i} className="font-semibold">{part}</strong> : part))}
                </p>
                {a.url && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener"
                    className="mt-2 inline-block text-[13px] font-medium text-primary hover:underline"
                  >
                    Pełna treść
                  </a>
                )}
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
