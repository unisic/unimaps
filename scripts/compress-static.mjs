/**
 * Writes a .br and a .gz next to every compressible file of the static build (default out/), so
 * server/static.ts sends them as they are and no request pays for compression. Skips a sibling that
 * would not be smaller.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.argv[2] || "out";
const TEXT = /\.(html|js|mjs|css|json|map|txt|svg|xml|webmanifest)$/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.isFile() && TEXT.test(d.name) ? [p] : [];
  });
}

let raw = 0;
let br = 0;
for (const file of walk(root)) {
  const buf = fs.readFileSync(file);
  if (buf.length < 1024) continue;
  const b = zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
  });
  const g = zlib.gzipSync(buf, { level: 9 });
  if (b.length < buf.length) fs.writeFileSync(`${file}.br`, b);
  if (g.length < buf.length) fs.writeFileSync(`${file}.gz`, g);
  raw += buf.length;
  br += Math.min(b.length, buf.length);
}
console.log(`compress-static: ${(raw / 1024).toFixed(0)} KB -> ${(br / 1024).toFixed(0)} KB brotli`);
