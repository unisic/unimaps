/**
 * Copies ZTM's recorded stop announcements into the directory /api/announce serves (KB_GZM_ANNOUNCE_DIR):
 * every `<municipality>/<name>.mp3` of the source becomes `s-<announceKey(name)>.mp3`, the phrase
 * "Następny przystanek" becomes `p-next.mp3`. Directories starting with "0 " hold no stops. Nothing in the
 * destination is ever deleted.
 *
 * Usage:
 *   npx tsx scripts/import-announcements.ts <source dir> [dest dir]
 */
import fs from "node:fs";
import path from "node:path";

import { announceKey } from "../lib/shared/announce";

const MAX_BYTES = 1024 * 1024;
const PHRASE = path.join("0 Komunikaty dodatkowe", "1_NastepnyPrzystanek.mp3");
/* the request-stop mark of a file name: "StadionNZ", "PomlynieNz", "Brzozowa_NZ", "Kościuszki_nż", "Skrzyżowanie nż" */
const REQUEST_TAIL = /(?:[_ ]+[nN][zZżŻ]|N[zZżŻ])$/u;

function fail(msg: string): never {
  console.error(`import-announcements: ${msg}`);
  process.exit(1);
}

const [src, dest = path.join("output", "gzm", "announce")] = process.argv.slice(2);
if (!src) fail("usage: tsx scripts/import-announcements.ts <source dir> [dest dir]");

let dirs: string[];
try {
  dirs = fs
    .readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("0 "))
    .map((d) => d.name)
    .sort();
} catch (e) {
  fail(`cannot read the source directory ${src}: ${(e as Error).message}`);
}
const phrase = path.join(src, PHRASE);
if (!fs.existsSync(phrase)) fail(`the phrase recording is missing: ${phrase}`);

let skipped = 0;
const plain: { file: string; stem: string }[] = [];
const tailed: { file: string; stem: string }[] = [];
for (const dir of dirs) {
  const entries = fs.readdirSync(path.join(src, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(src, dir, e.name);
    if (!/\.mp3$/i.test(e.name) || fs.statSync(file).size > MAX_BYTES) {
      skipped++;
      continue;
    }
    // macOS archives store names decomposed: "ż" is "z" + U+0307, which REQUEST_TAIL would miss
    const stem = e.name.slice(0, -4).normalize("NFC").trim();
    if (REQUEST_TAIL.test(stem)) tailed.push({ file, stem: stem.replace(REQUEST_TAIL, "") });
    else plain.push({ file, stem });
  }
}

fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(phrase, path.join(dest, "p-next.mp3"));
let copied = 1;
let duplicates = 0;
const taken = new Set<string>();
/* plain names first: a request-stop recording never replaces the plain one of the same stop */
for (const { file, stem } of [...plain, ...tailed]) {
  const key = announceKey(stem);
  if (!key) skipped++;
  else if (taken.has(key)) duplicates++;
  else {
    taken.add(key);
    fs.copyFileSync(file, path.join(dest, `s-${key}.mp3`));
    copied++;
  }
}
console.log(`import-announcements: copied ${copied} (p-next + ${copied - 1} stops) to ${dest}, duplicates ${duplicates}, skipped ${skipped}`);
