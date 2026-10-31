/**
 * One announcements list per city for /api/announcements and the push ticker (lib/push-news.ts):
 * BB = KB's feed + MZK's messages (one failed leg drops that leg, never the other), GZM = the
 * scraped news page. `hash` changes with the set (the client's unread dot).
 */
import { createHash } from "node:crypto";

import type { City } from "./api-helpers";
import { fetchGzmNews } from "./gzm-news";
import { pyTruthy } from "./kb-api";
import { getApi, getMzkApi, startPoller } from "./poller-singleton";

export interface AnnouncementItem {
  id: number;
  rev: number;
  content_markdown: string;
  operator: string;
  url?: string;
}

export interface Announcements {
  announcements: AnnouncementItem[];
  hash: string;
}

export const announcementKey = (a: AnnouncementItem): string => `${a.operator}:${a.id}:${a.rev}`;

/** The headline of an item: its first bold run, else its first line (the push body). */
export function announcementTitle(a: AnnouncementItem): string {
  const bold = /\*\*([\s\S]+?)\*\*/.exec(a.content_markdown);
  return (bold ? bold[1] : a.content_markdown.split("\n")[0]).replace(/﻿/g, "").trim().slice(0, 120);
}

/** BB or GZM; another city has no source and answers an empty list. */
export async function fetchAnnouncements(city: City): Promise<Announcements> {
  const items = city === "gzm" ? await fetchGzmNews() : city === "bb" ? await fetchBb() : [];
  return { announcements: items, hash: items.map((a) => `${a.id}:${a.rev}`).join("|") };
}

async function fetchBb(): Promise<AnnouncementItem[]> {
  await startPoller();
  const [kbData, mzkMsgs] = await Promise.allSettled([getApi().fetchAnnouncements(), getMzkApi().fetchMessages()]);
  const kbRaw =
    kbData.status === "fulfilled" && pyTruthy(kbData.value) && typeof kbData.value === "object"
      ? (kbData.value as { announcements?: unknown }).announcements
      : null;
  // one malformed KB entry must not 502 the whole list (and drop the MZK messages with it)
  const kb = (Array.isArray(kbRaw) ? kbRaw : [])
    .filter((a): a is { id: number; rev: number; content_markdown: string } => !!a && typeof a === "object")
    .map((a) => ({ ...a, operator: "KB" }));
  const mzk =
    mzkMsgs.status === "fulfilled" && Array.isArray(mzkMsgs.value)
      ? mzkMsgs.value.map((m) => ({
          id: m.loid,
          // OnTime has no revision: an in-place edit must still change the hash (unread badge)
          rev: parseInt(createHash("sha1").update(`${m.title}\n${m.intro}`).digest("hex").slice(0, 8), 16),
          content_markdown: `**[MZK Bielsko-Biała] ${m.title}**\n\n${m.intro}`,
          operator: "MZK",
        }))
      : [];
  return [...kb, ...mzk];
}
