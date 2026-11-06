/**
 * Golden vectors for the Rust port: the TS functions run on fixed inputs and backend/tests/*.rs read their answers
 * from backend/tests/vectors/*.json. Rerun after changing a ported function, from the repo root:
 *   node --import tsx scripts/dump-vectors.ts
 */
import fs from "node:fs";
import path from "node:path";

import { hhmm, preSortRows, type TimingRow } from "../lib/shared/departures";

const OUT = "backend/tests/vectors";

function write(name: string, data: unknown): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(data, null, 1)}\n`);
}

// lib/lines.ts, lib/gzm-feed.ts and lib/shared/departures.ts sort line names with the numeric "pl" collator,
// lib/shared/fleet.ts compareLineNames falls back to the plain one
const names: string[] = JSON.parse(fs.readFileSync("test/fixtures/line-names.json", "utf8"));
const numeric = new Intl.Collator("pl", { numeric: true });
write("collation", {
  icu: process.versions.icu,
  pl: [...names].sort((a, b) => a.localeCompare(b, "pl")),
  pl_numeric: [...names].sort(numeric.compare),
});

// lib/shared/departures.ts: the server pre-sort of a board and the wall clock of a row
{
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const now = 1_791_000_000.5;
  const lines = ["1", "2", "10", "17", "119", "N1", "M1", "T7", "02", "2", undefined];
  const boards = [];
  for (let b = 0; b < 100; b++) {
    // odd boards are dense: few minutes, lines and plans, so the later tie-breaks (plan, key) decide
    const dense = b % 2 === 1;
    const rows: TimingRow[] = [];
    for (let i = 0, n = 2 + Math.floor(rnd() * 14); i < n; i++) {
      const plan = rnd() < (dense ? 0.3 : 0.08) ? null : dense ? now + pick([299.5, 300, 330, 360]) : Math.round(now + rnd() * 7200 - 600);
      const eta = dense
        ? pick([null, now + 301, now + 329])
        : rnd() < 0.3 ? null : (plan ?? now) + Math.round(rnd() * 1200 - 120) + pick([0, 0.25, 0.5, -0.5]);
      rows.push({
        operator: pick(["KB", "MZK", "GZM"] as const),
        line_name: dense ? pick(["17", "017", "119", undefined]) : pick(lines),
        plan_ts: plan,
        eta_ts: eta,
        at_stop: rnd() < 0.08,
        canceled: rnd() < 0.08,
        not_started: rnd() < 0.1,
        row_key: pick(["gzm:a#1", "gzm:b#2", "mzk:7#3", "Z#1", "a#10", "a#9", "ż#1", "\u{1f68c}#1", "\u{ff5e}#1"]) + (rnd() < 0.5 ? "" : String(i)),
      });
    }
    const sorted = preSortRows(rows, now);
    boards.push({ rows, order: sorted.map((r) => rows.indexOf(r)) });
  }
  const instants = [0, -0.0005, -1.5, 59.999, 1_774_745_999, 1_774_746_000, 1_774_749_599.9, 1_792_889_999, 1_792_890_000, 1_792_893_600, now];
  for (let i = 0; i < 100; i++) instants.push(1_760_000_000 + Math.floor(rnd() * 90_000_000) + pick([0, 0.4, 0.9999]));
  write("departures", { now, boards, hhmm: instants.map((t) => [t, hhmm(t)]) });
}
