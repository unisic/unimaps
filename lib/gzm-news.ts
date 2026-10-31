/**
 * GZM has no announcements API: the "Utrudnienia" list for GZM is scraped from the news page
 * (KB_GZM_NEWS_URL, server-rendered HTML: one `panel panel-default` per item with the article
 * link, "Ostatnia aktualizacja" and a lead paragraph). Fetched at most every REFRESH_MS, a failed
 * fetch keeps the last list. The parser is pure and pinned by test/gzm-news.test.ts.
 */
import { createHash } from "node:crypto";

import { GZM_NEWS_URL, USER_AGENT } from "./config";
import { log } from "./logger";

export interface GzmNewsItem {
  id: number;
  /** changes when the title, update stamp or lead changes (the unread badge, push) */
  rev: number;
  content_markdown: string;
  operator: "GZM";
  url: string;
}

const REFRESH_MS = 15 * 60_000;
const MAX_ITEMS = 50;
/** the page is ~100 KB; anything past this is not the list */
const MAX_HTML = 2_000_000;
const PANEL = '<div class="panel panel-default">';
const LINK = /<a href="\/v2\/news\/i\/(\d+)\/"\s*>([\s\S]*?)<\/a>/;
const STAMP = /Ostatnia aktualizacja:\s*(\d{2}\.\d{2}\.\d{4})\s*(\d{2}:\d{2})?/;
const LEAD = /<p class="lead list_lead">([\s\S]*?)<\/p>/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** The news list from the page's HTML; a panel without a link or title is skipped. */
export function parseGzmNews(html: string, base = "https://rj.transportgzm.pl"): GzmNewsItem[] {
  const out: GzmNewsItem[] = [];
  // a chunk runs to the next panel opener: the first link, stamp and lead in it are this panel's
  for (const panel of html.slice(0, MAX_HTML).split(PANEL).slice(1)) {
    const link = LINK.exec(panel);
    if (!link) continue;
    const title = text(link[2]);
    if (!title) continue;
    const stamp = STAMP.exec(panel);
    const when = stamp ? [stamp[1], stamp[2]].filter(Boolean).join(" ") : "";
    const lead = text(LEAD.exec(panel)?.[1] ?? "");
    const body = [`**[GZM] ${title}**`, when && `Aktualizacja: ${when}`, lead].filter(Boolean).join("\n\n");
    out.push({
      id: Number(link[1]),
      rev: parseInt(createHash("sha1").update(`${title}\n${when}\n${lead}`).digest("hex").slice(0, 8), 16),
      content_markdown: body,
      operator: "GZM",
      url: `${base}/v2/news/i/${link[1]}/`,
    });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

let cache: { at: number; items: GzmNewsItem[] } | null = null;
let inflight: Promise<GzmNewsItem[]> | null = null;

/** The current GZM list (memo 15 min, in-flight deduped); throws only when nothing was ever fetched. */
export function fetchGzmNews(): Promise<GzmNewsItem[]> {
  if (!GZM_NEWS_URL) return Promise.reject(new Error("GZM news off"));
  if (cache && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache.items);
  inflight ??= (async () => {
    try {
      const res = await fetch(GZM_NEWS_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseGzmNews(await res.text(), new URL(GZM_NEWS_URL).origin);
      // an empty parse is a changed page layout, not "no news": keep what we had
      if (items.length === 0 && cache) throw new Error("no panels parsed");
      cache = { at: Date.now(), items };
      return items;
    } catch (err) {
      if (!cache) throw err;
      log.warn("gzm-news", `refresh failed, keeping ${cache.items.length} items: ${err}`);
      cache.at = Date.now();
      return cache.items;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
