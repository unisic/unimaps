import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AnnouncementItem } from "../lib/announcements";
import { PushNews } from "../lib/push-news";
import type { PushSub } from "../lib/web-push";

// real P-256 keys (the RFC 8291 test vector): isPushSub drops anything else on reload
const KEYS = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
const sub = (n: number): PushSub => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: KEYS });
const item = (id: number, rev = 1, operator = "KB"): AnnouncementItem => ({
  id,
  rev,
  operator,
  content_markdown: `**[${operator}] Objazd ${id}**\n\ntreść`,
});

function store(lists: Record<string, () => AnnouncementItem[]>, status = 201) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-news-")), "news.json");
  const sent: Array<{ endpoint: string; msg: { body: string; tag: string; url: string } }> = [];
  const s = new PushNews(
    file,
    async (to, msg) => (sent.push({ endpoint: to.endpoint, msg: msg as { body: string; tag: string; url: string } }), status),
    async (city) => {
      const items = lists[city]?.() ?? [];
      return { announcements: items, hash: items.map((a) => `${a.id}:${a.rev}`).join("|") };
    },
  );
  return { s, sent, file };
}

describe("PushNews", () => {
  it("records the first list silently, then pushes only what is new, per city", async () => {
    let bb = [item(1), item(2)];
    const gzm = [item(7, 1, "GZM")];
    const { s, sent, file } = store({ bb: () => bb, gzm: () => gzm });
    assert.equal(s.add(sub(1), "bb"), true);
    assert.equal(s.add(sub(2), "gzm"), true);
    assert.equal(s.add(sub(2), "bb"), true);
    assert.equal(s.size, 2);
    await s.tick();
    assert.equal(sent.length, 0);
    bb = [...bb, item(3), item(4)];
    await s.tick();
    assert.deepEqual(
      sent.map((x) => [x.endpoint.slice(-1), x.msg.body, x.msg.tag, x.msg.url]),
      [["1", "[KB] Objazd 3 (+1)", "news:bb", "/"], ["2", "[KB] Objazd 3 (+1)", "news:bb", "/"]],
    );
    await s.tick();
    assert.equal(sent.length, 2);
    // an edit = a new rev = a notification again
    bb = bb.map((a) => (a.id === 1 ? { ...a, rev: 2 } : a));
    await s.tick();
    assert.equal(sent.length, 4);
    // persisted and reloaded: nothing is "new" again
    await new Promise((r) => setTimeout(r, 2100));
    s.stop();
    const again = new PushNews(file, async () => 201, async (city) => ({ announcements: city === "bb" ? bb : gzm, hash: "" }));
    assert.equal(again.size, 2);
    const before = sent.length;
    await again.tick();
    assert.equal(sent.length, before);
    again.stop();
  });

  it("drops a subscription the push service reports gone; removing the last city removes it", async () => {
    let bb = [item(1)];
    const { s, sent } = store({ bb: () => bb }, 410);
    s.add(sub(1), "bb");
    s.add(sub(2), "bb");
    s.add(sub(2), "gzm");
    await s.tick();
    bb = [item(1), item(2)];
    await s.tick();
    assert.equal(sent.length, 2);
    assert.equal(s.size, 0);
    s.add(sub(3), "bb");
    s.add(sub(3), "gzm");
    s.remove(sub(3).endpoint, "bb");
    assert.equal(s.size, 1);
    s.remove(sub(3).endpoint, "gzm");
    assert.equal(s.size, 0);
    s.stop();
  });
});
