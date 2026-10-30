import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { isAlertInput, PushAlerts } from "../lib/push-alerts";
import type { Alert } from "../lib/shared/alerts";
import type { TimingRow } from "../lib/shared/departures";
import type { PushSub } from "../lib/web-push";

const NOW = Date.now() / 1000;
const sub = (n: number): PushSub => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "x", auth: "y" } });
const alert = (over: Partial<Alert> = {}): Alert => ({
  key: "kb:e1#4",
  designator: "123",
  stopName: "Szczyrk Biła",
  line: "120",
  dest: "Bielsko-Biała",
  leadMin: 5,
  until: NOW + 1800,
  ...over,
});
const row = (over: Partial<TimingRow> = {}) => ({ operator: "KB", row_key: "kb:e1#4", line_name: "120", plan_ts: NOW + 600, eta_ts: NOW + 600, ...over }) as TimingRow;

function store(rows: () => TimingRow[], status = 201) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-")), "alerts.json");
  const sent: Array<{ endpoint: string; msg: { title: string; tag: string } }> = [];
  const s = new PushAlerts(
    file,
    async (to, msg) => (sent.push({ endpoint: to.endpoint, msg: msg as { title: string; tag: string } }), status),
    async () => ({ rows: rows(), nowTs: NOW }),
  );
  return { s, sent, file };
}

describe("PushAlerts", () => {
  it("validates what a browser sends", () => {
    assert.equal(isAlertInput(alert(), NOW), true);
    assert.equal(isAlertInput(alert({ leadMin: 4 }), NOW), false);
    assert.equal(isAlertInput(alert({ until: NOW - 1 }), NOW), false);
    assert.equal(isAlertInput(alert({ until: NOW + 25 * 3600 }), NOW), false);
    assert.equal(isAlertInput(alert({ designator: "../x" }), NOW), false);
    assert.equal(isAlertInput(alert({ dest: "x".repeat(121) }), NOW), false);
  });

  it("caps one browser at 6 alerts; re-adding the same key replaces it", () => {
    const { s } = store(() => []);
    for (let i = 0; i < 6; i++) assert.equal(s.add(sub(1), alert({ key: `k${i}` })), true);
    assert.equal(s.add(sub(1), alert({ key: "k6" })), false);
    assert.equal(s.add(sub(1), alert({ key: "k0", leadMin: 10 })), true);
    assert.equal(s.size, 6);
    s.remove(sub(1).endpoint, "k0");
    assert.equal(s.size, 5);
    s.stop();
  });

  it("waits, fires once inside the lead, then forgets the alert", async () => {
    let eta = NOW + 600;
    const { s, sent } = store(() => [row({ eta_ts: eta })]);
    s.add(sub(1), alert());
    await s.tick();
    assert.equal(sent.length, 0);
    eta = NOW + 240;
    await s.tick();
    await s.tick();
    assert.deepEqual(sent.map((x) => [x.msg.title, x.msg.tag]), [["120 za 4 min", "kb:e1#4"]]);
    assert.equal(s.size, 0);
    s.stop();
  });

  it("a gone subscription (410) is dropped with all its alerts", async () => {
    const { s } = store(() => [row({ canceled: true })], 410);
    s.add(sub(1), alert());
    s.add(sub(1), alert({ key: "other" }));
    await s.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.size, 0);
    s.stop();
  });

  it("persists across a restart, dropping what no longer validates", async () => {
    const { s, file } = store(() => []);
    s.add({ endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } }, alert());
    s.add(sub(2), alert());
    await new Promise((r) => setTimeout(r, 2100));
    s.stop();
    const again = new PushAlerts(file, async () => 201, async () => null);
    // sub(2) carries keys that are not a P-256 point
    assert.equal(again.size, 1);
    again.stop();
  });
});
